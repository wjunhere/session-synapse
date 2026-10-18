/**
 * The DSH adapter: read the harness's own session corpus.
 *
 * Inside DSH this process IS the harness, so nothing is read from disk here:
 * the session controller and the session-query service already answer "which
 * sessions exist" and "what is in one" — for live sessions and for sessions
 * that were never loaded this process. Reading `~/.dsh/sessions/*.jsonl.zstd`
 * directly would mean re-implementing multi-frame Zstandard decoding and the
 * fork/seed semantics that these services already own
 * (`scripts/dsh-session-events.mjs` is the offline reader for everything else).
 *
 * Two host facts shape the code:
 *
 *   - **Sessions are event-sourced, not files.** A fork copies its parent's
 *     event prefix and reports the cut as a COUNT (`inheritedEventCount`); the
 *     projector drops that prefix and reports its last entry id instead.
 *   - **The host measures its own context.** The token meter's
 *     `contextPressure` projection is what DSH's own transcript shows, so it is
 *     passed through as the card's ring rather than re-derived here.
 *   - **The writes are service calls, not HTTP.** This process IS the harness,
 *     so `sessionController.create/rename/fork/prompt` and the workspace
 *     controller's archive are reachable directly — see `writeTransport()`.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { projectDshSession } from '../project/dsh.js'
import { capabilities, HostRequestError } from './contract.js'

/**
 * How long to coalesce a burst of session events before re-projecting.
 *
 * The engine re-reads a whole session on every change (as it does for pi), so a
 * streaming turn would otherwise re-read the log once per committed event.
 * DSH's own canvas coalesced per microtask; a short trailing window is cheaper
 * still and the canvas only needs "the session changed".
 */
const DEFAULT_DEBOUNCE_MS = 200

/**
 * How often to re-list the corpus for sessions another process created or wrote.
 *
 * Matches the engine's own reconcile interval: both are "the host's list is the
 * authority" passes, and the listing is documented as cheap (headers plus
 * projection-cache rows, never a per-session stat or a cold body read).
 */
const DEFAULT_SCAN_INTERVAL_MS = 5_000

/**
 * The image media types the harness's attachment store admits.
 *
 * A closed union in `@deepseek-ai/dsh-attachment`; anything else is refused by
 * the host, so the refusal happens here with the offending type named rather
 * than as an opaque `session/attachment-invalid` from deep inside admission.
 */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * The prompt content parts for one canvas message.
 *
 * Text last, matching the harness's own composer (attachments, then text).
 *
 * @param {string} text
 * @param {{data: string, mimeType: string}[]} [images]
 */
export function promptContent(text, images = []) {
  const parts = []
  for (const image of images) {
    const mediaType = image?.mimeType
    if (!IMAGE_MEDIA_TYPES.includes(mediaType)) throw new Error(`DSH 不接受这种图片类型：${String(mediaType)}`)
    if (typeof image.data !== 'string' || image.data === '') throw new Error('图片数据为空')
    parts.push({ type: 'image', mediaType, data: image.data })
  }
  const trimmed = String(text ?? '')
  if (trimmed.trim() !== '') parts.push({ type: 'text', text: trimmed })
  if (parts.length === 0) throw new Error('消息不能为空')
  return parts
}

/**
 * The fork boundary for a canvas entry id.
 *
 * The canvas speaks projection ids, which for DSH are the event `seq` padded to
 * eight digits (`dshEntryId`), so this is the exact inverse. `atSeq` is an
 * INCLUSIVE event seq in the host's own API, which is also what the canvas
 * means by "branch off this turn": the fork keeps the turn it branches from.
 *
 * @param {string} entryId
 */
export function forkBoundary(entryId) {
  if (typeof entryId !== 'string' || !/^\d+$/.test(entryId)) throw new Error(`分支位置不是 DSH 的事件序号：${String(entryId)}`)
  return Number(entryId)
}

