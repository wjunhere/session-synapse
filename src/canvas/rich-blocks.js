/**
 * The two markdown blocks that need a real library: mermaid diagrams and LaTeX.
 *
 * Everything else is rendered as HTML by `markdown.js` at parse time. These two
 * cannot be: mermaid is 3.4 MB and temml 160 KB, and a canvas whose sessions
 * contain no diagram or formula must not pay for either. So `markdown.js` emits
 * containers that hold the SOURCE as text, and this module replaces them after
 * the DOM exists — which also gives the failure mode for free: a diagram that
 * does not parse stays on screen as the code the user wrote, instead of a blank
 * box.
 *
 * Both libraries are loaded from `/synapse/vendor/` — this machine's own server,
 * never a CDN, so the canvas keeps working offline (see
 * `src/canvas/vendor/README.md`).
 */

const VENDOR = {
  mermaid: '/synapse/vendor/mermaid.js',
  temml: '/synapse/vendor/temml.js',
}

/**
 * One load per library per page, shared by every block that needs it.
 *
 * A rejected load is remembered too: a canvas with no network should show the
 * source of every diagram, not retry 3.4 MB per block.
 */
const loads = new Map()

function loadLibrary(name, globalName) {
  const cached = loads.get(name)
  if (cached !== undefined) return cached
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = VENDOR[name]
    script.addEventListener('load', () => {
      const api = /** @type {any} */ (window)[globalName]
      if (api === undefined || api === null) reject(new Error(`${VENDOR[name]} 没有挂出 window.${globalName}`))
      else resolve(api)
    })
    script.addEventListener('error', () => reject(new Error(`${VENDOR[name]} 加载失败`)))
    document.head.append(script)
  })
  loads.set(name, promise)
  return promise
}

/**
 * Rendered blocks, keyed by what produced them.
 *
 * The canvas rewrites its whole DOM on every render, so without this cache every
 * poll that changed anything would re-run mermaid over every diagram on screen.
 * The key carries the theme because a diagram is a coloured image: a dark-mode
 * canvas must not show a light-mode SVG (the host's theme toggle clears the cache,
 * see `refreshRichBlocks`).
 */
const rendered = new Map()

/** Mermaid needs a unique id per render; the counter never repeats within a page. */
let diagramCount = 0

const isDark = () => document.documentElement.dataset.theme === 'dark'

async function renderMermaid(source) {
  const key = `mermaid:${isDark() ? 'dark' : 'light'}:${source}`
  const cached = rendered.get(key)
  if (cached !== undefined) return cached
  const mermaid = await loadLibrary('mermaid', 'mermaid')
  mermaid.initialize({
    startOnLoad: false,
    // `strict` is what keeps a diagram from running scripts or handlers; the
    // text comes from a model, not from us.
    securityLevel: 'strict',
    // A broken diagram must not append mermaid's own error SVG to the page —
    // the caller shows the source instead.
    suppressErrorRendering: true,
    theme: isDark() ? 'dark' : 'default',
  })
  const parsed = await mermaid.parse(source, { suppressErrors: true })
  if (!parsed) throw new Error('mermaid 语法错误')
  diagramCount += 1
  const result = await mermaid.render(`synapse-diagram-${diagramCount}`, source)
  rendered.set(key, result.svg)
  return result.svg
}

async function renderMath(source, displayMode) {
  const key = `math:${displayMode ? 'block' : 'inline'}:${source}`
  const cached = rendered.get(key)
  if (cached !== undefined) return cached
  const temml = await loadLibrary('temml', 'temml')
  // MathML, not HTML+fonts: the browser renders it, so the canvas does not have
  // to ship the ~60 font files KaTeX needs.
  const html = temml.renderToString(source, { displayMode, throwOnError: false })
  rendered.set(key, html)
  return html
}

/**
 * Replace every not-yet-rendered diagram and formula under `root`.
 *
 * Fire-and-forget on purpose: this runs at the end of a render, and a diagram is
 * not worth blocking the frame for. A block that is still streaming
 * (`.message-pending`) is skipped — half a fence parses as an error, and the next
 * render picks it up once the reply is finished.
 */
export function enhanceRichBlocks(root) {
  for (const element of root.querySelectorAll('.md-mermaid:not([data-rich])')) {
    if (element.closest('.message-pending') !== null) continue
    element.dataset.rich = 'pending'
    const source = element.textContent ?? ''
    renderMermaid(source).then(svg => {
      element.innerHTML = svg
      element.dataset.rich = 'done'
    }).catch(error => {
      element.dataset.rich = 'error'
      element.title = `图渲染失败：${error?.message ?? error}`
    })
  }
  for (const element of root.querySelectorAll('.md-math:not([data-rich]), .md-math-block:not([data-rich])')) {
    if (element.closest('.message-pending') !== null) continue
    element.dataset.rich = 'pending'
    const displayMode = element.classList.contains('md-math-block')
    const source = element.textContent ?? ''
    renderMath(source, displayMode).then(html => {
      element.innerHTML = html
      element.dataset.rich = 'done'
    }).catch(error => {
      element.dataset.rich = 'error'
      element.title = `公式渲染失败：${error?.message ?? error}`
    })
  }
}

/** The host's theme changed: diagrams are images and have to be drawn again. */
export function refreshRichBlocks(root) {
  rendered.clear()
  for (const element of root.querySelectorAll('[data-rich]')) delete element.dataset.rich
  enhanceRichBlocks(root)
}
