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
 *
 * Which is why the holder is judged in THREE states, not two (`holderLiveness`):
 * alive-and-ours, dead-or-recycled, and *cannot tell*. Only the last may be aged
 * out. A confirmed-live holder keeps its lock no matter how old the file looks,
 * and a heartbeat keeps that age from ever reaching the bound anyway.
 */
import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Thrown when another live instance already holds the data file. */
export class InstanceLockError extends Error {
  constructor(holder, lockPath) {
    super(`另一个 synapse 实例正在使用同一份画布数据（PID ${holder.pid}）`)
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
 * can never lock the user out permanently. Age is measured from the lock file's
 * **mtime**, which the heartbeat below keeps fresh — see `lockIsStale`.
 */
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000

/**
 * How often a live holder refreshes its lock's mtime.
 *
 * Cheap (one `utimes`) and far inside the stale window: the point is only that a
 * healthy instance never ages out. Five minutes against a 24-hour window means
 * hundreds of ticks can be missed (a suspended laptop, a blocked event loop)
 * before the age bound could wrongly apply.
 */
const HEARTBEAT_MS = 5 * 60 * 1000

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
 * Does this PID still belong to a synapse instance?
 *
 * Windows recycles PIDs, so "a process with this PID exists" is not enough: a
 * recycled PID would make a dead instance look alive and lock the user out for
 * good. The holder's command line is the second signal.
 *
 * The token is the CLI's own file name (`bin/synapse.js`), which is why it shows
 * up in the command line however the CLI was started: `node bin/synapse.js`, a
 * global `synapse` shim, or the installed package directory
 * (`node_modules/session-synapse/bin/synapse.js`). It has to stay a literal the
 * launched command line really carries: a rename that misses this silently turns
 * every live holder into "not ours", which hands the data file a second writer.
 * A false positive is harmless by comparison -- it only refuses to steal a lock,
 * and `--force` is the documented way out.
 *
 * A host that runs Synapse INSIDE its own process cannot be recognised by that
 * token, because the command line carries the host's program instead. Such a
 * host passes its own `isOurs` matcher (`acquireInstanceLock` forwards it here);
 * without one, a live DSH host holding the lock reads as a recycled PID and the
 * next instance steals a lock that is very much alive.
 *
 * Best effort. When the command line cannot be read (no wmic, a restricted
 * platform, a permission error) this returns null and the caller keeps the
 * existing, more conservative behaviour.
 *
 * @param {number} pid
 * @param {(command: string) => boolean} [isOurs]  matcher over the raw command line
 * @returns {boolean|null} true/false when known, null when undeterminable
 */
export function commandLineLooksLikeOurs(pid, isOurs = synapseCommandLine) {
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
      return isOurs(command)
    }
    if (process.platform === 'linux') {
      try {
        return isOurs(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))
      } catch (error) {
        // A vanished /proc entry means the process is gone.
        if (error?.code === 'ENOENT') return false
        return null
      }
    }
    return isOurs(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 4_000 }))
  } catch {
    return null
  }
}