/**
 * Run one host call, turning a host REFUSAL into a caller-facing error.
 *
 * DSH's Remote failures are discriminated by `code`, never by `instanceof` (the
 * class is rebuilt across the Gateway, so two copies can meet in one process).
 * Codes name what was wrong with the REQUEST — `session/not-found`,
 * `session/fork-unavailable`, `workspace/session-active` — so they reach the
 * user as a 400 carrying the harness's own diagnostic. `gateway/internal` is
 * the harness reporting its OWN fault and keeps propagating as a 500.
 *
 * @param {string} action  what the caller was trying to do, for the message
 * @param {() => Promise<any>} run
 */
async function hostCall(action, run) {
  try {
    return await run()
  } catch (error) {
    if (error?.isDSHRemoteError !== true || typeof error.code !== 'string') throw error
    if (error.code === 'gateway/internal') throw error
    throw new HostRequestError(`${action}失败：${error.message}`)
  }
}

/**
 * How the canvas reaches this host's writes: our routes, never its own API.
 *
 * @type {() => import('./contract.js').WriteTransport}
 */
const WRITE_TRANSPORT = () => 'synapse'

/**
 * @param {object} options
 * @param {any} options.sessionController  `ctx.sessionController` (list/inspect/create/rename/fork/prompt)
 * @param {any} options.sessionQuery       `ctx.sessionQuery` (observeSession)
 * @param {any} [options.workspaceController] `ctx.workspaceController` (archive/unarchive)
 * @param {(event: string, listener: (...args: any[]) => void) => () => void} options.on
 *   cordis's `ctx.on`, bound. Passed in rather than reaching for a context so the
 *   adapter stays a plain object with the same shape as the pi one.
 * @param {string} [options.dshHome]          explicit harness home (else $DSH_HOME, else ~/.dsh)
 * @param {number} [options.debounceMs]
 * @param {number} [options.scanIntervalMs]  re-list interval for other processes' sessions
 * @param {boolean} [options.includeSubagents]
 *   Subagent children are the harness's internal delegation sessions: DSH's own
 *   navigation filters them out of the session list, and the canvas groups by
 *   cwd, so showing them would fill the map with internal chatter.
 * @param {object} [options.capabilities]     canvas-side capability overrides
 */
