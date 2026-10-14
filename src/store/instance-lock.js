/**
 * A single-writer lock for one canvas data file.
 *
 * The canvas is not safe to run twice against the same data file: each instance
 * keeps the whole workspace graph in memory and rewrites the file wholesale, so
 * two instances interleave writes and lose each other's work.
 *
 * Two distinct failure modes this prevents, and the second is the one that
 * actually caused damage:
 *
 *   1. a second instance clobbering the first's writes;
 *   2. a second instance that could NOT bind its port (EADDRINUSE) still running
 *      its projection timer and rewriting the file forever. It never served a
 *      single request, yet a few leftover copies of it inflated
 *      `workspaces.json` to 545 MB. Guarding on the port alone would miss this,
 *      because the loser of the port race is precisely the process that lingers.
 *
 * The lock is keyed on the DATA FILE, not the process or the port, which is the
 * correct granularity: two instances pointed at different data files do not
 * conflict and must both be allowed to run.
 *
 * STALE LOCKS ARE THE NORMAL CASE, not an edge case. On Windows, a SIGINT
 * delivered by another process terminates Node without running any JS handler
 * (verified: neither the `SIGINT` nor the `exit` listener fires), so a killed
 * instance always leaves its lock behind. Reclaiming a lock whose owner is dead
 * is therefore the primary path, and the liveness check is what has to be right.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Thrown when another live instance already holds the data file. */
export class InstanceLockError extends Error {
  constructor(holder, lockPath) {
    super(`另一个 pi-synapse 实例正在使用同一份画布数据（PID ${holder.pid}）`)
    this.name = 'InstanceLockError'
    this.holder = holder
    this.lockPath = lockPath
  }
}

/**
 * How long a lock may be trusted when its liveness cannot be confirmed.
 *
 * Deliberately generous: a real session can stay open all day. This is only the
 * backstop for the case where the command line cannot be read, so a recycled PID
 * can never lock the user out permanently.
 */
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000

/** A PID that is running right now and is not us. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return false
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

/**
 * Does this PID still belong to a pi-synapse instance?
 *
 * Windows recycles PIDs, so "a process with this PID exists" is not enough: a
 * recycled PID would make a dead instance look alive and lock the user out for
 * good. The holder's command line is the second signal.
 *
 * Best effort. When the command line cannot be read (no wmic, a restricted
 * platform, a permission error) this returns null and the caller keeps the
 * existing, more conservative behaviour.
 *
 * @returns {boolean|null} true/false when known, null when undeterminable
 */
export function commandLineLooksLikeOurs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('wmic', ['process', 'where', `processid=${pid}`, 'get', 'commandline'], {
        encoding: 'utf8', timeout: 4_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      })
      const text = out.trim()
      // No rows at all means wmic knows no such process: a definitive "no".
      if (text === '' || !/commandline/i.test(text)) return false
      const command = text.split(/\r?\n/).slice(1).join(' ').trim()
      if (command === '') return null
      return /pi-synapse/i.test(command)
    }
    if (process.platform === 'linux') {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('pi-synapse')
      } catch (error) {
        // A vanished /proc entry means the process is gone.
        if (error?.code === 'ENOENT') return false
        return null
      }
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 4_000 }).includes('pi-synapse')
  } catch {
    return null
  }
}

async function readHolder(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return {
      pid: Number.parseInt(parsed.pid, 10),
      port: Number.isInteger(parsed.port) ? parsed.port : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      host: typeof parsed.host === 'string' ? parsed.host : null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
    }
  } catch {
    // A missing or corrupt lock tells us nothing; the caller treats it as stale.
    return null
  }
}

/**
 * Is the recorded holder actually a live pi-synapse?
 *
 * Two checks, because each alone is wrong:
 *   - a PID that no longer exists is definitely dead;
 *   - a PID that exists may have been recycled by an unrelated process, so the
 *     command line is consulted when it can be read. Being unable to read it is
 *     NOT evidence of death, and treating it as death would let a second
 *     instance steal a live lock and corrupt the file. When the command line is
 *     unreadable the higher-level `staleAfterMs` guard decides, so a recycled
 *     PID still cannot lock the user out permanently.
 */
