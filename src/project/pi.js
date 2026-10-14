/**
 * pi session JSONL → host-neutral projection entries.
 *
 * pi stores a session as append-only JSONL: a `session` header followed by
 * tree nodes linked by `id`/`parentId`. Two kinds of branching exist and are
 * handled differently:
 *
 *   - in-session branches (`/tree`): several children share one `parentId`.
 *     Only the active branch is projected, because the canvas would otherwise
 *     show the same turn twice.
 *   - cross-file forks (`/fork`, `/clone`): the child session's header carries
 *     `parentSession` pointing at the parent file. The child's own entries are
 *     its tail; the inherited prefix is already represented by the parent node.
 *
 * Entry kinds are normalized to the vocabulary WorkspaceStore understands:
 * `title` / `user` / `assistant` / `todo` / `error` / `tool-call` / `tool-result`.
 */

import { effectiveModel } from './context-usage.js'

/** Entry types that carry conversation meaning; everything else is dropped. */
const IGNORED_ENTRY_TYPES = new Set([
  'model_change',
  'thinking_level_change',
  'usage',
  'label',
])

/** pi-web pins a session's tool loadout in a `custom` entry under this type. */
export const TOOL_SELECTION_TYPE = 'pi-web:tool-selection'

/**
 * The character cost pi charges for one image block.
 *
 * pi's estimator adds a flat `ESTIMATED_IMAGE_CHARS = 4800` per image (1200
 * tokens at its 4-chars-per-token divisor) instead of looking at the payload,
 * so the canvas must charge the same or its ring under-reports every session
 * that contains a pasted image. Charged for the same roles pi charges it for:
 * user, custom and tool-result content — NOT assistant messages, which pi sizes
 * from text, thinking and tool calls only.
 */
const IMAGE_CHARS = 4800

/** How many image blocks a pi content value carries. */
function imageCountOf(content) {
  let count = 0
  for (const block of asArray(content)) {
    if (block?.type === 'image') count += 1
  }
  return count
}

/** pi's flat per-image character charge, as a sum over one content value. */
function imageCharsOf(content) {
  return imageCountOf(content) * IMAGE_CHARS
}

/**
 * Read a pi session file into normalized projection entries.
 *
 * Returns the header, the active branch, and the entries the store consumes.
 * `inheritedEntryCount` lets a fork skip its parent's prefix.
 */
export function projectPiSession(header, entries) {
  const branch = activeBranch(entries)
  const activeIds = new Set(branch.map(entry => entry.id))
  const projected = []
  let order = 0
  for (const entry of entries) {
    if (!activeIds.has(entry.id)) continue
    for (const item of projectPiEntry(entry)) {
      projected.push({ ...item, order: order++ })
    }
  }
  return {
    header,
    entries: projected,
    inheritedEntryCount: 0,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    filePath: null,
    // The model at the end of the session, used to resolve the context window.
    model: effectiveModel(entries, header),
  }
}

/**
 * Walk from the last entry (the current leaf) back to the root along
 * `parentId`. The result is the conversation the model actually sees.
 *
 * The `session` header also has an `id` but no `parentId` key at all, so it
 * must be excluded by type rather than by `parentId == null` — treating it as
 * a tree node makes every session look like it has two roots.
 */
export function activeBranch(entries) {
  const nodes = entries.filter(entry => entry.type !== 'session' && typeof entry.id === 'string')
  const byId = new Map(nodes.map(entry => [entry.id, entry]))
  const path = []
  const seen = new Set()
  let cursor = nodes.at(-1)?.id
  while (typeof cursor === 'string' && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor)
    path.push(byId.get(cursor))
    cursor = byId.get(cursor).parentId
  }
  return path.reverse()
}

/**
 * One item in a session's projection.
 *
 * The shape is deliberately open: the pipeline carries several kinds through
 * one array (`title`, `assistant`, `tool-call`, `usage`, `error`, `label`, …),
 * and only `id`, `kind` and `at` are universal. Declaring it keeps every
 * consumer type-checked — without it each read of `text` / `usageChars` /
 * `callId` reports as a missing property, because TypeScript sees a union of
 * the individual literal shapes and cannot pick the member by `kind`.
 *
 * `text` is absent on purpose for the kinds that carry no prose (`usage`,
 * `tool-call`, `tool-selection`, `context-edit`), so a reader must
 * null-check rather than assume.
 *
 * @typedef {object} ProjectionEntry
 * @property {string} id
 * @property {number} [order]        Assigned by projectPiSession(), in file order
 * @property {string} kind
 * @property {string} [text]
 * @property {string} at
 * @property {object|null} [usage]   pi's own token accounting for the round
 * @property {number} [usageChars]   Characters pi counts but the canvas never shows
 * @property {number} [imageCount]
 * @property {string|null} [callId]
 * @property {string} [name]         Tool name, for `tool-call`
 * @property {string} [arguments]    Pretty-printed tool arguments
 * @property {string} [turn]         Entry id of the turn the item belongs to
 * @property {number|null} [step]
 * @property {string[]} [tools]      For `tool-selection`
 */

