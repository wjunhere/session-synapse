import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { contextUsage } from '../project/context-usage.js'

const MAX_TITLE_LENGTH = 120
const MAX_NOTE_LENGTH = 4_000
// Projected message text cap: longer replies truncate with a marker pointing
// at the detail view instead of silently cutting mid-sentence.
export const MAX_PROJECTION_LENGTH = 8_000
export const PROJECTION_TRUNCATED_SUFFIX = '\n——…（详情查看全文）'
const TOPIC_COLORS = ['#0f766e', '#2563eb', '#be123c', '#7c3aed', '#b45309']
const LOCK_STALE_MS = 60_000
// Deferred (event-projection) writes coalesce into one save per window, so a
// burst of session events costs a single full-state write instead of one per
// event (dsh-synapse issue #13: per-event saves pinned the main thread at ~90% CPU).
const SAVE_DEBOUNCE_MS = 800

// Continues the upstream numbering (dsh-synapse ended at 4). Reusing 1 would
// collide with the legacy v1 shape — `workspaces[].events`, no `threads` — and
// every restart would re-migrate its own output, duplicating workspaces.
export const STATE_VERSION = 5

export class InputError extends Error {}
export class NotFoundError extends Error {}

/**
 * JSON persistence for the Synapse workspace graph.
 *
 * The store is host-neutral: it only knows about workspaces, threads, and
 * projected messages. Adapters translate host sessions into that vocabulary.
 */
export class WorkspaceStore {
  constructor(dataFile) {
    if (typeof dataFile !== 'string' || dataFile.length === 0) throw new Error('synapse: config.dataFile must be a non-empty path')
    this.dataFile = dataFile
    this.state = undefined
    this.serial = Promise.resolve()
    this.ready = this.load()
    this.lastKnownMtime = null
    this.externalModWarned = false
    this.lockWarned = false
    this.dirty = false
    this.flushTimer = null
  }

  async list() {
    await this.ready
    return this.state.workspaces.map(workspace => this.summary(workspace))
  }

  async get(workspaceId) {
    await this.ready
    return structuredClone(this.workspace(workspaceId))
  }

  async create(title) {
    return this.mutate(() => {
      const now = new Date().toISOString()
      const workspace = { id: randomUUID(), kind: 'manual', cwd: null, title: requiredText(title, MAX_TITLE_LENGTH, 'title'), createdAt: now, updatedAt: now, threads: [] }
      this.state.workspaces.unshift(workspace)
      return this.summary(workspace)
    })
  }

