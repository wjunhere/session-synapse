# dsh desktop 适配

> 同一张画布接进 DeepSeek Harness：desktop app（Electron 壳）与 `web` profile 共用一份插件代码。
> 本篇只写「desktop 与 web 差在哪」「实测到哪些接口」，投影/画布/服务的通用规则仍在各自文档。

相关：[architecture.md](architecture.md)（三层与 adapter 契约）、[host-integration.md](host-integration.md)（pi-web 那套的对标）、[runtime.md](runtime.md)、[verification.md](verification.md)

## 1. dsh desktop 是什么（全部实测）

- `D:\dsh\DeepSeek Harness.exe`：Electron 壳 + 内置 dsh 运行时 **0.2.1-rc.2**（在 `resources/app.asar!/dsh`）。
- 壳把 harness 当子进程拉起，命令行是
  `... app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js <dsh 目录> <profile 目录> <runtime 目录>`，
  其中 profile 目录 = `~/.dsh/profiles/desktop`，并给该子进程开 `--inspect=127.0.0.1:9230`（`dsh-experimental-inspector`，CDP target `dsh://host`）。
- harness 进程里起的是**完整 web 栈**，不是另一套东西：`dsh-host-webserver` 监听 `127.0.0.1:43740`。
  无 cookie 时 `/api/*` → 401；未注册的路径 → 404。
- 渲染进程的文档 origin 是 `dsh-app://app`（自定义 scheme，注册为 `standard/secure/supportFetchAPI/corsEnabled/stream/codeCache`）。
  壳的 `protocol.handle('dsh-app')` 只把 `/`、`/index.html`、`/assets/*`、`/favicon.svg`、`/manifest.webmanifest` 交给本地 dist，
  **其余路径一律转发给 43740**（`forwardWebRequest`：删掉 `host`/`origin`/`cookie`/`sec-fetch-site`，注入 host cookie）。

⇒ 插件注册的 webServer 路由、`/plugins/<pkg>/client.js`、iframe 里的相对 URL，在 desktop 全部按相对路径正常走通。
**desktop 与 web 的差别只有 profile 文件本身**；上游 dsh-synapse README 写的「只支持 web profile」是它 patch 文件的写法，不是接口限制。

## 2. 服务面

host 半区（`export const inject = [...]`）：

| 服务 | 用途 | 备注 |
|---|---|---|
| `ctx.webServer.register({ kind, path, handler })` | 注册 HTTP 路由 | 匹配顺序：精确 → 最长前缀 → fallback；handler 是原生 `(req, res)` |
| `ctx.sessions` | 活会话 `list()` / `get(id)` / `snapshotEvents()` / `create()` / `fork()` | `ctx.on('session/created'\|'session/event')` 是增量来源 |
| `ctx.sessionQuery` | **冷 + 活**会话读取：`listSessions` / `readSession` / `readSurface` / `readTitleSnapshots` / `traceSession` | sqlite 后端由 dsh-base + dsh-web-app 挂上，desktop 同样有 |

client 半区：

| 服务 | 用途 |
|---|---|
| `ctx.sessions` | `list.getSnapshot()` → `{ ids, byId }`，行字段 `id/displayTitle/title/cwd/parentId/running/blank/updatedAt`；`retain()` 后 `binding.session.prompt()` 发消息；`create()` / `fork()` |
| `ctx.uiWorkspace` | `openSession(id)` 切到某会话的对话视图、`archiveSession()`、`forkSession()` |
| `ctx.uiConversation` | `binding(id).target('chat')` 读流式正文（可选） |

client bundle 契约：`window.__ModuleLoader__.load({ id, factory })`，`factory` 里只允许 `require` 平台种子词（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等）。我们的画布不是 React，client 半区只用 DOM + `postMessage`，因此**不需要打包器**。

## 3. 数据

- 会话文件：`~/.dsh/sessions/<cwd 编码>--/<session-id>/session.v4.jsonl.zstd`；cwd 编码 `B:\vibe_program` → `--B-vibe_program--`。
- 首行是 header：`{"type":"session","version":4,"id","createdAt","cwd","parentSession","isSeeded","origin","delegationDepth","agentPreset"}`；事件信封是 `{type, seq, time(ms), data}`。
- **上下文占用不用自己算**：token meter 的会话投影 `contextPressure`（`{pressureTokens, contextWindow, surfaceTokens, claim?}`）就是 DSH 自己界面上的那个数，`ctx.sessionQuery.observeSession(id, {projectionMode:'all'})` 一次拿到；adapter 原样交给 store（`SessionHistory.contextUsage`），store 优先用它、不再跑 pi 那套估算器。
- 事件词表见 `@deepseek-ai/dsh-session/lib/types/known-event-types.js`（本版 58 种）。投影只认
  `user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/start|end`、`step/start|end`、`todo/write`、`compaction/summary`、`session/title`、`request/context`、`model/selection`；其余不进卡片（`assistant/attempt`、`session/end-seed`、`agent/inbox/spliced`、插件自有事件……）。
