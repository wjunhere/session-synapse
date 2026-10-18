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
 */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { projectDshSession } from '../project/dsh.js'
import { capabilities } from './contract.js'

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
 * @param {object} options
 * @param {any} options.sessionController  `ctx.sessionController` (list/inspect)
 * @param {any} options.sessionQuery       `ctx.sessionQuery` (observeSession)
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
export function createDshAdapter({ sessionController, sessionQuery, on, dshHome = undefined, debounceMs = DEFAULT_DEBOUNCE_MS, scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS, includeSubagents = false, capabilities: overrides = {} }) {
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

  return {
    id: 'dsh',
    defaultDataFile: () => join(resolveDshHome(dshHome), 'session-synapse', 'workspaces.json'),
    listSessions,
    readHistory,
    subscribe,
    // What the CANVAS may do against this host. The writes are browser actions
    // (the client half calls the host's own session API), so they are declared
    // here rather than inferred from local methods — see the adapter contract.
    //
    // `openSession` is live: the client half handles `synapse:open-session` by
    // asking the workspace UI to show that session's conversation.
    capabilities: () => capabilities({ openSession: true, ...overrides }),
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