/** The CLI's own token, as explained above. */
function synapseCommandLine(command) {
  return /synapse/i.test(command)
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
 * What the lock says, plus when it was last written/refreshed.
 *
 * The mtime is the age signal, not the `startedAt` in the payload: the heartbeat
 * refreshes the file's timestamp, and a payload date could only ever get older.
 * A missing mtime (the file vanished between the two calls) reads as "no age at
 * all", i.e. conservative — never steal a lock on a failed stat.
 */
async function readLock(lockPath) {
  const holder = await readHolder(lockPath)
  try {
    return { holder, mtimeMs: (await stat(lockPath)).mtimeMs }
  } catch {
    return { holder, mtimeMs: null }
  }
}

/**
 * Is the recorded holder actually a live synapse instance?
 *
 * Three answers, because two are not enough: `true` (alive **and** confirmed to
 * be one of ours), `false` (gone, or the PID was recycled by an unrelated
 * process), and `null` when that cannot be determined. The distinction is
 * load-bearing — `lockIsStale` may only fall back to the age bound for `null`,
 * because for `true` a timeout would hand the file a second writer (see below).
 *
 * Two checks, because each alone is wrong:
 *   - a PID that no longer exists is definitely dead;
 *   - a PID that exists may have been recycled by an unrelated process, so the
 *     command line is consulted when it can be read. Being unable to read it is
 *     NOT evidence of death, and treating it as death would let a second
 *     instance steal a live lock and corrupt the file.
 *
 * @param {{ pid: number }|null} holder
 * @param {(command: string) => boolean} [isOurs]
 * @returns {boolean|null}
 */
function holderLiveness(holder, isOurs) {
  if (!isAlive(holder.pid)) return false
  return commandLineLooksLikeOurs(holder.pid, isOurs)
}

/**
 * A lock is stale when its owner is gone, or when an *unconfirmable* holder is
 * too old to trust.
 *
 * The age bound exists so that a recycled PID cannot lock the user out forever
 * on a platform where the command line cannot be read. It must apply **only** to
 * that case.
 *
 * It used to apply to everyone, and that was a real bug: `startedAt` was compared
 * against the window before asking whether the holder was ours, so a canvas that
 * had been up for more than a day was considered abandoned *while it was running*
 * and the next start took the lock away — two instances rewriting the same 88 MB
 * file, which is exactly what this lock exists to prevent. Measured here: the
 * canvas on port 30142 had been up 23 hours, one hour from that state.
 *
 * The liveness answer is an ARGUMENT rather than a call, because that is the one
 * thing a test cannot stage portably: on Windows it comes from `wmic`, which can
 * be missing, but on Linux it comes from `/proc/<pid>/cmdline`, which needs no
 * PATH and only fails for another user's process. Exported for the same reason
 * `commandLineLooksLikeOurs` is: the three-way contract is worth asserting
 * directly (see `test/instance-lock.test.js`).
 *
 * @param {{ pid: number }|null} holder
 * @param {{ staleAfterMs: number, mtimeMs: number|null, liveness: boolean|null }} state
 */
export function lockIsStale(holder, { staleAfterMs, mtimeMs, liveness }) {
  if (holder === null) return true
  if (liveness === false) return true
  // Confirmed alive and ours: never steal it, however old the file looks.
  if (liveness === true) return false
  // Undeterminable: the age bound is the only thing keeping a recycled PID from
  // locking the user out forever.
  if (staleAfterMs <= 0) return false
  const age = mtimeMs === null ? 0 : Date.now() - mtimeMs
  return age > staleAfterMs
}

/**
 * Claim exclusive use of a data file.
 *
 * @param {string} dataFile
 * @param {object} [options]
 * @param {number|null} [options.port]  recorded so the error names the holding instance
 * @param {boolean} [options.force]     take the lock even when another instance holds it
 * @param {number} [options.staleAfterMs]
 *   How long the lock file may go **unrefreshed** before an unconfirmable holder
 *   counts as abandoned. The fallback for the case where the holder's command
 *   line cannot be read: Windows recycles PIDs, so "that PID exists" never proves
 *   the holder is alive, but a threshold that is too eager would let a second
 *   instance steal a live lock. A confirmed-live holder is never aged out.
 * @param {(command: string) => boolean} [options.isOurs]
 *   How to recognise our own process on a holder's command line. Defaults to the
 *   CLI token; a host that embeds Synapse in its own process passes a matcher for
 *   its own launcher, because the default would read that host as a recycled PID
 *   and steal a live lock.
 * @returns {Promise<{ release: () => Promise<void>, refresh: () => Promise<void>, lockPath: string, tookOver: boolean }>}
 *   `refresh` is what the heartbeat calls every `HEARTBEAT_MS`; it is exposed so
 *   a test can observe the refresh without waiting minutes for a tick.
 * @throws {InstanceLockError} when a live instance already holds it
 */
export async function acquireInstanceLock(dataFile, { port = null, force = false, staleAfterMs = DEFAULT_STALE_MS, isOurs = undefined } = {}) {
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
    const { holder, mtimeMs } = await readLock(lockPath)
    // The holder may be unreadable (a torn file), in which case there is nothing
    // to ask about liveness — `lockIsStale` reclaims it on the holder alone.
    const liveness = holder === null ? null : holderLiveness(holder, isOurs)
    if (lockIsStale(holder, { staleAfterMs, mtimeMs, liveness })) {
      // The owner is gone (a killed instance always leaves its lock behind on
      // Windows) or the lock is too old to trust: reclaim it.
      tookOver = true
      await unlink(lockPath).catch(() => {})
      if (!(await claim())) {
        // Someone else re-claimed it between our unlink and our write.
        const { holder: racer } = await readLock(lockPath)
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
  /** @type {NodeJS.Timeout|null} */
  let heartbeatId = null
  let warnedAboutLoss = false
  const stopHeartbeat = () => {
    if (heartbeatId === null) return
    clearInterval(heartbeatId)
    heartbeatId = null
  }

  /**
   * Re-stamp the lock we hold, and give up loudly if it is no longer ours.
   *
   * Refreshing only the mtime (never the content) is deliberate: a rewrite could
   * be read as a torn file by another instance, and a torn lock reads as stale —
   * the one way this heartbeat could cause the corruption it is meant to prevent.
   */
  const refresh = async () => {
    if (released) return
    const { holder } = await readLock(lockPath)
    // `release` may have run while we were reading.
    if (released) return
    if (holder === null || holder.pid !== process.pid) {
      stopHeartbeat()
      if (!warnedAboutLoss) {
        warnedAboutLoss = true
        process.stderr.write('synapse: 画布数据锁已不属于本实例（可能被 --force 接管）——本实例不再刷新它；请只保留一个实例\n')
      }
      return
    }
    const now = new Date()
    await utimes(lockPath, now, now).catch(() => {})
  }

  // Keep the lock fresh for as long as we live, so the age fallback above can
  // never apply to a healthy instance. `unref` so a forgotten release in a test
  // (or a host embedding the module) cannot hang the process on this timer.
  heartbeatId = setInterval(() => { void refresh() }, HEARTBEAT_MS)
  heartbeatId.unref()

  const release = async () => {
    if (released) return
    released = true
    stopHeartbeat()
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
    refresh,
    lockPath,
    tookOver,
  }
}
