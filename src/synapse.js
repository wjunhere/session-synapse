/**
 * The sync engine: host sessions in, canvas state out.
 *
 * It owns the projection lifecycle so adapters stay thin:
 *   - full replay on startup
 *   - incremental append while a session streams
 *   - workspace grouping by cwd
 *   - fork linking through `parentSession`
 */
import { assertAdapter, requireCapability } from './adapters/contract.js'
import { WorkspaceStore } from './store/workspace-store.js'

/**
 * How often to reconcile the canvas against the host's session list.
 *
 * Deletion is only applied when a session is missing from TWO consecutive
 * passes (see `reconcile`), so a card disappears about one interval later.
 */
const RECONCILE_INTERVAL_MS = 5_000

export class Synapse {
  /**
   * @param {object} options
   * @param {import('./adapters/contract.js').SynapseAdapter} options.adapter
   * @param {string} [options.dataFile]
   * @param {boolean} [options.autoProjection]
   * @param {string} [options.projectionWorkspaceTitle]
   * @param {number} [options.reconcileIntervalMs]
   */
  constructor({ adapter, dataFile, autoProjection = true, projectionWorkspaceTitle = '会话', reconcileIntervalMs = RECONCILE_INTERVAL_MS }) {
    assertAdapter(adapter)
    this.adapter = adapter
    this.autoProjection = autoProjection
    this.projectionWorkspaceTitle = projectionWorkspaceTitle
    this.store = new WorkspaceStore(dataFile ?? adapter.defaultDataFile())
    this.sessions = new Map()
    /** Entry counts already projected per session, so appends stay incremental. */
    this.projectedCounts = new Map()
    /**
     * Session ids the host did not list on the previous reconcile pass.
     *
     * A single miss is weak evidence — a directory entry can be unreadable for
     * one pass while the file is being rewritten. A wrong deletion is not
     * recoverable either: the canvas keys card positions by thread id, so a
     * rebuilt thread comes back at a new place with nothing folded.
     */
    this.missingSessionIds = new Set()
    this.reconcileIntervalMs = reconcileIntervalMs
    this.reconcileTimer = null
    this.unsubscribe = null
    this.ready = this.store.ready
  }

