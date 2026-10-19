#!/usr/bin/env node
/**
 * DSH 适配的回归套件：起一个**隔离的 harness**，把画布当作它的插件来验。
 *
 * 与 `verify-all.mjs` 那 23 个套件分开，因为两者的世界不一样：那套要 pi-web 先在
 * 30100 跑着（画布是它的反代下游），这一套要自己拉起一个 harness（画布是它的插件，
 * 同进程），而且必须用**临时 home**——往用户真实的 `~/.dsh` 里装插件、发消息、改会话名
 * 是不可接受的副作用。
 *
 * 这个脚本会真的调用模型（新建会话、发一条消息、看回答、让侧问自报有没有 pwsh），
 * 和 `verify-send.mjs` 对 pi-web 做的事一样：投影/写操作链路的验证没法用替身，替身
 * 只能验证替身。
 *
 * 重启之后的行为不在这里：整个套件活着的是同一个 harness。`/btw` 那半的进程重启
 * 验证在一个临时探针里（它自己会重启 harness，不进仓库）。
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
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const PORT = Number(process.env.DSH_VERIFY_PORT ?? 30145)
const BASE = `http://127.0.0.1:${PORT}`
import { launchBrowser, resolveBrowser } from './browser.mjs'
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
const browser = await launchBrowser()
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
      threads.push({
        id: thread.id,
        sessionId: thread.sessionId,
        sessionTitle: thread.sessionTitle,
        parentId: thread.parentId ?? null,
        kind: thread.kind ?? 'branch',
        tools: thread.tools ?? null,
        // 工具调用名从投影的 process 里读：它是「这一轮真调了什么」的唯一证据。
        // `ran` 只算真的跑成了的（error === null）：模型可以「试图」调一个不存在的
        // 工具，那也会记一条调用（带 unknown tool 的 error）——那是被拒绝，不是有权限。
        calls: thread.messages.flatMap(message => (message.process ?? []).map(entry => entry.name)),
        ran: thread.messages.flatMap(message => (message.process ?? []).filter(entry => entry.error === null).map(entry => entry.name)),
        messages: thread.messages.map(message => `${message.kind}:${message.text}`),
      })
    }
  }
  return threads
})
const archivedInHost = () => JSON.parse(readFileSync(join(HOME, 'storages', 'workspace.json'), 'utf8')).global.archivedSessionIds ?? []

/**
 * 会话标签行里的标签文字。
 *
 * 宿主的 tablist 不止一个（侧栏也有一排），所以按「这一排里有 会话地图」认人 ——
 * 那是我们自己注册的标签，不会认错。没有会话视图时返回空数组。
 */
const conversationTabs = () => page.evaluate(() => {
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')]
    if (tabs.some(tab => (tab.textContent ?? '').trim() === '会话地图')) return tabs.map(tab => (tab.textContent ?? '').trim())
  }
  return []
})

/** 当前选中的会话标签（只在那排行里找）。 */
const activeConversationTab = () => page.evaluate(() => {
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')]
    if (!tabs.some(tab => (tab.textContent ?? '').trim() === '会话地图')) continue
    const active = tabs.find(tab => tab.getAttribute('aria-selected') === 'true') ?? tabs.find(tab => /Active/.test(tab.className))
    return active === undefined ? null : (active.textContent ?? '').trim()
  }
  return null
})

/** 点会话标签行里的某个标签；那一排不在时返回 false。 */
const clickConversationTab = label => page.evaluate(text => {
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')]
    if (!tabs.some(tab => (tab.textContent ?? '').trim() === '会话地图')) continue
    const tab = tabs.find(node => (node.textContent ?? '').trim() === text)
    if (tab === undefined) continue
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }
  return false
}, label)

/**
 * 切到画布：有标签就点宿主标签行里的「会话地图」，没有标签行时用浮动入口。
 *
 * 两种入口是产品设计的两半（标签是主入口，欢迎页那一屏没有标签行），所以
 * 验证脚本不能只认其中一种。
 */
async function showMap() {
  if (!(await clickConversationTab('会话地图'))) await page.evaluate(() => document.querySelector('.synapse-switch button[data-view="map"]').click())
  await sleep(1_500)
}

/** 切回对话：同上。 */
async function showDialog() {
  if (!(await clickConversationTab('对话'))) await page.evaluate(() => document.querySelector('.synapse-switch button[data-view="dialog"]').click())
  await sleep(1_500)
}

