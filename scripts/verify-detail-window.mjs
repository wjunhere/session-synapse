/**
 * 详情视图：只渲染转写的尾巴，且空闲时不动 DOM。
 *
 * 用户报的现象：进一条长会话的详情页之后一段时间滑动很卡，点「返回画布」要按好几下
 * 才生效。实测（923 条消息的会话）：
 *   - 详情视图把 923 条消息全渲染出来，每次写 DOM 782ms —— 1 秒一次的投影轮询
 *     只要发现**任何**工作区变了就重写一遍，于是每秒冻一次；
 *   - 点击落在被换掉的节点上就没了（「返回画布」因此要点好几次）；
 *   - 流式回复期间每 120ms 再来一次整树重建。
 *
 * 修法（三条，各对应一项断言）：
 *   1. 详情只渲染最近 `DETAIL_PAGE_SIZE` 条（宿主自己的会话页也是这么做的：最近 50 条 +
 *      按需加载更早的），点卡片带锚点时把窗口撑回那一轮；
 *   2. 打开的**这个**工作区没变就不重取、不重建（摘要里的 updatedAt/threadsUpdatedAt
 *      是它的变化信号）；建出来的 HTML 与上一次逐字相同就不写 DOM；
 *   3. 流式回复只补最后一条消息的正文，不整树重建。
 *
 * 需要真实的长会话才有意义（本套件只读会话文件，不改任何会话）。当前数据里没有超过
 * 一页的会话时，窗口那两项会 SKIP 并说明原因 —— 不假装验过。
 */
import { launchBrowser } from './browser.mjs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`) }
const skip = name => { console.log(`SKIP ${name}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${JSON.stringify(body).slice(0, 120)}`)
  return body
}

const PAGE = 50

