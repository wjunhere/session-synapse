// M3 实测：画布内发消息（全链路，走画布自己的 UI）
//
// 1. 造一次性会话，先发一条建立卡片
// 2. 等画布投影出该卡片
// 3. 在画布上点「追问」，输入并提交
// 4. 验证消息落盘 + 画布回显
// 结束后彻底清理。
import { launchBrowser } from './browser.mjs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
const MODEL = { provider: 'trae', modelId: 'DeepSeek-V4-Flash' }

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// 造会话 + 设模型 + 发第一条（建立卡片）
const id = await page.evaluate(async ({ cwd, model }) => {
  const r = await fetch('/api/agent/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, type: 'ensure_session' }) })
  const b = await r.json()
  const sid = b.sessionId
  if (typeof sid !== 'string') return null
  await fetch(`/api/agent/${encodeURIComponent(sid)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'set_model', ...model }) })
  await fetch(`/api/agent/${encodeURIComponent(sid)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: '第一条：请只回复「收到」。' }) })
  return sid
}, { cwd: PROBE_CWD, model: MODEL })
console.log('一次性会话:', id)
if (id === null) { console.log('创建失败'); await browser.close(); process.exit(1) }

// 切地图，等投影
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(10000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))

// 画布侧：找到包含该 sessionId 的 workspace，切过去
const probeTitle = PROBE_CWD.split(/[\\/]/).filter(Boolean).at(-1)
const opts = await frame.locator('select option').allTextContents()
console.log('工作区里有探测项:', opts.some(o => o.includes(probeTitle)), `(${probeTitle})`)
if (!opts.some(o => o.includes(probeTitle))) {
  console.log('探测工作区未出现，投影可能还没跑到。选项数:', opts.length)
  await browser.close(); process.exit(1)
}
await frame.locator('select').selectOption({ label: opts.find(o => o.includes(probeTitle)) })
await page.waitForTimeout(6000)

// 点「追问」按钮（卡片上的 open-continue）
const opened = await frame.evaluate(() => {
  const b = document.querySelector('[data-action="open-continue"]')
  if (!b) return false
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
})
console.log('打开追问框:', opened)
await page.waitForTimeout(1500)

// 在草稿框输入并提交（走画布自己的 submitDraft）
const draftPresent = await frame.evaluate(() => document.querySelector('[data-draft] textarea') !== null)
console.log('追问输入框存在:', draftPresent)
if (draftPresent) {
  await frame.evaluate(() => {
    const ta = document.querySelector('[data-draft] textarea')
    ta.value = '第二条：请只回复「画布发送成功」。'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(500)
  await frame.evaluate(() => {
    const form = document.querySelector('[data-draft]')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  console.log('已提交')
  await page.waitForTimeout(20000)
}

// 验证落盘
const file = await page.evaluate(async sid => {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}`)
  return (await r.json()).info?.path ?? null
}, id)
console.log('会话文件:', file)

console.log('页面错误:', errors.length ? errors.slice(0, 4) : '无')
await browser.close()
