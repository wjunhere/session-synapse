/**
 * Verify the single-instance guarantee end to end, through the real CLI.
 *
 * On Windows a signal sent by another process terminates Node WITHOUT running
 * any JS handler (verified: neither a `SIGINT` nor an `exit` listener fires), so
 * a killed instance always leaves its lock file behind. That makes "the next
 * start still works" the property worth asserting, not "the lock disappears".
 *
 * Three things are checked, in order:
 *   1. a second instance is refused while one is running;
 *   2. it is refused even on a DIFFERENT port (a port-only guard would miss the
 *      zombie-instance failure mode that inflated the data file to 545 MB);
 *   3. after the holder is killed however it dies, a fresh start still succeeds
 *      without --force, because a stale lock is reclaimed automatically.
 *
 * And one that is not about staleness at all: 4. a lock that *looks* ancient
 * must NOT be reclaimed while its holder is alive. Age is only the backstop for
 * a holder whose command line cannot be read; when it applied to every holder, an
 * instance that had been up past the window was treated as abandoned while it
 * was running and the next start took its lock — two writers on one data file.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, access, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'synapse-single-'))
const dataFile = join(dir, 'workspaces.json')
const lockPath = `${dataFile}.instance`
const CWD = process.cwd()

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

function start(port) {
  const child = spawn(process.execPath, ['bin/synapse.js', 'start', '--port', String(port), '--data', dataFile, '--no-inject'], { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  return {
    child,
    output: () => out,
    /** Resolve once the process either reports it is up or has exited. */
    settled: () => new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 90_000)
      const tick = () => {
        if (out.includes('已启动')) { clearTimeout(timer); resolve('up') }
        else if (child.exitCode !== null) { clearTimeout(timer); resolve('exited') }
        else setTimeout(tick, 400)
      }
      tick()
    }),
  }
}

const exists = async p => { try { await access(p); return true } catch { return false } }

// ---------- 1. one instance starts ----------
const first = start(30221)
check('第一个实例启动成功', await first.settled() === 'up')
check('锁文件已建立', await exists(lockPath))
const held = JSON.parse(await readFile(lockPath, 'utf8'))
check('锁记录了 PID', held.pid === first.child.pid, `lock=${held.pid} child=${first.child.pid}`)

// ---------- 2. a second instance on the SAME port is refused ----------
const samePort = start(30221)
await samePort.settled()
samePort.child.kill('SIGKILL')
check('同端口的第二个实例被拒绝', /已有实例正在使用这份画布数据/.test(samePort.output()))
check('拒绝信息给出占用的 PID', samePort.output().includes(String(first.child.pid)))

// ---------- 3. a second instance on a DIFFERENT port is ALSO refused ----------
// This is the case a port-only guard cannot catch, and the one that produced the
// zombie writer: it binds nothing, yet would keep rewriting the data file.
const otherPort = start(30222)
await otherPort.settled()
otherPort.child.kill('SIGKILL')
check('换端口的第二个实例仍被拒绝', /已有实例正在使用这份画布数据/.test(otherPort.output()))

// ---------- 4. a lock that LOOKS ancient is still not reclaimed while its holder lives ----------
// Both age signals are aged: the payload's `startedAt` (what the stale check
// used to use) and the file's mtime (what it uses now). A confirmed-live holder
// must keep its lock regardless — this is the state a canvas reaches on its own
// after a day of uptime, and getting it wrong ends with two instances rewriting
// one data file.
const liveLock = JSON.parse(await readFile(lockPath, 'utf8'))
await writeFile(lockPath, `${JSON.stringify({ ...liveLock, startedAt: '2020-01-01T00:00:00.000Z' })}\n`, 'utf8')
await utimes(lockPath, new Date(0), new Date(0))
const aged = start(30223)
await aged.settled()
aged.child.kill('SIGKILL')
check('锁看起来极旧但持有者活着时，第二个实例仍被拒绝', /已有实例正在使用这份画布数据/.test(aged.output()))
const stillHeld = JSON.parse(await readFile(lockPath, 'utf8').catch(() => '{}'))
check('锁仍归原实例所有（没被接管）', stillHeld.pid === first.child.pid, `lock=${stillHeld.pid} first=${first.child.pid}`)

// ---------- 5. the data file is not being written by anyone but the holder ----------
// The property is CONVERGENCE, not "no write in a fixed window". The holder
// legitimately writes while it settles (the store coalesces projection writes
// into one trailing flush, and a session file that changes under it gets
// re-projected), so a 6-second window measured right after startup caught those
// writes and reported a zombie that was not there. A runaway writer never
// converges; a settling one does within a few seconds.
const sizes = []
for (let i = 0; i < 20; i++) {
  sizes.push((await readFile(dataFile, 'utf8').catch(() => '')).length)
  const stable = sizes.length >= 3 && sizes.at(-1) === sizes.at(-2) && sizes.at(-2) === sizes.at(-3)
  if (stable) break
  await new Promise(r => setTimeout(r, 1_000))
}
const converged = sizes.length >= 3 && sizes.at(-1) === sizes.at(-2) && sizes.at(-2) === sizes.at(-3)
check('无僵尸写入者（数据文件收敛不再变化）', converged, sizes.map(size => `${(size / 1e6).toFixed(1)}MB`).join(' → '))

// ---------- 6. kill the holder however it dies; a fresh start must still work ----------
first.child.kill('SIGKILL')
await new Promise(resolve => first.child.once('exit', resolve))
check('持有者被杀后锁文件可能残留（Windows 上游限制）', true, `lock present: ${await exists(lockPath)}`)

const restart = start(30221)
const outcome = await restart.settled()
restart.child.kill('SIGKILL')
check('无需 --force 即可重新启动（陈旧锁被自动接管）', outcome === 'up', `outcome=${outcome}`)
check('接管时给出提示', /接管了一个遗留的锁/.test(restart.output()))
const newHeld = JSON.parse(await readFile(lockPath, 'utf8').catch(() => '{}'))
check('锁已转归新实例', newHeld.pid === restart.child.pid, `lock=${newHeld.pid} child=${restart.child.pid}`)

await rm(dir, { recursive: true, force: true })
const failed = results.filter(ok => !ok).length
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
