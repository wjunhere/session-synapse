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

**用 app 自己的插件管理（设置 → 插件）**，不要手改 profile：

- 桌面 profile 由 Electron 应用独占，`dsh plugin --profile desktop add …` 会被直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。
- app 内那条路径就是宿主插件 `@deepseek-ai/dsh-plugin-manager` 的 `installBundle(spec)`：`spec` 支持 registry 名、git、以及**绝对路径 / `link:`**（`parseInstallSpec`：去掉 `file:`/`link:` 前缀后必须是绝对路径，否则报 `a local path must be absolute`）。它跑 pnpm、写 profile、激活 bundle。
- 所以本地开发装的是**路径**，不是包名：在安装对话框里填仓库的绝对路径（如 `B:\vibe_program\session-synapse`）。

改完 profile 要重启 app（模块图在启动时建）。

想手改也可以，但要知道 app 会把它改回来：profile 三件套（`package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`）每次改动 app 都会留 `*.bak-<stamp>`，手改必须同时做两件事 —— `dependencies` 加 `"session-synapse": "link:<repo>"`、`dsh.profile.bundles` 追加 `"session-synapse"`，然后用运行时自带的 pnpm 在那个目录装（`D:\dsh\resources\runtime\primary-runtime\dependencies\pnpm`）。

`$DSH_HOME` 可覆盖数据根，所以自动化验证可以起一个**完全隔离的实例**（`DSH_HOME=<tmp> dsh rescue …`），不碰真实会话 —— 与 pi-web 套件的探测纪律同源。

## 5. 画布侧的宿主差异

| 项 | pi-web | DSH |
|---|---|---|
| 按钮/文案 | `src/canvas/host-labels.js` 的 `pi-web` 行 | 同文件的 `dsh` 行（由 `/synapse/api/status` 的 `adapter` 选行；未拿到之前显示中性文案） |
| 打开会话 | `?session=` 整页导航（父页面做） | `ctx.uiWorkspace.openSession(id)`（client 半区处理 `synapse:open-session`） |
| 运行中/流式 | 父页面订阅 pi-web 的 SSE | client 半区保留 running 会话的引用，读它 event window 里的 `assistant/live-chunk`（`text-delta` 拼接） |
| 主题 | `documentElement.dataset.theme` / `dark` class | `body[data-ds-dark-theme]`（client 半区转成 `synapse:theme`） |
| 写操作（新建/发消息/分支/改名/归档） | 浏览器直接调 pi-web 的 `/api/*`（pi-web 要求 `Origin` 等于自己的 `Host`，只有页面能发） | 画布调 `/synapse/api/host/*`，插件在本进程内调 harness 服务（`ctx.sessionController` / `ctx.workspaceController`） |
| 切换条位置 | pi-web 页面上居中悬浮（`src/canvas/bridge.js` 注入） | 宿主头部的操作区（`[class*="_headerCorner"]`）里第一个子节点，紧邻文件管理器/面板开关那排 |
| 画布占哪块地方 | 覆盖 pi-web 整页（除顶栏） | 宿主框架的**中间那一列**（`[class*="_centerCol"]`），头部下沿起 —— 宿主的侧栏和头部留在原处 |

### 5.1 切换条为什么长在头部操作区里

宿主**没有**为这个位置提供 slot（`dsh-client-ui-slots` 里只有 `sidebar` / `main` / `rightbar` / `shell.overlay` / `shell.leading` 这些框架级席位），所以切换条是 DOM 注入的，用 CSS-module 的**本地名**匹配（`*_headerCorner`）：哈希前缀每次构建都变，本地名不变。

两条推论，都是踩过才知道的：

1. **画布要只占中间那一列，且从头部下沿开始。**
   - 如果遮罩从页面顶部起，头部（连同里面的切换条）会被盖住 —— 按钮恰好在最需要它的时候点不到；
   - 如果遮罩只从头部下沿起、但横跨整页宽，宿主的侧栏会被**半截覆盖**：它自己的侧栏顶部（logo、新会话）露在画布上方，画布自己的侧栏又接着往下列 —— 两截侧栏叠在同一列，看起来像另一个应用被嵌进窗口（实测截图对比过）。所以宽度收到中间那一列，切视图只换内容，宿主侧栏/头部不动。
   - 几何全部实测得出（`--synapse-top` / `--synapse-left` / `--synapse-width`），右栏展开、侧栏收起、全屏都会变，所以跟切换条同一套 observer 重算。
