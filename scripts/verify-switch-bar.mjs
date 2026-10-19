// 视图切换入口必须**只有一个可见**。
//
// 画布自己的顶栏有一个「对话 / 会话地图」切换（`.view-switch`），注入到 pi-web
// 页面里的切换条（`.pi-synapse-switch`）是进入画布的入口。两者同时可见时，屏幕
// 上会出现两个一模一样的切换控件（且位置不同 x，因为一个是 fixed 居中、一个是
// 顶栏栅格的中列），实测就是用户看到的样子。
import { launchBrowser } from './browser.mjs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:30143'

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

// 对话视图 / 地图视图各只允许一个可见的切换入口。地图视图里宿主切换条必须
// 是唯一入口（画布内已不渲染另一份），否则会出现两个一模一样的切换控件。
const visibleSwitchTexts = async () => {
  const inHost = await page.evaluate(() => [...document.querySelectorAll('.pi-synapse-switch')]
    .filter(el => el.getBoundingClientRect().width > 0)
    .map(el => el.textContent.trim()))
  const frame = page.frames().find(f => f.url().includes('/synapse/'))
  const inCanvas = frame === undefined ? [] : await frame.evaluate(() => ({
    hostSwitches: [...document.querySelectorAll('.pi-synapse-switch')].length,
    tabs: [...document.querySelectorAll('.canvas-tabs button')].map(b => b.textContent.trim()),
  }))
  return { inHost, inCanvas }
}

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)

const dialogView = await visibleSwitchTexts()
console.log('对话视图  宿主切换条:', JSON.stringify(dialogView.inHost))
const dialogOk = dialogView.inHost.length === 1

await page.locator('.pi-synapse-switch button[data-view="map"]').click()
await page.waitForTimeout(5000)

const mapView = await visibleSwitchTexts()
console.log('地图视图  宿主切换条:', JSON.stringify(mapView.inHost), ' 画布内:', JSON.stringify(mapView.inCanvas))
// 画布内不得再有一份对话/地图切换；它在 iframe 里查不到宿主的切换条，应为 0。
const mapOk = mapView.inHost.length === 1 && mapView.inCanvas.hostSwitches === 0

// 宿主切换条在地图视图下仍可点回对话视图（画布内已无第二个入口）。
await page.locator('.pi-synapse-switch button[data-view="dialog"]').click()
await page.waitForTimeout(1200)
const overlayHidden = await page.evaluate(() => document.querySelector('.pi-synapse-overlay')?.hidden === true)
const returnOk = overlayHidden

const ok = dialogOk && mapOk && returnOk
console.log()
console.log(dialogOk ? 'PASS 对话视图只有宿主切换条' : 'FAIL 对话视图的切换条数量不对')
console.log(mapOk ? 'PASS 地图视图只有宿主切换条（画布内无重复）' : 'FAIL 地图视图出现重复切换入口')
console.log(returnOk ? 'PASS 宿主切换条能从地图切回对话' : 'FAIL 无法从地图返回')
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无')
await browser.close()
process.exit(ok ? 0 : 1)
