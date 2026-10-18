#!/usr/bin/env node
/**
 * DSH 适配的回归套件：起一个**隔离的 harness**，把画布当作它的插件来验。
 *
 * 与 `verify-all.mjs` 那 23 个套件分开，因为两者的世界不一样：那套要 pi-web 先在
 * 30100 跑着（画布是它的反代下游），这一套要自己拉起一个 harness（画布是它的插件，
 * 同进程），而且必须用**临时 home**——往用户真实的 `~/.dsh` 里装插件、发消息、改会话名
 * 是不可接受的副作用。
 *
 * 这个脚本会真的调用模型（新建会话、发一条消息、看回答），和 `verify-send.mjs` 对
 * pi-web 做的事一样：投影/写操作链路的验证没法用替身，替身只能验证替身。
 *
 * 前置条件（缺一个就直接报错退出，不降级）：
 *   - `dsh` 在 PATH 上（`@deepseek-ai/dsh` CLI）
 *   - 有可用凭据：`$DSH_HOME/.credentials.yaml` 或 `~/.dsh/.credentials.yaml`
 *   - `--from-default-profile web` 需要本机存在默认 profile
 *
 * 用法：
 *   npm run verify:dsh
 *   DSH_VERIFY_PORT=30145 node scripts/verify-dsh.mjs
 *
 * 失败时保留临时 home 并打印路径（复现要看服务日志）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const PORT = Number(process.env.DSH_VERIFY_PORT ?? 30145)
const BASE = `http://127.0.0.1:${PORT}`
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Users/wjun/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
const PLAYWRIGHT = process.env.PLAYWRIGHT_CORE ?? 'file:///D:/Nodejs/node_global/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs'
const HOME = join(tmpdir(), `_dsh-verify-${Date.now()}`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ' — ' + detail}\n`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function fatal(message) {
  process.stderr.write(`verify-dsh: ${message}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 前置检查
// ---------------------------------------------------------------------------
const dshVersion = spawnSync('dsh', ['--version'], { encoding: 'utf8', shell: true })
if (dshVersion.status !== 0) fatal(`dsh CLI 不可用（${dshVersion.error?.message ?? dshVersion.status}）；先安装 @deepseek-ai/dsh`)
const credentials = [join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml'), join(homedir(), '.dsh', '.credentials.yaml')].find(existsSync)
if (credentials === undefined) fatal('找不到 .credentials.yaml；本套件会真的调模型，没有凭据就不跑')
process.stdout.write(`verify-dsh: 隔离 home ${HOME}，端口 ${PORT}（${dshVersion.stdout.trim()}）\n\n`)

// ---------------------------------------------------------------------------
// 起 harness
// ---------------------------------------------------------------------------
mkdirSync(HOME, { recursive: true })
const env = { ...process.env, DSH_HOME: HOME }
function runDsh(args, { timeoutMs = 180_000 } = {}) {
  const result = spawnSync('dsh', args, { encoding: 'utf8', env, shell: true, timeout: timeoutMs })
  if (result.status !== 0) fatal(`dsh ${args.join(' ')} 失败：\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  return result.stdout ?? ''
}

runDsh(['rescue', '--from-default-profile', 'web', '--dump-config'])
cpSync(credentials, join(HOME, '.credentials.yaml'))
runDsh(['plugin', '--profile', 'rescue', 'add', `link:${ROOT}`])

const harness = spawn('dsh', ['rescue', '--no-open', '--port', String(PORT)], { env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
harness.stdout.on('data', chunk => { log += String(chunk) })
harness.stderr.on('data', chunk => { log += String(chunk) })
/** Kill the whole tree: the CLI spawns the harness as a child, and a survivor keeps writing. */
function stopHarness() {
  if (harness.exitCode !== null || harness.pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(harness.pid), '/T', '/F'], { stdio: 'ignore' })
  else harness.kill('SIGKILL')
}
async function cleanup({ keep }) {
  stopHarness()
  await sleep(1_000)
  if (keep) process.stdout.write(`\nverify-dsh: 临时 home 保留在 ${HOME}（服务日志在上面那段 stdout 里）\n`)
  else rmSync(HOME, { recursive: true, force: true })
}

for (let waited = 0; waited < 120_000; waited += 500) {
  if (/token=[A-Za-z0-9_-]+/.test(log)) break
  if (harness.exitCode !== null) { await cleanup({ keep: true }); fatal(`harness 提前退出（${harness.exitCode}）：\n${log}`) }
  await sleep(500)
}
const token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1]
if (token === undefined) { await cleanup({ keep: true }); fatal(`120s 内没有拿到 token：\n${log}`) }