const overlayVisible = () => page.evaluate(() => {
  const overlay = document.querySelector('.synapse-overlay')
  return overlay !== null && overlay.hidden === false
})

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
  // `btw` 开：DSH 能把一个 agent 作用域钉住 + 给孩子上只读权限预设。
  // `setTools` 关：DSH 没有「按会话固定工具清单」这回事，不能假装有。
  check('能力：btw 开、setTools 关', caps.btw === true && caps.setTools === false, JSON.stringify(caps))

  await showMap()
  await frame().waitForSelector('.thread-card, .empty-canvas', { timeout: 30_000 })
  const appText = await frame().evaluate(() => document.querySelector('#app')?.textContent?.length ?? 0)
  check('iframe 里画布真的渲染了', appText > 0, `#app ${appText} 字`)

  // B. 没有会话时（欢迎页）地图只有一个浮动入口 —— 那一屏没有标签行
  const placement = () => page.evaluate(() => {
    const bar = document.querySelector('.synapse-switch')
    const centre = document.querySelector('[class*="_centerCol"]')
    const overlay = document.querySelector('.synapse-overlay')
    const rect = bar?.getBoundingClientRect()
    const hit = rect === undefined ? null : document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return {
      hidden: bar?.hidden === true,
      overlay: { top: getComputedStyle(overlay).top, left: getComputedStyle(overlay).left, width: getComputedStyle(overlay).width },
      centre: { left: `${Math.round(centre?.getBoundingClientRect().left ?? -1)}px`, width: `${Math.round(centre?.getBoundingClientRect().width ?? -1)}px` },
      sidebarVisible: document.querySelector('[class*="_sidebarCol"]') !== null,
      visible: rect !== undefined && rect.width > 0 && rect.height > 0,
      hitIsBar: hit?.closest('.synapse-switch') !== null && hit?.closest('.synapse-switch') !== undefined,
    }
  })
  const welcomePlacement = await placement()
  check('没有会话时浮动入口还在（否则这一屏进不了地图）', welcomePlacement.hidden === false && welcomePlacement.visible === true, JSON.stringify(welcomePlacement))
  check('浮动入口在地图之上、点得到', welcomePlacement.hitIsBar === true, JSON.stringify(welcomePlacement))
  check('画布只占中间那一列（宿主侧栏留在旁边）', welcomePlacement.overlay.left === welcomePlacement.centre.left && welcomePlacement.overlay.width === welcomePlacement.centre.width && welcomePlacement.sidebarVisible, `overlay=${JSON.stringify(welcomePlacement.overlay)} centre=${JSON.stringify(welcomePlacement.centre)}`)

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
  await showDialog()
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

  // B2. 有会话之后，地图的入口是宿主自己的一个标签（不是我们注入的按钮）
  const labels = await conversationTabs()
  check('「会话地图」是宿主标签行里的一个标签', labels.includes('会话地图'), JSON.stringify(labels))
  check('它排在宿主自己的标签后面', labels.indexOf('会话地图') === labels.length - 1 && labels.indexOf('对话') === 0, JSON.stringify(labels))
  check('有会话后浮动入口不再出现（入口只剩标签）', await page.evaluate(() => document.querySelector('.synapse-switch')?.hidden === true))
  check('刚打开会话时不在画布上（停在 对话 标签）', (await overlayVisible()) === false && (await activeConversationTab()) === '对话', `active=${await activeConversationTab()}`)

  await showMap()
  const tabPlacement = await page.evaluate(() => {
    const overlay = document.querySelector('.synapse-overlay')
    const centre = document.querySelector('[class*="_centerCol"]')
    let tab
    for (const list of document.querySelectorAll('[role="tablist"]')) {
      const tabs = [...list.querySelectorAll('[role="tab"]')]
      if (!tabs.some(node => (node.textContent ?? '').trim() === '会话地图')) continue
      tab = tabs.find(node => (node.textContent ?? '').trim() === '会话地图')
    }
    const rect = tab?.getBoundingClientRect()
    const hit = rect === undefined ? null : document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return {
      overlay: { left: getComputedStyle(overlay).left, width: getComputedStyle(overlay).width },
      centre: { left: `${Math.round(centre?.getBoundingClientRect().left ?? -1)}px`, width: `${Math.round(centre?.getBoundingClientRect().width ?? -1)}px` },
      tabClickable: hit?.closest('[role="tab"]') !== null && hit?.closest('[role="tab"]') !== undefined,
      sidebarVisible: document.querySelector('[class*="_sidebarCol"]') !== null,
    }
  })
  check('点「会话地图」标签出画布', (await overlayVisible()) === true && (await activeConversationTab()) === '会话地图', `active=${await activeConversationTab()}`)
  check('画布铺满中间那一列，且标签行仍在它上面（点得到）', tabPlacement.overlay.left === tabPlacement.centre.left && tabPlacement.overlay.width === tabPlacement.centre.width && tabPlacement.tabClickable === true && tabPlacement.sidebarVisible, JSON.stringify(tabPlacement))

  await showDialog()
  check('点「对话」标签收回画布', (await overlayVisible()) === false && (await activeConversationTab()) === '对话', `active=${await activeConversationTab()}`)

  // 回到地图，后面都是画布上的动作
  await showMap()
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

  // I. /btw 侧问：真 fork + 工具真的被钉 + 真的能答
  //
  // 这一项用一次真模型来证「工具面被砍」：让侧问自己说它有没有 pwsh。宿主把
  // 整套工具（含 pwsh）给普通会话，所以「没有 pwsh」只可能是因为被钉住了。
  const BTW = '.thread-card [data-action="open-btw"]'
  let hasBtw = null
  for (let attempt = 0; attempt < 20 && hasBtw === null; attempt++) {
    hasBtw = await frame().evaluate(selector => document.querySelector(selector)?.dataset.seq ?? null, BTW)
    if (hasBtw === null) await sleep(1_500)
  }
  check('卡片上有「侧问 /btw」入口', hasBtw !== null, String(hasBtw))
  let btwThread = null
  if (hasBtw !== null) {
    // 画布只占中间那一列：卡片贴着上沿时它的侧问按钮会落在宿主头部底下，卡片靠左
    // 时草稿卡的 chips 会被宿主侧栏盖住（两者都是真实用户也点不到的位置）。先把
    // 镜头往右下挪一点，让这张卡片整体落在画布中间。
    await frame().evaluate(() => {
      const state = window.__synapse.state
      state.canvasCamera = { x: state.canvasCamera.x + 340, y: state.canvasCamera.y + 240 }
      document.querySelector('.canvas-content').style.transform = `translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})`
    })
    await sleep(500)
    await frame().click(BTW)
    await frame().waitForSelector('[data-draft] .draft-tool-chip', { timeout: 15_000 })
    const chips = await frame().evaluate(() => [...document.querySelectorAll('[data-draft] .draft-tool-chip')].map(node => ({ name: node.dataset.tool, on: node.classList.contains('is-on') })))
    const on = chips.filter(chip => chip.on).map(chip => chip.name).sort()
    check('草稿卡给出工具 chips，默认选中五个只读工具', JSON.stringify(on) === JSON.stringify(['glob', 'grep', 'read', 'web_fetch', 'web_search']), JSON.stringify(on))
    // 画布在开卡时才向宿主问这个会话的工具面（宿主只有活会话才答得出），所以多
    // 等一会儿：能长出默认那五个之外的 chip，就说明这条路真的通了。
    let grew = chips.length
    for (let attempt = 0; attempt < 10 && grew <= 5; attempt++) {
      await sleep(1_000)
      grew = await frame().evaluate(() => document.querySelectorAll('[data-draft] .draft-tool-chip').length)
    }
    check('chips 里长出了宿主能钉的其他工具（问的是当前会话）', grew > 5, `${chips.length} → ${grew} 个`)
    await frame().click('[data-draft] .draft-tool-chip[data-tool="web_search"]')
    const off = await frame().evaluate(() => document.querySelector('[data-draft] .draft-tool-chip[data-tool="web_search"]').classList.contains('is-on'))
    check('点一下 chip 就能把工具从清单里去掉', off === false)
    await frame().click('[data-draft] .draft-tool-chip[data-tool="web_search"]')
    await frame().fill('[data-draft] textarea', '用 pwsh 工具执行 echo hi；如果你根本没有这个工具，就只回答 NO_TOOL。')
    await frame().click('[data-draft] button[type="submit"]')
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(2_000)
      btwThread = (await store()).find(thread => thread.kind === 'btw')
      if (btwThread !== undefined && btwThread.messages.some(text => text.startsWith('assistant:'))) break
    }
    check('侧问被宿主真 fork 出来并登记成 btw 线程', typeof btwThread?.sessionId === 'string' && btwThread.sessionId !== created?.sessionId, `sessionId=${btwThread?.sessionId ?? '无'}`)
    check('侧问记下了自己的工具清单', JSON.stringify(btwThread?.tools) === JSON.stringify(['read', 'grep', 'glob', 'web_fetch', 'web_search']), JSON.stringify(btwThread?.tools ?? null))
    check('侧问没有被归档（DSH 的归档会让它再也答不了）', btwThread !== undefined && !archivedInHost().includes(btwThread.sessionId), JSON.stringify(archivedInHost()))
    // 工具面本身：宿主按活会话报，被钉住的侧问里没有 pwsh。
    const childTools = await page.evaluate(async id => {
      const status = await (await fetch(`/synapse/api/status?session=${encodeURIComponent(id)}`)).json()
      return { visible: status.tools ?? [], pinnable: status.pinnableTools ?? [] }
    }, btwThread?.sessionId ?? '')
    check('宿主报出侧问的实际工具面：没有 pwsh，但作用域内注册的 subagent 还在', childTools.visible.includes('read') && !childTools.visible.includes('pwsh') && childTools.visible.includes('subagent'), `visible=${JSON.stringify(childTools.visible)}`)
    check('可钉的名字仍是完整的一套（钉的是这个会话，不是进程）', childTools.pinnable.includes('pwsh') && childTools.pinnable.includes('read'), `${childTools.pinnable.length} 个`)
    const answered = btwThread?.messages.filter(text => text.startsWith('assistant:')).at(-1) ?? ''
    check('侧问真的答了，而且没真跑成 pwsh（最多是试了一下被拒）', btwThread?.ran.includes('pwsh') === false && /NO_TOOL/.test(answered), `调用=${JSON.stringify(btwThread?.calls ?? null)} 跑成=${JSON.stringify(btwThread?.ran ?? null)} ${JSON.stringify(answered.slice(0, 60))}`)
    const widget = await frame().evaluate(() => document.querySelector('.btw-widget')?.textContent?.trim() ?? null)
    check('画布上出现侧问挂件', widget !== null, JSON.stringify(widget))
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

  // H2. 画布跟着宿主的会话换工作区
  //
  // 用户报过：在宿主里切到另一个目录的会话，画布还停在上一个工作区 —— 画布只在
  // 宿主的会话真的变了时跟随，而首次加载时宿主那条 current-session 消息发早了
  // （iframe 还没装监听），画布根本不知道宿主在哪。这里用画布→宿主那条桥消息
  // （卡片上的「DSH」按钮发的就是它）把宿主带到另一个目录的会话上。
  const otherCwd = join(HOME, 'other-workspace')
  mkdirSync(otherCwd, { recursive: true })
  const otherSession = await page.evaluate(async cwd => {
    const made = await (await fetch('/synapse/api/host/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd }) })).json()
    await fetch('/synapse/api/host/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: made.sessionId, text: '只回答一个词：好的' }) })
    return made.sessionId
  }, otherCwd)
  // 等投影把新目录变成工作区（投影是异步的，而画布只在工作区列表里找得到这条
  // 会话时才跟得过去）。
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(1_500)
    const known = await page.evaluate(async cwd => {
      const list = await (await fetch('/synapse/api/workspaces')).json()
      return list.workspaces.some(workspace => String(workspace.cwd ?? '').toLowerCase() === cwd.toLowerCase())
    }, otherCwd)
    if (known) break
  }
  const cwdBeforeFollow = await frame().evaluate(() => window.__synapse.state.workspace?.cwd ?? null)
  await frame().evaluate(id => window.parent.postMessage({ source: 'synapse', type: 'synapse:open-session', sessionId: id }, window.location.origin), otherSession)
  let followed = null
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(1_500)
    followed = await frame().evaluate(() => ({ cwd: window.__synapse.state.workspace?.cwd ?? null, host: window.__synapse.state.currentSession?.id ?? null }))
    if (followed.host === otherSession && resolve(followed.cwd ?? '') === resolve(otherCwd)) break
  }
  check('宿主换到另一个目录的会话：画布跟着换工作区', followed?.host === otherSession && resolve(followed.cwd ?? '') === resolve(otherCwd), `${cwdBeforeFollow} → ${followed?.cwd ?? null}`)

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
