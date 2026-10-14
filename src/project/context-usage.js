/**
 * Context-window usage for a pi session, derived from disk.
 *
 * pi-web reports `contextUsage` through `/api/agent/:id`, but only for sessions
 * currently loaded in memory (the rest are evicted after the idle timeout). The
 * canvas must show the same figure for EVERY session, so this module reproduces
 * pi's own calculation from the session file:
 *
 *   1. find the last entry carrying usage — that usage IS what the model saw
 *      (`calculateContextTokens`); it is not always an assistant message with
 *      prose, because a tool-only round reports usage and no text;
 *   2. add token estimates for everything after it, since those entries are in
 *      the transcript but have not been billed yet;
 *   3. discard that anchor when a `compaction` or `context_edit` follows it:
 *      the context was rewritten or a block removed, so the old figure no
 *      longer describes what is in the window. The re-estimate is then taken
 *      from the LAST compaction onward, because a compaction replaces the
 *      history before it with its summary;
 *   4. divide by the model's context window (from the model registry).
 *
 * Estimates count characters and divide by 4, matching pi.
 */

/** pi's own divisor: a rough 4 characters per token. */
const CHARS_PER_TOKEN = 4

/**
 * The fields the estimator reads.
 *
 * Its own shape rather than `ProjectionEntry`: the estimator is called with
 * projection entries AND with the store's persisted messages, and only this
 * subset is common to both. `process` is the folded tool results (their output
 * is context too) and is absent from raw projections.
 *
 * @typedef {object} EstimateInput
 * @property {string} [text]
 * @property {string} [kind]
 * @property {object|null} [usage]
 * @property {number} [usageChars]
 * @property {Array<{ result?: unknown, error?: unknown, imageChars?: number }>} [process]
 */

/** Tokens one projected entry occupies in the context. */
function estimateEntryTokens(entry) {
  if (entry === null || typeof entry !== 'object') return 0
  let chars = typeof entry.text === 'string' ? entry.text.length : 0
  // The entry's own payload that pi counts but the canvas never displays:
  // reasoning text (length only) plus the compact tool-call arguments. The
  // projector sums these into one field so it is added exactly once per entry.
  chars += typeof entry.usageChars === 'number' && entry.usageChars > 0 ? entry.usageChars : 0
  // A tool result's output is context too, and it lives in the folded process.
  // `imageChars` is the projector's flat per-image charge (pi charges 4800
  // characters per image); the result text alone would miss it.
  for (const item of entry.process ?? []) {
    chars += String(item.result ?? item.error ?? '').length
    chars += typeof item.imageChars === 'number' && item.imageChars > 0 ? item.imageChars : 0
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** pi stores token counts on the assistant message's `usage`. */
export function usageTotal(usage) {
  if (usage === null || typeof usage !== 'object') return 0
  if (typeof usage.totalTokens === 'number' && usage.totalTokens > 0) return usage.totalTokens
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

/**
 * Walk the projected entries and produce the token estimate.
 *
 * @param {EstimateInput[]} entries Projected entries or persisted messages, in order.
 * @returns {{ tokens: number, anchored: boolean }}
 */
export function estimateContextTokens(entries) {
  // The anchor is the newest entry carrying a real usage record. It is not
  // always an assistant entry with prose: a tool-only assistant round reports
  // the context it ran against and carries no text at all, and that usage is
  // the newest one in the session. Searching for `usage` rather than for
  // `kind === 'assistant'` keeps the anchor from being lost there.
  let anchorIndex = -1
  let usageTokens = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const total = usageTotal(entries[index]?.usage)
    if (total <= 0) continue
    anchorIndex = index
    usageTokens = total
    break
  }

  // A compaction or context edit after the anchor rewrites the context, so the
  // recorded usage no longer describes what is in the window. pi invalidates on
  // both; a `context_edit` is a removal (`replacement: null` in every real
  // session), which shrinks the context just as compaction does.
  if (anchorIndex !== -1) {
    for (let index = anchorIndex + 1; index < entries.length; index++) {
      const kind = entries[index]?.kind
      if (kind === 'compaction' || kind === 'context-edit') { anchorIndex = -1; break }
    }
  }

  if (anchorIndex === -1) {
    // FALLBACK, and it must be compaction-aware. A compaction REPLACES the
    // history before it with its summary, so the context pi actually sends is
    // the summary plus everything after it — not the whole transcript. Summing
    // every entry here reported 94.6% for a session pi would call 0.3%, i.e. it
    // panicked the user about a context that had just been cleared.
    let start = 0
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]?.kind === 'compaction') { start = index; break }
    }
    let tokens = 0
    for (let index = start; index < entries.length; index++) tokens += estimateEntryTokens(entries[index])
    return { tokens, anchored: false }
  }

  // Everything after the anchor is in the context but unbilled.
  let tokens = usageTokens
  // The anchor's own usage was snapshotted when it was generated, so any tool
  // RESULT folded into it arrived afterwards and is unbilled trailing context.
  // (Its arguments were part of the anchor's own output, so they are not added.)
  for (const item of entries[anchorIndex].process ?? []) {
    const resultChars = String(item.result ?? item.error ?? '').length + (item.imageChars ?? 0)
    tokens += Math.ceil(resultChars / CHARS_PER_TOKEN)
  }
  for (let index = anchorIndex + 1; index < entries.length; index++) tokens += estimateEntryTokens(entries[index])
  return { tokens, anchored: true }
}

/**
 * Compute the usage to show on a card.
 *
 * @param {object} input
 * @param {Array<object>} input.entries      Projected entries of the active branch.
 * @param {number|null|undefined} input.contextWindow
 * @returns {{ tokens: number, contextWindow: number, percent: number, estimated: boolean }|null}
 *   `null` when no window is known, so the UI omits the ring entirely rather
 *   than drawing a meaningless one.
 */
export function contextUsage({ entries, contextWindow }) {
  if (typeof contextWindow !== 'number' || !(contextWindow > 0)) return null
  const estimate = estimateContextTokens(entries)
  return {
    tokens: Math.max(0, Math.round(estimate.tokens)),
    contextWindow,
    percent: Math.max(0, Math.min(100, estimate.tokens / contextWindow * 100)),
    estimated: estimate.anchored === false,
  }
}

/**
 * The model in force at the end of a session: the newest `model_change`, else
 * the header. pi records `provider`/`modelId` on the change entry and
 * `provider`/`model` on the header.
 *
 * Operates on RAW pi entries, because `model_change` is not a conversation
 * event and never reaches the projection.
 */
export function effectiveModel(rawEntries, header) {
  for (let index = rawEntries.length - 1; index >= 0; index--) {
    const entry = rawEntries[index]
    if (entry?.type !== 'model_change') continue
    const id = typeof entry.modelId === 'string' && entry.modelId !== '' ? entry.modelId
      : typeof entry.model === 'string' && entry.model !== '' ? entry.model : null
    if (id !== null) return { provider: typeof entry.provider === 'string' ? entry.provider : null, id }
  }
  const id = typeof header?.model === 'string' && header.model !== '' ? header.model : null
  if (id === null) return null
  return { provider: typeof header?.provider === 'string' ? header.provider : null, id }
}
