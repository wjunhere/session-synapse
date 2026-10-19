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
 *   - **A tool loadout is a scoped effect, not session state.** The harness has
 *     no per-session tool list to set: `tools.restrict()` masks what one
 *     agent scope inherits, and the mask dies with the agent. A /btw side
 *     question therefore pins twice — the restriction while the process lives,
 *     and a read-only permission preset in its own log for everything after a
 *     restart (`pinBtw`).
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
 * What a /btw side question may do unless the user says otherwise.
 *
 * These are HARNESS tool names, not pi's: pi's read-only preset
 * (`READ_ONLY_TOOLS`: read/grep/find/ls) names two tools DSH does not have and
 * misses the two that do the browsing, so the two vocabularies are kept apart
 * rather than shared.
 */
export const BTW_DEFAULT_TOOLS = ['read', 'grep', 'glob', 'web_fetch', 'web_search']

/**
 * The permission preset a /btw side question is put in.
 *
 * It is one of the profile's own presets (`sandbox: read-only`, `approval: ask`
 * in `~/.dsh/profiles/<name>/cordis.patch.yml`), not something this adapter
 * invents: `permissionPresets.set()` refuses a name the deployment does not
 * configure, and the refusal is loud (fail-fast) rather than a silent debase.
 * Unlike the tool restriction this is DURABLE — it appends `permission/preset`,
 * `sandbox/mode` and `approval/policy` to the child's own log.
 */
const READ_ONLY_PRESET = 'read-only'

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
 * The tool loadout a /btw pin will apply.
 *
 * An empty list is refused HERE because the harness accepts it: measured,
 * `tools.restrict({ allow: [] })` returns a disposer and changes nothing, so a
 * side question that asked for no tools would silently keep all of them — the
 * exact opposite of what "pin this session to these tools" means.
 *
 * @param {unknown} tools
 * @returns {string[]} the names, deduplicated, in the caller's order
 */