2. **注入的节点会被 React 重渲染丢掉。** 切会话/切主题都会重建头部，所以要用 MutationObserver（rAF 合帧）幂等地重挂，并重算几何。

头部找不到时（全屏框架、以后的布局改版）切换条回到自己的容器里当悬浮胶囊 —— **只降级位置，不降级功能**。

选择哪条通道不是画布决定的：`/synapse/api/status` 报 `writeTransport`（`'host'` / `'synapse'`），画布据此安装；未知值直接报错，不猜。画布只会调语义化操作（`hostSendMessage` / `hostForkSession` / `hostRenameSession` / `hostArchiveSession` / `hostEnsureSession`），宿主自己的命令词（`prompt` / `fork_branch` / `set_tools`）不外泄到 `app.js`。

### 5.2 DSH 的写操作具体怎么落

| 画布动作 | 路由 | harness 调用 |
|---|---|---|
| 新建会话 | `POST /synapse/api/host/session` | `sessionController.create({ cwd })` |
| 发消息（可带图） | `POST /synapse/api/host/prompt` | `sessionController.prompt({ requestId, sessionId, mode: 'queue', content, clientTimeZone })` |
| 分支 | `POST /synapse/api/host/fork` | `sessionController.fork({ sessionId, atSeq })` |
| 改名 | `POST /synapse/api/host/rename` | `sessionController.rename({ sessionId, title })` |
| 归档 / 取消归档 | `POST /synapse/api/host/archive` | `workspaceController.archiveSession({ sessionId })` / `unarchiveSession` |

几个不能想当然的点：

- **`atSeq` 是事件序号，不是索引，而且是闭区间。** 画布的 entry id 就是事件 `seq` 补零到 8 位（`dshEntryId`），所以 `Number(entryId)` 正好是逆运算；画布说的「从这一轮分叉」= 保留这一轮，与 harness 的闭区间语义一致。注意 DSH 的 id 是**十进制**，pi 的 entry id 是 8 位**十六进制**——形状一样、意思完全不同，所以 `forkBoundary()` 用十进制正则校验，把混淆当场报错。
- **`mode: 'queue'` 而不是 `'steer'`。** 队列是在当前轮之后追加，steer 会打断当前轮——画布发一条消息不该打断正在跑的轮次。
- **`requestId` 必须自己铸。** 宿主把它记成用户消息的 `rpcId` 并据此去重，重试要用同一个身份。
- **图片字段叫 `mediaType`（不是 pi-web 的 `mimeType`），且是闭集**（`image/png|jpeg|webp|gif`）。不在集合里的类型在这里就报出具体类型，而不是等附件准入抛一个笼统的 `session/attachment-invalid`。模型不支持图片输入时 harness 会拒（`MODEL_DOES_NOT_SUPPORT_IMAGES`），这是真实错误，不绕过。
- **归档不传 `stopActivity`。** DSH 自己的归档命令也不传：正在跑的会话会被**拒绝**（`workspace/session-active`），而不是静默把那一轮杀掉。
- **`btw` / `setTools` 保持 false。** DSH 根本没有「按会话固定工具清单」这回事（工具限制只存在于 subagent 描述符和权限预设里），不固定工具的 fork 是另一个功能，不该借同一个按钮露出来。
- **归档只影响 DSH 自己的侧栏。** `sessionController.list()` 不按归档集过滤（归档集是 workspace registry 的全局状态，由客户端 UI 用来过滤列表），所以归档后画布卡片照旧在——这与 pi-web 一致（那边归档也只隐藏 pi-web 自己的列表）。
- **harness 的拒绝会带原文。** DSH 的 Remote 失败靠 `code` 判别（不用 `instanceof`），域内 code（`session/fork-unavailable`、`workspace/session-active`…）在 adapter 里转成 `HostRequestError` → 路由回 400 + harness 原话；`gateway/internal` 是 harness 自己的故障，继续走 500。

## 6. 验证

