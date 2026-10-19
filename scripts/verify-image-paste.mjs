// 卡片内粘贴图片（新会话草稿 + 追问草稿）。
//
// 端到端断言四件事，任一环断了都能定位：
//   1. 粘贴后出现缩略图（blob: 预览）
//   2. 宿主收到的 prompt 请求带上了 images（type/mimeType/base64）
//   3. 图片真的落进**会话文件**（用请求里的 sessionId 精确定位文件）
//   4. 投影保留 imageCount（否则卡片标题会变成空白），且发送后草稿清空
//
// 会话与 cwd 都是一次性的，测完由调用方清理。
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
import { mkdir } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

/**
 * A real PNG, built here rather than committed as a fixture.
 *
 * It has to be a genuine image: pi runs every attachment through its image
 * pipeline, and a hand-rolled 1x1 base64 blob is rejected as undecodable —
 * which would look like "the paste never reached the host".
 */
function makePng(width = 96, height = 64) {
  const rawRows = []
  for (let y = 0; y < height; y++) {
    const row = [0]
    for (let x = 0; x < width; x++) row.push((x * 255 / width) | 0, (y * 255 / height) | 0, 128)
    rawRows.push(Buffer.from(row))
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rawRows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const EXE = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
// Overridable like the other probe suites: a provider that answers with an empty
// body makes the "the reply mentions the image" check fail on the probe rather
// than on the feature.
const MODEL = { provider: process.env.PROBE_PROVIDER ?? 'trae', modelId: process.env.PROBE_MODEL ?? 'DeepSeek-V4-Flash' }
const PNG_BASE64 = makePng().toString('base64')
// PROBE_CWD 必须先存在：POST /api/agent/new 对不存在的目录返回 400（不是「代理坏了」）。
await mkdir(PROBE_CWD, { recursive: true })

const browser = await chromium.launch({ executablePath: EXE })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

/** 轮询直到谓词成立，返回命中的值或 null。 */
async function until(read, predicate, { attempts = 25, intervalMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const value = await read()
    if (predicate(value)) return value
    await page.waitForTimeout(intervalMs)
  }
  return null
}

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(4000)
const frame = page.frames().find(f => f.url().includes('/synapse/'))

// 探测工作区必须先存在，否则「新会话」会建到别的 cwd（selectOption 会静默失败）
const seeded = await page.evaluate(async ({ cwd, model }) => {
  const created = await (await fetch('/api/agent/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, type: 'ensure_session' }) })).json()
  if (typeof created.sessionId !== 'string') return null
  await fetch(`/api/agent/${encodeURIComponent(created.sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'set_model', ...model }) })
  await fetch(`/api/agent/${encodeURIComponent(created.sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: '请只回复两个字：好的。' }) })
  return created.sessionId
}, { cwd: PROBE_CWD, model: MODEL })
console.log('预置会话:', seeded)
if (seeded === null) { console.log('FAIL 预置会话失败'); await browser.close(); process.exit(1) }

const probeTitle = PROBE_CWD.split(/[\\/]/).filter(Boolean).at(-1)
const options = await until(
  () => frame.locator('select option').allTextContents(),
  list => list.some(option => option.includes(probeTitle)),
)
if (options === null) { console.log('FAIL 探测工作区没有出现在画布上'); await browser.close(); process.exit(1) }
await frame.locator('select').selectOption({ label: options.find(option => option.includes(probeTitle)) })
await page.waitForTimeout(4000)

// 记录画布发往宿主的所有 agent 命令：这是画布与宿主的边界
await frame.evaluate(() => {
  window.__prompts = []
  const original = window.fetch
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? ''
    if (typeof url === 'string' && url.includes('/api/agent/') && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        window.__prompts.push({ type: body.type, sessionId: body.sessionId, message: body.message ?? null, images: body.images ?? null })
      } catch { /* not our command */ }
    }
    return original(input, init)
  }
})

const pasteIntoDraft = base64 => frame.evaluate(async data => {
  const textarea = document.querySelector('[data-draft] textarea')
  if (textarea === null) return { ok: false, reason: '没有草稿输入框' }
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0))
  const transfer = new DataTransfer()
  transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
  textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  return { ok: true, bytes }
}, base64)

