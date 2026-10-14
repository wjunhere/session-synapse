/**
 * Read pi sessions straight from the agent data directory.
 *
 * This adapter is deliberately filesystem-first. pi-web's `/api/sessions/:id/context`
 * endpoint returns only a *window* of the active branch (a 2882-message session
 * returned 101 entries with `hasMore: true`), so it cannot rebuild a canvas
 * from history. The JSONL file is the only complete source; the HTTP API is
 * used only for live state and for commands.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { projectPiSession, parseSessionLines, splitSession } from '../project/pi.js'
import { capabilities } from './contract.js'
import { createModelRegistry } from '../models/registry.js'

/** pi encodes a cwd into a directory name: `--B--cc_program--`. */
const SESSION_DIR_PREFIX = '--'
const SESSION_DIR_SUFFIX = '--'

/**
 * How much of a session file to read when only its header is wanted.
 *
 * The header is the first line and measures 137 bytes on this machine, so the
 * first read almost always suffices; the loop in `readHeader` only grows for a
 * pathologically long one. Reading the WHOLE file to get it is what made a
 * periodic re-list unaffordable: 179 sessions / 561 MB here.
 */
const HEADER_CHUNK_BYTES = 16 * 1024

/** `mtime:size` — the cheapest identity of a file's contents that a re-stat yields. */
function signatureOf(file) {
  return `${file.mtimeMs}:${file.size}`
}

export function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
}

export function defaultSessionsDir(agentDir = defaultAgentDir()) {
  return join(agentDir, 'sessions')
}

export function defaultDataFile(agentDir = defaultAgentDir()) {
  return join(agentDir, 'synapse', 'workspaces.json')
}

/**
 * A session as recorded on disk, before projection.
 * @typedef {object} PiSessionFile
 * @property {string} id
 * @property {string} path
 * @property {string|null} cwd
 * @property {string|null} parentSessionFile
 * @property {string} modified
 * @property {number} size
 */