  async createThread(workspaceId, input) {
    return this.mutate(() => {
      const workspace = this.workspace(workspaceId)
      const now = new Date().toISOString()
      const thread = this.thread({
        title: input?.title,
        parentId: input?.parentId,
        sessionId: input?.sessionId,
        sessionTitle: input?.sessionTitle,
        position: input?.position,
        color: input?.color,
        now,
        order: workspace.threads.length,
      })
      if (thread.parentId !== null && !workspace.threads.some(item => item.id === thread.parentId)) throw new InputError('分支来源不存在')
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  async branch(threadId, input) {
    return this.mutate(() => {
      const { workspace, thread: parent } = this.locateThread(threadId)
      const now = new Date().toISOString()
      const sessionId = typeof input?.sessionId === 'string' && input.sessionId.length > 0 ? input.sessionId : null
      // A fork emits session creation while the browser receives its fork
      // response. Either path may win the race, but both must resolve to one node.
      if (sessionId !== null) {
        const existing = workspace.threads.find(item => item.sessionId === sessionId)
        if (existing !== undefined) {
          existing.parentId ??= parent.id
          if (typeof input?.title === 'string' && input.title.trim() !== '') existing.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
          if (typeof input?.sessionTitle === 'string') existing.sessionTitle = input.sessionTitle.slice(0, MAX_TITLE_LENGTH)
          // A thread the canvas just created can win this race against the
          // projection; keep the btw marker and its pinned tool loadout.
          if (input?.kind === 'btw') existing.kind = 'btw'
          if (Array.isArray(input?.tools)) existing.tools = input.tools.slice(0, 64)
          existing.updatedAt = now
          workspace.updatedAt = now
          return structuredClone(existing)
        }
      }
      const siblings = workspace.threads.filter(item => item.parentId === parent.id)
      const thread = this.thread({
        title: input?.title,
        parentId: parent.id,
        sessionId: input?.sessionId,
        sessionTitle: input?.sessionTitle,
        position: input?.position ?? { x: parent.position.x + 420, y: parent.position.y + siblings.length * 248 },
        color: input?.color ?? parent.color,
        now,
        order: workspace.threads.length,
      })
      thread.kind = input?.kind === 'btw' ? 'btw' : 'branch'
      if (Array.isArray(input?.tools)) thread.tools = input.tools.slice(0, 64)
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  /**
   * Every /btw side question the canvas recorded, with the tool loadout it was
   * pinned to.
   *
   * The HOST cannot recover this: a tool restriction is a live effect on one
   * agent scope, not session state, so after a restart the only record of "this
   * forked session is a read-only side question with these tools" is this file.
   * Threads without a loadout are skipped rather than guessed at: pinning
   * nothing would be worse than not pinning at all.
   *
   * @returns {{sessionId: string, tools: string[]}[]}
   */
  btwPins() {
    const pins = []
    for (const workspace of this.state.workspaces) {
      for (const thread of workspace.threads) {
        if (thread.kind !== 'btw' || typeof thread.sessionId !== 'string' || thread.sessionId === '') continue
        if (!Array.isArray(thread.tools) || thread.tools.length === 0) continue
        pins.push({ sessionId: thread.sessionId, tools: [...thread.tools] })
      }
    }
    return pins
  }

  /**
   * Keep only the canvas graph in Synapse; the host remains the source of session truth.
   *
   * `removedSessionIds` are sessions the CALLER has confirmed the host no longer
   * has (see `Synapse.reconcile`): their threads go, a projection workspace that
   * empties out goes, and their archive markers are pruned. The store does not
   * decide this itself — "missing" is a judgement about the host, and how much
   * evidence is enough belongs to the layer that talks to it.
   */
  async syncSessions(sessions, removedSessionIds = []) {
    return this.mutate(() => {
      if (!Array.isArray(sessions)) throw new InputError('sessions 必须是数组')
      if (!Array.isArray(removedSessionIds) || removedSessionIds.some(item => typeof item !== 'string')) throw new InputError('removedSessionIds 必须是字符串数组')
      const blankIds = new Set(sessions.filter(item => item?.blank === true && typeof item.id === 'string').map(item => item.id))
      const removedIds = new Set(removedSessionIds)
      for (const workspace of this.state.workspaces) {
        if (workspace.kind !== 'projection') continue
        workspace.threads = workspace.threads.filter(thread => !blankIds.has(thread.sessionId) && !removedIds.has(thread.sessionId))
      }
      this.state.workspaces = this.state.workspaces.filter(workspace => workspace.kind !== 'projection' || workspace.threads.length > 0)
      // Prune the archive markers of the ids confirmed gone THIS pass, and only
      // those: a hidden id whose session is merely unreadable for one pass must
      // survive, or a temporary read failure would resurrect a card the user
      // deliberately archived.
      if (removedIds.size > 0) this.state.hiddenSessionIds = this.state.hiddenSessionIds.filter(id => !removedIds.has(id))
      for (const item of sessions) {
        if (typeof item?.id !== 'string' || item.id === '' || typeof item.cwd !== 'string' || item.cwd === '') continue
        if (item.blank === true) continue
        // Canvas archiving is persistent UI state. A normal host list refresh
        // must not recreate a session that the user deliberately archived.
        if (this.state.hiddenSessionIds.includes(item.id)) continue
        const workspace = this.projectionWorkspace(item.cwd, '会话')
        const session = {
          id: item.id,
          filePath: typeof item.filePath === 'string' ? item.filePath : null,
          parentSessionFile: typeof item.parentSessionFile === 'string' ? item.parentSessionFile : null,
          title: typeof item.title === 'string' ? item.title : undefined,
          entries: [],
        }
        const thread = this.projectionThread(workspace, session)
        if (typeof item.title === 'string' && item.title.trim() !== '') {
          thread.title = item.title.slice(0, MAX_TITLE_LENGTH)
          thread.sessionTitle = thread.title
        }
      }
      return this.list()
    })
  }

  async addMessage(threadId, text) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const now = new Date().toISOString()
      thread.messages.push({ id: randomUUID(), text: requiredText(text, MAX_NOTE_LENGTH, 'text'), kind: 'user', sourceEntryId: null, at: now })
      thread.updatedAt = now
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  async updateThread(threadId, input) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      if (input?.title !== undefined) thread.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
      if (input?.position !== undefined) thread.position = positionOf(input.position)
      // Visibility is TRI-state: `true` hides the cards, `false` pins them
      // visible (an old session the user wants on the canvas), and clearing the
      // field hands the decision back to the canvas's own default (the
      // recent-activity window). A boolean alone could not express the third
      // state, so a user who brought an old session back would have it
      // disappear again on the next render.
      if (input?.hidden !== undefined) {
        if (input.hidden === null) delete thread.hidden
        else if (typeof input.hidden !== 'boolean') throw new InputError('hidden 必须是布尔值或 null')
        else thread.hidden = input.hidden
      }
      thread.updatedAt = new Date().toISOString()
      workspace.updatedAt = thread.updatedAt
      return structuredClone(thread)
    })
  }

  async removeThread(threadId) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const removal = new Set([thread.id])
      for (let changed = true; changed;) {
        changed = false
        for (const item of workspace.threads) {
          if (item.parentId !== null && removal.has(item.parentId) && !removal.has(item.id)) { removal.add(item.id); changed = true }
        }
      }
      for (const item of workspace.threads) {
        if (removal.has(item.id) && item.sessionId !== null && !this.state.hiddenSessionIds.includes(item.sessionId)) this.state.hiddenSessionIds.push(item.sessionId)
      }
      workspace.threads = workspace.threads.filter(item => !removal.has(item.id))
      workspace.updatedAt = new Date().toISOString()
      if (workspace.threads.length === 0) this.state.workspaces = this.state.workspaces.filter(item => item.id !== workspace.id)
      return { removed: removal.size }
    })
  }