/**
 * Map one pi entry to zero or more projection entries.
 *
 * A single entry can yield several: an assistant message that both writes text
 * and calls a tool produces the assistant card plus one `tool-call` entry per
 * call, so the store can fold each call into that same card by `callId`.
 *
 * @returns {ProjectionEntry[]}
 */
export function projectPiEntry(entry) {
  switch (entry.type) {
    case 'message':
      return projectMessage(entry)
    case 'custom':
      return projectCustom(entry)
    case 'session_info':
      return typeof entry.name === 'string' && entry.name.trim() !== ''
        ? [{ id: `${entry.id}:title`, kind: 'title', text: entry.name, at: entry.timestamp }]
        : []
    case 'custom_message':
      return entry.display === true
        ? note(entry, 'user', textOf(entry.content), { usageChars: imageCharsOf(entry.content), imageCount: imageCountOf(entry.content) })
        : []
    case 'compaction':
      return typeof entry.summary === 'string' && entry.summary.trim() !== ''
        ? [{ id: `${entry.id}:compaction`, kind: 'compaction', text: entry.summary, at: entry.timestamp }]
        : []
    // A context edit removes a block from the context. It carries no prose, but
    // the estimator must still see it: pi invalidates the usage anchor when one
    // follows, and without this entry the estimate would keep a stale figure.
    case 'context_edit':
      return [{ id: `${entry.id}:context-edit`, kind: 'context-edit', at: entry.timestamp }]
    case 'branch_summary':
      return typeof entry.summary === 'string' && entry.summary.trim() !== ''
        ? [{ id: `${entry.id}:branch`, kind: 'branch', text: entry.summary, at: entry.timestamp }]
        : []
    default:
      return IGNORED_ENTRY_TYPES.has(entry.type) ? [] : []
  }
}

function projectMessage(entry) {
  const message = entry.message
  if (message === null || typeof message !== 'object') return []
  switch (message.role) {
    case 'user': {
      const text = textOf(message.content)
      return isRuntimeContextText(text) ? [] : note(entry, 'user', text, { usageChars: imageCharsOf(message.content), imageCount: imageCountOf(message.content) })
    }
    case 'assistant': {
      const items = []
      const text = assistantText(message.content)
      // `usage` must reach the projection: it is the only authoritative token
      // count pi records, and the canvas derives the context-window figure from
      // the newest one. A tool-only round carries the newest usage and no
      // prose, so dropping it here would silently lose the anchor.
      // `usageChars` is the entry's own payload that pi counts but the canvas
      // never displays: reasoning text (length only, not the text) plus the
      // compact tool-call arguments. Keeping it as one sum means the estimator
      // adds it exactly once, however many items this entry produced.
      const extra = {
        usage: message.usage ?? null,
        usageChars: thinkingChars(message.content) + argumentCharsTotal(message.content),
      }
      if (text !== '') items.push(...note(entry, 'assistant', text, extra))
      // A tool call belongs to the turn it was made in. A single turn is often
      // several assistant entries (one per tool round), and only the last one
      // carries prose, so the call is attached to the card by its own entry id
      // and the store folds it into whichever card owns that turn.
      for (const block of asArray(message.content)) {
        if (block?.type !== 'toolCall') continue
        items.push({
          id: `${entry.id}:call:${block.id ?? items.length}`,
          kind: 'tool-call',
          callId: typeof block.id === 'string' ? block.id : null,
          name: typeof block.name === 'string' ? block.name : '工具调用',
          arguments: formatArguments(block.arguments),
          turn: entry.id,
          step: null,
          at: entry.timestamp,
          // Exactly one item per entry carries the entry's own accounting, or
          // the usage and reasoning size would be counted once per tool call.
          ...(items.length === 0 ? extra : {}),
        })
      }
      // A round that produced neither prose nor a tool call still reports the
      // context it ran against (and any reasoning it spent), and that figure is
      // what anchors the ring.
      if (items.length === 0 && (extra.usage !== null || extra.usageChars > 0)) {
        items.push({ id: `${entry.id}:usage`, kind: 'usage', at: entry.timestamp, ...extra })
      }
      if (message.stopReason === 'error' || (message.error !== undefined && message.error !== null)) {
        items.push({ id: `${entry.id}:error`, kind: 'error', text: errorText(message.error) ?? '本轮执行失败', turn: entry.id, step: null, at: entry.timestamp })
      }
      return items
    }
    case 'toolResult': {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : null
      return [{
        id: `${entry.id}:result:${callId ?? 'unknown'}`,
        kind: 'tool-result',
        callId,
        name: typeof message.toolName === 'string' ? message.toolName : '工具调用',
        text: textOf(message.content),
        error: message.isError === true ? (textOf(message.content) || '工具执行失败') : null,
        // An image a tool returned (a screenshot, a chart) is context pi still
        // charges for, even though the canvas folds the result into plain text.
        usageChars: imageCharsOf(message.content),
        imageCount: imageCountOf(message.content),
        // A tool result is a child of the assistant entry that made the call,
        // so its `parentId` identifies the turn this result belongs to.
        turn: entry.parentId,
        step: null,
        at: entry.timestamp,
      }]
    }
    // The system message carries the prompt and every tool schema; it has no
    // conversational value and would dwarf every card.
    case 'system':
    default:
      return []
  }
}

