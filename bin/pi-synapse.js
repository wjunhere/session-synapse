#!/usr/bin/env node
/**
 * pi-synapse CLI.
 *
 * `start` runs the proxy that puts the canvas and pi-web on one origin, then
 * projects every pi session into the canvas. pi-web itself is expected to be
 * running already (or is spawned with --spawn).
 */
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { createPiAdapter, defaultAgentDir, defaultDataFile } from '../src/adapters/pi.js'
import { Synapse } from '../src/synapse.js'
import { createApiHandler, createAssetHandler } from '../src/server/routes.js'
import { createGuard } from '../src/server/guard.js'
import { startServer } from '../src/server/proxy.js'
import { acquireInstanceLock, InstanceLockError } from '../src/store/instance-lock.js'

const HELP = `pi-synapse — pi 的会话地图

用法:
  pi-synapse start [选项]

选项:
  -p, --port <port>         canvas 代理端口 (默认 30142)
  -u, --upstream <port>     pi-web 端口 (默认 30100)
  -H, --hostname <host>     绑定地址 (默认 127.0.0.1)
      --data <path>         画布数据文件 (默认 <agent>/synapse/workspaces.json)
      --no-projection       不自动投影会话
      --no-inject           不向 pi-web 页面注入切换条
      --spawn               顺带启动 pi-web
      --force               接管另一实例持有的画布数据锁（仅当它已挂起时用）
  -h, --help                显示帮助

说明:
  同一份画布数据文件同时只能有一个实例在写。若已有实例在跑，
  本进程会在做任何工作之前退出并告知占用的 PID。

环境变量:
  PI_CODING_AGENT_DIR       pi agent 数据目录 (默认 ~/.pi/agent)
  PI_SYNAPSE_PORT           同 --port
  PI_SYNAPSE_UPSTREAM       同 --upstream
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      upstream: { type: 'string', short: 'u' },
      hostname: { type: 'string', short: 'H' },
      data: { type: 'string' },
      'no-projection': { type: 'boolean' },
      'no-inject': { type: 'boolean' },
      spawn: { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  const command = positionals[0] ?? 'start'
  if (values.help === true || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (command !== 'start') {
    process.stderr.write(`未知命令: ${command}\n\n${HELP}`)
    process.exitCode = 1
    return
  }

  const port = Number(values.port ?? process.env.PI_SYNAPSE_PORT ?? 30142)
  const upstreamPort = Number(values.upstream ?? process.env.PI_SYNAPSE_UPSTREAM ?? 30100)
  const host = values.hostname ?? '127.0.0.1'
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`无效端口: ${port}`)
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error(`无效上游端口: ${upstreamPort}`)

  const agentDir = defaultAgentDir()
  const dataFile = values.data ?? defaultDataFile(agentDir)

  // Claim the data file BEFORE anything can write to it.
  //
  // Order matters. The WorkspaceStore writes on first run (creating the file)
  // and on migration, and `synapse.start()` starts a projection poll timer. If
  // the lock were taken later, a second instance would already have rewritten
  // the file and, when its port was busy, would keep doing so forever: exactly
  // how three leftover copies inflated the data file to 545 MB.
  let lock
  try {
    lock = await acquireInstanceLock(dataFile, { port, force: values.force === true })
  } catch (error) {
    if (error instanceof InstanceLockError) {
      const held = error.holder
      const since = typeof held.startedAt === 'string' ? `，启动于 ${held.startedAt}` : ''
      const where = Number.isInteger(held.port) && held.port !== null ? `，端口 ${held.port}` : ''
      process.stderr.write(`pi-synapse: 已有实例正在使用这份画布数据（PID ${held.pid}${where}${since}）\n`)
      process.stderr.write(`pi-synapse: 数据文件 ${dataFile}\n`)
      process.stderr.write('pi-synapse: 同一份数据只能有一个写入者。若要换端口，请同时改 --data；若那个进程已挂起，用 --force\n')
      process.exitCode = 1
      return
    }
    throw error
  }
  if (lock.tookOver) process.stdout.write('pi-synapse: 接管了一个遗留的锁（原持有者已退出）\n')

  // The browser performs the writes (it shares pi-web's origin through the
  // proxy), so the capabilities are declared here and the canvas gates its UI
  // on them. `openSession` is also a browser action: a plain navigation.
  const adapter = createPiAdapter({
    agentDir,
    renameSession: true,
    archiveSession: true,
    capabilities: { openSession: true, forkSession: true, sendMessage: true, setTools: true, btw: true },
  })
  const synapse = new Synapse({
    adapter,
    dataFile,
    autoProjection: values['no-projection'] !== true,
  })

  if (values.spawn === true) spawnPiWeb(upstreamPort)

  const isTrustedHost = createGuard()
  const handleApi = createApiHandler(synapse, isTrustedHost)
  const handleAsset = createAssetHandler()

  // Bind the port BEFORE projecting. A busy port is the common case for a second
  // instance, and failing here means it exits without ever starting the
  // projection timer or touching the data file.
  const server = await startServer({
    port,
    host,
    upstreamPort,
    synapse,
    inject: values['no-inject'] !== true,
    handleSynapse: async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/synapse/api' || path.startsWith('/synapse/api/')) {
        await handleApi(req, res)
        return true
      }
      return handleAsset(req, res)
    },
  })

  process.stdout.write('pi-synapse: 正在读取会话…\n')
  try {
    await synapse.start()
  } catch (error) {
    server.close()
    await lock.release()
    throw error
  }
  const sessions = synapse.sessions.size
  const workspaces = await synapse.listWorkspaces()
  process.stdout.write(`pi-synapse: 已投影 ${sessions} 个会话 / ${workspaces.length} 个工作区\n`)

  const address = server.address()
  const shownPort = typeof address === 'object' && address !== null ? address.port : port
  process.stdout.write(`pi-synapse: 已启动 → http://${host}:${shownPort}/\n`)
  process.stdout.write(`pi-synapse: 会话地图 → http://${host}:${shownPort}/synapse/\n`)
  process.stdout.write('pi-synapse: 在 pi-web 页面顶部中间的「对话 / 会话地图」切换条即可打开\n')

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    process.stdout.write('\npi-synapse: 正在关闭…\n')
    synapse.stop()
    await lock.release().catch(() => {})
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2_000).unref()
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

function spawnPiWeb(port) {
  const child = spawn('npx', ['-y', '@agegr/pi-web@latest', '--port', String(port), '--no-open'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  child.on('error', error => process.stderr.write(`pi-synapse: 无法启动 pi-web: ${error.message}\n`))
  process.on('exit', () => child.kill())
}

main().catch(error => {
  process.stderr.write(`pi-synapse: ${error?.stack ?? error}\n`)
  process.exitCode = 1
})