function holderIsAlive(holder) {
  if (!isAlive(holder.pid)) return false
  const looksLikeOurs = commandLineLooksLikeOurs(holder.pid)
  if (looksLikeOurs === true) return true
  if (looksLikeOurs === false) return false
  // Undeterminable: trust the PID, the timestamp guard covers the rest.
  return true
}

/**
 * A lock is stale when its owner is gone, or when it is too old to trust.
 *
 * The age bound exists so that an unreadable command line (or a recycled PID on
 * a platform where the check is unavailable) cannot lock the user out forever.
 * It is generous because a legitimate session can run for many hours.
 */
function lockIsStale(holder, staleAfterMs) {
  if (holder === null) return true
  if (!holderIsAlive(holder)) return true
  if (staleAfterMs <= 0 || typeof holder.startedAt !== 'string') return false
  const started = Date.parse(holder.startedAt)
  if (!Number.isFinite(started)) return false
  return Date.now() - started > staleAfterMs
}

/**
 * Claim exclusive use of a data file.
 *
 * @param {string} dataFile
 * @param {object} [options]
 * @param {number|null} [options.port]  recorded so the error names the holding instance
 * @param {boolean} [options.force]     take the lock even when another instance holds it
 * @param {number} [options.staleAfterMs]
 *   How long a lock may go unrefreshed before it counts as abandoned. The
 *   fallback when the holder's command line cannot be read: Windows recycles
 *   PIDs, so "that PID exists" never proves the holder is alive, but a stale
 *   threshold that is too eager would let a second instance steal a live lock.
 * @returns {Promise<{ release: () => Promise<void>, lockPath: string, tookOver: boolean }>}
 * @throws {InstanceLockError} when a live instance already holds it
 */
export async function acquireInstanceLock(dataFile, { port = null, force = false, staleAfterMs = DEFAULT_STALE_MS } = {}) {
  const lockPath = `${dataFile}.instance`
  const payload = () => JSON.stringify({
    pid: process.pid,
    port,
    host: hostname(),
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  })

  // `wx` makes creation atomic, so exactly one of two racing processes wins.
  const claim = async () => {
    try {
      await writeFile(lockPath, `${payload()}\n`, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      // The data directory may not exist yet on a first run (WorkspaceStore
      // creates it later). Make it here so the lock never fails with a bare
      // ENOENT that says nothing about what the user should do.
      if (error?.code === 'ENOENT') {
        await mkdir(dirname(lockPath), { recursive: true })
        await writeFile(lockPath, `${payload()}\n`, { encoding: 'utf8', flag: 'wx' })
        return true
      }
      throw error
    }
  }

  let tookOver = false
  if (!(await claim())) {
    const holder = await readHolder(lockPath)
    if (lockIsStale(holder, staleAfterMs)) {
      // The owner is gone (a killed instance always leaves its lock behind on
      // Windows) or the lock is too old to trust: reclaim it.
      tookOver = true
      await unlink(lockPath).catch(() => {})
      if (!(await claim())) {
        // Someone else re-claimed it between our unlink and our write.
        const racer = await readHolder(lockPath)
        throw new InstanceLockError(racer ?? { pid: -1 }, lockPath)
      }
    } else if (force) {
      tookOver = true
      await unlink(lockPath).catch(() => {})
      await claim()
    } else {
      throw new InstanceLockError(holder, lockPath)
    }
  }

  let released = false
  const release = async () => {
    if (released) return
    released = true
    // Only remove the lock if it is still OURS. A leftover process that died
    // slowly must not delete the lock a newer instance now owns.
    const holder = await readHolder(lockPath)
    if (holder !== null && holder.pid !== process.pid) return
    await unlink(lockPath).catch(() => {})
  }

  // Clean up on the ways an instance normally goes away. `exit` is synchronous,
  // so it also covers a throw that reaches the top level.
  const onExit = () => { void release() }
  process.once('exit', onExit)

  return {
    release: async () => {
      process.removeListener('exit', onExit)
      await release()
    },
    lockPath,
    tookOver,
  }
}
