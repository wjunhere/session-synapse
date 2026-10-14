/**
 * Branch (「分支」) end-to-end verification.
 *
 * Four regressions this guards, all measured in a real browser:
 *   1. The newest card of a thread must offer 「分支」. It used to be hidden by
 *      `childCount === 0 || canContinue === true`, i.e. on exactly the turn a
 *      user is most likely to branch from.
 *   2. An earlier card's 「分支」 must open the draft. It used to answer with
 *      「请等待这张卡片的最终回答后再创建分支」 because the entry id was run
 *      through `Number.isInteger()` — pi ids are 8 hex digits, never numbers.
 *   3. The fork must cut the parent history at the chosen turn. Without the
 *      entry id the host forks at the leaf; with `inheritedEntryCount` left at
 *      0 the child re-rendered the parent's whole conversation as its own
 *      turns (measured: 13 identical questions on a 13-turn session).
 *   4. The child thread must carry the seed boundary so the canvas knows which
 *      parent turn it hangs under.
 *
 * Writes a real session, so it needs PROBE_CWD and cleans up after itself.
 */
import { chromium } from 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
import { mkdir, rm } from 'node:fs/promises'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'
const PROBE_CWD = process.env.PROBE_CWD
if (PROBE_CWD === undefined) { console.log('需要 PROBE_CWD（一次性会话目录）'); process.exit(1) }
await mkdir(PROBE_CWD, { recursive: true })
const probeTitle = PROBE_CWD.split(/[\\/]/).filter(Boolean).at(-1)

