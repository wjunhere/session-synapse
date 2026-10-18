/**
 * The DSH host half of session-synapse.
 *
 * DSH's host-plugin contract is small — `name` / `inject` / `apply(ctx, config)` —
 * and `ctx.webServer.register()` *is* its HTTP route table. So the canvas needs
 * no second process and no proxy here, which is the exact opposite of the pi-web
 * integration in `src/server/proxy.js`: pi-web ships as a prebuilt Next.js app
 * with no plugin surface at all, so there the canvas and pi-web have to be forced
 * onto one origin by a proxy.
 *
 * `web` and `desktop` share this file. The Electron shell hands every path
 * outside its own dist to the harness web server (see docs/dsh-desktop.md §1), so
 * `/synapse/*` arrives through the same URL in both hosts.
 *
 * Route layout, and why it is two registrations:
 *   - `prefix /synapse/api` — Synapse's own JSON API, one handler, longest prefix
 *     wins over the canvas prefix below.
 *   - `prefix /synapse`     — the canvas page, its modules, styles and fonts.
 *     A DSH route handler owns everything under its prefix, so the asset handler
 *     has to answer 404 itself instead of returning "not mine".
 */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createAssetHandler } from '../../server/routes.js'
import { createGuard, sendJson } from '../../server/guard.js'
import { READ_ONLY_TOOLS, capabilities } from '../../adapters/contract.js'
import { WorkspaceStore } from '../../store/workspace-store.js'
import { acquireInstanceLock } from '../../store/instance-lock.js'

export const name = 'synapse'
export const inject = ['webServer']

/**
 * @param {any} ctx                the DSH plugin context (a cordis Context)
 * @param {object} [config]        the `synapse` entry's config from the profile patch
 * @param {string} [config.dataFile]       canvas metadata file; defaults under the harness home
 * @param {string} [config.dshHome]        explicit harness home override (else $DSH_HOME, else ~/.dsh)
 * @param {string[]} [config.trustedHosts] extra authorities for the Host check
 * @returns {Promise<() => Promise<void>>} disposer; a throw here fails the plugin
 *   load visibly instead of leaving a half-mounted surface behind.
 */
export function apply(ctx, config) {
  const dataFile = typeof config?.dataFile === 'string' && config.dataFile !== ''
    ? config.dataFile
    // The harness home, resolved the way the rest of DSH resolves it (explicit >
    // $DSH_HOME > ~/.dsh). Deliberately NOT the upstream dsh-synapse file: two
    // plugins writing `$DSH_HOME/synapse/workspaces.json` would be two writers on
    // one canvas (AGENTS 铁律 7). `synapse import` moves an existing canvas over.
    : join(resolveDshHome(typeof config?.dshHome === 'string' ? config.dshHome : undefined), 'session-synapse', 'workspaces.json')

  // Claim the data file before any route can write to it (AGENTS 铁律 7: one
  // writer per canvas data file). Failing the plugin load is the point — a
  // refusal shows up in DSH's plugin list, whereas a second writer does not.
  //
  // `isOurs` is not optional here: this plugin runs INSIDE the harness process,
  // whose command line names the harness (or the Electron shell) and never the
  // word "synapse". With the CLI's default matcher a live DSH holding this lock
  // reads as a recycled PID, and the next instance steals a lock in active use.
  return acquireInstanceLock(dataFile, { port: ctx.webServer.port ?? null, isOurs: isOurHostProcess })
    .then(lock => {
      if (lock.tookOver) ctx.logger.warn('synapse: 接管了一个遗留的锁（原持有者已退出）')
      const store = new WorkspaceStore(dataFile)
      const isTrustedHost = createGuard(config?.trustedHosts ?? [])
      const handleAsset = createAssetHandler()
      const handleApi = createApiHandler({ store, isTrustedHost })
      ctx.effect(
        () => ctx.webServer.register({ kind: 'prefix', path: '/synapse/api', handler: handleApi }),
        'synapse: /synapse/api',
      )
      ctx.effect(
        () => ctx.webServer.register({ kind: 'prefix', path: '/synapse', handler: createCanvasHandler(handleAsset) }),
        'synapse: canvas assets',
      )
      return async () => { await lock.release() }
    })
}

/**
 * Which command lines may belong to a process holding our lock.
 *
 * The first pattern is the CLI's own token (`bin/synapse.js`); the other two are
 * the launchers that host this plugin — the Electron desktop host, and the `dsh`
 * launcher behind `dsh web`. A false positive only refuses to steal a lock, and
 * `--force` … has no equivalent here, so the extra patterns stay narrow.
 *
 * @param {string} command a process command line
 */
function isOurHostProcess(command) {
  return /synapse/i.test(command)
    || /dsh-desktop-host[\\/]lib[\\/]index\.js/i.test(command)
    || /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(command)
}

/**
 * The canvas surface: page, modules, styles, fonts.
 *
 * @param {(req: any, res: any) => Promise<boolean>} handleAsset
 */
function createCanvasHandler(handleAsset) {
  return async function handleCanvas(req, res) {
    // `createAssetHandler` answers `/synapse` with a redirect to `/synapse/` and
    // serves every canvas module by name rule; anything else is ours to refuse.
    if (await handleAsset(req, res)) return
    sendJson(res, 404, { error: '接口不存在' })
  }
}

/**
 * `/synapse/api/*`.
 *
 * The DSH `/api` fence does not cover plugin routes, so this checks the Host
 * header itself, with the same guard the pi-web server uses (DNS-rebinding).
 *
 * NOTE (D2): the routes below are served from the store alone while the DSH
 * projection engine is being built; `status` reports an empty session set and no
 * capabilities on purpose, so the canvas hides actions it cannot perform rather
 * than offering them. Wiring `Synapse` + `createApiHandler` here replaces this
 * handler wholesale.
 *
 * @param {object} options
 * @param {WorkspaceStore} options.store
 * @param {(host: string) => boolean} options.isTrustedHost
 */
function createApiHandler({ store, isTrustedHost }) {
  return async function handleApi(req, res) {
    try {
      if (!isTrustedHost(req.headers.host)) return sendJson(res, 403, { error: '不被信任的 Host' })
      const path = new URL(req.url ?? '/', 'http://synapse.local').pathname
      const method = req.method ?? 'GET'

      if (path === '/synapse/api/status' && method === 'GET') {
        return sendJson(res, 200, {
          adapter: 'dsh',
          capabilities: capabilities(),
          // The canvas reads this to pin a /btw session's tool set; echoing the
          // shared constant keeps the two from drifting.
          readOnlyTools: READ_ONLY_TOOLS,
          sessions: 0,
        })
      }
      if (path === '/synapse/api/workspaces' && method === 'GET') {
        return sendJson(res, 200, { workspaces: await store.list() })
      }
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      process.stderr.write(`synapse: ${error?.stack ?? error}\n`)
      return sendJson(res, 500, { error: 'Synapse 数据暂时不可用' })
    }
  }
}