- **注入的上下文也是 `user/message`**：同一个事件类型既承载人的提问（`data.source.kind === 'user'`），也承载 harness 注入的每一份快照（实测出现过的 kind：`runtime-context`、`agent-instructions`、`skill-catalog`、`time-context`、`tool-jobs`、`agent-message`、`subagent-settled`、`plugin`、`compact-checkpoint`）。只有 `user` 能变成卡片，否则画布会被系统提示塔满。
- **投影条目的 id 必须是定宽的 `seq`**（`00000008`）：画布用 `sourceEntryId <= seedBoundary` 的**字符串**比较定位分支的父卡，不补零会让 `'100' < '12'`。
- fork：header 的 `parentSession` + 观察到的 `inheritedEventCount`（**事件数**，不是 id）。投影器自己把前缀丢掉，并把最后一个被继承事件的定宽 id 当 `inheritedEntryCount` 返回 —— store 与画布两边比的都是 id。
- 离线读日志用 `scripts/dsh-session-events.mjs`（多帧 zstd）；插件运行时不用它。
- 画布数据文件：`$DSH_HOME/session-synapse/workspaces.json`（`$DSH_HOME` 优先于 `~/.dsh`）。
  与上游 dsh-synapse 的 `$DSH_HOME/synapse/workspaces.json` **分开**，免得两个插件抢同一份数据的写权；要搬布局用 `synapse import --from`。

## 4. 装进 desktop profile

`dsh` CLI 明确拒绝 `--profile desktop`（`managed exclusively by the Electron application`），profile 三件套由 app 自己维护（每次改动留 `*.bak-<stamp>`）：

1. `~/.dsh/profiles/desktop/package.json`：`dependencies` 加 `"session-synapse": "link:<repo>"`，`dsh.profile.bundles` 追加 `"session-synapse"`；
2. 在该目录用运行时自带的 pnpm 安装：`D:\dsh\resources\runtime\primary-runtime\dependencies\pnpm`；
3. 重启 app。

`$DSH_HOME` 可覆盖数据根，所以自动化验证可以起一个**完全隔离的实例**（`DSH_HOME=<tmp> dsh web`），不碰真实会话 —— 与 pi-web 套件的探测纪律同源。

## 5. 画布侧的宿主差异

| 项 | pi-web | DSH |
|---|---|---|
| 按钮/文案 | `src/canvas/host-labels.js` 的 `pi-web` 行 | 同文件的 `dsh` 行（由 `/synapse/api/status` 的 `adapter` 选行；未拿到之前显示中性文案） |
| 打开会话 | `?session=` 整页导航（父页面做） | `ctx.uiWorkspace.openSession(id)`（client 半区处理 `synapse:open-session`） |
| 运行中/流式 | 父页面订阅 pi-web 的 SSE | client 半区保留 running 会话的引用，读它 event window 里的 `assistant/live-chunk`（`text-delta` 拼接） |
| 主题 | `documentElement.dataset.theme` / `dark` class | `body[data-ds-dark-theme]`（client 半区转成 `synapse:theme`） |
| 写操作（改名/归档/发消息/分支） | 浏览器直接调 pi-web 的 `/api/*` | 未实现（D4：走 client 半区的 `ctx.conversation` / `ctx.uiWorkspace`） |

## 6. 验证

隔离实例（不碰真实会话）：

```bash
# 1) 用临时 home 建一个从官方 web 模板派生的 profile，并把插件装进去
DSH_HOME=B:/vibe_program/tmp/dsh-probe dsh rescue --from-default-profile web --dump-config
DSH_HOME=B:/vibe_program/tmp/dsh-probe dsh plugin --profile rescue add link:B:/vibe_program/session-synapse
# 2) 启动（打印带 token 的 URL）
DSH_HOME=B:/vibe_program/tmp/dsh-probe dsh rescue --no-open --port 30144
# 3) 断言
curl -s 127.0.0.1:30144/synapse/api/status     # → {"adapter":"dsh",...}
curl -s 127.0.0.1:30144/synapse/ | head        # → 画布 HTML
```