export function btwToolPin(tools) {
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('侧问至少要给一个工具（空清单等于不限制）')
  const names = []
  for (const tool of tools) {
    if (typeof tool !== 'string' || tool.trim() === '') throw new Error(`工具名必须是字符串：${JSON.stringify(tool)}`)
    if (!names.includes(tool)) names.push(tool)
  }
  return names
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
 * @param {any} [options.tools]            `ctx.tools` (schemas/view/restrict)
 * @param {any} [options.agents]           `ctx.agents` (live agent registry)
 * @param {any} [options.sessions]         `ctx.sessions` (live sessions)
 * @param {any} [options.permissionPresets] `ctx.permissionPresets` (the durable half of a /btw pin)
 * @param {() => {sessionId: string, tools: string[]}[]} [options.btwPins]
 *   The canvas's record of which forked sessions are /btw side questions and
 *   what each was pinned to. Read when an agent appears, to re-apply the pin
 *   the process lost (see `pinBtw`).
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
export function createDshAdapter({ sessionController, sessionQuery, workspaceController = undefined, tools = undefined, agents = undefined, sessions = undefined, permissionPresets = undefined, btwPins = undefined, on, dshHome = undefined, debounceMs = DEFAULT_DEBOUNCE_MS, scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS, includeSubagents = false, capabilities: overrides = {} }) {
  if (typeof on !== 'function') throw new Error('createDshAdapter: on 必须是 cordis 的 ctx.on')

  /**
   * One injected service, or a clear complaint naming what is missing.
   *
   * They are read at the use site rather than checked up front because the
   * adapter is also constructed by unit tests that only exercise the pure
   * helpers; a /btw is the one path that cannot work without them.
   */
  function service(name, value) {
    if (value === undefined || value === null) throw new Error(`dsh adapter 缺少 ${name} 服务（host/dsh 的 inject 应当提供）`)
    return value
  }

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

    /**
     * One agent already pinned in this process.
     *
     * Keyed by the agent OBJECT: the restriction is an effect on the agent's
     * scope, so a disposed-and-resumed session gets a NEW agent that must be
     * pinned again, while the same agent must not be pinned on every event
     * (each call appends another restriction layer).
     */
    const pinnedAgents = new WeakSet()

    /**
     * Re-apply the /btw tool pin of one freshly created agent.
     *
     * `tools.restrict()` is the half of the /btw contract that does NOT
     * survive a restart — it is a scoped effect, not an event in the session
     * log — so the canvas's own record of side questions is replayed here. The
     * agent is announced during its own resume, before any turn can run, which
     * is what makes this the place to do it.
     */
    function pinBtw(agent) {
      if (typeof agent?.id !== 'string' || pinnedAgents.has(agent)) return
      const pin = pins().find(item => item.sessionId === agent.id)
      if (pin === undefined) return
      pinnedAgents.add(agent)
      try {
        agent.ctx.tools.restrict({ allow: pin.tools })
      } catch (error) {
        // This listener runs INSIDE `agent/created`, so throwing would fail the
        // resume it rode in on and lock the user out of that session. A pin
        // naming a tool this harness no longer knows is stale data, not a bug
        // in the resume: report it and let the durable half (the read-only
        // permission preset in the session's own log) stand.
        process.stderr.write(`synapse: 重新钉住 ${agent.id} 的工具失败（${pin.tools.join(', ')}）：${error?.message ?? error}\n`)
      }
    }

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
      on('agent/created', payload => { pinBtw(payload?.agent) }),
    ]
    // Agents that are ALREADY live when this subscriber attaches (a plugin
    // reload, a harness that resumed sessions before us) never announce
    // themselves again, so they are pinned here as well.
    for (const agent of service('agents', agents).list()) pinBtw(agent)
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

  /** The canvas's record of /btw tool pins, or a clear complaint if unwired. */
  function pins() {
    if (typeof btwPins !== 'function') throw new Error('dsh adapter 缺少 btwPins（用于重启后重新钉住侧问的工具）')
    return btwPins()
  }

  /** The live agent of one session — never activates a cold one. */
  function liveAgentFor(sessionId) {
    const registry = service('agents', agents)
    if (typeof sessionId === 'string' && sessionId !== '') return registry.get(sessionId)
    // The canvas may ask before it names a session (its status call). The tools
    // on offer must not come from a /btw child: that plane is pinched on
    // purpose, so it is the one agent whose tools are NOT "available here".
    const sideQuestions = new Set(pins().map(pin => pin.sessionId))
    return registry.list().filter(agent => !sideQuestions.has(agent.id)).at(-1)
  }

  /**
   * The tool vocabulary a /btw side question is expressed in.
   *
   * `visible` is what the harness shows a model in that session.
   * `pinnable` is the subset a pin may NAME: a restriction only masks what a
   * scope INHERITS, so tools registered in the agent's own layer stay whatever
   * the allow list says (measured: pinning read/grep/glob still leaves
   * `subagent`), and naming one of those is refused by the harness. Offering
   * them as choices would be offering a guaranteed failure.
   *
   * Both are empty when no agent is live — this never activates a session just
   * to answer a question about it.
   *
   * @param {string} [sessionId] the session to describe; omitted = any live one
   */
  function btwTools(sessionId = undefined) {
    const defaults = [...BTW_DEFAULT_TOOLS]
    const agent = liveAgentFor(sessionId)
    if (agent === undefined) return { defaults, visible: [], pinnable: [] }
    const registry = service('tools', tools)
    return {
      defaults,
      visible: registry.schemas(agent).map(schema => schema.name).sort(),
      pinnable: [...registry.view(agent).restrictableNames].sort(),
    }
  }

  /**
   * The agent of a session, resolved through the harness's own entry point.
   *
   * This DOES resume a cold session (that is what `resolveAgent` is for) —
   * which is acceptable exactly here, right after a fork we just made, and not
   * in `btwTools()`: describing a session must never activate it.
   *
   * The failure is a value, not a throw: the harness answers `{ error }` for a
   * session it cannot resolve, and that answer is the caller's problem (400),
   * so it is turned into a `HostRequestError` here.
   */
  async function resolveAgentFor(sessionId) {
    const resolved = await hostCall('解析会话', () => sessionController.resolveAgent(sessionId))
    if (resolved?.error !== undefined) throw new HostRequestError(`解析会话失败：${resolved.error?.message ?? String(resolved.error)}`)
    if (resolved?.agent === undefined) throw new Error(`宿主没有为会话 ${sessionId} 返回 agent`)
    return resolved.agent
  }

  /**
   * A /btw side question.
   *
   * No Synapse-invented mechanism, just the harness's own calls in the order
   * they must happen:
   *
   *   1. fork — the only way to inherit REAL history (text injection would need
   *      a model-calling runtime the canvas does not have); `entryId` forks at
   *      that event seq when the caller names one.
   *   2. `tools.restrict` — the side question may look but not touch. It must
   *      land BEFORE the first prompt, and it is a live-scope effect (see
   *      `pinBtw`).
   *   3. `permissionPresets.set` — the durable half: read-only sandbox + ask
   *      approval, written into the CHILD's log, so it survives a restart.
   *
   * There is deliberately NO archive step, unlike pi-web. Measured on dsh
   * 0.2.1-rc.2: archiving a session attaches `ArchivedSessionGate`, which
   * rejects every `agent/pre-step` proposed for it, so a "hidden" side question
   * could never answer anything — the first prompt after the fork came back as
   * `turn/end { kind: 'blocked' }`, with no model request and no error. A side
   * question that cannot be asked is not a side question, so the tradeoff goes
   * the other way here: the child stays in the harness's own session list, and
   * it works. (`sessionController.prompt` does not refuse an archived session
   * either — the turn just ends — which is exactly the silent failure this
   * avoids.)
   *
   * @param {string} sessionId
   * @param {string} [entryId]  canvas entry id (the host event seq)
   * @param {string[]} [tools]  defaults to {@link BTW_DEFAULT_TOOLS}
   * @returns {Promise<{sessionId: string, tools: string[]}>}
   */
  async function btw(sessionId, entryId = undefined, tools = undefined) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('该节点没有关联的会话')
    const pinned = btwToolPin(tools ?? BTW_DEFAULT_TOOLS)
    const forked = await forkSession(sessionId, entryId)
    const agent = await resolveAgentFor(forked)
    try {
      // Names the harness does not know are refused here, with the full list of
      // the ones it does — a diagnostic worth showing to the user as-is.
      agent.ctx.tools.restrict({ allow: pinned })
    } catch (error) {
      throw new HostRequestError(String(error?.message ?? error))
    }
    const session = service('sessions', sessions).get(forked)
    if (session === undefined) throw new Error(`fork 出来的会话 ${forked} 不在活跃会话表里`)
    service('permissionPresets', permissionPresets).set(session, READ_ONLY_PRESET)
    return { sessionId: forked, tools: pinned }
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
    btw,
    btwTools,
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
    // `btw` is live through the SAME channel as the other writes: it needs the
    // harness's own `tools`/`permissionPresets` services, which no page can
    // reach. `setTools` stays off — DSH has no per-session tool loadout to set;
    // the restriction a /btw makes is an effect on one agent scope, not a
    // property of the session, and pretending otherwise would be a lie in the
    // capability table.
    capabilities: () => capabilities({ openSession: true, createSession: true, sendMessage: true, forkSession: true, renameSession: true, archiveSession: true, btw: true, ...overrides }),
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
