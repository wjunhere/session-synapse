// 端到端：用真实 pi 会话数据跑投影，报告每个工作区的卡片/工具统计。
// 只读真实会话；画布数据写在系统临时目录并删掉（曾经写死在仓库的 `_e2e/`，每跑一次留 80MB 残渣）。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiAdapter, defaultAgentDir } from '../src/adapters/pi.js'
import { Synapse } from '../src/synapse.js'

const runDir = await mkdtemp(join(tmpdir(), 'pi-synapse-e2e-'))

const adapter = createPiAdapter({ agentDir: defaultAgentDir() })
const synapse = new Synapse({ adapter, dataFile: join(runDir, 'workspaces.json') })

const t0 = Date.now()
await synapse.start()
const elapsed = Date.now() - t0

const workspaces = await synapse.listWorkspaces()
console.log(`投影耗时 ${elapsed} ms`)
console.log(`会话数 ${synapse.sessions.size}  工作区数 ${workspaces.length}`)
console.log()

let totalCards = 0
let totalTools = 0
let totalThreads = 0
const rows = []
for (const w of workspaces) {
  const full = await synapse.getWorkspace(w.id)
  const cards = full.threads.reduce((n, t) => n + t.messages.filter(m => m.kind === 'user').length, 0)
  const tools = full.threads.reduce((n, t) => n + t.messages.reduce((k, m) => k + (m.process?.length ?? 0), 0), 0)
  const forks = full.threads.filter(t => t.parentId !== null).length
  totalCards += cards
  totalTools += tools
  totalThreads += full.threads.length
  rows.push({ title: w.title, threads: full.threads.length, cards, tools, forks, cwd: w.cwd })
}
rows.sort((a, b) => b.cards - a.cards)
for (const r of rows.slice(0, 12)) {
  console.log(`  ${r.title.padEnd(20)} 会话${String(r.threads).padStart(3)} 卡片${String(r.cards).padStart(5)} 工具${String(r.tools).padStart(5)} 分支${String(r.forks).padStart(2)}  ${r.cwd}`)
}
console.log()
console.log(`合计: 会话 ${totalThreads}  卡片 ${totalCards}  工具调用 ${totalTools}`)

// 抽查一个真实会话，确认卡片内容与原始 JSONL 一致
const target = rows.find(r => r.cards > 3)
if (target !== undefined) {
  const w = workspaces.find(x => x.title === target.title)
  const full = await synapse.getWorkspace(w.id)
  const thread = full.threads.find(t => t.messages.some(m => m.kind === 'user'))
  console.log()
  console.log(`抽查工作区「${target.title}」的会话 ${thread.sessionId}`)
  console.log(`  标题: ${thread.title}`)
  console.log(`  文件: ${thread.sessionFile}`)
  for (const m of thread.messages.slice(0, 4)) {
    const preview = m.text.replaceAll(/\s+/g, ' ').slice(0, 70)
    console.log(`  [${m.kind}] ${preview}${m.text.length > 70 ? '…' : ''}${m.process?.length ? `  (工具×${m.process.length})` : ''}`)
  }
}

await synapse.stop()
await rm(runDir, { recursive: true, force: true })
