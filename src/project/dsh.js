/**
 * DSH session events → host-neutral projection entries.
 *
 * DSH keeps an event-sourced log: every fact the model saw is one typed event
 * (`user/message`, `assistant/message`, `tool/call`, `tool/result`, …) in an
 * envelope `{ type, seq, time, data }`. There is no entry tree and no separate
 * fork file: a fork COPIES the parent's event prefix into the child and records
 * the cut as a count (`inheritedEventCount` from the host's observation).
 *
 * Two host differences from pi are load-bearing:
 *
 *   - **Turns and steps are real numbers** (`turn/start`, `assistant/message`),
 *     so a tool call is attached by its own `turn`/`step` rather than inferred
 *     from entry order.
 *   - **Injected context arrives as `user/message`.** The same event type
 *     carries the human's prompt (`source.kind === 'user'`) and every snapshot
 *     the harness injects (`time-context`, `agent-instructions`, `skill-catalog`,
 *     `runtime-context`, `tool-jobs`, `compact-checkpoint`, …). Only the human's
 *     kind becomes a card; the rest would dwarf the map. One non-human kind is
 *     the exception: `intercom` — a message another dsh session addressed to
 *     this one (`dsh-intercom`), which IS a turn and carries the caller's
 *     session id.
 *
 * Entry ids are the event `seq`, zero-padded to a fixed width. That is not
 * cosmetic: the canvas resolves a fork's parent card by comparing
 * `sourceEntryId <= sourceSeedLength` as STRINGS (`seedBoundary` in app.js), so
 * lexicographic order has to match numeric order — which only holds while every
 * id has the same width.
 */

/** Fixed width for `seq`-derived ids; 8 digits covers any real log. */
const ID_WIDTH = 8

/** Zero-padded projection id for an event seq. */
export function dshEntryId(seq) {
  return String(seq).padStart(ID_WIDTH, '0')
}

/**
 * Read a DSH event log into normalized projection entries.
 *
 * @param {any[]} events               the session's events, in seq order
 * @param {object} [options]
 * @param {number} [options.inheritedEventCount]
 *   Fork cut, in EVENTS: the child's own log starts at this seq. The inherited
 *   prefix is dropped here — the parent's cards already represent it — and the
 *   id of its last event is returned as `inheritedEntryCount` so the canvas can
 *   still anchor the branch on the parent's card.
 * @param {object|null} [options.contextPressure]
 *   DSH's own occupancy measurement (`{ pressureTokens, contextWindow, claim }`
 *   from the token meter's session projection). Passed through as the card's
 *   ring, because DSH measures its own context and the canvas must show that
 *   number rather than a re-derived one.
 * @returns {{ header: object|null, entries: object[], inheritedEntryCount: number|string, cwd: string|null, filePath: null, model: {provider: string, id: string}|null, contextWindow: number|null, contextUsage: {tokens: number, contextWindow: number, percent: number, estimated: boolean}|null }}
 */
export function projectDshSession(events, options = {}) {
  const inherited = Number.isInteger(options.inheritedEventCount) && options.inheritedEventCount > 0 ? options.inheritedEventCount : 0
  const header = events.find(event => event?.type === 'session') ?? null
  /** @type {{ turnEntryId: string|null, model: {provider: string, id: string}|null, contextWindow: number|null }} */
  const state = {
    /** Id of the user entry that opened the current turn, for `entry.turn`. */
    turnEntryId: null,
    model: null,
    contextWindow: null,
  }
  const entries = []
  let order = 0
  let lastInheritedSeq = -1
  for (const event of events) {
    if (typeof event?.seq !== 'number') continue
    if (event.seq < inherited) {
      lastInheritedSeq = event.seq
      continue
    }
    for (const item of projectDshEvent(event, state)) {
      entries.push({ ...item, order: order++ })
    }
  }
  const contextWindow = state.contextWindow ?? header?.contextWindow ?? null
  return {
    header,
    entries,
    // A string id, not a count: the store and the canvas both compare it against
    // projection entry ids (see the adapter contract). The inherited prefix is
    // already gone from `entries`, so nothing else needs to skip it.
    inheritedEntryCount: lastInheritedSeq >= 0 ? dshEntryId(lastInheritedSeq) : 0,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    // DSH sessions are addressed by id; the store only uses this field to match
    // a child against its parent (the adapter fills the parent id in there).
    filePath: null,
    model: state.model,
    contextWindow,
    contextUsage: contextUsageOf(options.contextPressure, contextWindow),
  }
}

