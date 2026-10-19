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
 * Route layout, and why it is two registrations: DSH matches the longest prefix
 * first, so `/synapse/api` (one JSON handler, the same one the pi-web server
 * uses) wins over the canvas prefix below. A route handler owns everything under
 * its prefix, which is why the canvas handler answers 404 itself instead of
 * returning "not mine".
 */
import { createAssetHandler, createApiHandler } from '../../server/routes.js'
import { createGuard, sendJson } from '../../server/guard.js'
import { Synapse } from '../../synapse.js'
import { createDshAdapter } from '../../adapters/dsh.js'
import { acquireInstanceLock } from '../../store/instance-lock.js'

export const name = 'synapse'
// `tools` / `agents` / `sessions` / `permissionPresets` are what a /btw side
// question needs and what its reload story needs: the tool mask is a scoped
// effect, so it has to be re-applied to each agent the harness composes after a
// restart (see the adapter's `pinBtw`).
export const inject = ['webServer', 'sessionController', 'sessionQuery', 'workspaceController', 'tools', 'agents', 'sessions', 'permissionPresets']

/**
 * @param {any} ctx                the DSH plugin context (a cordis Context)
 * @param {object} [config]        the `synapse` entry's config from the profile patch
 * @param {string} [config.dataFile]       canvas metadata file; defaults under the harness home
 * @param {string} [config.dshHome]        explicit harness home override (else $DSH_HOME, else ~/.dsh)
 * @param {string[]} [config.trustedHosts] extra authorities for the Host check
 * @param {boolean} [config.autoProjection] project the host's sessions (default true)
 * @param {string} [config.projectionWorkspaceTitle] workspace title for projected sessions
 * @param {boolean} [config.includeSubagents] put subagent sessions on the canvas too
 * @returns {Promise<() => Promise<void>>} disposer; a throw here fails the plugin
 *   load visibly instead of leaving a half-mounted surface behind.
 */
export async function apply(ctx, config) {
  // The /btw tool pins live in the canvas store, which the engine owns — and
  // the engine is built FROM this adapter, so the lookup cannot be handed over
  // up front. It is late-bound instead: the adapter only reads it from
  // `subscribe()`, which `engine.start()` calls after the store has loaded.
  let engine = null
  const adapter = createDshAdapter({
    sessionController: ctx.sessionController,
    sessionQuery: ctx.sessionQuery,
    // Archive lives in the workspace registry, not the session controller: the
    // archive set is registry-global and its admission gate owns what a running
    // session is allowed to do.
    workspaceController: ctx.workspaceController,
    tools: ctx.tools,
    agents: ctx.agents,
    sessions: ctx.sessions,
    permissionPresets: ctx.permissionPresets,
    btwPins: () => {
      if (engine === null) throw new Error('synapse: 引擎建好之前读了侧问工具记录')
      return engine.sessionBtwPins()
    },
    on: (event, listener) => ctx.on(event, listener),
    dshHome: typeof config?.dshHome === 'string' ? config.dshHome : undefined,
    includeSubagents: config?.includeSubagents === true,
  })
  // The adapter owns the default location; the profile patch may override it.
  const dataFile = typeof config?.dataFile === 'string' && config.dataFile !== '' ? config.dataFile : adapter.defaultDataFile()

  // Claim the data file before anything can write to it (AGENTS 铁律 7: one
  // writer per canvas data file). Failing the plugin load is the point — a
  // refusal shows up in DSH's plugin list, whereas a second writer does not.
  //
  // `isOurs` is not optional here: this plugin runs INSIDE the harness process,
  // whose command line names the harness (or the Electron shell) and never the
  // word "synapse". With the CLI's default matcher a live DSH holding this lock
  // reads as a recycled PID, and the next instance steals a lock in active use.
  const lock = await acquireInstanceLock(dataFile, { port: ctx.webServer.port ?? null, isOurs: isOurHostProcess })
  if (lock.tookOver) ctx.logger.warn('synapse: 接管了一个遗留的锁（原持有者已退出）')

  const synapse = new Synapse({
    adapter,
    dataFile,
    autoProjection: config?.autoProjection !== false,
    ...(typeof config?.projectionWorkspaceTitle === 'string' ? { projectionWorkspaceTitle: config.projectionWorkspaceTitle } : {}),
  })
  engine = synapse
  // The projection is what puts cards on the canvas, and the HTTP surface only
  // serves what it produced: start it before the routes exist, so no request can
  // see a half-built store.
  await synapse.start()

  const isTrustedHost = createGuard(config?.trustedHosts ?? [])
  const handleApi = createApiHandler(synapse, isTrustedHost)
  const handleAsset = createAssetHandler()
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/synapse/api', handler: handleApi }),
    'synapse: /synapse/api',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/synapse', handler: createCanvasHandler(handleAsset) }),
    'synapse: canvas assets',
  )

  return async () => {
    await synapse.stop()
    await lock.release()
  }
}

/**
 * Which command lines may belong to a process holding our lock.
 *
 * The first pattern is the CLI's own token (`bin/synapse.js`); the other two are
 * the launchers that host this plugin — the Electron desktop host, and the `dsh`
 * launcher behind `dsh web`. A false positive only refuses to steal a lock, so
 * the extra patterns stay narrow.
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