一条命令跑完整套（自己起隔离 harness、自己清理）：

```bash
npm run verify:dsh
```

`scripts/verify-dsh.mjs` 做的是：临时 home 建 profile → `dsh plugin add link:<repo>` → 拷一份 `.credentials.yaml`（它要真的调模型）→ `dsh rescue --no-open` → 用 playwright 把画布当插件验 15 项（切换条/能力/宿主文案/新建+发消息/分支/改名/归档/拒绝报文/无页面错误）→ 杀进程树、删临时 home。前置：`dsh` 在 PATH 上 + 有凭据；缺一个就直接报错退出，不降级。

手动起一个隔离实例（套件里那套步骤，拆开看）：

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

写操作分两层验，两层都跑真宿主：

```bash
npm run verify:dsh                                   # 仓库里的套件（推荐）
node B:/vibe_program/tmp/probe-dsh-writes.mjs        # 页面内 fetch 直接打 /synapse/api/host/*
node B:/vibe_program/tmp/probe-dsh-ui-writes.mjs     # 真按画布按钮：新建/发消息/分支/改名/归档
```

UI 探针里有两处必须记住的细节：`data-thread` 是**画布线程 id**（不是会话 id，会话 id 形如 `session-<uuid>`）；画布会因投影刷新重渲染，元素句柄会失效，点之前要重新取。第三处是套件里的真问题：**`store()` 读服务端的库，卡片却是从页面自己的 `state.workspace` 渲染的**，两者不同步 —— 刚发出的那轮在页面上可能还带着 pending 占位答案（没有 `sourceEntryId`，就没有分支入口），所以要**轮询等卡片落定**而不是看一眼就断言。

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
53. **`sessionController.list()` 不按归档集过滤。** 归档集（`workspaceRegistry.archivedSessionIds`）是 registry 的全局状态，只由客户端 UI 用来过滤侧栏；宿主列表照旧返回已归档的会话。所以「归档成功」要看 `storages/workspace.json` 的 `global.archivedSessionIds`，用会话数量变化去判断会得出错误结论。
54. **画布调不到 harness 的写服务。** 它们是本进程内的 cordis 服务，不是页面上某个 origin 的 HTTP 路由，pi-web 那套「同源 + 浏览器直接发」搬不过来。写操作因此必须由宿主插件代做（`writeTransport: 'synapse'`），并且这条路要显式声明：默认值仍是 `'host'`，缺字段时不会把写操作悄悄改道。
55. **DSH 的 Remote 失败不能用 `instanceof` 判。** 类会被 Gateway 跨 bundle 重建，官方判据是 `code` 字符串（`isDSHRemoteError === true` 是结构标记）。而且「请求有问题」与「harness 自己坏了」共用同一个类：域内 code 应当回 400 带原文，`gateway/internal` 才该是 500 —— 一律当 500 会把用户能自己修的问题藏进服务器错误。
56. **自己注入的 UI 不能被自己的遮罩盖住，也不能被遮一半。** 切换条原来浮在标题上，遮罩从 `--dsh-frame-chrome-top` 起 —— 地图视图下整条头部（连同切换条）都在遮罩之下，**回不到对话视图**；改成「头部下沿起、横跨整页」后又变成宿主的侧栏被截成两截（它自己的 logo/新会话露在画布上方，画布自己的侧栏接着往下列）。正解是**只占中间那一列**（`[class*="_centerCol"]`）。判断可见性要用 `elementFromPoint` 命中自己，不能只看 `getBoundingClientRect`。
57. **注入到 React 组件里的节点会被重渲染丢掉。** 切会话/切主题都会重建头部，头部操作区里那个 `prepend` 进去的节点随之消失（外表现为「切换条时有时无」）。用 MutationObserver（rAF 合帧，避免流式期间每帧回调）幂等重挂，并顺手重算头部下沿。
58. **CSS-module 的哈希前缀会变，本地名不变。** 选宿主元素只能匹配 `*_headerCorner` 这种后半段（实测哈希是 `wSkVaW_headerCorner`）。反过来，`[class*="_header"]` 这种写宽了会命中别的东西（实测命中了正文里的 `bhn1Oq_headerActions`），拿它量头部高度会把画布起点算到 198px 而不是 40px。