/**
 * Turn DSH's occupancy measurement into the canvas ring.
 *
 * `pressureTokens` is what the harness would send next (its own replay-based
 * meter), so this is the same figure DSH's transcript reports. `claim` present
 * means the provider itself reported the usage for that span; without it the
 * number is derived, which is what the ring's `estimated` flag shows.
 */
export function contextUsageOf(pressure, contextWindow) {
  if (pressure === null || typeof pressure !== 'object') return null
  const window = typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0 ? pressure.contextWindow : contextWindow
  if (typeof window !== 'number' || !(window > 0)) return null
  const tokens = typeof pressure.pressureTokens === 'number' && pressure.pressureTokens > 0
    ? pressure.pressureTokens
    : typeof pressure.surfaceTokens === 'number' ? pressure.surfaceTokens : 0
  return {
    tokens: Math.max(0, Math.round(tokens)),
    contextWindow: window,
    percent: Math.max(0, Math.min(100, tokens / window * 100)),
    estimated: pressure.claim === undefined,
  }
}

/**
 * Map one DSH event to zero or more projection entries.
 *
 * `state` is mutated as the walk advances: it carries the current turn's user
 * entry id (DSH events name their turn by NUMBER, the canvas wants the entry the
 * turn belongs to) and the routed model.
 *
 * @returns {object[]}
 */