const draftImages = () => frame.evaluate(() => ({
  thumbnails: document.querySelectorAll('.draft-image img').length,
  blobUrl: (document.querySelector('.draft-image img')?.getAttribute('src') ?? '').startsWith('blob:'),
  counter: document.querySelector('.draft-attach-count')?.textContent ?? '',
  // 画布内部状态：模块化后不再有裸 `state` 全局，改用画布显式暴露的句柄。
  error: window.__synapse.state.error,
}))

/** 从请求里的 sessionId 定位会话文件（文件名以 sessionId 结尾）。 */
const sessionFile = sessionId => {
  const root = join(homedir(), '.pi', 'agent', 'sessions')
  for (const dir of readdirSync(root)) {
    for (const name of readdirSync(join(root, dir))) {
      if (name.endsWith(`_${sessionId}.jsonl`)) return join(root, dir, name)
    }
  }
  return null
}
const userImageBlocks = file => {
  let count = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry?.type !== 'message' || entry.message?.role !== 'user') continue
    const blocks = Array.isArray(entry.message.content) ? entry.message.content : []
    count += blocks.filter(block => block?.type === 'image' && typeof block.data === 'string' && block.data.length > 100).length
  }
  return count
}

// ── A. 新会话草稿 ──
await frame.evaluate(() => document.querySelector('[data-action="create-session"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
await page.waitForTimeout(1500)
console.log('A 粘贴:', JSON.stringify(await pasteIntoDraft(PNG_BASE64)))
const previewA = await until(draftImages, state => state.thumbnails === 1)
console.log('A 预览:', JSON.stringify(previewA))
await frame.evaluate(() => document.querySelector('[data-draft]')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
const promptA = await until(
  () => frame.evaluate(() => (window.__prompts ?? []).find(prompt => prompt.type === 'prompt' && Array.isArray(prompt.images) && prompt.images.length > 0) ?? null),
  value => value !== null,
)
if (promptA === null) {
  // 失败时把现场全部打出来：记录了哪些命令、草稿还在不在、有没有错误提示
  console.log('A 未捕获到带图 prompt，现场:', JSON.stringify(await frame.evaluate(() => {
    const { state } = window.__synapse
    return {
      recorded: (window.__prompts ?? []).map(prompt => prompt.type ?? '(无 type)'),
      draft: state.draft === null ? null : { kind: state.draft.kind, sending: state.draft.sending, images: (state.draft.images ?? []).length, text: state.draft.text },
      error: state.error,
      statusText: document.querySelector('.status-message')?.textContent ?? null,
      capabilities: state.capabilities,
    }
  })))
}
console.log('A 宿主收到的 prompt:', JSON.stringify(promptA === null ? null : { sessionId: promptA.sessionId, message: promptA.message, images: promptA.images.length, type: promptA.images[0]?.type, mime: promptA.images[0]?.mimeType, b64: String(promptA.images[0]?.data ?? '').length }))

// ── B. 追问草稿（在预置会话上，模型已知可用，能验落盘）──
const seededThreadId = await frame.evaluate(async sessionId => {
  const list = await (await fetch('/synapse/api/workspaces')).json()
  for (const workspace of list.workspaces) {
    const full = await (await fetch(`/synapse/api/workspaces/${workspace.id}`)).json()
    const hit = full.workspace.threads.find(thread => thread.sessionId === sessionId)
    if (hit !== undefined) return hit.id
  }
  return null
}, seeded)
await frame.evaluate(threadId => document.querySelector(`.tree-row[data-thread="${threadId}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })), seededThreadId)
await page.waitForTimeout(2000)
// 重试到出现为止：画布只挂视口附近的卡，而投影/镜头都是最终一致的
let opened = false
for (let i = 0; i < 10 && !opened; i++) {
  opened = await frame.evaluate(threadId => {
    const button = [...document.querySelectorAll('[data-action="open-continue"]')].find(candidate => candidate.dataset.thread === threadId)
    if (button === undefined) {
      document.querySelector(`.tree-row[data-thread="${threadId}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      document.querySelector('[data-action="focus-active"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return false
    }
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, seededThreadId)
  if (!opened) await page.waitForTimeout(1500)
}
await page.waitForTimeout(1500)
console.log('B 打开追问草稿:', opened)
if (!opened) { console.log('FAIL 没有可用的追问入口'); await browser.close(); process.exit(1) }
console.log('B 粘贴:', JSON.stringify(await pasteIntoDraft(PNG_BASE64)))
const previewB = await until(draftImages, state => state.thumbnails === 1)
console.log('B 预览:', JSON.stringify(previewB))
await frame.evaluate(() => {
  const textarea = document.querySelector('[data-draft] textarea')
  textarea.value = '这张图主色是什么？'
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('[data-draft]')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
})
const promptB = await until(
  () => frame.evaluate(sessionId => (window.__prompts ?? []).find(prompt => prompt.type === 'prompt' && prompt.sessionId === sessionId && Array.isArray(prompt.images) && prompt.images.length > 0) ?? null, seeded),
  value => value !== null,
)
console.log('B 宿主收到的 prompt:', JSON.stringify(promptB === null ? null : { sessionId: promptB.sessionId, targetedSeeded: promptB.sessionId === seeded, message: promptB.message, images: promptB.images.length, mime: promptB.images[0]?.mimeType }))

// 落盘 + 投影（都是最终一致的，轮询到出现为止）
let onDisk = 0
let projected = null
let draftCleared = null
if (promptB !== null) {
  const file = sessionFile(seeded)
  onDisk = (await until(() => Promise.resolve(file === null ? 0 : userImageBlocks(file)), count => count > 0)) ?? 0
  projected = await until(
    () => frame.evaluate(async sessionId => {
      const list = await (await fetch('/synapse/api/workspaces')).json()
      for (const workspace of list.workspaces) {
        const full = await (await fetch(`/synapse/api/workspaces/${workspace.id}`)).json()
        const hit = full.workspace.threads.find(thread => thread.sessionId === sessionId)
        if (hit !== undefined) return { imageCounts: hit.messages.filter(message => message.kind === 'user').map(message => message.imageCount ?? 0), title: hit.title }
      }
      return null
    }, seeded),
    value => value !== null && value.imageCounts.some(count => count === 1),
  )
  draftCleared = await until(draftImages, state => state.thumbnails === 0)
}
console.log('B 会话文件里的用户图片块:', onDisk)
console.log('B 投影出的用户消息:', JSON.stringify(projected))

const previewOk = previewA?.thumbnails === 1 && previewA?.blobUrl === true && previewB?.thumbnails === 1 && previewB?.blobUrl === true
const requestOk = promptA !== null && promptB !== null
  && promptA.images[0]?.type === 'image' && promptA.images[0]?.mimeType === 'image/png' && String(promptA.images[0]?.data ?? '').length > 100
  && promptB.images[0]?.mimeType === 'image/png'
const storedOk = onDisk >= 1
const projectedOk = projected !== null && projected.imageCounts.some(count => count === 1)
const clearedOk = draftCleared?.thumbnails === 0

console.log()
console.log(previewOk ? 'PASS 粘贴后出现缩略图（新会话 + 追问）' : `FAIL 缩略图异常: ${JSON.stringify({ previewA, previewB })}`)
console.log(requestOk ? 'PASS prompt 请求带上了图片（type/mimeType/base64）' : 'FAIL prompt 请求没带图片')
console.log(storedOk ? `PASS 图片落进会话文件（${onDisk} 个图片块）` : 'FAIL 会话文件里没有图片块')
console.log(projectedOk ? `PASS 投影保留 imageCount（${JSON.stringify(projected)}）` : `FAIL 投影丢了 imageCount: ${JSON.stringify(projected)}`)
console.log(clearedOk ? 'PASS 发送后草稿清空' : 'FAIL 发送后草稿里还留着缩略图')
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无')
await browser.close()
process.exit(previewOk && requestOk && storedOk && projectedOk && clearedOk ? 0 : 1)
