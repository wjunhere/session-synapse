/**
 * 详情视图里的 markdown 渲染：mermaid 图、LaTeX 公式，以及这次补齐的语法。
 *
 * 办法是发一条**带这些语法的 prompt** —— prompt 本身就是会话里的一条用户消息，
 * 详情视图会渲染它，所以既不用假数据也不用等模型写出图来。断言看的是渲染结果
 * （`<svg>`、`<math>`、`<table>`…），而观感那部分只能看图（截图路径打在输出里）。
 *
 * 两条库是**按需加载**的：页面里没有图或公式时不请求 `/synapse/vendor/*`，
 * 所以这里也要验「不该加载时没加载」。
 */
import { launchBrowser } from './browser.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
if (PROBE_CWD === undefined) { console.log('需要 PROBE_CWD（一次性会话目录）'); process.exit(1) }
const MODEL = { provider: process.env.PROBE_PROVIDER ?? 'trae', modelId: process.env.PROBE_MODEL ?? 'DeepSeek-V4-Flash' }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const PROMPT = `请只回复"收到"，不要复述下面的内容。

\`\`\`mermaid
graph TD
  A[开始] --> B{判断}
  B -->|是| C[执行]
  B -->|否| D[结束]
\`\`\`

行内公式 $E = mc^2$，块公式：

$$
\\int_0^1 x^2 dx = \\frac{1}{3}
$$

| 项 | 值 |
|---|---|
| a | 1 |

1. 第一层
   - 第二层
     - 第三层
2. 回到第一层

- [x] 做完的
- [ ] 没做的

> 一句引用

---

见 https://example.com/a 和 [链接](https://example.com/b)。`

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${JSON.stringify(body).slice(0, 140)}`)
  return body
}

async function untilValue(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() > deadline) return null
    await sleep(1_000)
  }
}

const browser = await launchBrowser({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
const errors = []
const vendorRequests = []
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text().slice(0, 160)) })
page.on('request', request => { if (request.url().includes('/synapse/vendor/')) vendorRequests.push(request.url().split('/').pop()) })

let sessionId = null
try {
  const created = await api('/api/agent/new', { method: 'POST', body: JSON.stringify({ cwd: PROBE_CWD, type: 'ensure_session' }) })
  sessionId = created.sessionId
  if (typeof sessionId !== 'string') throw new Error(`无法创建一次性会话: ${JSON.stringify(created).slice(0, 140)}`)
  const post = payload => api(`/api/agent/${encodeURIComponent(sessionId)}`, { method: 'POST', body: JSON.stringify(payload) })
  await post({ type: 'set_model', ...MODEL })
  await post({ type: 'set_thinking_level', level: 'off' })
  await post({ type: 'prompt', message: PROMPT })

  const projected = await untilValue(async () => {
    const listed = (await api('/synapse/api/workspaces')).workspaces
    for (const summary of listed) {
      const full = await api(`/synapse/api/workspaces/${summary.id}`).catch(() => null)
      if (full === null) continue
      const thread = full.workspace.threads.find(item => item.sessionId === sessionId)
      if (thread !== undefined && (thread.messages ?? []).some(message => (message.text ?? '').includes('graph TD'))) return thread
    }
    return null
  }, 120_000)
  check('带语法的 prompt 进了投影（会话文件是真的）', projected !== null)

  await page.goto(`${BASE}/?session=${encodeURIComponent(sessionId)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3_000)
  await page.locator('.pi-synapse-switch button[data-view="map"]').click()
  await page.waitForTimeout(5_000)
  const frame = page.frames().find(candidate => candidate.url().includes('/synapse/'))
  if (frame === undefined) throw new Error('画布 iframe 未加载')
  await frame.waitForSelector('.canvas-tabs button[data-action="show-thread"]:not([disabled])', { timeout: 90_000 })
  await frame.locator('.canvas-tabs button[data-action="show-thread"]').click()
  await page.waitForTimeout(1_500)

  const readBlocks = () => frame.evaluate(() => ({
    mermaid: document.querySelectorAll('.md-mermaid[data-rich="done"] svg').length,
    mathInline: document.querySelectorAll('.md-math[data-rich="done"] math').length,
    mathBlock: document.querySelectorAll('.md-math-block[data-rich="done"] math').length,
    failed: document.querySelectorAll('[data-rich="error"]').length,
    table: document.querySelectorAll('.message-body table').length,
    nested: document.querySelectorAll('.message-body li li').length,
    task: document.querySelectorAll('.message-body .md-task').length,
    quote: document.querySelectorAll('.message-body blockquote').length,
    hr: document.querySelectorAll('.message-body hr').length,
    link: document.querySelectorAll('.message-body a.md-link').length,
    fence: document.querySelectorAll('.message-body pre.md-block').length,
  }))

  // 两个库是懒加载的：等到真的渲染出来
  const blocks = await untilValue(async () => {
    const state = await readBlocks()
    return state.mermaid > 0 && state.mathInline > 0 && state.mathBlock > 0 ? state : null
  }, 60_000)
  check('mermaid 围栏渲染成 SVG', (blocks?.mermaid ?? 0) > 0, JSON.stringify(blocks))
  check('行内公式与块公式都渲染成 MathML', (blocks?.mathInline ?? 0) > 0 && (blocks?.mathBlock ?? 0) > 0, `inline=${blocks?.mathInline} block=${blocks?.mathBlock}`)
  check('没有任何块渲染失败（失败会留在源码 + 标记）', (blocks?.failed ?? 1) === 0, `failed=${blocks?.failed}`)
  check('表格 / 嵌套列表 / 任务框 / 引用 / 分隔线 / 链接都在',
    (blocks?.table ?? 0) > 0 && (blocks?.nested ?? 0) > 0 && (blocks?.task ?? 0) === 2
    && (blocks?.quote ?? 0) > 0 && (blocks?.hr ?? 0) > 0 && (blocks?.link ?? 0) >= 2,
    JSON.stringify(blocks))
  check('两个 vendor 库都是按需请求的（这次请求了 mermaid 与 temml）',
    vendorRequests.includes('mermaid.js') && vendorRequests.includes('temml.js'), vendorRequests.join(',') || '(没有请求)')

  // 截图（观感只能看图）：滚到图和列表两处
  const shot = process.env.PROBE_SHOT ?? join(tmpdir(), 'verify-markdown.png')
  await frame.locator('.md-mermaid').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: shot, fullPage: false })
  await frame.locator('.message-body .md-task').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: shot.replace(/\.png$/, '-lists.png'), fullPage: false })
  console.log(`截图: ${shot} 与 ${shot.replace(/\.png$/, '-lists.png')}`)

  check('没有页面错误', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  check('套件自身没有崩', false, String(error?.message ?? error).slice(0, 300))
  console.log(error?.stack ?? error)
} finally {
  await browser.close()
  const failed = results.filter(item => !item.ok).length
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`)
  process.exitCode = failed > 0 ? 1 : 0
}