export function projectDshEvent(event, state) {
  const data = event?.data
  const at = timeOf(event)
  const id = dshEntryId(event.seq)
  switch (event.type) {
    case 'session/title': {
      const title = typeof data?.title === 'string' ? data.title.trim() : ''
      return title === '' ? [] : [{ id: `${id}:title`, kind: 'title', text: title, at }]
    }
    case 'user/message': {
      const sourceKind = data?.source?.kind
      // A human prompt and an intercom relay are both real turns; every other
      // kind is injected context (see the module header) and never a card.
      if (sourceKind !== 'user' && sourceKind !== 'intercom') return []
      const text = textOf(data.content)
      const imageCount = imageCountOf(data.content)
      // An image-only message carries no prose but IS a turn; the store keeps it
      // alive from the count alone.
      if (text === '' && imageCount === 0) return []
      // The turn anchor is set for a relay too, and that is load-bearing: the
      // canvas groups a turn as "everything after a user entry", so leaving the
      // anchor on the previous human turn would glue this turn's answer to THAT
      // card and overwrite its answer.
      state.turnEntryId = id
      if (sourceKind === 'intercom') {
        // dsh-intercom's relay. `senderSessionId` is the only handle the canvas
        // has on who called, so it rides on the entry as `from`.
        const sender = data?.source?.senderSessionId
        return [{ id, kind: 'call', text, at, from: typeof sender === 'string' && sender !== '' ? sender : null }]
      }
      return [{ id, kind: 'user', text, at, ...(imageCount > 0 ? { imageCount } : {}) }]
    }
    case 'assistant/message': {
      const text = textOf(data?.message?.content)
      const items = []
      if (text !== '') items.push({ id, kind: 'assistant', text, turn: state.turnEntryId, step: numberOrNull(data?.step), at })
      return items
    }
    case 'tool/call': {
      const callId = typeof data?.callId === 'string' ? data.callId : ''
      return [{
        id: `${id}:call`,
        kind: 'tool-call',
        callId,
        name: typeof data?.name === 'string' && data.name !== '' ? data.name : '工具调用',
        arguments: formatArguments(data?.arguments),
        turn: state.turnEntryId,
        step: numberOrNull(data?.step),
        at,
      }]
    }
    case 'tool/result': {
      const message = data?.message
      const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : ''
      const text = textOf(message?.content)
      const imageCount = imageCountOf(message?.content)
      return [{
        id: `${id}:result`,
        kind: 'tool-result',
        callId,
        name: null,
        text,
        error: message?.isError === true ? (text || '工具执行失败') : null,
        ...(imageCount > 0 ? { imageCount } : {}),
        turn: state.turnEntryId,
        step: numberOrNull(data?.step),
        at,
      }]
    }
    case 'todo/write': {
      const todos = Array.isArray(data?.todos) ? data.todos : []
      const text = todos
        .filter(todo => todo !== null && typeof todo === 'object' && typeof todo.content === 'string')
        .map(todo => `[${String(todo.status ?? 'pending')}] ${todo.content}`)
        .join('\n')
      return text.trim() === '' ? [] : [{ id: `${id}:todo`, kind: 'todo', text, at }]
    }
    case 'compaction/summary': {
      const summary = typeof data?.summary === 'string' ? data.summary.trim() : ''
      // The compaction REPLACED the surface before it with this summary; the
      // card records that boundary, and the ring's estimator resets on it.
      return summary === '' ? [] : [{ id: `${id}:compaction`, kind: 'compaction', text: summary, at }]
    }
    case 'turn/end': {
      const reason = data?.reason
      // A failed or cancelled turn is still an answer to its question: without a
      // card the user's message looks permanently unanswered (and the canvas's
      // pending-reply state would never settle).
      if (reason?.kind === 'error') {
        return [{ id: `${id}:error`, kind: 'error', text: errorText(reason.error) ?? '本轮执行失败', turn: state.turnEntryId, step: null, at }]
      }
      if (reason?.kind === 'aborted') {
        return [{ id: `${id}:error`, kind: 'error', text: '本轮已取消', turn: state.turnEntryId, step: null, at }]
      }
      return []
    }
    case 'request/context': {
      // The routed model and the capacity it ran with. DSH records this per
      // message series, so the newest one describes the end of the session.
      if (typeof data?.provider === 'string' && typeof data?.model === 'string') state.model = { provider: data.provider, id: data.model }
      if (typeof data?.contextWindow === 'number' && data.contextWindow > 0) state.contextWindow = data.contextWindow
      return []
    }
    case 'model/selection': {
      if (typeof data?.provider === 'string' && typeof data?.model === 'string') state.model = { provider: data.provider, id: data.model }
      return []
    }
    default:
      // Everything else is bookkeeping (turn/step brackets, request headers,
      // surface replacements, inbox splices) or an out-of-repo plugin event —
      // `session/end-seed` belongs here too: the fork cut it marks is already
      // reported exactly by `inheritedEventCount`.
      return []
  }
}

/** DSH stamps `time` as Unix epoch milliseconds; the projection wants ISO. */
function timeOf(event) {
  return typeof event?.time === 'number' ? new Date(event.time).toISOString() : new Date().toISOString()
}

function numberOrNull(value) {
  return typeof value === 'number' ? value : null
}

/** Visible prose of a DSH content value: text blocks only, in order. */
export function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** How many image blocks a DSH content value carries. */
export function imageCountOf(content) {
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'image') count += 1
  }
  return count
}

/** Pretty-print a tool call's arguments for the card; DSH keeps the raw JSON string. */
function formatArguments(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

/** A readable message out of DSH's structured failure. */
function errorText(value) {
  if (typeof value === 'string') return value.trim() || null
  if (value === null || value === undefined || typeof value !== 'object') return null
  const code = typeof value.code === 'string' && value.code.trim() !== '' ? value.code.trim() : ''
  const message = typeof value.message === 'string' && value.message.trim() !== '' ? value.message.trim() : ''
  if (message !== '') return [code].filter(Boolean).concat(message).join(': ')
  return code || null
}
