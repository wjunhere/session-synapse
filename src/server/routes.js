/**
 * The `/synapse/api/*` routes.
 *
 * Kept as a pure request handler so the same code serves under pi-web's
 * webserver, a standalone proxy, or a test harness.
 */
import { readFile } from 'node:fs/promises'
import { InputError, NotFoundError, readJson, sendJson } from './guard.js'
import { READ_ONLY_TOOLS, writeTransport } from '../adapters/contract.js'

const UUID = /^\/synapse\/api\/workspaces\/([0-9a-f-]+)$/i
const BRANCH = /^\/synapse\/api\/threads\/([0-9a-f-]+)\/branch$/i
const MESSAGES = /^\/synapse\/api\/threads\/([0-9a-f-]+)\/messages$/i
const LINK = /^\/synapse\/api\/threads\/([0-9a-f-]+)\/link$/i
const THREAD = /^\/synapse\/api\/threads\/([0-9a-f-]+)$/i

/**
 * @param {import('../synapse.js').Synapse} synapse
 * @param {(host: string) => boolean} isTrustedHost
 */
export function createApiHandler(synapse, isTrustedHost) {
  return async function handleApi(req, res) {
    try {
      if (!isTrustedHost(req.headers.host)) return sendJson(res, 403, { error: '不被信任的 Host' })
      const url = new URL(req.url ?? '/', 'http://synapse.local')
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (path === '/synapse/api/reset' && method === 'POST') {
        return sendJson(res, 200, await synapse.reset([...synapse.sessions.values()]))
      }
      if (path === '/synapse/api/status' && method === 'GET') {
        // Which live session to describe tools from, when the canvas names one.
        // Nothing is activated to answer this (see the adapter's `btwTools`).
        const named = url.searchParams.get('session')
        const btwTools = synapse.btwTools(named === null || named === '' ? undefined : named)
        return sendJson(res, 200, {
          adapter: synapse.adapter.id,
          capabilities: synapse.adapter.capabilities(),
          // How the canvas reaches this host's writes: its own API from the
          // browser, or our routes (see the adapter contract).
          writeTransport: writeTransport(synapse.adapter),
          // A /btw is expressed in the HOST's tool vocabulary (pi's
          // read/grep/find/ls are not DSH's read/grep/glob/...), so the host
          // that owns one also says what a new side question starts with and
          // which names it may be given at all. Both are empty when the host
          // cannot name a session's tools without activating it.
          tools: btwTools?.visible ?? [],
          pinnableTools: btwTools?.pinnable ?? [],
          defaultBtwTools: btwTools?.defaults ?? READ_ONLY_TOOLS,
          sessions: synapse.sessions.size,
        })
      }
      // Host writes, for hosts the browser cannot reach directly.
      //
      // pi-web needs neither: the canvas shares its origin and calls it itself
      // (pi-web rejects any request whose Origin is not its own Host, so only a
      // page can). DSH is the opposite — its write surface is cordis services
      // inside the harness process — so the canvas calls these and the adapter
      // performs them. `requireCapability` refuses with 「当前宿主不支持 …」,
      // which is mapped to a 400 below.
      if (path === '/synapse/api/host/prompt' && method === 'POST') {
        const body = await readJson(req)
        await synapse.sendMessage(String(body.sessionId ?? ''), String(body.text ?? ''), Array.isArray(body.images) ? body.images : [])
        return sendJson(res, 200, { ok: true })
      }
      if (path === '/synapse/api/host/session' && method === 'POST') {
        const body = await readJson(req)
        return sendJson(res, 201, { sessionId: await synapse.createSession(typeof body.cwd === 'string' ? body.cwd : null) })
      }
      if (path === '/synapse/api/host/fork' && method === 'POST') {
        const body = await readJson(req)
        const sessionId = await synapse.forkSession(String(body.sessionId ?? ''), typeof body.entryId === 'string' && body.entryId !== '' ? body.entryId : undefined)
        return sendJson(res, 201, { sessionId })
      }
      // A /btw side question is fork + tool pin + sandbox preset + archive,
      // performed by the host: the tool mask is a scope effect and the sandbox
      // preset is a service call, neither of which a page can reach.
      if (path === '/synapse/api/host/btw' && method === 'POST') {
        const body = await readJson(req)
        const entryId = typeof body.entryId === 'string' && body.entryId !== '' ? body.entryId : undefined
        const toolNames = Array.isArray(body.tools) ? body.tools : undefined
        return sendJson(res, 201, await synapse.btwSession(String(body.sessionId ?? ''), entryId, toolNames))
      }
      if (path === '/synapse/api/host/rename' && method === 'POST') {
        const body = await readJson(req)
        await synapse.renameSession(String(body.sessionId ?? ''), String(body.title ?? ''))
        return sendJson(res, 200, { ok: true })
      }
      if (path === '/synapse/api/host/archive' && method === 'POST') {
        const body = await readJson(req)
        await synapse.archiveSession(String(body.sessionId ?? ''), body.archived === true)
        return sendJson(res, 200, { ok: true })
      }
      if (path === '/synapse/api/sessions/sync' && method === 'POST') {
        return sendJson(res, 200, { workspaces: await synapse.syncSessions() })
      }
      if (path === '/synapse/api/sessions/open' && method === 'POST') {
        const body = await readJson(req)
        await synapse.openSession(String(body.sessionId ?? ''))
        return sendJson(res, 200, { ok: true })
      }
      if (path === '/synapse/api/workspaces') {
        if (method === 'GET') return sendJson(res, 200, { workspaces: await synapse.listWorkspaces() })
        if (method === 'POST') return sendJson(res, 201, { workspace: await synapse.createWorkspace((await readJson(req)).title) })
      }
      const workspace = UUID.exec(path)
      if (workspace !== null) {
        if (method === 'GET') return sendJson(res, 200, { workspace: await synapse.getWorkspace(workspace[1]) })
        if (method === 'POST') return sendJson(res, 201, { thread: await synapse.createThread(workspace[1], await readJson(req)) })
      }
      const branch = BRANCH.exec(path)
      if (branch !== null && method === 'POST') {
        return sendJson(res, 201, { thread: await synapse.branch(branch[1], await readJson(req)) })
      }
      const messages = MESSAGES.exec(path)
      if (messages !== null && method === 'POST') {
        const body = await readJson(req)
        return sendJson(res, 201, { thread: await synapse.addMessage(messages[1], body.text) })
      }
      // A /btw fork is created by the browser (fork + set_tools are pi-web
      // calls that need pi-web's origin). The canvas then registers the result
      // so the child card exists without waiting for a projection rescan.
      const link = LINK.exec(path)
      if (link !== null && method === 'POST') {
        return sendJson(res, 201, { thread: await synapse.linkSessionThread(link[1], await readJson(req)) })
      }
      const thread = THREAD.exec(path)
      if (thread !== null && method === 'PATCH') {
        return sendJson(res, 200, { thread: await synapse.updateThread(thread[1], await readJson(req)) })
      }
      if (thread !== null && method === 'DELETE') {
        return sendJson(res, 200, await synapse.removeThread(thread[1]))
      }
      // Renaming and archiving a host session on pi-web are done by the
      // BROWSER, which shares pi-web's origin; there the server cannot call
      // pi-web's relative API (and pi-web would reject the cross-origin request
      // anyway), and the canvas learns the result from the projection rescan.
      // Hosts the browser cannot reach write through `/synapse/api/host/*`
      // above instead.
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message })
      if (error?.message === '节点不存在' || error?.message === '工作空间不存在') return sendJson(res, 404, { error: error.message })
      // A host-side refusal (bad name, unsupported action) is the caller's
      // problem, not a server fault, so it is reported as a 400 with the host's
      // own message rather than a generic 500.
      if (error?.name === 'HostRequestError') return sendJson(res, 400, { error: error.message })
      if (typeof error?.message === 'string' && error.message.startsWith('当前宿主不支持')) return sendJson(res, 400, { error: error.message })
      process.stderr.write(`synapse: ${error?.stack ?? error}\n`)
      return sendJson(res, 500, { error: 'Synapse 数据暂时不可用' })
    }
  }
}

