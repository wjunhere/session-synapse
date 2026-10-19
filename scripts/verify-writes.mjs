// M3 验证：capabilities 门控 + 改名 + pi-web 归档
//
// 全部操作都在一次性会话上做，结束后清理。
import { launchBrowser } from './browser.mjs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
const MODEL = { provider: 'trae', modelId: 'DeepSeek-V4-Flash' }

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
// prompt() 对话框：默认接受并填入固定名字
page.on('dialog', async d => { await d.accept('M3 改名验证') })

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

const status = await page.evaluate(async () => (await (await fetch('/synapse/api/status')).json()))
console.log('服务端 capabilities:', JSON.stringify(status.capabilities))

// 造一次性会话 + 一条消息
const id = await page.evaluate(async ({ cwd, model }) => {
  const r = await fetch('/api/agent/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, type: 'ensure_session' }) })
  const b = await r.json()
  if (typeof b.sessionId !== 'string') return null
  await fetch(`/api/agent/${b.sessionId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'set_model', ...model }) })
  await fetch(`/api/agent/${b.sessionId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: '请只回复「ok」。' }) })
  return b.sessionId
}, { cwd: PROBE_CWD, model: MODEL })
console.log('一次性会话:', id)
if (id === null) { console.log('创建失败'); await browser.close(); process.exit(1) }

await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(6000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))

// 轮询等探测工作区出现（投影按 4s 重扫）
const probeTitle = PROBE_CWD.split(/[\\/]/).filter(Boolean).at(-1)
let opts = []
for (let i = 0; i < 15; i++) {
  opts = await frame.locator('select option').allTextContents()
  if (opts.some(o => o.includes(probeTitle))) break
  await page.waitForTimeout(3000)
}
if (!opts.some(o => o.includes(probeTitle))) {
  console.log('探测工作区未出现；现有:', opts.slice(0, 6))
  await browser.close(); process.exit(1)
}
console.log('探测工作区已出现')
await frame.locator('select').selectOption({ label: opts.find(o => o.includes(probeTitle)) })
await page.waitForTimeout(5000)

console.log('门控后的按钮数:', await frame.evaluate(() => ({
  rename: document.querySelectorAll('[data-action="rename-thread"]').length,
  hostArchive: document.querySelectorAll('[data-action="host-archive"]').length,
  newSession: document.querySelectorAll('.new-workspace').length,
})))

// 按钮带的是 threadId，先通过画布 API 把 sessionId 映射成 threadId，
// 否则会点到画布数据里残留的旧探测 thread。
const threadIdFor = async sessionId => {
  const list = await page.evaluate(async () => (await (await fetch('/synapse/api/workspaces')).json()).workspaces)
  for (const w of list) {
    const full = await page.evaluate(async id => (await (await fetch(`/synapse/api/workspaces/${id}`)).json()).workspace, w.id)
    const hit = full.threads.find(t => t.sessionId === sessionId)
    if (hit) return hit.id
  }
  return null
}
const clickForSession = (action, threadId) => frame.evaluate(({ a, tid }) => {
  const buttons = [...document.querySelectorAll(`[data-action="${a}"]`)]
  const target = buttons.find(b => b.dataset.thread === tid)
  if (!target) return false
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
}, { a: action, tid: threadId })

// --- 改名 ---
const tid = await threadIdFor(id)
console.log('threadId:', tid)
console.log('点改名:', await clickForSession('rename-thread', tid))
await page.waitForTimeout(5000)
const afterRename = await page.evaluate(async sid => {
  // The list API carries the display name; `/api/sessions/:id`.info does not.
  const list = await (await fetch('/api/sessions')).json()
  return list.sessions.find(s => s.id === sid)?.name ?? null
}, id)
console.log('pi-web 中的会话名:', JSON.stringify(afterRename))

// 落盘验证：session_info 条目
const named = await page.evaluate(async sid => {
  const b = await (await fetch(`/api/sessions/${encodeURIComponent(sid)}`)).json()
  return b.info?.path ?? null
}, id)
console.log('会话文件:', named)

// --- pi-web 归档 ---
console.log('点 pi-web 归档:', await clickForSession('host-archive', tid))
await page.waitForTimeout(5000)
const uiState = await page.evaluate(async () => (await (await fetch('/api/sessions/ui-state')).json()))
console.log('ui-state 归档标记:', JSON.stringify(uiState.state?.sessions?.[id] ?? null))

console.log('页面错误:', errors.length ? errors.slice(0, 4) : '无')
await browser.close()
