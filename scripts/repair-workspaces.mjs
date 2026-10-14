/**
 * Repair an inflated workspaces.json by de-duplicating tool process entries.
 *
 * The growth bug appended a fresh copy of every tool call to its thread on each
 * rescan, so a thread could hold 104 copies of one call. Repairing in place —
 * rather than rebuilding from the session files — PRESERVES thread ids, and the
 * browser's saved card positions are keyed by those ids.
 *
 * Within one thread a `callId` is a unique tool invocation, so the first
 * occurrence wins and later copies are dropped. A later copy may still carry a
 * result the first one lacks (a call folded before its result arrived), so
 * results are merged rather than discarded.
 *
 * Usage: node scripts/repair-workspaces.mjs <in.json> [out.json]
 */
import { readFile, writeFile, rename } from 'node:fs/promises'

const input = process.argv[2]
const output = process.argv[3] ?? input
if (typeof input !== 'string') {
  console.error('usage: node scripts/repair-workspaces.mjs <workspaces.json> [out.json]')
  process.exit(1)
}

console.error('reading…')
const state = JSON.parse(await readFile(input, 'utf8'))

let removedEntries = 0
let repairedThreads = 0
let mergedResults = 0

for (const workspace of state.workspaces ?? []) {
  for (const thread of workspace.threads ?? []) {
    const seen = new Map()
    let changed = false
    for (const message of thread.messages ?? []) {
      const process = message.process
      if (!Array.isArray(process) || process.length === 0) continue
      const kept = []
      for (const entry of process) {
        const key = String(entry.callId ?? '')
        // An empty callId cannot be matched, so such entries are always kept.
        if (key === '') { kept.push(entry); continue }
        const earlier = seen.get(key)
        if (earlier === undefined) {
          seen.set(key, entry)
          kept.push(entry)
          continue
        }
        removedEntries++
        changed = true
        // Fill in anything the first copy was missing.
        if (earlier.result === null && entry.result !== null) { earlier.result = entry.result; mergedResults++ }
        if (earlier.error === null && entry.error !== null) { earlier.error = entry.error; mergedResults++ }
        if (earlier.arguments === null && entry.arguments !== null) earlier.arguments = entry.arguments
      }
      if (kept.length !== process.length) message.process = kept
    }
    // The pending queue can hold copies of calls already folded into a message.
    const pending = thread.pendingProcess
    if (Array.isArray(pending) && pending.length > 0) {
      const kept = []
      for (const entry of pending) {
        const key = String(entry.callId ?? '')
        if (key !== '' && seen.has(key)) { removedEntries++; changed = true; continue }
        kept.push(entry)
      }
      if (kept.length !== pending.length) thread.pendingProcess = kept
    }
    if (changed) repairedThreads++
  }
}

console.error(`removed ${removedEntries} duplicate entries across ${repairedThreads} threads (merged ${mergedResults} results)`)

const json = JSON.stringify(state)
console.error(`writing ${(json.length / 1048576).toFixed(1)} MB…`)
const temp = `${output}.repair.tmp`
await writeFile(temp, `${json}\n`, 'utf8')
await rename(temp, output)
console.error(`done → ${output}`)