const browser = await chromium.launch({ executablePath: 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1920, height: 1100 } })
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`) }

let created = null
try {
  await page.goto(`${BASE}/synapse`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  const frame = page.frames().find(f => f.url().includes('/synapse'))
  if (frame === undefined) throw new Error('画布 iframe 未加载')

  // 造一个一次性会话，发 3 轮真实消息（分支需要真实落盘的回答）
  created = await page.evaluate(async cwd => {
    const res = await fetch('/api/agent/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, type: 'ensure_session' }) })
    const body = await res.json()
    return body.sessionId ?? null
  }, PROBE_CWD)
  if (created === null) throw new Error('无法创建一次性会话')
  console.log('一次性会话:', created)
  await page.evaluate(async ({ sessionId }) => {
    const post = async body => fetch(`/api/agent/${encodeURIComponent(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    await post({ type: 'set_model', provider: 'trae', modelId: 'DeepSeek-V4-Flash' })
    // Thinking OFF. A reasoning model with thinking on may answer with thinking
    // only (measured: three `stop` replies whose content was one `thinking`
    // block and no prose), which projects to a usage entry with no answer — and
    // a turn with no answer has no branch button. The test would then fail on
    // its own probe instead of on the feature.
    await post({ type: 'set_thinking_level', level: 'off' })
  }, { sessionId: created })

  for (const text of ['第一轮：只回复 1', '第二轮：只回复 2', '第三轮：只回复 3']) {
    await page.evaluate(async ({ sessionId, text }) => {
      await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: text }) })
    }, { sessionId: created, text })
    // 等这一轮落盘（轮次由会话文件驱动，投影重扫才能看到）
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(3000)
      const running = await page.evaluate(async () => (await (await fetch('/api/agent/running')).json()).runningSessionIds ?? [])
      if (!running.includes(created)) break
    }
  }
  console.log('3 轮已落盘')

  // 切到探测工作区并等这个会话投影成卡片
  const options = await frame.evaluate(() => [...document.querySelectorAll('select option')].map(o => o.textContent ?? ''))
  const label = options.find(o => o.includes(probeTitle))
  if (label === undefined) throw new Error(`工作区下拉里找不到 ${probeTitle}`)
  await frame.locator('select').selectOption({ label })
  await page.waitForTimeout(3000)

  let threadId = null
  for (let i = 0; i < 30 && threadId === null; i++) {
    await page.waitForTimeout(3000)
    threadId = await frame.evaluate(async sessionId => {
      const list = await (await fetch('/synapse/api/workspaces')).json()
      for (const w of list.workspaces) {
        const full = await (await fetch(`/synapse/api/workspaces/${w.id}`)).json()
        const hit = full.workspace.threads.find(t => t.sessionId === sessionId)
        if (hit) return hit.id
      }
      return null
    }, created)
  }
  if (threadId === null) throw new Error('探测会话未投影成 thread')
  console.log('threadId:', threadId)

  // 选中并聚焦，让卡片挂载
  const mounted = async () => {
    await frame.evaluate(tid => document.querySelector(`.tree-row[data-thread="${tid}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })), threadId)
    await page.waitForTimeout(1800)
    await frame.evaluate(() => document.querySelector('[data-action="focus-active"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await page.waitForTimeout(1500)
    return frame.evaluate(tid => document.querySelectorAll(`.thread-card[data-thread="${tid}"]`).length, threadId)
  }
  let cardCount = 0
  for (let i = 0; i < 10 && cardCount < 3; i++) cardCount = await mounted()
  console.log('挂载卡片数:', cardCount)
  check('探测会话的 3 轮都挂载成卡片', cardCount >= 3, `实际 ${cardCount}`)

  // 断言 1：最新卡有分支按钮
  const newest = await frame.evaluate(tid => {
    const cards = [...document.querySelectorAll(`.thread-card[data-thread="${tid}"]`)]
    const last = cards.at(-1)
    return {
      hasBranch: last?.querySelector('.graph-branch-button') !== null,
      hasContinue: last?.querySelector('.graph-continue-button') !== null,
      seq: last?.querySelector('.graph-branch-button')?.dataset.seq ?? null,
      tail: last?.dataset.cardId?.split(':turn:').at(-1) ?? null,
    }
  }, threadId)
  check('最新卡有分支按钮', newest.hasBranch === true, JSON.stringify(newest))
  check('最新卡同时也保留追问按钮', newest.hasContinue === true, `hasContinue=${newest.hasContinue}`)

  // 断言 2：旧卡的分支按钮能打开草稿（不再报「请等待…」）
  const clicked = await frame.evaluate(tid => {
    const cards = [...document.querySelectorAll(`.thread-card[data-thread="${tid}"]`)]
    const target = cards[0]
    const button = target?.querySelector('.graph-branch-button')
    if (button === null || button === undefined) return { ok: false, reason: '第一张卡没有分支按钮' }
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return { ok: true, seq: button.dataset.seq, card: button.dataset.card }
  }, threadId)
  await page.waitForTimeout(1500)
  const draft = await frame.evaluate(() => ({
    open: document.querySelector('[data-draft]') !== null,
    heading: document.querySelector('.draft-card .thread-card-head strong')?.textContent?.trim() ?? null,
    alert: document.querySelector('.status-message[role="alert"]')?.textContent ?? null,
  }))
  check('旧卡能打开分支草稿（不再报错）', clicked.ok === true && draft.open === true && draft.alert === null, JSON.stringify({ clicked, draft }))
  check('草稿标题是「新的分支」', draft.heading === '新的分支', String(draft.heading))

  // 断言 3+4：提交分支，子会话只含自己的轮次，且带 seed 边界
  const branchText = `分支验证 ${Date.now()}`
  await frame.evaluate(text => {
    const area = document.querySelector('[data-draft] textarea')
    area.value = text
    area.dispatchEvent(new Event('input', { bubbles: true }))
  }, branchText)
  await frame.evaluate(() => document.querySelector('[data-draft] button.primary')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  console.log('已提交分支:', branchText)

  let child = null
  for (let i = 0; i < 30 && child === null; i++) {
    await page.waitForTimeout(3000)
    // 按 parentId 找子线程，不能按 sessionId：分叉出来的是**新会话**，拿父会话
    // 的 sessionId 去查只会命中父自己（上一版就是这么误判的）。
    child = await frame.evaluate(async parentThreadId => {
      const list = await (await fetch('/synapse/api/workspaces')).json()
      for (const w of list.workspaces) {
        const full = await (await fetch(`/synapse/api/workspaces/${w.id}`)).json()
        const hit = full.workspace.threads.find(t => t.parentId === parentThreadId)
        if (hit) return { id: hit.id, users: hit.messages.filter(m => m.kind === 'user').length, seed: hit.sourceSeedLength ?? null, parentId: hit.parentId, firstQ: String(hit.messages.find(m => m.kind === 'user')?.text ?? '').slice(0, 20) }
      }
      return null
    }, threadId)
    if (child !== null && child.users >= 1) break
  }
  console.log('子线程:', JSON.stringify(child))
  check('分支线程已投影', child !== null)
  if (child !== null) {
    // 分支自己那条 prompt 落盘前 users 会是 0，所以这里轮询到它出现为止；
    // 同时这也是一次真实的「父历史有没有被复制」检验：未截断的话会先出现 3。
    for (let i = 0; i < 30 && child.users === 0; i++) {
      await page.waitForTimeout(3000)
      child = await frame.evaluate(async parentThreadId => {
        const list = await (await fetch('/synapse/api/workspaces')).json()
        for (const w of list.workspaces) {
          const full = await (await fetch(`/synapse/api/workspaces/${w.id}`)).json()
          const hit = full.workspace.threads.find(t => t.parentId === parentThreadId)
          if (hit) return { id: hit.id, users: hit.messages.filter(m => m.kind === 'user').length, seed: hit.sourceSeedLength ?? null, parentId: hit.parentId, firstQ: String(hit.messages.find(m => m.kind === 'user')?.text ?? '').slice(0, 20) }
        }
        return null
      }, threadId)
    }
    console.log('子线程（等 prompt 落盘后）:', JSON.stringify(child))
    // 父有 3 轮 + 分支自己 1 轮；未截断的话这里会是 4（父的 3 轮被复制）
    check('分支只含自己的轮次（父历史被截断）', child.users === 1, `users=${child.users}（未截断会是 4）`)
    check('分支第一问是自己的问题', child.firstQ.startsWith('分支验证') === true, `firstQ=${child.firstQ}`)
    check('分支带 seed 边界', typeof child.seed === 'string' && child.seed !== '', `seed=${child.seed}`)
    check('分支挂在父 thread 下', child.parentId === threadId, `parentId=${String(child.parentId)?.slice(0, 8)} vs ${threadId.slice(0, 8)}`)
  }
} catch (error) {
  check('验证过程无异常', false, error?.message ?? String(error))
} finally {
  await browser.close()
  // 一次性会话与其 cwd 必须清掉：它会污染会话目录、pi-web 的 projectOrder
  // 和画布数据文件。清理放在停服后由调用方完成（见 AGENTS.md 探测纪律）。
  await rm(PROBE_CWD, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter(r => !r.ok)
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) process.exit(1)
