/**
 * Remove a probe workspace from the canvas data file.
 *
 * `scripts/verify-*.mjs` run against a throwaway cwd so they never touch a real
 * conversation, but their projection still lands in workspaces.json. This drops
 * a named workspace (matched by cwd) and leaves every other workspace byte for
 * byte alone, so nothing real is at risk.
 *
 * Usage: node scripts/drop-probe-workspace.mjs <workspaces.json> <cwd-substring>
 */
import { readFile, writeFile, rename, copyFile } from 'node:fs/promises'

const [input, needle] = process.argv.slice(2)
if (typeof input !== 'string' || typeof needle !== 'string') {
  console.error('usage: node scripts/drop-probe-workspace.mjs <workspaces.json> <cwd-substring>')
  process.exit(1)
}

const state = JSON.parse(await readFile(input, 'utf8'))
const before = state.workspaces?.length ?? 0
const dropped = (state.workspaces ?? []).filter(workspace => String(workspace.cwd ?? '').toLowerCase().includes(needle.toLowerCase()))
if (dropped.length === 0) {
  console.error(`no workspace matches ${needle}; nothing written`)
  process.exit(0)
}
state.workspaces = (state.workspaces ?? []).filter(workspace => !String(workspace.cwd ?? '').toLowerCase().includes(needle.toLowerCase()))
for (const workspace of dropped) console.error(`dropping ${workspace.title} (${workspace.cwd}), ${workspace.threads?.length ?? 0} threads`)

await copyFile(input, `${input}.before-drop`)
const json = JSON.stringify(state)
const temp = `${input}.drop.tmp`
await writeFile(temp, `${json}\n`, 'utf8')
await rename(temp, input)
console.error(`workspaces ${before} → ${state.workspaces.length} (backup at ${input}.before-drop)`)
