/**
 * The contract between the host-neutral core and a host integration.
 *
 * A host adapter answers three questions: which sessions exist, what is in
 * one session, and what changed since. Everything else (canvas layout,
 * workspace organization, card text) belongs to the core.
 *
 * @typedef {object} HostSession
 * @property {string} id
 * @property {string|null} cwd
 * @property {string|null} title
 * @property {string|null} filePath
 * @property {string|null} parentSessionFile
 * @property {boolean} running
 * @property {boolean} [blank]
 *   The host says this session holds nothing worth showing, so a rescan drops
 *   its cards. Optional because it is host-specific: pi does not set it (a
 *   session a user just created still belongs on the canvas) and the pruning
 *   path in the store simply never fires.
 * @property {string} [modified]  Host-provided display time
 * @property {number} [size]      File size in bytes
 * @property {number} [mtimeMs]   File mtime, used to skip unchanged rescans
 *
 * @typedef {object} SessionHistory
 * @property {object|null} header      Host session header
 * @property {object[]} entries        Normalized projection entries, in order
 * @property {number|string} inheritedEntryCount
 *   The fork cut: 0 when nothing was inherited, else the ID of the last entry
 *   the fork copied from its parent. pi copies the parent branch verbatim
 *   (same ids, same order), so the shared prefix is exactly the inherited
 *   history. An id rather than a count, because the canvas matches it against
 *   projection entry ids — entry ids are 8 hex digits, and comparing one to a
 *   count is false for every id.
 * @property {string|null} cwd
 * @property {{ provider: string, id: string }|null} [model]
 *   The model in effect at the end of the session, read from its last
 *   `model_change` entry.
 * @property {number|null} [contextWindow]
 *   That model's context window, resolved through the model registry. Null when
 *   the model is unknown, in which case the canvas reports no ring.
 * @property {{tokens: number, contextWindow: number, percent: number, estimated: boolean}|null} [contextUsage]
 *   The host's OWN occupancy measurement, when it keeps one. DSH measures the
 *   context it would send next (its token meter), and the canvas must show that
 *   figure rather than an estimate — so when this is present the store uses it
 *   verbatim and never runs the pi estimator. `undefined` (not `null`) means the
 *   host has nothing to say and the estimate applies.
 *
 * @typedef {object} AdapterCapabilities
 *   What the CANVAS may do against this host — not what this process can do.
 *   The browser performs the writes (it shares pi-web's origin), so a
 *   capability can be true while the adapter exposes no matching method; call
 *   `adapter[name]` only through `requireCapability()`.
 * @property {boolean} sendMessage
 * @property {boolean} forkSession
 * @property {boolean} openSession
 * @property {boolean} renameSession
 * @property {boolean} archiveSession
 * @property {boolean} btw          fork + read-only tool pin + archive
 * @property {boolean} setTools     pin a session's tool loadout
 *
 * @typedef {object} SynapseAdapter
 * @property {string} id
 * @property {() => string} defaultDataFile
 * @property {() => Promise<HostSession[]>} listSessions
 * @property {(session: HostSession) => Promise<SessionHistory>} readHistory
 * @property {(onChange: (session: HostSession) => void) => () => void} subscribe
 * @property {() => AdapterCapabilities} capabilities
 * @property {((sessionId: string, text: string) => Promise<void>)} [sendMessage]
 * @property {((sessionId: string, entryId?: string) => Promise<string>)} [forkSession]
 *   `entryId` forks at that entry instead of at the branch's leaf. Optional:
 *   pi-web's file-level fork cannot express it and ignores the argument.
 * @property {((sessionId: string) => Promise<void>)} [openSession]
 * @property {((sessionId: string, name: string) => Promise<void>)} [renameSession]
 * @property {((sessionId: string, archived: boolean) => Promise<void>)} [archiveSession]
 */

/** Capabilities a host may or may not provide; the UI hides what is missing. */
export function capabilities(overrides = {}) {
  return {
    sendMessage: false,
    forkSession: false,
    openSession: false,
    archiveSession: false,
    renameSession: false,
    // A /btw side question needs a fork (for context), a tool pin, and the
    // host's archive call (to keep the main session list clean).
    btw: false,
    setTools: false,
    ...overrides,
  }
}

/**
 * What a /btw side question runs with unless the user says otherwise.
 *
 * This is the host's own read-only preset (`lib/tool-presets.ts`), not a
 * Synapse invention: keeping the two identical means a btw card reports the
 * same loadout pi-web would show for the same session.
 */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls']

/**
 * Resolve a method an adapter may or may not implement.
 *
 * BOTH conditions matter. `capabilities()` answers what the CANVAS may do
 * against the host — for pi-web the browser performs the write through pi-web's
 * own origin — while this function answers what THIS process can call. A guard
 * that checked only the capability sent the call into `undefined` and answered
 * HTTP 500 with `TypeError: this.adapter.forkSession is not a function`.
 *
 * The message starts with 「当前宿主不支持」 on purpose: routes.js maps that exact
 * prefix to a 400, because an unsupported action is the caller's problem rather
 * than a server fault.
 */
export function requireCapability(adapter, name) {
  const caps = adapter.capabilities()
  if (caps[name] !== true || typeof adapter[name] !== 'function') {
    throw new Error(`当前宿主不支持 ${name}（adapter: ${adapter.id}）`)
  }
  return adapter[name].bind(adapter)
}

/** Minimal validation so a broken adapter fails loudly instead of silently. */
export function assertAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object') throw new Error('adapter 必须是对象')
  for (const method of ['listSessions', 'readHistory', 'subscribe', 'capabilities']) {
    if (typeof adapter[method] !== 'function') throw new Error(`adapter 缺少 ${method}()`)
  }
  if (typeof adapter.id !== 'string' || adapter.id === '') throw new Error('adapter.id 必须是非空字符串')
  return adapter
}