import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireInstanceLock, InstanceLockError, lockIsStale } from '../src/store/instance-lock.js'

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-lock-'))
  try {
    await run(dir, join(dir, 'workspaces.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Start a process that a liveness check will accept as a synapse instance.
 *
 * The PID-existence test alone is not enough (Windows recycles PIDs), so the
 * holder's command line is also inspected. `process.ppid` cannot stand in for a
 * holder: it is the test runner, and the check correctly rejects it. This spawns
 * a real process carrying `synapse` in its command line instead.
 */
function spawnFakeHolder() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'synapse'], { stdio: 'ignore' })
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
          assert.match(error.message, /另一个 synapse 实例/)
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
    // The test runner itself is alive but is NOT a synapse instance.
    await writeFile(`${dataFile}.instance`, `${JSON.stringify({ pid: process.ppid, port: 30142, startedAt: new Date().toISOString() })}\n`, 'utf8')
    const lock = await acquireInstanceLock(dataFile)
    assert.equal(lock.tookOver, true)
    await lock.release()
  })
})

test('a live holder is not reclaimed just because its lock looks old', async () => {
  // The bug this test was written for: age used to be compared before asking
  // whether the holder was ours, so an instance that had been up past the
  // window was treated as abandoned **while it was running** and the next start
  // took the lock away — two writers on one data file. A confirmed-live holder
  // must never be aged out, however old the lock file is.
  await withDir(async (_dir, dataFile) => {
    const holder = spawnFakeHolder()
    try {
      await writeFile(`${dataFile}.instance`, `${JSON.stringify({ pid: holder.pid, port: 30142, startedAt: '2020-01-01T00:00:00.000Z' })}\n`, 'utf8')
      // Age the file itself too: the age signal is the lock's mtime.
      await utimes(`${dataFile}.instance`, new Date(0), new Date(0))
      await assert.rejects(
        () => acquireInstanceLock(dataFile, { staleAfterMs: 1000 }),
        error => error instanceof InstanceLockError && error.holder.pid === holder.pid,
      )
    } finally {
      await holder.stop()
    }
  })
})

test('an unreadable command line still lets age reclaim the lock (Windows only)', { skip: process.platform !== 'win32' }, async () => {
  // The backstop the age bound exists for: when the holder's command line cannot
  // be read, "that PID exists" proves nothing (Windows recycles PIDs), so an
  // ancient lock must be reclaimable or the user is locked out forever.
  // Simulated by taking `wmic` off PATH — the real state of a machine where the
  // command line is unreadable, and what Windows 11 24H2 will ship by default.
  //
  // Windows only, and not by choice: on Linux the command line comes from
  // `/proc/<pid>/cmdline`, which needs no PATH and cannot be made unreadable from
  // a test (the real failure there is another user's process → EACCES). Blanking
  // PATH there changed nothing, the holder still read as ours, and this test
  // failed on CI for two runs before the simulation was understood. The portable
  // half of it is the decision table below.
  await withDir(async (_dir, dataFile) => {
    const holder = spawnFakeHolder()
    const path = process.env.PATH
    try {
      await writeFile(`${dataFile}.instance`, `${JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() })}\n`, 'utf8')
      await utimes(`${dataFile}.instance`, new Date(0), new Date(0))
      process.env.PATH = ''
      const lock = await acquireInstanceLock(dataFile, { staleAfterMs: 1000 })
      assert.equal(lock.tookOver, true)
      await lock.release()
    } finally {
      process.env.PATH = path
      await holder.stop()
    }
  })
})

test('the staleness decision is three-way: gone, ours, and unknown', () => {
  // The same contract, asserted where no OS can change the answer (this is the
  // half that runs on CI). Getting any of these wrong is a data-corruption bug in
  // one direction or a lockout in the other:
  //   - `true`  → a live instance would lose its lock to the next start (two
  //               writers, which is what the lock exists to prevent);
  //   - `false` → an ancient lock would be stolen from a live holder;
  //   - `null`  → the age bound is the only way out of a recycled PID.
  const old = { staleAfterMs: 1000, mtimeMs: Date.now() - 60_000 }
  const holder = { pid: 4242 }
  assert.equal(lockIsStale(null, { ...old, liveness: null }), true, 'no holder at all is free')
  assert.equal(lockIsStale(holder, { ...old, liveness: false }), true, 'a gone owner is reclaimable')
  assert.equal(lockIsStale(holder, { ...old, liveness: true }), false, 'a confirmed live owner is never aged out')
  assert.equal(lockIsStale(holder, { ...old, liveness: null }), true, 'an unknown owner is reclaimed once the lock is old')
  assert.equal(lockIsStale(holder, { ...old, mtimeMs: Date.now(), liveness: null }), false, 'a fresh lock is kept even when unknown')
  assert.equal(lockIsStale(holder, { ...old, mtimeMs: null, liveness: null }), false, 'an unreadable mtime reads as no age (never steal on a failed stat)')
  assert.equal(lockIsStale(holder, { ...old, staleAfterMs: 0, liveness: null }), false, 'the bound can be switched off')
})

test('the heartbeat refreshes the lock so a long-running instance stays protected', async () => {
  // Without a heartbeat the age bound creeps up on a *healthy* instance: its
  // lock file's timestamp only ever gets older. Refreshing restamps it, so the
  // instance stays protected for as long as it actually runs.
  await withDir(async (_dir, dataFile) => {
    const lock = await acquireInstanceLock(dataFile)
    try {
      const aged = new Date(Date.now() - 60 * 60 * 1000)
      await utimes(lock.lockPath, aged, aged)
      await lock.refresh()
      const { mtimeMs } = await stat(lock.lockPath)
      assert.ok(Date.now() - mtimeMs < 10_000, `mtime should be fresh, got ${new Date(mtimeMs).toISOString()}`)
    } finally {
      await lock.release()
    }
  })
})

test('refreshing a lock that is no longer ours does not touch it', async () => {
  // A --force takeover (or a reclaimed lock) means two instances; the loser must
  // not keep restamping a file it no longer owns and make it look fresh forever.
  await withDir(async (_dir, dataFile) => {
    const lock = await acquireInstanceLock(dataFile)
    try {
      await writeFile(lock.lockPath, `${JSON.stringify({ pid: process.ppid })}\n`, 'utf8')
      await utimes(lock.lockPath, new Date(0), new Date(0))
      await lock.refresh()
      const { mtimeMs } = await stat(lock.lockPath)
      assert.ok(Date.now() - mtimeMs > 1000, 'a lock owned by someone else must be left alone')
    } finally {
      await lock.release()
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