`dsh plugin add` 是标准的装插件动作：它改 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`）并跑 pnpm。

浏览器侧（playwright，同 pi-web 套件那套）：带 `?token=` 打开首页 → 断言 `.synapse-switch button` 有 2 个、`.synapse-overlay iframe` 的 url 以 `/synapse/` 结尾、iframe 里 `#app` 有内容、`pageerror`/`console error` 为空。
**新 home 首次启动会有引导弹窗**（「预览版说明」/「添加一个 API Key」），它的 mask 会拦住指针事件：脚本里用 `page.evaluate(() => el.click())` 发 DOM click，或先把弹窗点掉。

流式要**在同一个进程里跑一个轮次**才看得到（在 DSH 界面里发一条 prompt），因为 `running` 与实时 chunk 都是进程内状态：

```js
const composer = page.locator('[contenteditable=true]').first()   // DSH 的输入框不是 textarea
await composer.click(); await composer.type('写一篇 400 字短文…'); await page.keyboard.press('Enter')
// 切到画布后读 iframe 里的 window.__synapse.state.liveReplies：running=true + text 长度增长
```

反过来说，另一个进程（`dsh headless`、第二个 harness）写的会话，本进程只能在轮询里发现（坑 52），且**不会**有流式状态。

desktop 侧的肉眼验收：遮罩里画布出卡片、主题跟随、点卡片能跳会话。host realm 可调试：CDP `ws://127.0.0.1:9230/devtools/page/<id>`（target 是 `dsh://host`）。

## 7. 坑（编号接仓库全局序列）

44. **桌面不是另一套接口。** 判断「某能力 desktop 有没有」时先看 webServer 那条转发规则（§1），别按 README 的 profile 声明下结论：desktop 上 `webServer`、`/plugins/*`、iframe 相对 URL 全都在。
45. **会话文件是多帧 zstd。** `zlib.zstdDecompressSync` 只解**第一帧**（实测 766 KB 的文件只拿到 header 一行）——append-only 日志每段一个 frame，必须逐帧解（DSH 自己用 `NodePrivateZstdFrameDecoder`）。在 host 里读冷会话一律走 `ctx.sessionQuery`，自己解文件只在离线场景用。
46. **client 插件 apply 时 `document.body` 可能还不存在**（pi-web 那条注入路径踩过同一个坑）。挂 DOM 前先判空，缺了就等 `DOMContentLoaded`。
47. **client bundle 只能 require 平台种子词**，不能 import 自己的相对模块（没有打包器就不行）。所以 client 半区必须是自足的单文件。
48. **插件必须在 profile 里用「包的裸名」挂载。** 两处硬要求叠在一起：宿主 loader 按裸名解析模块，而 client 模块图的 `exactPackageSpecifier()` 会拒掉任何带 `/` 的 specifier（`session-synapse/dsh` → 客户端 bundle 永不出现，`/plugins/*` 返回 404，页面上只有宿主 UI 而没有切换条）。所以包的**主入口就得是插件**（与 dsh-synapse / dsh-skill-mcp-panel 同形）：`src/index.js` 在原有库导出之外再 re-export 插件的 `name`/`inject`/`apply`。
49. **client bundle 的注册 id 是「包名」，不是 patch 里的 entry id。** 客户端模块图的行 id 取自解析到的 package name（`record.entry.id = packageName`），所以 `__ModuleLoader__.load({ id })` 要写 `session-synapse`；写 patch 的 `synapse` 会得到 “bundle loaded without registering …”。
50. **`/plugins/<pkg>/client.js` 不是稳定 URL。** 启动图用 combo URL（`/plugins/??a/client.js,b/client.js&rev=…`），直连单资源路径会 404 —— 404 不能当成「客户端半区没加载」，要看首页 HTML 里的 `__DSH_BOOT__`。
51. **在 `ctx.sessions.list` 的订阅里 retain 会递归。** `retain()`/`release()` 会把引用计数发布到同一张列表快照里（行上的 `retainedBy`），于是在订阅者里调用它就又进一次订阅者 —— 实测 `RangeError: Maximum call stack size exceeded`，由 client store 的 subscriber 抛出，客户端 UI 停在半更新状态。加一个「已在同步中就直接返回」的门就能断环（外层那次会跑完同样的活）。
52. **另一个进程写的会话，本进程看不见。** `session/created` / `session/event` 只覆盖本进程的事件；DSH 的持久化层没有 watcher，也没有变更事件，所以 `dsh headless`（或第二个 harness）新建/追加的会话在我们这里根本不触发通知 —— 实测：headless 跑完一整轮，画布仍是旧数量。适配器必须自己按 5s 重新列一次语料，只对 `updatedAt` 变了的行重新投影（与 pi 适配器需要轮询是同一个原因：画布不是它所读东西的唯一写入者）。