  /** Full replay: read every session, then start following changes. */
  async start() {
    await this.store.ready
    if (!this.autoProjection) return this
    const sessions = await this.adapter.listSessions()
    for (const session of sessions) {
      this.sessions.set(session.id, session)
      await this.replay(session)
    }
    this.unsubscribe = this.adapter.subscribe(session => { void this.onChange(session) })
    // Reconciliation is separate from the change watcher because a DELETION is
    // the one event a file watcher cannot report usefully: nothing is left to
    // watch. `unref` keeps it from holding the process open on its own.
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch(error => {
        process.stderr.write(`synapse: 会话对账失败: ${error?.message ?? error}\n`)
      })
    }, this.reconcileIntervalMs)
    this.reconcileTimer.unref?.()
    return this
  }

  /**
   * Stop following the host and persist what is in memory.
   *
   * Returns the flush promise so a caller that is about to move the data file
   * (a test tearing down its temporary directory) can wait for the write it
   * just asked for; the CLI ignores it, as the process ends anyway.
   */
  stop() {
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    if (typeof this.unsubscribe === 'function') this.unsubscribe()
    this.unsubscribe = null
    return this.store.flush()
  }

  /** Project a whole session, replacing any earlier projection of it. */
  async replay(session) {
    try {
      const history = await this.adapter.readHistory(session)
      const merged = { ...session, cwd: history.cwd ?? session.cwd, parentSessionFile: session.parentSessionFile }
      this.sessions.set(session.id, merged)
      await this.store.projectSession(
        {
          id: merged.id,
          cwd: merged.cwd,
          filePath: merged.filePath,
          parentSessionFile: merged.parentSessionFile,
          title: merged.title,
          entries: history.entries,
          inheritedEntryCount: history.inheritedEntryCount,
          contextWindow: history.contextWindow,
          // Hosts that measure their own occupancy report it here; the store
          // uses it verbatim instead of running the pi estimator.
          contextUsage: history.contextUsage,
        },
        // Always a full replay: the inherited-prefix cut is resolved inside
        // `projectSession` from `inheritedEntryCount` itself.
        0,
        this.projectionWorkspaceTitle,
      )
      this.projectedCounts.set(session.id, history.entries.length)
      return history
    } catch (error) {
      process.stderr.write(`synapse: 无法投影会话 ${session.id}: ${error?.message ?? error}\n`)
      return null
    }
  }

  /** Append only the entries a session gained since its last projection. */
  async onChange(session) {
    const previous = this.sessions.get(session.id)
    this.sessions.set(session.id, { ...previous, ...session })
    const history = await this.replay(session)
    if (history !== null) return history
    return null
  }

  async listWorkspaces() {
    return this.store.list()
  }

  async getWorkspace(id) {
    return this.store.get(id)
  }

  async syncSessions() {
    const sessions = await this.adapter.listSessions()
    return this.store.syncSessions(hostSessionRefs(sessions))
  }

  /**
   * Drop the cards of sessions the host no longer has.
   *
   * Projection is append-only, so without this a deleted session keeps a card
   * forever: the card opens a session that is gone, the archive markers
   * accumulate without bound, and the data file only ever grows. The host's own
   * session list is the authority on what exists (`listSessions` enumerates the
   * session directory), because pi-web's ARCHIVE is not a deletion — an
   * archived session keeps its file, so it stays in this list and keeps its
   * card.
   *
   * Two guards keep this from destroying a hand-arranged canvas:
   *   - an empty host list while the canvas still believes in sessions is a
   *     failed directory read, not "the user deleted everything" — skip the
   *     pass outright;
   *   - a session must be missing from two consecutive passes before its card
   *     goes.
   *
   * @returns {Promise<{ removed: string[] }>}
   */
  async reconcile() {
    const sessions = await this.adapter.listSessions()
    const live = new Set(sessions.map(session => session.id))
    const known = this.knownSessionIds()
    if (live.size === 0 && known.size > 0) return { removed: [] }
    const removed = []
    for (const id of known) {
      if (live.has(id)) {
        this.missingSessionIds.delete(id)
        continue
      }
      if (!this.missingSessionIds.has(id)) {
        this.missingSessionIds.add(id)
        continue
      }
      removed.push(id)
    }
    if (removed.length === 0) return { removed }
    for (const id of removed) {
      this.missingSessionIds.delete(id)
      this.sessions.delete(id)
      this.projectedCounts.delete(id)
    }
    await this.store.syncSessions(hostSessionRefs(sessions), removed)
    return { removed }
  }

  /**
   * Every session id the canvas currently believes in.
   *
   * The store is included, not just the in-memory session map: a session can be
   * deleted while this process is not running, leaving its thread in the data
   * file and nothing in `sessions` to reconcile against.
   *
   * @returns {Set<string>}
   */
  knownSessionIds() {
    const ids = new Set(this.sessions.keys())
    for (const id of this.store.state.hiddenSessionIds) ids.add(id)
    for (const workspace of this.store.state.workspaces) {
      for (const thread of workspace.threads) {
        if (typeof thread.sessionId === 'string' && thread.sessionId !== '') ids.add(thread.sessionId)
      }
    }
    return ids
  }

  async createWorkspace(title) {
    return this.store.create(title)
  }

  async createThread(workspaceId, input) {
    return this.store.createThread(workspaceId, input)
  }

  async addMessage(threadId, text) {
    return this.store.addMessage(threadId, text)
  }

  async branch(threadId, input) {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : null
    const { thread: parent, workspace } = this.locateThread(threadId)
    // No caller-supplied session means the HOST must fork for us. A host whose
    // fork only exists in the browser (pi-web's canvas forks itself and passes
    // the new sessionId) cannot serve this request, and answering with a
    // session-less thread instead would create a card that can be neither
    // continued nor opened — a silent dead node. `requireCapability` refuses
    // with 「当前宿主不支持 …」, which routes.js maps to a 400.
    const forkSessionId = sessionId !== null
      ? sessionId
      : await requireCapability(this.adapter, 'forkSession')(parent.sessionId, input?.entryId)
    const thread = await this.store.branch(threadId, {
      title: input?.title ?? (forkSessionId === null ? undefined : `${parent.title} 分支`),
      sessionId: forkSessionId,
      sessionTitle: input?.sessionTitle,
      position: input?.position,
      color: input?.color,
    })
    if (forkSessionId !== null && !this.sessions.has(forkSessionId)) {
      const sessions = await this.adapter.listSessions()
      const created = sessions.find(item => item.id === forkSessionId)
      if (created !== undefined) {
        this.sessions.set(created.id, created)
        await this.replay(created)
      }
    }
    void workspace
    return thread
  }

  locateThread(threadId) {
    for (const workspace of this.store.state.workspaces) {
      const thread = workspace.threads.find(item => item.id === threadId)
      if (thread !== undefined) return { workspace, thread }
    }
    throw new Error('节点不存在')
  }

  async updateThread(threadId, input) {
    return this.store.updateThread(threadId, input)
  }

  async removeThread(threadId) {
    return this.store.removeThread(threadId)
  }

  async reset(sessions) {
    return this.store.clearLegacy(sessions ?? [])
  }

  async sendMessage(sessionId, text, images = []) {
    // `requireCapability` checks the METHOD as well as the declared capability,
    // which is what keeps this from calling an adapter that only advertises the
    // capability (pi-web's canvas posts prompts itself; this process cannot).
    return requireCapability(this.adapter, 'sendMessage')(sessionId, text, images)
  }

  /** A usable session on this cwd, created when there is none. */
  async createSession(cwd) {
    return requireCapability(this.adapter, 'createSession')(cwd)
  }

  async forkSession(sessionId, entryId = undefined) {
    return requireCapability(this.adapter, 'forkSession')(sessionId, entryId)
  }

  async renameSession(sessionId, name) {
    return requireCapability(this.adapter, 'renameSession')(sessionId, name)
  }

  async archiveSession(sessionId, archived) {
    return requireCapability(this.adapter, 'archiveSession')(sessionId, archived)
  }

  async openSession(sessionId) {
    return requireCapability(this.adapter, 'openSession')(sessionId)
  }

  /**
   * Register a thread the BROWSER created.
   *
   * A btw side-question forks a session and pins its tools from the canvas, so
   * the host never observes a Synapse operation to mirror. The canvas reports
   * the finished thread here so it appears as a child card immediately, rather
   * than waiting for the projection rescan to notice the new session file.
   */
  async linkSessionThread(threadId, input) {
    const sessionId = typeof input?.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null
    if (sessionId === null) throw new Error('缺少会话 ID')
    const kind = input?.kind === 'btw' ? 'btw' : 'branch'
    return this.store.branch(threadId, {
      sessionId,
      title: input?.title,
      sessionTitle: input?.sessionTitle,
      kind,
      tools: input?.tools,
    })
  }
}

/**
 * The fields `WorkspaceStore.syncSessions` needs from a host session.
 *
 * A deliberate subset: the store only groups by cwd and prunes emptied
 * workspaces, while the projection (not this list) is what puts content on a
 * card. `blank` is host-specific and pi simply never sets it.
 *
 * @param {import('./adapters/contract.js').HostSession[]} sessions
 */
function hostSessionRefs(sessions) {
  return sessions.map(session => ({
    id: session.id,
    cwd: session.cwd,
    blank: session.blank === true,
  }))
}