/** Serve the canvas page and its assets. */
export function createAssetHandler() {
  const assets = new Map([
    ['/synapse/', { file: 'app.html', type: 'text/html; charset=utf-8' }],
    ['/synapse/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
    ['/synapse/mark.svg', { file: 'mark.svg', type: 'image/svg+xml' }],
    // The canvas may be viewed on an offline machine, so the two typefaces it
    // depends on ship with it instead of being fetched from a font CDN.
    ['/synapse/fonts/geist-latin.woff2', { file: 'fonts/geist-latin.woff2', type: 'font/woff2' }],
    ['/synapse/fonts/newsreader-latin.woff2', { file: 'fonts/newsreader-latin.woff2', type: 'font/woff2' }],
  ])
  return async function handleAsset(req, res) {
    const path = new URL(req.url ?? '/', 'http://synapse.local').pathname
    if (path === '/synapse') {
      res.writeHead(302, { location: '/synapse/' })
      return res.end()
    }
    const asset = assets.get(path) ?? canvasModule(path) ?? vendorModule(path)
    if (asset === undefined) return false
    // Binary assets (the vendored woff2 files) must be served as bytes: reading
    // them as utf8 would corrupt the font table and silently break the render.
    const binary = path.startsWith('/synapse/fonts/')
    const body = await readFile(new URL(`../canvas/${asset.file}`, import.meta.url), binary ? undefined : 'utf8')
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' })
    res.end(body)
    return true
  }
}

/**
 * `/synapse/<name>.js` → the canvas ES module of that name.
 *
 * A rule rather than a table: the canvas is a module graph now, and a table
 * meant every new module also had to be registered here or the page silently
 * failed to load (the browser reports it only as a module-load error). The name
 * pattern is the guard — no dots or slashes, so no traversal.
 */
function canvasModule(path) {
  const match = /^\/synapse\/([a-z0-9-]+)\.js$/.exec(path)
  if (match === null) return undefined
  return { file: `${match[1]}.js`, type: 'text/javascript; charset=utf-8' }
}

/**
 * `/synapse/vendor/<name>.js` → a third-party build in `canvas/vendor/`.
 *
 * A separate rule so the vendored files cannot be mistaken for our modules (and
 * so `canvasModule`'s flat-name rule keeps its guarantee: no dots, no slashes).
 * See `src/canvas/vendor/README.md` for what is in there and why.
 */
function vendorModule(path) {
  const match = /^\/synapse\/vendor\/([a-z0-9-]+)\.js$/.exec(path)
  if (match === null) return undefined
  return { file: `vendor/${match[1]}.js`, type: 'text/javascript; charset=utf-8' }
}

/** True when this request belongs to the Synapse surface. */
export function isSynapsePath(path) {
  return typeof path === 'string' && (path === '/synapse' || path.startsWith('/synapse/'))
}