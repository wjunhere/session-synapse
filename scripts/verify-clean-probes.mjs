// clean-probes 不许动**活实例**的锁与临时文件。
//
// 为什么值得一条回归：这个脚本曾经写死扫 `~/.pi/agent/synapse` 并见文件就删，于是
// `npm run verify`（带 `--data <临时文件>`）会顺手删掉用户正在跑的那个实例的
// `<data>.<pid>.tmp` 与 `<data>.instance`。实测后果两件：
//   1. 删掉写入中途的 tmp，让那次保存的 rename 报 ENOENT —— **那一笔改动静默丢失**；
//   2. 删掉 `<data>.instance`（只在启动时写一次），实例从此没有单实例保护，
//      第二个实例可以同时写同一份文件。
//
// 全用 `--dry-run` 跑：脚本会照常算出「该删什么」并打在报告里，但不落任何盘。
// 于是既验证了决策逻辑，又不会去改真实的会话目录 / pi-web 状态。
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  child.on('error', reject)
  child.on('close', code => resolve({ code, out, err }))
})

const dir = await mkdtemp(join(tmpdir(), 'clean-probes-check-'))
const dataFile = join(dir, 'probe-workspaces.json')
// 另一份数据文件的附属产物：同名目录里的另一个 basename 必须完全不被碰。
const otherFile = join(dir, 'other-workspaces.json')

// 一个「活着、而且命令行看起来像 synapse」的持有者：脚本判活靠
// `commandLineLooksLikeOurs`（grep 命令行里的 synapse），所以参数里带上这个字样。
const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'synapse-idle-marker'], { stdio: 'ignore' })
await new Promise(resolve => live.once('spawn', resolve))
const livePid = live.pid
// 一个确定不存在的 PID（远大于 pid_max），代表「写盘写到一半被杀的实例」。
const deadPid = 999999

await mkdir(dir, { recursive: true })
await writeFile(dataFile, `${JSON.stringify({ workspaces: [], hiddenSessionIds: [] })}\n`)
await writeFile(otherFile, `${JSON.stringify({ workspaces: [], hiddenSessionIds: [] })}\n`)
await writeFile(`${dataFile}.instance`, `${JSON.stringify({ pid: livePid, port: 30143, host: 'x', startedAt: new Date().toISOString(), cwd: dir })}\n`)
await writeFile(`${dataFile}.lock`, `${livePid}\n`)
await writeFile(`${dataFile}.${livePid}.tmp`, 'half written')
await writeFile(`${dataFile}.${deadPid}.tmp`, 'orphan from a killed writer')
await writeFile(`${otherFile}.instance`, `${JSON.stringify({ pid: livePid, startedAt: new Date().toISOString() })}\n`)
await writeFile(`${otherFile}.${deadPid}.tmp`, 'another data file')

const result = await run(process.execPath, [join(ROOT, 'scripts', 'clean-probes.mjs'), '--data', dataFile, '--dry-run'])
console.log(result.out.trim())
if (result.code !== 0) console.log('stderr:', result.err.trim().slice(0, 400))

const report = result.out
const cleaned = name => report.includes(`清掉 ${name}`)
const kept = name => report.includes(`留着 ${name}`)

const checks = [
  ['活实例的 .instance 留着', kept('probe-workspaces.json.instance')],
  ['活实例的 .lock 留着', kept('probe-workspaces.json.lock')],
  ['活实例正在写的 .tmp 留着', kept(`probe-workspaces.json.${livePid}.tmp`)],
  ['死实例留下的 .tmp 被清掉', cleaned(`probe-workspaces.json.${deadPid}.tmp`)],
  ['另一份数据文件的 .instance 不被碰', !report.includes('other-workspaces.json')],
  ['另一份数据文件的 .tmp 不被碰', !report.includes(`other-workspaces.json.${deadPid}.tmp`)],
]

for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
const ok = checks.every(item => item[1]) && result.code === 0

live.kill('SIGKILL')
await rm(dir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