/** List every session file under the sessions directory, newest first. */
export async function listSessionFiles(sessionsDir = defaultSessionsDir()) {
  let cwdDirs
  try {
    cwdDirs = await readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const found = []
  for (const dirent of cwdDirs) {
    if (!dirent.isDirectory()) continue
    const dirPath = join(sessionsDir, dirent.name)
    let files
    try {
      files = await readdir(dirPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      const path = join(dirPath, file.name)
      const id = sessionIdFromFileName(file.name)
      if (id === null) continue
      found.push({ id, path, dir: dirent.name })
    }
  }
  const withStats = await Promise.all(found.map(async item => {
    try {
      const info = await stat(item.path)
      return { ...item, modified: info.mtime.toISOString(), size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return null
    }
  }))
  return withStats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** `<timestamp>_<uuid>.jsonl` → `<uuid>`; falls back to the whole stem. */
export function sessionIdFromFileName(fileName) {
  const stem = fileName.replace(/\.jsonl$/, '')
  const separator = stem.lastIndexOf('_')
  const candidate = separator === -1 ? stem : stem.slice(separator + 1)
  return candidate === '' ? null : candidate
}

/** The cwd a session directory name encodes, best effort. */
export function cwdFromDirName(dirName) {
  if (!dirName.startsWith(SESSION_DIR_PREFIX) || !dirName.endsWith(SESSION_DIR_SUFFIX)) return null
  const inner = dirName.slice(SESSION_DIR_PREFIX.length, -SESSION_DIR_SUFFIX.length)
  if (inner === '') return null
  // pi replaces the leading separator and every `:`, `/`, `\` with `-`.
  const drive = /^([A-Za-z])--(.+)$/.exec(inner)
  if (drive !== null) return `${drive[1]}:\\${drive[2].replaceAll('-', '\\')}`
  return inner.replaceAll('-', '\\')
}

/**
 * Read one session file into its header, tree entries, and normalized
 * projection entries.
 */
export async function readSessionFile(path) {
  const text = await readFile(path, 'utf8')
  const parsed = parseSessionLines(text)
  const { header, entries } = splitSession(parsed)
  return { header, rawEntries: entries, text }
}

/**
 * Build the adapter.
 *
 * @param {object} [options]
 * @param {string} [options.sessionsDir]
 * @param {string} [options.agentDir]
 * @param {(path: string) => Promise<void>} [options.openSession]
 * @param {(sessionId: string, entryId?: string) => Promise<string>} [options.forkSession]
 *   `entryId` asks the host to fork at that entry. Only hosts that accept one
 *   honor it; pi-web's file-level fork always cuts at the branch's leaf.
 * @param {(sessionId: string, text: string) => Promise<void>} [options.sendMessage]
 * @param {boolean} [options.renameSession]     the browser can rename via pi-web
 * @param {boolean} [options.archiveSession]    the browser can archive via pi-web
 * @param {object} [options.capabilities]       extra capability overrides
 * @param {import('../models/registry.js').ModelRegistry} [options.models]
 *   Model registry override (tests). Typed rather than a bare `object`: a vague
 *   type made `models.contextWindow()` below report as a missing property.
 * @param {number} [options.pollIntervalMs]
 */
export function createPiAdapter(options = {}) {
  const agentDir = options.agentDir ?? defaultAgentDir()
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir(agentDir)
  const pollIntervalMs = options.pollIntervalMs ?? 4_000
  const models = options.models ?? createModelRegistry(agentDir)

  /**
   * `path → signature` for the watcher: what it has already REPORTED.
   *
   * Deliberately separate from the header cache below. A change the watcher has
   * not yet reported must stay unreported, and `listSessions` — called every few
   * seconds by reconciliation — would otherwise mark a file as seen the moment
   * it read it, so an append that arrived just before that read would be
   * swallowed by the next rescan and never reach the canvas. Measured as a card
   * stuck on 「正在回复」 whose final assistant message never arrived, and as a
   * 3-turn probe showing only 2 cards.
   */
  const known = new Map()
  /** `path → { signature, header }`: parsed headers, so a periodic list stays cheap. */
  const headers = new Map()
  const listeners = new Set()
  let timer = null

  async function listSessions() {
    const files = await listSessionFiles(sessionsDir)
    const sessions = []
    for (const file of files) {
      const signature = signatureOf(file)
      const cached = headers.get(file.path)
      let header
      if (cached !== undefined && cached.signature === signature) {
        header = cached.header
      } else {
        // A file that cannot be read at all is skipped, not listed with a
        // fallback cwd. Reconciliation reads an absent session as a deletion,
        // and the lazy fallback would hide the very failure it must not act on.
        try {
          header = await readHeader(file.path)
        } catch {
          continue
        }
        headers.set(file.path, { signature, header })
      }
      const cwd = typeof header?.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd : cwdFromDirName(file.dir)
      sessions.push({
        id: file.id,
        cwd,
        title: null,
        filePath: file.path,
        parentSessionFile: typeof header?.parentSession === 'string' ? header.parentSession : null,
        running: false,
        modified: file.modified,
        size: file.size,
        mtimeMs: file.mtimeMs,
      })
    }
    return sessions
  }

  /**
   * The header is the first line; only that much of the file is read.
   *
   * Bounded rather than `readFile`: this runs for every session on every
   * reconcile pass, and the sessions directory on the machine this was written
   * for totals 561 MB. The chunk grows only when a single line exceeds it.
   */
  async function readHeader(path) {
    const handle = await open(path, 'r')
    try {
      for (let size = HEADER_CHUNK_BYTES; size <= 4 * 1024 * 1024; size *= 4) {
        const buffer = Buffer.alloc(size)
        const { bytesRead } = await handle.read(buffer, 0, size, 0)
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        const newline = text.indexOf('\n')
        if (newline === -1 && bytesRead === size) continue
        const firstLine = newline === -1 ? text : text.slice(0, newline)
        try {
          const parsed = JSON.parse(firstLine)
          return parsed?.type === 'session' ? parsed : null
        } catch {
          return null
        }
      }
      return null
    } finally {
      await handle.close()
    }
  }

  async function readHistory(session) {
    const path = session.filePath
    if (typeof path !== 'string') throw new Error('会话缺少文件路径')
    const { header, rawEntries } = await readSessionFile(path)
    const projected = projectPiSession(header, rawEntries)
    // pi's fork COPIES the parent's branch into the child file, so without a
    // cut the canvas would re-render the parent's whole conversation as the
    // child's own turns (measured: a fork of a 13-turn session produced 13
    // identical user entries with identical entry ids). The cut is the length
    // of the id prefix the two files share.
    const inheritedEntryCount = await countInheritedEntries(rawEntries, session.parentSessionFile)
    // pi-web reports `contextUsage` only for sessions loaded in memory, so the
    // canvas derives it from the file for every session instead. The window
    // comes from the model registry; without it the figure stays absent.
    const contextWindow = projected.model === null
      ? null
      : await models.contextWindow(projected.model.provider, projected.model.id)
    return {
      header,
      entries: projected.entries,
      inheritedEntryCount,
      cwd: projected.cwd,
      model: projected.model,
      contextWindow,
    }
  }

  /**
   * How many leading entries of `entries` the fork parent already contains.
   *
   * pi copies the parent branch verbatim (same ids, same order) and then
   * appends the child's own turns, so the shared prefix is exactly the
   * inherited history. Matching on ids rather than timestamps matters: the
   * copied entries keep their ORIGINAL timestamps, all of which predate the
   * child's header, so no timestamp rule can separate copied from new.
   */
  async function countInheritedEntries(entries, parentSessionFile) {
    if (typeof parentSessionFile !== 'string' || parentSessionFile === '') return 0
    let parentEntries = null
    try {
      parentEntries = (await readSessionFile(parentSessionFile)).rawEntries
    } catch {
      // The parent may have been deleted; a missing parent simply means there is
      // nothing provable to cut, and showing the full history is the safe side.
      return 0
    }
    const parentIds = new Set(parentEntries.filter(entry => typeof entry.id === 'string').map(entry => entry.id))
    let count = 0
    for (const entry of entries) {
      if (typeof entry.id !== 'string' || !parentIds.has(entry.id)) break
      count += 1
    }
    // The canvas needs the ID of the last inherited entry, not a count: a count
    // cannot be compared against an entry id (ids are 8 hex digits, so
    // `'927f88e9' < 34` is false for every id and the lineage lookup silently
    // found nothing). Returning the boundary id lets the canvas match exactly.
    return count === 0 ? 0 : entries[count - 1].id
  }

  /**
   * Report changed sessions.
   *
   * `fs.watch` is used only as a "something changed" signal: on Windows a burst
   * of writes produced 101 events for 100 writes and touched a file that was
   * never written, so event counts can never be trusted. The truth comes from
   * re-stat'ing every file and comparing mtime+size. A slow poll backs up the
   * watcher, because a dropped event must not freeze the canvas.
   */
  function subscribe(onChange) {
    listeners.add(onChange)
    if (timer === null) timer = setInterval(() => { void scan() }, pollIntervalMs)
    void scan()
    return () => {
      listeners.delete(onChange)
      if (listeners.size === 0 && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
  }

  async function scan() {
    if (listeners.size === 0) return
    let files
    try {
      files = await listSessionFiles(sessionsDir)
    } catch {
      return
    }
    const seen = new Set()
    for (const file of files) {
      seen.add(file.path)
      const signature = signatureOf(file)
      if (known.get(file.path) === signature) continue
      known.set(file.path, signature)
      let header = null
      try {
        header = await readHeader(file.path)
      } catch {
        continue
      }
      // Share what was just read with `listSessions`; the signature is the same
      // one it would compute, so this is a plain cache fill, not a mark of the
      // watcher's progress.
      headers.set(file.path, { signature, header })
      const session = {
        id: file.id,
        cwd: typeof header?.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd : cwdFromDirName(file.dir),
        title: null,
        filePath: file.path,
        parentSessionFile: typeof header?.parentSession === 'string' ? header.parentSession : null,
        running: false,
        modified: file.modified,
        size: file.size,
        mtimeMs: file.mtimeMs,
      }
      for (const listener of listeners) {
        try {
          listener(session)
        } catch {
          // A listener that throws must not stop the others.
        }
      }
    }
    for (const path of [...known.keys()]) {
      if (!seen.has(path)) known.delete(path)
    }
    for (const path of [...headers.keys()]) {
      if (!seen.has(path)) headers.delete(path)
    }
  }

  return {
    id: 'pi',
    defaultDataFile: () => defaultDataFile(agentDir),
    agentDir,
    models,
    listSessions,
    readHistory,
    subscribe,
    // Capabilities describe what the CANVAS can do against this host, which is
    // not the same as what this process can do: the write calls are made by the
    // browser (it shares pi-web's origin), so they are declared explicitly
    // rather than inferred from local functions.
    capabilities: () => capabilities({
      openSession: typeof options.openSession === 'function',
      forkSession: typeof options.forkSession === 'function',
      sendMessage: typeof options.sendMessage === 'function',
      renameSession: options.renameSession === true,
      archiveSession: options.archiveSession === true,
      ...options.capabilities,
    }),
    ...(typeof options.openSession === 'function' ? { openSession: options.openSession } : {}),
    ...(typeof options.forkSession === 'function' ? { forkSession: options.forkSession } : {}),
    ...(typeof options.sendMessage === 'function' ? { sendMessage: options.sendMessage } : {}),
    ...(typeof options.renameSession === 'function' ? { renameSession: options.renameSession } : {}),
    ...(typeof options.archiveSession === 'function' ? { archiveSession: options.archiveSession } : {}),
  }
}