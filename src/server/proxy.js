/**
 * The same-origin proxy that makes pi-web and the canvas one application.
 *
 * Why a proxy rather than an iframe: pi-web rejects any cross-origin request
 * to `/api/*` (the `Origin` header must equal the request's own `Host`), so a
 * canvas on another port cannot call the API at all. Serving both from one
 * origin removes that problem, and it is also what lets the canvas navigate
 * pi-web with a plain `?session=` URL.
 *
 * HTML responses get a small script injected before `</head>`: a "会话地图"
 * entry button in pi-web's own chrome, plus the bridge that forwards the
 * current session and live replies to the canvas. Both anchors are stable
 * (each appears exactly once), and an injection that finds no anchor is
 * skipped rather than corrupting the page.
 */
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

/** Load the injected bridge script once, from the canvas directory. */
async function loadBridgeScript() {
  return readFile(new URL('../canvas/bridge.js', import.meta.url), 'utf8')
}

/**
 * Decode a compressed HTML body.
 *
 * A real browser sends `Accept-Encoding: gzip`, so pi-web answers with gzipped
 * HTML. Injecting into those bytes corrupts the page (the browser then renders
 * mojibake instead of the app), so the body must be decoded first and the
 * response sent back uncompressed.
 */
function decodeBody(buffer, encoding) {
  const name = String(encoding ?? '').trim().toLowerCase()
  if (name === '' || name === 'identity') return buffer.toString('utf8')
  try {
    if (name === 'gzip' || name === 'x-gzip') return gunzipSync(buffer).toString('utf8')
    if (name === 'br') return brotliDecompressSync(buffer).toString('utf8')
    if (name === 'deflate') return inflateSync(buffer).toString('utf8')
  } catch {
    return null
  }
  return null
}

function injectIntoHtml(html, script) {
  // The script is deferred so it runs after pi-web's HTML is parsed: it appends
  // to `document.body`, which does not exist yet while the head is streaming.
  const tag = `<script defer>${script}</script>`
  const headClose = html.indexOf('</head>')
  if (headClose !== -1) return `${html.slice(0, headClose)}${tag}${html.slice(headClose)}`
  const bodyClose = html.indexOf('</body>')
  if (bodyClose !== -1) return `${html.slice(0, bodyClose)}${tag}${html.slice(bodyClose)}`
  return html
}

/**
 * @param {object} options
 * @param {number} options.upstreamPort   pi-web's port
 * @param {string} [options.host]
 * @param {object} options.synapse        the Synapse instance
 * @param {(req, res) => Promise<any>} options.handleSynapse
 * @param {boolean} [options.inject]
 */
export function createProxy({ upstreamPort, host = '127.0.0.1', synapse, handleSynapse, inject = true }) {
  let bridgeScript = null
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/synapse' || path.startsWith('/synapse/')) {
      try {
        const handled = await handleSynapse(req, res)
        if (handled !== false) return
      } catch (error) {
        process.stderr.write(`synapse: ${error?.stack ?? error}\n`)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'Synapse 处理请求失败' }))
        }
        return
      }
    }
    forward(req, res)
  })

  function forward(req, res) {
    // The `Origin` header is dropped so pi-web's same-origin check sees a
    // request it accepts: the proxy already guarantees both sides share an
    // origin, and a forwarded browser Origin would name the upstream port.
    //
    // `accept-encoding` is normalized to identity for HTML so the page can be
    // rewritten without a decode step; other responses keep the browser's
    // original encoding and stream through untouched.
    const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` }
    delete headers.origin
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html')
    if (wantsHtml) headers['accept-encoding'] = 'identity'
    const upstream = httpRequest({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers }, async response => {
      const contentType = String(response.headers['content-type'] ?? '')
      if (!inject || !contentType.includes('text/html')) {
        const out = { ...response.headers }
        delete out.connection
        res.writeHead(response.statusCode ?? 502, out)
        response.pipe(res)
        return
      }
      const chunks = []
      for await (const chunk of response) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      const decoded = decodeBody(raw, response.headers['content-encoding'])
      if (decoded === null) {
        // Unknown or broken encoding: pass the bytes through untouched rather
        // than inject into something we cannot read.
        const passthrough = { ...response.headers }
        delete passthrough.connection
        res.writeHead(response.statusCode ?? 200, passthrough)
        res.end(raw)
        return
      }
      if (bridgeScript === null) bridgeScript = await loadBridgeScript()
      const body = injectIntoHtml(decoded, bridgeScript)
      const out = { ...response.headers }
      delete out['content-length']
      delete out['content-encoding']
      delete out.connection
      out['content-type'] = 'text/html; charset=utf-8'
      res.writeHead(response.statusCode ?? 200, out)
      res.end(body)
    })
    upstream.on('error', error => {
      if (res.headersSent) return res.end()
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`pi-web 不可达（127.0.0.1:${upstreamPort}）：${error.message}`)
    })
    req.pipe(upstream)
  }
}

export function startServer({ port, host = '127.0.0.1', upstreamPort, synapse, handleSynapse, inject = true }) {
  const server = createProxy({ upstreamPort, host, synapse, handleSynapse, inject })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

export { HOP_BY_HOP }