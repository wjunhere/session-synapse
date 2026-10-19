/**
 * The browser the verify suites drive — resolved, never hardcoded.
 *
 * The suites are dev-only (`scripts/` is not part of the published package), but
 * they still must not name anybody's machine: the driver is a package, and the
 * browser is whatever that machine already has. First hit wins:
 *
 *   1. `CHROME_PATH` — an explicit Chromium/Chrome executable, for pinning a
 *      suite run to one binary;
 *   2. the browser `playwright` resolved for its own version (`npx playwright
 *      install chromium` puts it in the shared ms-playwright cache);
 *   3. the newest `chromium-<rev>` already sitting in that cache, whatever
 *      version downloaded it — the cache is shared between playwright versions,
 *      and a second `npm i` that bumps playwright must not make the suites
 *      demand a fresh 150 MB download;
 *   4. the Chrome installed on the machine (`channel: 'chrome'`).
 *
 * `PLAYWRIGHT_CORE` points at another playwright/playwright-core (a path or a
 * `file://` URL) for machines that keep it elsewhere; by default the local
 * `playwright` devDependency is used.
 *
 * The suites assert DOM and geometry rather than pixels, so any of the four is
 * fine. `npm run verify` prints which one it picked, and
 * [docs/verification.md](../docs/verification.md) records which one the current
 * expectations were measured on.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where playwright keeps downloaded browsers, per platform. */
const CACHE_ROOT = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
    : join(homedir(), '.cache', 'ms-playwright')

/** Where the executable lives inside one `chromium-<rev>` cache directory. */
const CHROMIUM_INSIDE = [
  ['chrome-win64', 'chrome.exe'],
  ['chrome-linux', 'chrome'],
  ['chrome-linux64', 'chrome'],
  ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
]

/**
 * The driver. `PLAYWRIGHT_CORE` is an escape hatch for machines that keep
 * playwright outside this repo; otherwise it is the local devDependency, which
 * is why `playwright` is in `devDependencies` at all.
 */
async function loadDriver() {
  const override = process.env.PLAYWRIGHT_CORE
  if (typeof override === 'string' && override !== '') return import(override)
  try {
    return await import('playwright')
  } catch (error) {
    throw new Error(`找不到 playwright：先在仓库里 \`npm i\`（devDependencies 里有它），或用 PLAYWRIGHT_CORE=<playwright 入口> 指定。原始错误：${error?.message ?? error}`)
  }
}

/** The browser playwright itself would use, or null when it has none downloaded. */
function playwrightChromium(chromium) {
  try {
    const path = chromium.executablePath()
    return typeof path === 'string' && existsSync(path) ? path : null
  } catch {
    // `executablePath()` throws (rather than answering null) when this version
    // has no browser installed — the case steps 3 and 4 exist for.
    return null
  }
}

/** The newest chromium in the shared cache, whatever playwright version put it there. */
function cachedChromium() {
  let entries
  try {
    entries = readdirSync(CACHE_ROOT)
  } catch {
    return null
  }
  const revisions = entries
    .map(name => /^chromium-(\d+)$/.exec(name))
    .filter(match => match !== null)
    .map(match => ({ name: match[0], revision: Number(match[1]) }))
    .sort((a, b) => b.revision - a.revision)
  for (const { name } of revisions) {
    for (const parts of CHROMIUM_INSIDE) {
      const path = join(CACHE_ROOT, name, ...parts)
      if (existsSync(path)) return path
    }
  }
  return null
}

/**
 * Which browser to launch, as playwright launch options plus a label to print.
 *
 * Exported separately from `launchBrowser` so the harness can report the choice
 * before it spends a minute starting a service.
 *
 * @returns {Promise<{ label: string, executablePath?: string, channel?: string }>}
 */
export async function resolveBrowser() {
  const explicit = process.env.CHROME_PATH
  if (typeof explicit === 'string' && explicit !== '') {
    if (!existsSync(explicit)) throw new Error(`CHROME_PATH 指向的文件不存在：${explicit}`)
    return { label: `CHROME_PATH → ${explicit}`, executablePath: explicit }
  }
  const { chromium } = await loadDriver()
  const own = playwrightChromium(chromium)
  if (own !== null) return { label: `playwright 下载的 chromium → ${own}`, executablePath: own }
  const cached = cachedChromium()
  if (cached !== null) return { label: `ms-playwright 缓存里最新的 chromium → ${cached}`, executablePath: cached }
  return { label: '机器上装的 Chrome（channel: chrome）', channel: 'chrome' }
}

/** Launch it. `options` are playwright's own launch options (`headless`, …). */
export async function launchBrowser(options = {}) {
  const { chromium } = await loadDriver()
  const { executablePath, channel } = await resolveBrowser()
  return chromium.launch({ ...options, executablePath, channel })
}