function note(entry, kind, text, extra = {}) {
  const normalized = typeof text === 'string' ? text.trim() : ''
  // An image-only message carries no prose but IS a turn: dropping it would
  // make a pasted screenshot an invisible card and hide its share of context.
  if (normalized === '' && !(extra.imageCount > 0)) return []
  return [{ id: entry.id, kind, text: normalized, at: entry.timestamp, ...extra }]
}

/**
 * A `custom` entry is extension state, never conversation — except pi-web's
 * tool-selection pin, which the canvas mirrors so a btw card can show whether
 * its tools are restricted.
 */
function projectCustom(entry) {
  if (entry.customType !== TOOL_SELECTION_TYPE) return []
  const data = entry.data
  // A `cleared` pin retracts an earlier one: the session follows settings.json
  // again, so the thread carries no restriction.
  const tools = data?.cleared === true
    ? null
    : Array.isArray(data?.tools) && data.tools.every(name => typeof name === 'string')
      ? [...new Set(data.tools)]
      : undefined
  if (tools === undefined) return []
  return [{ id: `${entry.id}:tools`, kind: 'tool-selection', tools, at: entry.timestamp }]
}

/**
 * The assistant's visible prose. Thinking blocks are excluded: they are long,
 * often duplicated across retries, and not what the user reads on the canvas.
 */
function assistantText(content) {
  return asArray(content)
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** How many characters of reasoning this entry carried, without the text. */
function thinkingChars(content) {
  let chars = 0
  for (const block of asArray(content)) {
    if (block?.type === 'thinking' && typeof block.thinking === 'string') chars += block.thinking.length
  }
  return chars
}

/**
 * The compact character count of a tool call's arguments.
 *
 * pi counts `JSON.stringify(arguments).length` when estimating context, so the
 * pretty-printed form kept for display must not be used for that sum.
 */
function argumentCharsTotal(content) {
  let chars = 0
  for (const block of asArray(content)) {
    if (block?.type !== 'toolCall') continue
    chars += String(block.name ?? '').length
    chars += compactLength(block.arguments)
  }
  return chars
}

/** `JSON.stringify(value).length`, which is how pi sizes a tool call's input. */
function compactLength(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

/** Flatten any pi content value (string, or an array of content blocks). */
export function textOf(content) {
  if (typeof content === 'string') return content
  return asArray(content).flatMap(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block?.type === 'thinking' && typeof block.thinking === 'string') return []
    if (block?.type === 'toolResult') return [textOf(block.content)]
    if (typeof block?.text === 'string') return [block.text]
    return []
  }).filter(value => typeof value === 'string' && value.trim() !== '').join('\n')
}

function formatArguments(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function errorText(value) {
  if (typeof value === 'string') return value.trim() || null
  if (value === null || value === undefined || typeof value !== 'object') return null
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : ''
  const code = typeof value.code === 'string' && value.code.trim() !== '' ? value.code.trim() : ''
  const message = typeof value.message === 'string' && value.message.trim() !== '' ? value.message.trim() : ''
  if (message !== '') return [name, code].filter(Boolean).concat(message).join(': ')
  return [name, code].filter(Boolean).join(': ') || null
}

/**
 * pi injects a runtime-context snapshot as a user message. It is bookkeeping,
 * not something the user asked, so it never becomes a card.
 */
export function isRuntimeContextText(text) {
  return typeof text === 'string' && text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** Parse a session file body into entries. Tolerates a truncated last line. */
export function parseSessionLines(text) {
  const entries = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      // A partially written trailing line is expected while a session streams.
    }
  }
  return entries
}

/** Split a parsed session into its header and its tree entries. */
export function splitSession(entries) {
  const header = entries.find(entry => entry.type === 'session') ?? null
  const rest = entries.filter(entry => entry.type !== 'session')
  return { header, entries: rest }
}