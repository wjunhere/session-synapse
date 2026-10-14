import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireInstanceLock, InstanceLockError } from '../src/store/instance-lock.js'

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-synapse-lock-'))
  try {
    await run(dir, join(dir, 'workspaces.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Start a process that a liveness check will accept as a pi-synapse instance.
 *
 * The PID-existence test alone is not enough (Windows recycles PIDs), so the
 * holder's command line is also inspected. `process.ppid` cannot stand in for a
 * holder: it is the test runner, and the check correctly rejects it. This spawns
 * a real process carrying `pi-synapse` in its command line instead.
 */
function spawnFakeHolder() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'pi-synapse'], { stdio: 'ignore' })
  return {
    pid: child.pid,
    stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill() }),
  }
}

test('a free data file can be locked and released', async () => {
  await withDir(async (_dir, dataFile) => {
    const lock = await acquireInstanceLock(dataFile, { port: 30142 })
    assert.equal(lock.tookOver, false)
    // The lock records who holds it, so a refusal can name the instance.
    const held = JSON.parse(await readFile(lock.lockPath, 'utf8'))
    assert.equal(held.pid, process.pid)
    assert.equal(held.port, 30142)
    await lock.release()
    // Released means a later instance may take it.
    const again = await acquireInstanceLock(dataFile)
    await again.release()
  })
})

test('a live holder blocks a second instance', async () => {
  // Two writers on one data file interleave whole-file rewrites and lose each
  // other's work, so the second must be refused rather than warned.
  await withDir(async (_dir, dataFile) => {
    const holder = spawnFakeHolder()
    try {
      await writeFile(`${dataFile}.instance`, `${JSON.stringify({ pid: holder.pid, port: 30142, startedAt: new Date().toISOString() })}\n`, 'utf8')
      await assert.rejects(
        () => acquireInstanceLock(dataFile),
        error => {
          assert.ok(error instanceof InstanceLockError)
          assert.equal(error.holder.pid, holder.pid)
          assert.match(error.message, /另一个 pi-synapse 实例/)
          return true
        },
      )
    } finally {
      await holder.stop()
    }
  })
})

test('a recycled PID does not lock the user out', async () => {
  // The harmful direction of the PID check: an unrelated process inherits the
  // dead holder's PID. Treating that as a live holder would refuse to start
  // forever with no way out, so the command line settles it.
  await withDir(async (_dir, dataFile) => {
    // The test runner itself is alive but is NOT a pi-synapse instance.
    await writeFile(`${dataFile}.instance`, `${JSON.stringify({ pid: process.ppid, port: 30142, startedAt: new Date().toISOString() })}\n`, 'utf8')
    const lock = await acquireInstanceLock(dataFile)
    assert.equal(lock.tookOver, true)
    await lock.release()
  })
})

test('a very old lock is reclaimed even if its PID looks alive', async () => {
  // The backstop for an unreadable command line: without it, a recycled PID on a
  // platform where the check is unavailable would block every future start.
  await withDir(async (_dir, dataFile) => {
    const holder = spawnFakeHolder()
    try {
      await writeFile(`${dataFile}.instance`, `${JSON.stringify({ pid: holder.pid, startedAt: '2020-01-01T00:00:00.000Z' })}\n`, 'utf8')
      const lock = await acquireInstanceLock(dataFile, { staleAfterMs: 1000 })
      assert.equal(lock.tookOver, true)
      await lock.release()
    } finally {
      await holder.stop()
    }
  })
})

test('a stale lock from a dead process is reclaimed', async () => {
  // An instance killed with the terminal leaves its lock behind; a lock must not
  // outlive its owner or the tool becomes unusable until someone deletes it.
  await withDir(async (_dir, dataFile) => {
    // PID 0x7FFFFFFF cannot exist, so it reads as dead.
    await writeFile(`${dataFile}.instance`, `${JSON.stringify({ pid: 2147483647, port: 30142 })}\n`, 'utf8')
    const lock = await acquireInstanceLock(dataFile)
    assert.equal(lock.tookOver, true)
    await lock.release()
  })
})

test('an unreadable lock is treated as stale, not as a blocker', async () => {
  await withDir(async (_dir, dataFile) => {
    await writeFile(`${dataFile}.instance`, 'not json at all', 'utf8')
    const lock = await acquireInstanceLock(dataFile)
    assert.equal(lock.tookOver, true)
    await lock.release()
  })
})

test('release does not delete a lock that now belongs to someone else', async () => {
  // A slow-dying instance must not strip the lock a newer instance acquired
  // after reclaiming the stale one.
  await withDir(async (_dir, dataFile) => {
    const lock = await acquireInstanceLock(dataFile)
    await writeFile(lock.lockPath, `${JSON.stringify({ pid: process.ppid })}\n`, 'utf8')
    await lock.release()
    const stillThere = JSON.parse(await readFile(lock.lockPath, 'utf8'))
    assert.equal(stillThere.pid, process.ppid)
  })
})

test('--force takes over a live holder', async () => {
  await withDir(async (_dir, dataFile) => {
    const holder = spawnFakeHolder()
    try {
      await writeFile(`${dataFile}.instance`, `${JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() })}\n`, 'utf8')
      const lock = await acquireInstanceLock(dataFile, { force: true })
      assert.equal(lock.tookOver, true)
      const held = JSON.parse(await readFile(lock.lockPath, 'utf8'))
      assert.equal(held.pid, process.pid)
      await lock.release()
    } finally {
      await holder.stop()
    }
  })
})

test('different data files do not conflict', async () => {
  // The lock is keyed on the data file, so two canvases over different profiles
  // are legitimate and must both run.
  await withDir(async (dir, dataFile) => {
    const other = join(dir, 'other.json')
    const a = await acquireInstanceLock(dataFile)
    const b = await acquireInstanceLock(other)
    assert.equal(b.tookOver, false)
    await a.release()
    await b.release()
  })
})

test('a first run creates the data directory for the lock', async () => {
  // WorkspaceStore creates the directory later, so the lock must not be the
  // thing that fails with a bare ENOENT on a brand-new profile.
  await withDir(async dir => {
    const nested = join(dir, 'a', 'b', 'workspaces.json')
    const lock = await acquireInstanceLock(nested)
    assert.equal(lock.tookOver, false)
    await lock.release()
  })
})