export function createDshAdapter({ sessionController, sessionQuery, workspaceController = undefined, on, dshHome = undefined, debounceMs = DEFAULT_DEBOUNCE_MS, scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS, includeSubagents = false, capabilities: overrides = {} }) {
  if (typeof on !== 'function') throw new Error('createDshAdapter: on 必须是 cordis 的 ctx.on')

  async function listSessions() {
    // `list()` is cold-safe: it never activates an agent, and it carries the
    // projection values (title, contextPressure) that the DSH sidebar shows.
    const { items } = await sessionController.list({}, new AbortController().signal)
    const sessions = []
    for (const item of items) {
      if (includeSubagents !== true && item.origin === 'subagent') continue
      sessions.push({
        id: item.sessionId,
        cwd: typeof item.cwd === 'string' && item.cwd.trim() !== '' ? item.cwd : null,
        title: titleOf(item),
        // DSH addresses sessions by id, so the id IS the identity the store uses
        // to pair a child with its parent (pi uses the file path for this).
        filePath: item.sessionId,
        parentSessionFile: typeof item.parentSessionId === 'string' ? item.parentSessionId : null,
        // The core does not consume this yet (the canvas's live indicator comes
        // over the host bridge); it is reported as the host knows it.
        running: item.running === true,
        blank: item.blank === true,
        modified: new Date(item.updatedAt).toISOString(),
        mtimeMs: item.updatedAt,
      })
    }
    return sessions
  }

  async function readHistory(session) {
    // `projectionMode: 'all'` computes the context-pressure projection in the
    // same observation, so the ring costs no second replay of the log.
    const observation = await sessionQuery.observeSession(session.id, { projectionMode: 'all' })
    try {
      const projected = projectDshSession(observation.events, {
        inheritedEventCount: observation.inheritedEventCount,
        contextPressure: observation.projections?.values?.contextPressure ?? null,
      })
      return { ...projected, cwd: projected.cwd ?? session.cwd }
    } finally {
      observation[Symbol.dispose]()
    }
  }

  function subscribe(onChange) {
    /** Trailing per-session timers, so a burst of events costs one re-read. */
    const timers = new Map()
    const latest = new Map()
    /** Last activity timestamp seen per session, for the out-of-process scan. */
    const seen = new Map()
    let seeded = false

    const schedule = session => {
      if (session === null || typeof session?.id !== 'string') return
      if (includeSubagents !== true && session.header?.origin === 'subagent') return
      latest.set(session.id, session)
      if (timers.has(session.id)) return
      timers.set(session.id, setTimeout(() => {
        timers.delete(session.id)
        const current = latest.get(session.id)
        latest.delete(session.id)
        if (current === undefined) return
        try {
          onChange(hostSessionOf(current))
        } catch (error) {
          process.stderr.write(`synapse: 投影会话 ${current.id} 失败: ${error?.message ?? error}\n`)
        }
      }, debounceMs))
    }

    /**
     * Re-list the corpus on an interval.
     *
     * A session created or appended by ANOTHER process — `dsh headless`, a
     * second harness — is invisible to this process's own `session/event`
     * stream, and DSH publishes no watcher for it (the persistence layer has no
     * change events, and `chokidar` is nowhere in the session stack). The pi
     * adapter needs the same fallback for the same reason: the canvas is not
     * the only writer of the thing it reads. Only rows whose activity timestamp
     * MOVED are re-projected, so a quiet corpus costs one listing per interval
     * and nothing else.
     */
    const scan = async () => {
      let items
      try {
        ({ items } = await sessionController.list({}, new AbortController().signal))
      } catch (error) {
        process.stderr.write(`synapse: 重新列出会话失败: ${error?.message ?? error}\n`)
        return
      }
      for (const item of items) {
        const previous = seen.get(item.sessionId)
        seen.set(item.sessionId, item.updatedAt)
        // The first pass only records what is there: the engine has already
        // replayed every session before it subscribed.
        if (!seeded || previous === item.updatedAt) continue
        if (includeSubagents !== true && item.origin === 'subagent') continue
        try {
          onChange(hostSessionOfSummary(item))
        } catch (error) {
          process.stderr.write(`synapse: 投影会话 ${item.sessionId} 失败: ${error?.message ?? error}\n`)
        }
      }
      seeded = true
    }

    const disposers = [
      on('session/created', session => { schedule(session) }),
      on('session/event', session => { schedule(session) }),
    ]
    void scan()
    const timer = setInterval(() => { void scan() }, scanIntervalMs)
    return () => {
      clearInterval(timer)
      for (const pending of timers.values()) clearTimeout(pending)
      timers.clear()
      latest.clear()
      seen.clear()
      for (const dispose of disposers) dispose()
    }
  }

  /**
   * Send one prompt into a session.
   *
   * `mode: 'queue'` is what the harness's own composer sends when a turn is
   * already running (it appends after the current turn); `steer` would interrupt
   * it, which is not what a canvas message means.
   *
   * The `requestId` is not optional here even though the client-side wrapper
   * defaults it: the host records it on the accepted user message as `rpcId`
   * and deduplicates on it, so a retried request must reuse the identity the
   * caller minted rather than a fresh one.
   */
  async function sendMessage(sessionId, text, images = []) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('该节点没有关联的会话')
    const content = promptContent(text, images)
    await hostCall('发送消息', () => sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, new AbortController().signal))
  }

  /** A usable session on this cwd, created when there is none. */
  async function createSession(cwd) {
    const request = typeof cwd === 'string' && cwd.trim() !== '' ? { cwd } : {}
    const { sessionId } = await hostCall('新建会话', () => sessionController.create(request))
    return sessionId
  }

  /** Fork at an exact event seq (inclusive), or at the latest completed turn. */
  async function forkSession(sessionId, entryId = undefined) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('该节点没有关联的会话')
    const request = entryId === undefined ? { sessionId } : { sessionId, atSeq: forkBoundary(entryId) }
    const { sessionId: forked } = await hostCall('创建分支', () => sessionController.fork(request))
    return forked
  }

  async function renameSession(sessionId, name) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('该节点没有关联的会话')
    const title = String(name ?? '').trim()
    if (title === '') throw new Error('名称不能为空')
    await hostCall('重命名会话', () => sessionController.rename({ sessionId, title }))
  }

  /**
   * The harness's own archive.
   *
   * `stopActivity` is deliberately NOT passed: DSH's own archive command omits
   * it too, so archiving a session that is still running is REFUSED
   * (`workspace/session-active`) rather than silently killing the turn. The
   * refusal reaches the user as an error card, which is the honest outcome —
   * the alternative would stop work the user did not ask to stop.
   */
  async function archiveSession(sessionId, archived) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('该节点没有关联的会话')
    if (workspaceController === undefined) throw new Error('当前宿主不支持 archiveSession（workspaceController 不可用）')
    // A running session is REFUSED by the registry (`workspace/session-active`),
    // which reaches the user as an error card rather than as a killed turn.
    if (archived === true) await hostCall('归档会话', () => workspaceController.archiveSession({ sessionId }))
    else await hostCall('取消归档', () => workspaceController.unarchiveSession({ sessionId }))
  }

  return {
    id: 'dsh',
    defaultDataFile: () => join(resolveDshHome(dshHome), 'session-synapse', 'workspaces.json'),
    listSessions,
    readHistory,
    subscribe,
    sendMessage,
    createSession,
    forkSession,
    renameSession,
    archiveSession,
    // The canvas cannot reach the harness's write services: they are cordis
    // services inside this process, not HTTP routes on an origin the page
    // shares. So the canvas calls `/synapse/api/host/*` and these methods run
    // here instead.
    writeTransport: WRITE_TRANSPORT,
    // What the CANVAS may do against this host.
    //
    // `openSession` is live too, but through the other channel: the client half
    // handles `synapse:open-session` by asking the workspace UI to show that
    // session's conversation, because only the client owns the view.
    //
    // `btw` and `setTools` stay off on purpose. A /btw side question pins the
    // forked session to read-only tools, and DSH has no per-session tool
    // allowlist at all (tool restriction exists only in subagent descriptors
    // and in permission presets). Forking without pinning would be a different
    // feature wearing the same button.
    capabilities: () => capabilities({ openSession: true, createSession: true, sendMessage: true, forkSession: true, renameSession: true, archiveSession: true, ...overrides }),
  }
}

