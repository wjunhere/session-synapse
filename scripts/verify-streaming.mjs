// M2 验证：流式「边写边显」
//
// live-reply 消息由 pi-web 侧 bridge 发往画布 iframe，所以必须在 iframe 内监听。
// 用一次性会话（唯一临时 cwd）触发真实流式回复，结束后彻底清理。
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
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(5000)

const frame = page.frames().find(f => f.url().includes('/synapse/'))
// 在画布内记录收到的 live-reply
await frame.evaluate(() => {
  window.__live = []
  window.addEventListener('message', e => {
    const d = e.data
    if (d?.source === 'synapse-host' && d.type === 'synapse:live-reply') {
      window.__live.push({ at: Date.now(), running: d.running, len: (d.text ?? '').length, head: (d.text ?? '').slice(0, 30) })
    }
  })
})

// 造一次性会话并换成可用模型
const created = await page.evaluate(async ({ cwd, model }) => {
  const r = await fetch('/api/agent/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, type: 'ensure_session' }) })
  const body = await r.json()
  if (typeof body.sessionId === 'string') {
    await fetch(`/api/agent/${encodeURIComponent(body.sessionId)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'set_model', ...model }),
    })
  }
  return body
}, { cwd: PROBE_CWD, model: MODEL })
console.log('一次性会话:', created.sessionId)
if (typeof created.sessionId !== 'string') { console.log('创建失败', created); await browser.close(); process.exit(1) }

// 发提问
const prompt = await page.evaluate(async id => {
  const r = await fetch(`/api/agent/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'prompt', message: '请从 1 数到 20，每个数字单独一行，不要用任何工具。' }),
  })
  return r.json()
}, created.sessionId)
console.log('prompt 受理:', prompt.success === true ? 'ok' : JSON.stringify(prompt).slice(0, 120))

// 采样：等 bridge 的 5s 轮询发现运行中会话，再观察长度递增
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(5000)
  const live = await frame.evaluate(() => window.__live)
  const last = live.at(-1)
  console.log(`  t=${(i + 1) * 5}s  事件 ${live.length} 条  末次长度 ${last?.len ?? 0}  running=${last?.running ?? '-'}`)
}

const live = await frame.evaluate(() => window.__live)
const running = live.filter(s => s.running).map(s => s.len)
const grew = running.length >= 2 && running.at(-1) > running[0]
console.log()
console.log(`live-reply 事件 ${live.length} 条；运行中样本 ${running.length}；长度递增 ${grew ? '✅ 是' : '❌ 否'}`)
console.log(`长度轨迹: ${running.slice(0, 14).join(' → ')}${running.length > 14 ? ' …' : ''}`)
console.log(`首个片段: ${JSON.stringify(live[0]?.head ?? null)}`)
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无')
await browser.close()