// ---------------------------------------------------------------------------
// 浏览器断言
// ---------------------------------------------------------------------------
const { chromium } = await import(PLAYWRIGHT)
const browser = await chromium.launch({ executablePath: CHROME_PATH })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const pageErrors = []
page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text().slice(0, 200)) })
page.on('pageerror', error => pageErrors.push(`pageerror: ${String(error).slice(0, 200)}`))
let dialogAnswer = null
page.on('dialog', dialog => { void dialog.accept(dialogAnswer ?? '') })

/**
 * 新 home 首次启动会有引导弹窗（「预览版说明」等），它的遮罩会拦住指针事件 ——
 * 实测：不关掉它，Playwright 点画布按钮会一直重试到超时（`_mask_… intercepts
 * pointer events`）。弹窗自己的按钮用 DOM click 点，不走指针。
 *
 * 一次启动可能连出两个弹窗（第一个点完才挂第二个），所以不能「扫到没有就收工」：
 * 要连续两轮扫不到才认为清完了。
 */
async function dismissOnboarding(page) {
  let idleRounds = 0
  for (let round = 0; round < 10 && idleRounds < 2; round++) {
    const clicked = await page.evaluate(() => {
      const modals = [...document.querySelectorAll('div[role="presentation"]')].filter(root => root.querySelector('button') !== null)
      const modal = modals.at(-1)
      if (modal === undefined) return null
      const buttons = [...modal.querySelectorAll('button')]
      const button = buttons.find(candidate => /继续|稍后|关闭|跳过|取消|知道了/.test(candidate.textContent ?? '')) ?? buttons.at(-1)
      const label = (button?.textContent ?? '').trim()
      button?.click()
      return label === '' ? '（无标题按钮）' : label
    })
    if (clicked === null) {
      idleRounds += 1
      await sleep(2_000)
      continue
    }
    idleRounds = 0
    process.stdout.write(`verify-dsh: 关掉引导弹窗「${clicked}」\n`)
    await sleep(2_000)
  }
}

const store = () => page.evaluate(async () => {
  const { workspaces } = await (await fetch('/synapse/api/workspaces')).json()
  const threads = []
  for (const workspace of workspaces) {
    const full = await (await fetch(`/synapse/api/workspaces/${workspace.id}`)).json()
    for (const thread of full.workspace.threads) {
      threads.push({ id: thread.id, sessionId: thread.sessionId, sessionTitle: thread.sessionTitle, messages: thread.messages.map(message => `${message.kind}:${message.text}`) })
    }
  }
  return threads
})
const archivedInHost = () => JSON.parse(readFileSync(join(HOME, 'storages', 'workspace.json'), 'utf8')).global.archivedSessionIds ?? []