  async clearLegacy(sessions) {
    return this.mutate(() => {
      const hidden = new Set(this.state.hiddenSessionIds)
      for (const workspace of this.state.workspaces) for (const thread of workspace.threads) if (thread.sessionId !== null) hidden.add(thread.sessionId)
      for (const session of sessions) hidden.add(session.id)
      this.state.hiddenSessionIds = [...hidden]
      this.state.workspaces = []
      return { cleared: true }
    })
  }

  /**
   * Replay one host session into its projection workspace.
   *
   * `entries` is the adapter's normalized, already-active-branch sequence.
   * `replayFrom` skips a fork's inherited prefix: a forked session inherits its
   * parent's history, which the canvas already represents through the parent
   * node, so only the child's own tail is projected.
   */
  async projectSession(session, replayFrom = 0, workspaceTitle = '会话') {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.projectionWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.projectionThread(workspace, session)
      // A fork COPIES its parent's branch into its own file (same entry ids, in
      // order) and only then appends its own turns. Projecting the whole file
      // made the child re-render the parent's entire conversation as its own
      // turns — a fork of a 13-turn session showed the same 13 questions twice,
      // once per card chain, which is what made 「分支」 look like a duplicate
      // rather than a branch. The inherited prefix is skipped: the parent's
      // cards already represent it.
      const inheritedThrough = inheritedPrefixEnd(session, replayFrom)
      for (const entry of session.entries) {
        if (entry.order < replayFrom || entry.order <= inheritedThrough) continue
        this.projectEntryInto(workspace, thread, entry)
      }
      // Context usage is recomputed from the whole entry list after a full
      // replay; an append leaves it to `projectEntries`.
      //
      // A host that measures its own context (DSH's token meter) hands the
      // figure over, and it wins: the estimator below is the pi path's answer to
      // the same question, so running it here would replace a real measurement
      // with an estimate.
      if (session.contextUsage !== undefined) thread.contextUsage = session.contextUsage
      else this.refreshContextUsage(thread, session.entries, session.contextWindow)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project one committed host entry. Repeated entry ids are ignored. */
  async projectEntry(session, entry, workspaceTitle = '会话') {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.projectionWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.projectionThread(workspace, session)
      this.projectEntryInto(workspace, thread, entry)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project a batch of committed entries for one session in a single write. */
  async projectEntries(session, entries, workspaceTitle = '会话') {
    if (entries.length === 0) return null
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.projectionWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.projectionThread(workspace, session)
      for (const entry of entries) this.projectEntryInto(workspace, thread, entry)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /**
   * Recompute the card's context-window figure.
   *
   * The projected entries are the source, not the raw session: a usage record
   * is only meaningful together with the conversation it belongs to, and the
   * projection is already the active branch with tool output folded in.
   */
  refreshContextUsage(thread, entries, contextWindow) {
    // `null`, not a deleted key: the thread shape declares this field, and the
    // canvas distinguishes "no window known" from "not computed yet".
    thread.contextUsage = contextUsage({ entries: entries ?? [], contextWindow })
  }

  async load() {
    await mkdir(dirname(this.dataFile), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, 'utf8'))
      const { state, migrated } = normalizeState(parsed)
      this.state = state
      if (migrated) await this.save()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`synapse: cannot read ${this.dataFile}: ${error.message}`)
      this.state = { version: STATE_VERSION, hiddenSessionIds: [], workspaces: [] }
      await this.save()
    }
  }

  async mutate(action, { deferred = false } = {}) {
    await this.ready
    const task = this.serial.then(async () => {
      const result = action()
      if (deferred) this.markDirty()
      else await this.save()
      return result
    })
    this.serial = task.catch(() => undefined)
    return task
  }