const browser = await launchBrowser({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', error => errors.push('pageerror: ' + error.message))

let churn = null
try {
  // ── 找一条最长的会话（只读；不改它的任何东西）──
  const summaries = (await api('/synapse/api/workspaces')).workspaces
  let longest = null
  for (const summary of summaries) {
    const full = await api(`/synapse/api/workspaces/${summary.id}`).catch(() => null)
    if (full === null) continue
    for (const thread of full.workspace.threads) {
      const count = (thread.messages ?? []).length
      if (thread.sessionId !== null && (longest === null || count > longest.count)) longest = { count, thread, workspace: full.workspace }
    }
  }
  if (longest === null) throw new Error('数据里没有任何带会话的线程')
  console.log(`最长会话: ${longest.count} 条消息 (${longest.thread.sessionId})`)

  await page.goto(`${BASE}/?session=${encodeURIComponent(longest.thread.sessionId)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3_000)
  await page.locator('.pi-synapse-switch button[data-view="map"]').click()
  await page.waitForTimeout(5_000)
  const frame = page.frames().find(candidate => candidate.url().includes('/synapse/'))
  if (frame === undefined) throw new Error('画布 iframe 未加载')
  await frame.waitForSelector('.thread-card, .empty-canvas', { state: 'attached', timeout: 60_000 })

  const readDetail = () => frame.evaluate(() => {
    const scroller = document.querySelector('.detail-scroll')
    const first = scroller?.querySelector('.message')
    return {
      mode: window.__synapse.state.mode,
      rendered: document.querySelectorAll('.detail-scroll .message').length,
      earlier: document.querySelector('.detail-earlier')?.textContent ?? null,
      // The message at the TOP OF THE VIEWPORT, and where it sits on screen:
      // growing the window prepends rows, so that one must not move. (The first
      // row of the list is thousands of pixels above the viewport here — the
      // detail view lands on the newest message — so measuring that one would
      // measure nothing.)
      viewportSeq: (() => {
        const box = scroller?.getBoundingClientRect()
        if (box === undefined) return null
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 8)
        return hit?.closest('.message')?.getAttribute('data-message-seq') ?? null
      })(),
      viewportSeqTop: (() => {
        const box = scroller?.getBoundingClientRect()
        if (box === undefined) return null
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 8)
        return hit?.closest('.message')?.getBoundingClientRect().top ?? null
      })(),
      scrollTop: scroller?.scrollTop ?? null,
      scrollHeight: scroller?.scrollHeight ?? null,
      scrollerTop: scroller?.getBoundingClientRect().top ?? null,
      stats: window.__synapse.stats,
    }
  })

  // 画布打开工作区是异步的（首次投影可能还在跑），「详情」tab 在没线程时是 disabled 的，
  // 直接点会等 30 秒超时 —— 先等它可用。
  const detailTab = '.canvas-tabs button[data-action="show-thread"]:not([disabled])'
  try {
    await frame.waitForSelector(detailTab, { timeout: 90_000 })
  } catch (error) {
    const state = await frame.evaluate(() => ({
      workspace: window.__synapse.state.workspace?.id ?? null,
      threads: window.__synapse.state.workspace?.threads?.length ?? null,
      activeId: window.__synapse.state.activeId ?? null,
      mode: window.__synapse.state.mode,
      hostSession: window.__synapse.state.currentSession?.id ?? null,
      tabs: [...document.querySelectorAll('.canvas-tabs button')].map(button => `${button.dataset.action}${button.disabled ? '(disabled)' : ''}`),
    })).catch(() => null)
    throw new Error(`「详情」tab 一直不可用：${JSON.stringify(state)}`)
  }
  await frame.locator(detailTab).click()
  await page.waitForTimeout(1_200)
  const opened = await readDetail()
  check('进详情视图', opened.mode === 'thread', JSON.stringify({ mode: opened.mode, rendered: opened.rendered }))

  if (longest.count <= PAGE) {
    skip(`详情视图只渲染最近 ${PAGE} 条（数据里最长的会话只有 ${longest.count} 条）`)
    skip('点「显示更早的」把窗口撑大且不跳位（同上）')
  } else {
    check(`详情视图只渲染最近 ${PAGE} 条，不是全部 ${longest.count} 条`, opened.rendered === PAGE, `渲染 ${opened.rendered} 条`)
    check('转写顶部出现「显示更早的」', typeof opened.earlier === 'string' && opened.earlier.includes('显示更早的'), String(opened.earlier))

    // 点「显示更早的」：窗口 +50，而且刚补进来的（更早的）那几条就在眼前 —— 按钮在
    // 转写最上面，点它的人本来就停在顶部想继续往上读，补进来的内容跑到视口上方
    // 就等于「点了没反应」。
    const before = await readDetail()
    await frame.locator('.detail-earlier').click()
    await page.waitForTimeout(600)
    const after = await readDetail()
    check('点「显示更早的」后多渲染 50 条', after.rendered === before.rendered + PAGE, `${before.rendered} → ${after.rendered}`)
    const visible = await frame.evaluate(() => {
      const scroller = document.querySelector('.detail-scroll')
      const first = scroller?.querySelector('.message')
      if (scroller === null || first == null) return null
      const box = scroller.getBoundingClientRect()
      const row = first.getBoundingClientRect()
      return { scrollTop: scroller.scrollTop, inView: row.top >= box.top - 1 && row.top < box.bottom }
    })
    check('补进来的最早那条就在视口里（点完不用再往上滚）', visible !== null && visible.inView, JSON.stringify(visible))
  }

  // ── 空闲：别的会话在动，详情视图不许重建 ──
  // 噪声是真实的 PATCH（侧栏眼睛图标那一下），只动隔离 data 文件，不碰会话。
  const other = summaries.find(summary => summary.id !== longest.workspace.id && summary.threadCount > 0)
  if (other === undefined) {
    skip('别的会话在动时详情视图不重建（数据里没有第二个工作区）')
  } else {
    const otherFull = await api(`/synapse/api/workspaces/${other.id}`)
    const target = otherFull.workspace.threads[0]
    let hidden = false
    churn = setInterval(() => {
      hidden = !hidden
      void fetch(`${BASE}/synapse/api/threads/${target.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hidden }) }).catch(() => {})
    }, 1_000)
    const start = await readDetail()
    await sleep(7_000)
    const end = await readDetail()
    check('别的会话在动时：详情视图一次都没重写 DOM', end.stats.writes === start.stats.writes, `writes ${start.stats.writes} → ${end.stats.writes}`)
    check('别的会话在动时：连 render 都没跑（轮询按摘要跳过）', end.stats.renders === start.stats.renders, `renders ${start.stats.renders} → ${end.stats.renders}`)
    check('这 7 秒里渲染的消息数没变', end.rendered === start.rendered, `${start.rendered} → ${end.rendered}`)
    clearInterval(churn)
    churn = null
  }

  // ── 真鼠标点「返回画布」：不能被重建吞掉 ──
  // locator.click 会等元素稳定、失败会重试，正好把要测的东西遮住；这里用
  // page.mouse 按下 → 停 120ms → 松开，和人的点击一样不重试。
  const rawClick = async selector => {
    const locator = frame.locator(selector)
    if (await locator.count() === 0) return false
    const rect = await locator.boundingBox()
    const frameBox = await page.evaluate(() => {
      const element = document.querySelector('.pi-synapse-overlay iframe')
      const box = element?.getBoundingClientRect()
      return box === undefined ? null : { x: box.x, y: box.y }
    })
    if (rect === null || frameBox === null) return false
    await page.mouse.move(frameBox.x + rect.x + rect.width / 2, frameBox.y + rect.y + rect.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(120)
    await page.mouse.up()
    return true
  }
  const modeOf = () => frame.evaluate(() => window.__synapse.state.mode)
  let missed = 0
  for (let round = 0; round < 6; round += 1) {
    await frame.waitForSelector(detailTab, { timeout: 30_000 })
    await rawClick(detailTab)
    await page.waitForTimeout(300)
    if (await modeOf() !== 'thread') { missed += 1; continue }
    await rawClick('.detail-head button[data-action="show-canvas"]')
    await page.waitForTimeout(350)
    if (await modeOf() !== 'canvas') missed += 1
  }
  check('真鼠标点「返回画布」6 次全部生效', missed === 0, `${missed} 次没生效`)

  check('全程没有页面错误', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  check('套件自身没有崩', false, String(error?.message ?? error).slice(0, 300))
  console.log(error?.stack ?? error)
} finally {
  if (churn !== null) clearInterval(churn)
  await browser.close()
  const failed = results.filter(item => !item.ok).length
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`)
  process.exitCode = failed > 0 ? 1 : 0
}