/** The title DSH itself would show, from the list row's projection values. */
function titleOf(item) {
  const title = item?.projections?.values?.title
  return typeof title === 'string' && title.trim() !== '' ? title : null
}

/**
 * The minimal `HostSession` for a live session that just emitted an event.
 *
 * Title and blank state are deliberately absent: the projection's own `title`
 * entry carries the first, and the second only ever prunes a session the user
 * never wrote into (which a session that is emitting events is not).
 */
function hostSessionOf(session) {
  const header = session.header ?? {}
  return {
    id: session.id,
    cwd: typeof header.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd : null,
    title: null,
    filePath: session.id,
    parentSessionFile: typeof header.parentSession === 'string' ? header.parentSession : null,
    running: true,
    blank: false,
  }
}

/**
 * The `HostSession` for one listing row.
 *
 * Used by the out-of-process scan, where there is no live Session object to read
 * a header from — the row is the whole evidence, which is also why it carries
 * the title and blank state (they come free from the list's projections).
 */
function hostSessionOfSummary(item) {
  return {
    id: item.sessionId,
    cwd: typeof item.cwd === 'string' && item.cwd.trim() !== '' ? item.cwd : null,
    title: titleOf(item),
    filePath: item.sessionId,
    parentSessionFile: typeof item.parentSessionId === 'string' ? item.parentSessionId : null,
    running: item.running === true,
    blank: item.blank === true,
    modified: new Date(item.updatedAt).toISOString(),
    mtimeMs: item.updatedAt,
  }
}