try {
  await page.goto(`${BASE}/?token=${token}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.synapse-switch button', { timeout: 30_000 })
  await dismissOnboarding(page)

  // A. 画布作为插件挂进了 DSH
  const switches = await page.locator('.synapse-switch button').count()
  check('切换条有「对话 / 会话地图」两个入口', switches === 2, `实际 ${switches}`)
  const frame = () => page.frames().find(candidate => candidate.url().includes('/synapse/'))
  const status = await page.evaluate(async () => (await fetch('/synapse/api/status')).json())
  check('插件声明自己是 dsh adapter', status.adapter === 'dsh', JSON.stringify(status.adapter))
  check('写操作通道是 synapse', status.writeTransport === 'synapse', JSON.stringify(status.writeTransport))
  const caps = status.capabilities ?? {}
  check('能力：读会话 + 五种写操作开着', caps.openSession === true && caps.createSession === true && caps.sendMessage === true && caps.forkSession === true && caps.renameSession === true && caps.archiveSession === true, JSON.stringify(caps))
  check('能力：没有按会话固定工具清单的宿主不做 btw/setTools', caps.btw === false && caps.setTools === false)

  await page.evaluate(() => document.querySelector('.synapse-switch button[data-view="map"]').click())
  await frame().waitForSelector('.thread-card, .empty-canvas', { timeout: 30_000 })
  const appText = await frame().evaluate(() => document.querySelector('#app')?.textContent?.length ?? 0)
  check('iframe 里画布真的渲染了', appText > 0, `#app ${appText} 字`)

  // B. 切换条长在宿主自己的头部操作区里（紧邻文件管理器），而不是浮在标题上
  const placement = () => page.evaluate(() => {
    const bar = document.querySelector('.synapse-switch')
    const corner = document.querySelector('[class*="_headerCorner"]')
    const header = corner?.closest('header')
    const centre = document.querySelector('[class*="_centerCol"]')
    const overlay = document.querySelector('.synapse-overlay')
    const rect = bar?.getBoundingClientRect()
    const hit = rect === undefined ? null : document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return {
      inCorner: bar?.parentElement === corner && corner !== null,
      firstChild: (corner?.firstElementChild?.className ?? '').toString().includes('synapse-switch'),
      overlay: { top: getComputedStyle(overlay).top, left: getComputedStyle(overlay).left, width: getComputedStyle(overlay).width },
      headerBottom: `${Math.round(header?.getBoundingClientRect().bottom ?? -1)}px`,
      centre: { left: `${Math.round(centre?.getBoundingClientRect().left ?? -1)}px`, width: `${Math.round(centre?.getBoundingClientRect().width ?? -1)}px` },
      sidebarVisible: document.querySelector('[class*="_sidebarCol"]') !== null,
      visible: rect !== undefined && rect.width > 0 && rect.height > 0,
      hitIsBar: hit?.closest('.synapse-switch') !== null && hit?.closest('.synapse-switch') !== undefined,
    }
  })
  const dialogPlacement = await placement()
  check('切换条落在宿主头部的操作区里', dialogPlacement.inCorner === true, JSON.stringify(dialogPlacement))
  check('排在操作区最前（紧邻文件管理器那排按钮）', dialogPlacement.firstChild === true)
  check('画布从头部下方开始（头部在地图视图里仍可见）', dialogPlacement.overlay.top === dialogPlacement.headerBottom, `overlay=${dialogPlacement.overlay.top} header=${dialogPlacement.headerBottom}`)
  check('画布只占中间那一列（宿主侧栏留在旁边）', dialogPlacement.overlay.left === dialogPlacement.centre.left && dialogPlacement.overlay.width === dialogPlacement.centre.width && dialogPlacement.sidebarVisible, `overlay=${JSON.stringify(dialogPlacement.overlay)} centre=${JSON.stringify(dialogPlacement.centre)}`)

  const mapPlacement = await placement()
  check('地图视图下切换条仍可见且没被画布盖住', mapPlacement.visible && mapPlacement.hitIsBar, JSON.stringify(mapPlacement))

  // C. 画布带多少 chrome：这个宿主已经有自己的侧栏和头部，画布什么都不带
  const chrome = await frame().evaluate(() => {
    const shell = document.querySelector('.synapse-shell')
    const controls = document.querySelector('.canvas-controls')
    const viewport = document.querySelector('.canvas-viewport')
    const card = document.querySelector('.thread-card')
    const root = getComputedStyle(document.documentElement)
    const rect = controls?.getBoundingClientRect()
    const visibleCards = [...document.querySelectorAll('.thread-card')].filter(node => { const r = node.getBoundingClientRect(); return r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight }).length
    return {
      embedded: shell?.classList.contains('embedded') === true,
      sidebarGone: document.querySelector('.sidebar') === null,
      topbarGone: document.querySelector('.topbar') === null,
      tabsGone: document.querySelector('.canvas-tabs') === null,
      controls: rect === undefined ? null : { right: Math.round(window.innerWidth - rect.right), bottom: Math.round(window.innerHeight - rect.bottom), width: Math.round(rect.width) },
      hostBg: root.getPropertyValue('--host-bg').trim(),
      canvasBg: viewport === null ? '' : getComputedStyle(viewport).backgroundColor,
      hostFont: root.getPropertyValue('--host-font').trim(),
      cardFont: card === null ? '' : getComputedStyle(card.querySelector('.thread-title') ?? card).fontFamily.trim(),
      visibleCards,
    }
  })
  check('画布切到嵌入模式（自己的壳全部不渲染）', chrome.embedded && chrome.sidebarGone && chrome.topbarGone && chrome.tabsGone, JSON.stringify(chrome))
  check('工具变成右下角的浮动簇', chrome.controls !== null && chrome.controls.width > 0 && chrome.controls.right < 40 && chrome.controls.bottom < 40, JSON.stringify(chrome.controls))
  check('背景跟随宿主 token', chrome.hostBg !== '' && chrome.canvasBg !== '', `host=${chrome.hostBg} canvas=${chrome.canvasBg}`)
  check('字体跟随宿主 token（画布不再自带一套字型）', chrome.hostFont !== '' && chrome.cardFont === chrome.hostFont, `host=${chrome.hostFont.slice(0, 30)} card=${chrome.cardFont.slice(0, 30)}`)
  check('地图打开时视口里就有卡片', chrome.visibleCards > 0, `可见 ${chrome.visibleCards} 张`)

  // D. 宿主文案：画布不该在 DSH 里自称 pi-web
  const hostButton = await frame().evaluate(() => document.querySelector('.thread-card [data-action="open-host"]')?.textContent?.trim() ?? '')
  check('卡片页脚按宿主命名（DSH）', hostButton.includes('DSH'), JSON.stringify(hostButton))

  // D. 发消息（真模型）
  //
  // 第一条在 DSH 自己的输入框里发：嵌入模式下画布不再有自己的侧栏，也就没有
  // 它的「新会话」按钮 —— 第一条消息本来就属于宿主，画布是在会话已经有内容
  // 之后才把它画成卡片的（空会话会被当作 blank 剪掉）。然后从卡片上的「追问」
  // 发第二条，验的是画布 → /synapse/api/host/prompt 这条路。
  //
  // 必须先切回「对话」：地图视图下画布遮罩就盖在输入框上面，点它只会超时。
  await page.evaluate(() => document.querySelector('.synapse-switch button[data-view="dialog"]').click())
  await sleep(1_500)
  const composer = page.locator('[contenteditable=true]').first()
  await composer.click()
  await composer.type('画布发来的第一条消息')
  await page.keyboard.press('Enter')
  let created = null
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(2_000)
    created = (await store()).find(thread => thread.messages.some(text => text.includes('画布发来的第一条消息')))
    if (created !== undefined && created.messages.some(text => text.startsWith('assistant:'))) break
  }
  check('宿主里发的第一条消息在画布上画成了卡片', created !== undefined, created === undefined ? '卡片没出现' : `sessionId=${created.sessionId}`)
  check('模型真的回答了（写操作 + 投影闭环）', created?.messages.some(text => text.startsWith('assistant:')) === true, JSON.stringify(created?.messages.at(-1)?.slice(0, 60) ?? null))

  // 回到地图，后面都是画布上的动作
  await page.evaluate(() => document.querySelector('.synapse-switch button[data-view="map"]').click())
  await sleep(2_000)

  // 从卡片上追问：这条走画布自己的写通道
  const CONTINUE = '.thread-card [data-action="open-continue"]'
  let hasContinue = false
  for (let attempt = 0; attempt < 20 && !hasContinue; attempt++) {
    await sleep(1_500)
    hasContinue = await frame().evaluate(selector => document.querySelector(selector) !== null, CONTINUE)
  }
  check('卡片上有「追问」入口', hasContinue === true)
  if (hasContinue) {
    await frame().click(CONTINUE)
    await frame().waitForSelector('[data-draft] textarea', { timeout: 15_000 })
    await frame().fill('[data-draft] textarea', '画布追问的一句')
    await frame().click('[data-draft] button[type="submit"]')
    let followed = null
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(2_000)
      followed = (await store()).find(thread => thread.messages.some(text => text.includes('画布追问的一句')))
      if (followed !== undefined) break
    }
    check('画布发出的追问落进了同一个会话', followed?.sessionId === created?.sessionId, `sessionId=${followed?.sessionId ?? '无'}`)
  }

  // E. 分支：画布的 entry id 要变成宿主的事件 seq
  //
  // 等卡片「落定」再找按钮：轮询期间那轮的答案可能还在流式（页面把 live 文本当成
  // pending 答案画上去，没有 sourceEntryId，也就没有分支入口），而 store() 读的是
  // 服务端的库，两者不同步。超时也要把卡片的状态报出来，否则失败无从判断。
  //
  // 全程用选择器而不是元素句柄：画布会因投影刷新重渲染，握住句柄再点会
  // `Element is not attached to the DOM`；frame().click(selector) 每次都重新解析。
  const BRANCH = '.thread-card [data-action="open-branch"]'
  let atSeq = null
  let cardState = '卡片还没出现'
  for (let attempt = 0; attempt < 40 && atSeq === null; attempt++) {
    await sleep(1_500)
    atSeq = await frame().evaluate(selector => document.querySelector(selector)?.dataset.seq ?? null, BRANCH)
    cardState = await frame().evaluate(() => {
      const state = window.__synapse?.state
      const cards = state?.canvasCards ?? []
      if (cards.length === 0) return '没有卡片'
      const card = cards.at(-1)
      return `${cards.length} 张卡，最后一张 answer=${card.answer === null ? 'null' : `${card.answer.pending === true ? 'pending' : 'settled'}:${card.answer.sourceEntryId ?? '-'}`}`
    })
  }
  check('卡片上有「分支」入口（这一轮有回答）', atSeq !== null, cardState)
  if (atSeq !== null) {
    await frame().click(BRANCH)
    await frame().waitForSelector('[data-draft] textarea', { timeout: 15_000 })
    await frame().fill('[data-draft] textarea', '这是分支上的问题')
    await frame().click('[data-draft] button[type="submit"]')
    let branched = null
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(2_000)
      branched = (await store()).find(thread => thread.messages.some(text => text.includes('这是分支上的问题')))
      if (branched !== undefined) break
    }
    check('分支会话被宿主真的 fork 出来', typeof branched?.sessionId === 'string' && branched.sessionId !== created?.sessionId, `卡片 data-seq=${atSeq} → ${branched?.sessionId ?? '无'}`)
  }

  // F. 改名
  dialogAnswer = '画布改的标题'
  await frame().click('.thread-card [data-action="rename-thread"]')
  let renamed = null
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(1_000)
    renamed = (await store()).find(thread => thread.sessionTitle === '画布改的标题')
    if (renamed !== undefined) break
  }
  check('改名写进了 DSH 的会话记录', renamed !== undefined, JSON.stringify(renamed?.sessionTitle ?? null))

  // G. 归档：先取消归档，好让这次点击真的产生一次状态变化
  const archiveButton = await frame().$('.thread-card[data-thread] [data-action="host-archive"]')
  const targetThread = await archiveButton?.evaluate(node => node.closest('.thread-card').dataset.thread)
  const targetSession = (await store()).find(thread => thread.id === targetThread)?.sessionId
  if (targetSession === undefined) {
    check('归档落进 DSH 的归档集', false, '找不到目标会话')
  } else {
    await page.evaluate(async id => {
      await fetch('/synapse/api/host/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, archived: false }) })
    }, targetSession)
    await sleep(4_000)
    const before = archivedInHost().includes(targetSession)
    // 画布会因投影刷新重渲染，元素句柄会失效，所以点之前重新取。
    await frame().click(`.thread-card[data-thread="${targetThread}"] [data-action="host-archive"]`)
    await sleep(4_000)
    const canvasError = await frame().evaluate(() => window.__synapse?.state.error ?? '')
    check('归档落进 DSH 的归档集', before === false && archivedInHost().includes(targetSession), `session=${targetSession}${canvasError === '' ? '' : ' 画布报错：' + canvasError}`)
  }

  // H. 宿主拒绝要带原文（画布能自己修的问题不该显示成服务器故障）
  //
  // 这一步故意打一个 400，浏览器会记一条「Failed to load resource」控制台错误，
  // 所以页面错误的断言只看这一步之前。
  const errorsBeforeRefusal = [...pageErrors]
  const refused = await page.evaluate(async id => {
    const response = await fetch('/synapse/api/host/fork', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, entryId: '99999999' }) })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, created?.sessionId ?? '')
  check('不存在的分支位置回 400 带宿主原话', refused.status === 400 && /does not exist|not found/.test(refused.body?.error ?? ''), `${refused.status} ${JSON.stringify(refused.body)}`)

  check('全程没有页面错误', errorsBeforeRefusal.length === 0, errorsBeforeRefusal.slice(0, 3).join(' | '))
} catch (error) {
  // 崩了也要算失败并清理：上一版把 cleanup 写在 try 之外，一次超时就把 harness
  // 留在 30145 上继续活着（下一个 run 直接 EADDRINUSE），而且它还在写临时 home。
  check('套件自身没有崩', false, String(error?.message ?? error).slice(0, 200))
  process.stdout.write(`${error?.stack ?? error}\n`)
} finally {
  await browser.close()
  const failed = results.filter(result => !result.ok).length
  process.stdout.write(`\n合计 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}\n`)
  await cleanup({ keep: failed > 0 })
  process.exitCode = failed > 0 ? 1 : 0
}