  /** Mark the state dirty and schedule one trailing flush for the window. */
  markDirty() {
    this.dirty = true
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      // A failed save MUST NOT be swallowed silently: an unhandled rejection
      // terminates Node without printing anything, so the process vanished
      // mid-write and left a `.tmp` behind with no explanation (a full disk is
      // enough to do it). Report it and keep serving — the in-memory state is
      // still valid, and the next flush retries.
      void this.flush().catch(error => {
        process.stderr.write(`synapse: 写入 ${this.dataFile} 失败: ${error?.message ?? error}\n`)
      })
    }, SAVE_DEBOUNCE_MS)
  }

  /** Persist the current state when dirty, ordered after in-flight mutations. */
  flush() {
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    const task = this.serial.then(() => this.save())
    this.serial = task.catch(() => undefined)
    return task
  }

  async save() {
    // Two server instances sharing one profile clobber each other's canvas
    // state. Warn loudly instead of silently losing work; a live lock held by
    // another process or a file mtime that moved since our last write both
    // indicate a second writer.
    const before = await this.fileMtime()
    if (this.lastKnownMtime !== null && before !== null && before !== this.lastKnownMtime) {
      this.lastKnownMtime = before
      if (!this.externalModWarned) {
        this.externalModWarned = true
        process.stderr.write('synapse: workspaces.json 已被另一个实例修改，本实例的写入可能覆盖其更改——请只运行一个实例\n')
      }
    }
    await this.acquireLock()
    try {
      const temporaryFile = `${this.dataFile}.${process.pid}.tmp`
      await writeFile(temporaryFile, `${JSON.stringify(this.state)}\n`, 'utf8')
      await rename(temporaryFile, this.dataFile)
      this.lastKnownMtime = (await stat(this.dataFile)).mtimeMs
    } finally {
      await this.releaseLock()
    }
  }

  async fileMtime() {
    try { return (await stat(this.dataFile)).mtimeMs } catch { return null }
  }

  /** Take an exclusive cross-process lock, breaking a stale one; warn when a live process holds it. */
  async acquireLock() {
    const lockFile = `${this.dataFile}.lock`
    if (await this.tryAcquire(lockFile)) return
    if (await this.lockIsStale(lockFile)) {
      await unlink(lockFile).catch(() => {})
      if (await this.tryAcquire(lockFile)) return
    }
    if (!this.lockWarned) {
      this.lockWarned = true
      process.stderr.write('synapse: 另一个实例正在写入 workspaces.json——请只运行一个实例，否则画布数据可能互相覆盖\n')
    }
  }

  async tryAcquire(lockFile) {
    try {
      await writeFile(lockFile, `${process.pid}\n`, { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }

  /** A lock is stale when its owner PID is gone or the lock file is older than the stale window. */
  async lockIsStale(lockFile) {
    try {
      const [content, stats] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)])
      const tooOld = Date.now() - stats.mtimeMs > LOCK_STALE_MS
      const pid = Number.parseInt(content, 10)
      if (!Number.isInteger(pid)) return tooOld
      if (pid === process.pid) return false
      try {
        process.kill(pid, 0)
        return tooOld
      } catch {
        return true
      }
    } catch {
      return false
    }
  }

  async releaseLock() {
    await unlink(`${this.dataFile}.lock`).catch(() => {})
  }

  workspace(workspaceId) {
    const workspace = this.state.workspaces.find(item => item.id === workspaceId)
    if (workspace === undefined) throw new NotFoundError('工作空间不存在')
    return workspace
  }

  locateThread(threadId) {
    for (const workspace of this.state.workspaces) {
      const thread = workspace.threads.find(item => item.id === threadId)
      if (thread !== undefined) return { workspace, thread }
    }
    throw new NotFoundError('节点不存在')
  }

  projectionWorkspace(cwd, fallbackTitle) {
    let workspace = this.state.workspaces.find(item => item.kind === 'projection' && item.cwd === cwd)
    if (workspace !== undefined) return workspace
    const now = new Date().toISOString()
    workspace = { id: randomUUID(), kind: 'projection', cwd, title: workspaceTitle(cwd, fallbackTitle), createdAt: now, updatedAt: now, threads: [] }
    this.state.workspaces.unshift(workspace)
    return workspace
  }

  projectionThread(workspace, session) {
    let thread = workspace.threads.find(item => item.sessionId === session.id)
    if (thread !== undefined) {
      if (typeof session.title === 'string' && session.title.trim() !== '') {
        const title = session.title.slice(0, MAX_TITLE_LENGTH)
        thread.title = title
        thread.sessionTitle = title
      }
      if (typeof session.filePath === 'string' && session.filePath !== '') thread.sessionFile = session.filePath
      // `inheritedEntryCount` is the durable fork cut: the ID of the last entry
      // the child copied from its parent, already represented by the parent's
      // cards. A string id, not a count — see the adapter contract.
      const seed = session.inheritedEntryCount
      if (typeof seed === 'string' && seed !== '') thread.sourceSeedLength = seed
      return thread
    }
    const parentSessionFile = typeof session.parentSessionFile === 'string' && session.parentSessionFile !== '' ? session.parentSessionFile : null
    const parent = parentSessionFile === null ? undefined : workspace.threads.find(item => item.sessionFile === parentSessionFile)
    const now = new Date().toISOString()
    thread = {
      id: randomUUID(),
      title: typeof session.title === 'string' && session.title.trim() !== '' ? session.title.slice(0, MAX_TITLE_LENGTH) : (parent === undefined ? '会话' : `${parent.title} 分支`),
      parentId: parent?.id ?? null,
      sourceParentSessionFile: parentSessionFile,
      sourceSeedLength: typeof session.inheritedEntryCount === 'string' && session.inheritedEntryCount !== '' ? session.inheritedEntryCount : null,
      sessionId: session.id,
      sessionTitle: typeof session.title === 'string' ? session.title.slice(0, MAX_TITLE_LENGTH) : null,
      sessionFile: typeof session.filePath === 'string' ? session.filePath : null,
      tools: null,
      contextUsage: null,
      color: TOPIC_COLORS[workspace.threads.length % TOPIC_COLORS.length],
      // The projection stores only a neutral semantic anchor. The visual map
      // lays out visible cards from the current conversation graph each render,
      // so old/archived session counts must never leak into future coordinates.
      position: parent === undefined ? { x: 86, y: 82 } : { x: parent.position.x + 400, y: parent.position.y },
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
    workspace.threads.push(thread)
    // A child may arrive before its parent during startup replay. Repair that
    // relation when the missing parent later reaches the projection.
    for (const child of workspace.threads) {
      if (child.sourceParentSessionFile === session.filePath && child.parentId === null) child.parentId = thread.id
    }
    workspace.updatedAt = now
    return thread
  }

  /**
   * Fold one normalized entry into the thread.
   *
   * The adapter hands over `{ kind, ... }` values so this method never has to
   * know a host's entry vocabulary:
   *   - `title`       → thread title
   *   - `tool-call`   → fold into the assistant message's process list
   *   - `tool-result` → pair with its call by `callId`
   *   - `user` / `assistant` / `todo` / `error` → a canvas message
   */
  projectEntryInto(workspace, thread, entry) {
    const at = typeof entry.at === 'string' ? entry.at : new Date().toISOString()
    if (process.env.SYNAPSE_TRACE) process.stderr.write(`synapse trace: ${thread.id} ${JSON.stringify(entry.kind)} img=${JSON.stringify(entry.imageCount)} text=${JSON.stringify((entry.text ?? '').slice(0, 12))}\n`)
    if (entry.kind === 'title') {
      if (typeof entry.text === 'string' && entry.text.trim() !== '') {
        thread.title = entry.text.slice(0, MAX_TITLE_LENGTH)
        thread.sessionTitle = thread.title
        thread.updatedAt = at
        workspace.updatedAt = at
      }
      return
    }
    if (entry.kind === 'tool-selection') {
      // pi-web pins the loadout per session; `null` means it follows settings.
      thread.tools = Array.isArray(entry.tools) ? entry.tools.slice(0, 64) : null
      thread.updatedAt = at
      return
    }
    if (entry.kind === 'tool-call' || entry.kind === 'tool-result') {
      this.foldToolProcess(thread, entry)
      workspace.updatedAt = thread.updatedAt
      return
    }
    // A round that produced neither prose nor a tool call: it carries no card
    // text at all. It exists in the ENTRY stream only, so the context estimator
    // can anchor on its usage and count its reasoning. It never becomes a
    // persisted message, or the detail view would show an empty row.
    if (entry.kind === 'usage') return
    // Same contract for a context edit: the estimator needs to see that the
    // context was rewritten, but there is nothing to show on a card.
    if (entry.kind === 'context-edit') return
    const projection = messageProjection(entry.kind, entry.text, entry.imageCount)
    if (projection === null || thread.messages.some(message => message.sourceEntryId === entry.id)) return
    const message = {
      id: randomUUID(),
      text: projection.text,
      kind: projection.kind,
      sourceEntryId: entry.id,
      at,
      // How many images the message carried. pi records images as content
      // blocks, and the canvas only needs the COUNT: it renders `[图片]`
      // markers for display, and the token accounting rides on the projection
      // entries (`usageChars`), which the estimator reads directly.
      ...(Number.isInteger(entry.imageCount) && entry.imageCount > 0 ? { imageCount: entry.imageCount } : {}),
      ...(projection.kind === 'assistant' || projection.kind === 'error'
        ? { turn: entry.turn, step: entry.step, process: [] }
        : {}),
    }
    this.attachPendingProcess(thread, message)
    thread.messages.push(message)
    thread.updatedAt = at
    workspace.updatedAt = at
    if (thread.sessionTitle === null && projection.kind === 'user') {
      thread.title = titleFromText(projection.text === '' ? imageTitle(entry.imageCount) : projection.text)
      thread.sessionTitle = thread.title
    }
  }

  /**
   * Fold one tool call or result into the assistant message of its own turn,
   * keyed by `callId`, so a tool invocation never becomes a separate canvas
   * card.
   *
   * pi has no turn/step numbers: a turn is the run of entries between two user
   * messages, and its assistant entries can be several (one per tool round),
   * often with no prose at all. A call therefore attaches to the most recent
   * assistant/error message of the current turn, and while that message has not
   * arrived yet it waits in `pendingProcess` — the next assistant message
   * claims it, which is exactly the round that made the call.
   *
   * IDEMPOTENCE: the lookup for an existing call is over the WHOLE thread, not
   * just the fold target. Projection re-reads and re-folds a thread on every
   * rescan (and the host re-emits entries while a session streams), so a
   * target-local lookup would miss the entry it created last time and append
   * another copy. Real data reached 104 copies of one call and an 86.9%
   * duplicate rate before this was fixed; a re-fold must always be a no-op.
   */
  foldToolProcess(thread, entry) {
    const at = typeof entry.at === 'string' ? entry.at : new Date().toISOString()
    const callId = String(entry.callId ?? '')
    // Look in every message's process list first, then the pending queue. An
    // empty callId cannot be matched, so those always fall through to the fold
    // target (hosts without call ids attach each attempt as its own entry).
    let found = callId === '' ? undefined : findProcessEntry(thread, callId)
    let process
    if (found !== undefined) {
      process = found.process
      found = found.entry
    } else {
      const target = [...thread.messages].reverse().find(message => message.kind === 'assistant' || message.kind === 'error')
      process = target === undefined ? (thread.pendingProcess ??= []) : (target.process ??= [])
    }
    if (entry.kind === 'tool-call') {
      if (found === undefined) {
        process.push({ callId, name: entry.name, arguments: entry.arguments, result: null, error: null })
      } else {
        found.name = entry.name
        found.arguments = entry.arguments
      }
    } else {
      if (found === undefined) {
        process.push({ callId, name: entry.name ?? '工具调用', arguments: null, result: entry.text ?? null, error: entry.error ?? null, imageChars: entry.usageChars ?? 0 })
      } else {
        found.result = entry.text ?? null
        found.error = entry.error ?? null
      }
    }
    thread.updatedAt = at
  }

  /**
   * Hand the turn's waiting tool calls to the assistant message that just
   * arrived. Called for every projected assistant/error message.
   */
  attachPendingProcess(thread, message) {
    if (!Array.isArray(thread.pendingProcess) || thread.pendingProcess.length === 0 || !Array.isArray(message.process)) return
    message.process.push(...thread.pendingProcess)
    thread.pendingProcess = []
  }

  thread({ title, parentId, sessionId, sessionTitle, position, color, now, order }) {
    return {
      id: randomUUID(),
      title: requiredText(title, MAX_TITLE_LENGTH, 'title'),
      parentId: typeof parentId === 'string' && parentId.length > 0 ? parentId : null,
      sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
      sessionTitle: typeof sessionTitle === 'string' ? sessionTitle.slice(0, MAX_TITLE_LENGTH) : null,
      sessionFile: null,
      // `kind` distinguishes a plain fork from a /btw side question, which the
      // canvas renders as a collapsed widget hanging off its parent card.
      kind: 'branch',
      tools: null,
      contextUsage: null,
      color: TOPIC_COLORS.includes(color) ? color : TOPIC_COLORS[order % TOPIC_COLORS.length],
      position: positionOf(position ?? { x: 86 + (order % 3) * 410, y: 82 + Math.floor(order / 3) * 260 }),
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
  }

  summary(workspace) {
    // `sessionIds` is how a consumer answers "which workspace holds this session?"
    // without loading every workspace — the canvas needs exactly that to follow
    // the host's current session across directories. Manual threads have no
    // session, so they contribute nothing.
    //
    // `threadsUpdatedAt` is the newest thread-level change, which is not the
    // same as `updatedAt`: a tool-selection entry moves a thread's own stamp
    // without touching the workspace's. A consumer that skips work when a
    // workspace "has not changed" needs both, or a pinned tool set would never
    // reach the canvas until some message happened to arrive.
    return {
      id: workspace.id,
      kind: workspace.kind ?? 'manual',
      cwd: workspace.cwd ?? null,
      title: workspace.title,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      threadsUpdatedAt: workspace.threads.reduce((newest, thread) => (typeof thread.updatedAt === 'string' && thread.updatedAt > newest ? thread.updatedAt : newest), ''),
      threadCount: workspace.threads.length,
      sessionIds: workspace.threads.flatMap(thread => (typeof thread.sessionId === 'string' ? [thread.sessionId] : [])),
    }
  }
}

export function normalizeState(value) {
  let migrated = false
  let state
  if (value?.version === STATE_VERSION && Array.isArray(value.workspaces)) {
    // Already current: adopt it as-is so a restart never rewrites its own data —
    // but still drop transient messages, which can linger from an earlier run
    // because projection merges into a thread instead of rebuilding it.
    const hiddenSessionIds = Array.isArray(value.hiddenSessionIds) ? value.hiddenSessionIds.filter(item => typeof item === 'string') : []
    state = { ...value, version: STATE_VERSION, hiddenSessionIds }
    return { state, migrated: dropTransientMessages(state.workspaces) }
  }
  if ((value?.version === 2 || value?.version === 3 || value?.version === 4) && Array.isArray(value.workspaces)) {
    const hiddenSessionIds = Array.isArray(value.hiddenSessionIds) ? value.hiddenSessionIds.filter(item => typeof item === 'string') : []
    migrated = true
    const workspaces = value.workspaces.map(workspace => ({
      ...workspace,
      kind: workspace.kind === 'dsh' ? 'projection' : (workspace.kind ?? 'manual'),
      threads: Array.isArray(workspace.threads) ? workspace.threads.map(thread => {
        const renamed = renameThreadFields(thread)
        if (Array.isArray(renamed.messages)) {
          const messages = renamed.messages.filter(message => !isRuntimeContextMessage(message))
          if (messages.length !== renamed.messages.length) migrated = true
          return { ...renamed, messages }
        }
        const notes = Array.isArray(renamed.notes) ? renamed.notes : []
        const { notes: _notes, ...rest } = renamed
        return { ...rest, messages: notes, pendingProcess: [] }
      }) : [],
    }))
    state = { version: STATE_VERSION, hiddenSessionIds, workspaces }
  } else if (value?.version === 1 && Array.isArray(value.workspaces)) {
    const now = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
    state = {
      version: STATE_VERSION,
      hiddenSessionIds: [],
      workspaces: value.workspaces.map((workspace, index) => {
        const events = Array.isArray(workspace.events) ? workspace.events : []
        const workspaceNow = typeof workspace.updatedAt === 'string' ? workspace.updatedAt : now
        return {
          id: typeof workspace.id === 'string' ? workspace.id : randomUUID(),
          kind: 'manual',
          cwd: null,
          title: typeof workspace.title === 'string' && workspace.title.trim() ? workspace.title : '未命名工作空间',
          createdAt: typeof workspace.createdAt === 'string' ? workspace.createdAt : workspaceNow,
          updatedAt: workspaceNow,
          threads: events.length === 0 ? [] : [{
            id: randomUUID(), title: workspace.title || '历史记录', parentId: null, sessionId: null, sessionTitle: null,
            color: TOPIC_COLORS[index % TOPIC_COLORS.length], position: { x: 86, y: 82 }, createdAt: workspaceNow, updatedAt: workspaceNow,
            messages: events.map(event => ({ id: typeof event.id === 'string' ? event.id : randomUUID(), text: String(event.text ?? ''), kind: 'user', sourceEntryId: null, at: typeof event.at === 'string' ? event.at : workspaceNow })),
          }],
        }
      }),
    }
    migrated = true
  } else {
    throw new Error('expected Synapse data version 1, 2, 3, 4, or 5')
  }
  if (foldLegacyToolCards(state.workspaces)) migrated = true
  if (dropTransientMessages(state.workspaces)) migrated = true
  return { state, migrated }
}

/**
 * Drop messages that were only ever estimand inputs, never conversation.
 *
 * `usage` entries exist so the context estimator can anchor on a round that
 * produced no prose, but they must not be persisted: the projection MERGES
 * into an existing thread rather than rebuilding it, so anything written stays
 * forever and renders as a blank row in the detail view.
 */
export function dropTransientMessages(workspaces) {
  let changed = false
  for (const workspace of workspaces ?? []) {
    for (const thread of workspace.threads ?? []) {
      if (!Array.isArray(thread.messages)) continue
      const kept = thread.messages.filter(message => message.kind !== 'usage')
      if (kept.length !== thread.messages.length) {
        thread.messages = kept
        changed = true
      }
    }
  }
  return changed
}

/**
 * The `order` of the last entry a fork inherited from its parent, or -1.
 *
 * `session.inheritedEntryCount` carries the boundary entry's ID (see the
 * adapter contract). It is matched against the projection entry ids rather
 * than against `order`, because the same pi entry projects into several
 * entries (`assistant` + `tool-call` + `usage`) that share the source id — the
 * LAST of those is still inherited, so every entry whose source id matches must
 * be skipped, not just the first.
 */
function inheritedPrefixEnd(session, replayFrom) {
  const boundary = session.inheritedEntryCount
  if (typeof boundary !== 'string' || boundary === '') return -1
  let end = -1
  for (const entry of session.entries) {
    if (entry.order < replayFrom) continue
    const sourceId = typeof entry.turn === 'string' && entry.turn !== '' ? entry.turn : entry.id
    // Projection ids are `<sourceId>` or `<sourceId>:<suffix>`, so the source
    // entry is the part before the first colon.
    const base = typeof sourceId === 'string' ? sourceId.split(':')[0] : ''
    if (base !== boundary) continue
    end = entry.order
  }
  return end
}

/** Map the upstream dsh-synapse field names onto the host-neutral ones. */
function renameThreadFields(thread) {
  const {
    dshSessionId, dshSessionTitle, sourceParentSessionId, sourceSeedLength,
    ...rest
  } = thread
  return {
    ...rest,
    sessionId: thread.sessionId ?? dshSessionId ?? null,
    sessionTitle: thread.sessionTitle ?? dshSessionTitle ?? null,
    sessionFile: thread.sessionFile ?? null,
    sourceParentSessionFile: thread.sourceParentSessionFile ?? sourceParentSessionId ?? null,
    sourceSeedLength: thread.sourceSeedLength ?? sourceSeedLength ?? null,
  }
}

/**
 * Fold legacy standalone tool cards (kinds `tool` / `tool-result`) into the
 * preceding assistant message's `process` list, pairing each call with the
 * result that follows it in order, so every tool invocation lives in one
 * home: the assistant turn card.
 */
export function foldLegacyToolCards(workspaces) {
  let changed = false
  for (const workspace of workspaces) {
    for (const thread of workspace.threads ?? []) {
      if (!Array.isArray(thread.messages)) continue
      const folded = []
      let assistant = null
      let pending = []
      for (const message of thread.messages) {
        if (message.kind === 'assistant') {
          assistant = message
          assistant.process ??= []
          pending = []
          folded.push(message)
          continue
        }
        if (message.kind !== 'tool' && message.kind !== 'tool-result') {
          folded.push(message)
          continue
        }
        if (assistant === null) {
          folded.push(message)
          continue
        }
        changed = true
        if (message.kind === 'tool') {
          const [name = '工具调用', ...argumentLines] = String(message.text ?? '').split('\n')
          const entry = { callId: `legacy-${assistant.process.length}`, name, arguments: argumentLines.join('\n'), result: null, error: null }
          pending.push(entry)
          assistant.process.push(entry)
        } else {
          const entry = pending.shift() ?? (() => {
            const orphan = { callId: `legacy-orphan-${assistant.process.length}`, name: '工具调用', arguments: null, result: null, error: null }
            assistant.process.push(orphan)
            return orphan
          })()
          entry.result = message.text
        }
      }
      thread.messages = folded
    }
  }
  return changed
}

/**
 * Find a process entry by callId anywhere in a thread.
 *
 * Returns the entry together with the list holding it, so the caller can also
 * APPEND to that list when the call is new but belongs to an earlier message.
 */
function findProcessEntry(thread, callId) {
  for (const message of thread.messages ?? []) {
    const entry = (message.process ?? []).find(item => item.callId === callId)
    if (entry !== undefined) return { entry, process: message.process }
  }
  const pending = (thread.pendingProcess ?? []).find(item => item.callId === callId)
  if (pending !== undefined) return { entry: pending, process: thread.pendingProcess }
  return undefined
}

function positionOf(value) {
  const x = Number(value?.x)
  const y = Number(value?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new InputError('position 必须包含有效坐标')
  return { x: Math.round(Math.max(-2000, Math.min(5000, x))), y: Math.round(Math.max(-2000, Math.min(5000, y))) }
}

function requiredText(value, maxLength, field) {
  if (typeof value !== 'string') throw new InputError(`${field} 必须是文本`)
  const text = value.trim()
  if (text.length === 0) throw new InputError(`${field} 不能为空`)
  if (text.length > maxLength) throw new InputError(`${field} 超过长度限制`)
  return text
}

export function noteProjection(kind, text) {
  const normalized = typeof text === 'string' ? text.trim() : ''
  if (normalized === '') return null
  if (normalized.length <= MAX_PROJECTION_LENGTH) return { kind, text: normalized }
  return { kind, text: `${normalized.slice(0, MAX_PROJECTION_LENGTH)}${PROJECTION_TRUNCATED_SUFFIX}` }
}

/**
 * The transcript of one projected entry, or `null` when there is nothing to show.
 *
 * An image-only message has no words but IS a turn, so its count keeps it
 * alive — dropping it here would make a pasted screenshot an invisible card.
 */
export function messageProjection(kind, text, imageCount = 0) {
  const projection = noteProjection(kind, text)
  if (projection !== null) return projection
  if (Number.isInteger(imageCount) && imageCount > 0) return { kind, text: '' }
  return null
}

export function isRuntimeContextText(text) {
  return typeof text === 'string' && text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
}

function isRuntimeContextMessage(message) {
  return message?.kind === 'user' && isRuntimeContextText(message.text)
}

export function titleFromText(text) {
  const line = String(text ?? '').replaceAll(/\s+/g, ' ').trim()
  return (line.length > 42 ? `${line.slice(0, 42)}...` : line) || '会话'
}

/** A name for a message that carried no words, only images. */
function imageTitle(imageCount) {
  const count = Number.isInteger(imageCount) && imageCount > 1 ? imageCount : 1
  return Array.from({ length: count }, () => '[图片]').join(' ')
}

function sessionCwd(session) {
  const cwd = session.cwd ?? session.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '未指定工作目录'
}

export function workspaceTitle(cwd, fallbackTitle) {
  if (cwd === '未指定工作目录') return fallbackTitle
  const segment = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
  return segment && segment.trim() !== '' ? segment : fallbackTitle
}