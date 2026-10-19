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
| `ctx.uiConversation` | `binding(id).target('chat')` 读流式正文（可选）；`binding(id).activate(viewId)` 切到某个会话标签 |
| `ctx.slots` | `inject('conversation.view', () => register({ name: 'conversation.view', id, order, label, inject }, Component))` 把「会话地图」注册成宿主标签行里的一个标签（与 对话/轨迹/提示词 同一套）。组件由 ui-renderer 用 React 渲染（所以 client bundle 里现在真的 `require('react')`），挂载/卸载就是「地图是不是当前标签」的真相（§5.1） |

client bundle 契约：`window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 里只允许 `require` 平台种子词（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等）。画布本身仍然是 DOM + `postMessage`（视图正文只挂一个锚点 `div`），因此**不需要打包器**；唯一用到的种子模块是 `react`（标签视图必须是个 React 组件）。

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
| 画布显示哪个工作区 | 侧栏里自己选（画布就是导航） | **跟着宿主的会话走**：宿主换到另一个目录的会话，地图就跟着换过去（地图里没有工作区下拉）。靠 `synapse:current-session` 推过来，只有 id 真的变了才动 |
| 运行中/流式 | 父页面订阅 pi-web 的 SSE | client 半区保留 running 会话的引用，读它 event window 里的 `assistant/live-chunk`（`text-delta` 拼接） |
| 主题 | `documentElement.dataset.theme` / `dark` class | `body[data-ds-dark-theme]`（client 半区转成 `synapse:theme`） |
| 写操作（新建/发消息/分支/改名/归档） | 浏览器直接调 pi-web 的 `/api/*`（pi-web 要求 `Origin` 等于自己的 `Host`，只有页面能发） | 画布调 `/synapse/api/host/*`，插件在本进程内调 harness 服务（`ctx.sessionController` / `ctx.workspaceController`） |
| 地图入口 | pi-web 页面上居中悬浮的切换条（`src/canvas/bridge.js` 注入） | 宿主自己的会话标签行里的一个标签（`conversation.view` 槽位，与 对话/轨迹/提示词 同一套）；没有标签行的那一屏（欢迎页）才用浮动胶囊 |
| 画布占哪块地方 | 覆盖 pi-web 整页（除顶栏） | 宿主框架的**中间那一列**（`[class*="_centerCol"]`），头部下沿起 —— 宿主的侧栏和头部留在原处 |
| 画布自己的侧栏 | 展开（它就是这个界面的唯一导航） | **不渲染**：宿主已有自己的会话列表，两份列表是同一份信息两次 |
| 画布自己的顶栏 / 视图标签 | 渲染 | **不渲染**：宿主已有头部，再顶一条就是「应用套应用」；工具改成右下角浮动簇 |
| 颜色与字体 | 画布自己的暖纸色 + Geist/Newsreader | 跟随宿主的 `--dsw-alias-*` / `--dsw-font-family`（由宿主半区读出后经桥推过来） |

### 5.1 地图为什么是宿主的一个标签（而不是自己注入一条切换框）

宿主自己就把「对话 / 轨迹 / 提示词」做成了**可注册的视图**：`ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id, order, label, inject }, Component))`。标签行由宿主从 `slots.entries('conversation.view')` 渲染，哪个是当前标签、每个会话记住哪个标签、点击怎么切，全是宿主的事 —— 所以「会话地图」注册成一个视图就够了，不需要注入按钮，也不需要自己维护选中态。

于是契约变成一条极简的循环：**我们的组件被挂载 = 地图是当前标签**，所以挂载时 `show('map')`、卸载时 `show('dialog')`，宿主的状态就是唯一真相。两个后果：

- **画布仍然是 iframe + 固定定位的遮罩，不是视图的子节点。** 在 DOM 里搬动 iframe 会让它重新加载，把画布当视图正文就等于每切一次标签把整页（相机、选中、模块图）重载一遍。视图正文只渲染一个锚点 `div`，遮罩按实测几何（头部下沿 + 中间那一列）盖在会话区上。
- **「离开地图」不是自己能做的事。** 点 对话 是宿主切标签（我们卸载 → 收遮罩）；但欢迎页的浮动入口打开的那层遮罩没有任何东西会卸载它，所以还要按标签行的 active 状态同步（`syncMapWithHost`）。同理 Escape 与「打开会话」要请宿主切到 `chat` 视图，而不是自己把遮罩藏掉 —— 否则标签停在 会话地图、背后却是一片空白。

几何仍然是实测的（`--synapse-top` / `--synapse-left` / `--synapse-width`）：右栏展开、侧栏收起、全屏都会变，跟标签行同一套 observer 重算。

**没有标签行的那一屏（欢迎页）保留浮动胶囊。** 实测：欢迎页会为它自己的输入框保留一个会话（所以“有当前会话”不等于“有标签行”），但它不渲染标签行 —— 那时地图的入口只能是胶囊，而胶囊的显示条件因此要看 DOM（`conversationTabList()`），不能看会话 id。

遮罩为什么只占中间那一列、且从头部下沿开始（踩过才知道的）：

- 如果遮罩从页面顶部起，头部（连同里面的标签行）会被盖住 —— 入口恰好在最需要它的时候点不到；
- 如果遮罩只从头部下沿起、但横跨整页宽，宿主的侧栏会被**半截覆盖**：它自己的侧栏顶部（logo、新会话）露在画布上方，画布自己的侧栏又接着往下列 —— 两截侧栏叠在同一列，看起来像另一个应用被嵌进窗口（实测截图对比过）。所以宽度收到中间那一列，切视图只换内容，宿主侧栏/头部不动。

画布自己的设置面板（右下角齿轮：卡片大小 / 卡片字体 / 显示天数）不依赖宿主，两边都有；见 [canvas-ui.md](canvas-ui.md)。

画布带多少 chrome 由宿主说：DSH 在 `synapse:map-ready` 后回一条 `synapse:chrome {embedded:true}`，画布进入**嵌入模式**（侧栏/顶栏/标签行全不渲染、工具变浮动簇、字体与颜色改跟宿主）。pi-web 不发这条消息，画布保持原样。

两个必须知道的细节：

- **token 只能由宿主读出来推过去。** 画布在 iframe 里，`getComputedStyle(frame).getPropertyValue('--dsw-…')` 在帧内返回空串 —— 自定义属性不过文档边界。所以宿主半区读自己的 token（在 `body` 上，不在 `documentElement` 上）、以 `synapse:theme {dark, tokens}` 推给画布。
- **token 重映射要挂在 `html[data-embedded]`，不能挂在 `#app` 里的壳上。** 画布在 `:root` 里就写了 `font-family: var(--font-sans)`，作用在 `html` 上，挂在壳上的重映射它看不见（实测：卡片字型还是 Geist，而宿主字体已经推到了）。

选择哪条通道不是画布决定的：`/synapse/api/status` 报 `writeTransport`（`'host'` / `'synapse'`），画布据此安装；未知值直接报错，不猜。画布只会调语义化操作（`hostSendMessage` / `hostForkSession` / `hostRenameSession` / `hostArchiveSession` / `hostEnsureSession`），宿主自己的命令词（`prompt` / `fork_branch` / `set_tools`）不外泄到 `app.js`。

### 5.2 DSH 的写操作具体怎么落

| 画布动作 | 路由 | harness 调用 |
|---|---|---|
| 新建会话 | `POST /synapse/api/host/session` | `sessionController.create({ cwd })` |
| 发消息（可带图） | `POST /synapse/api/host/prompt` | `sessionController.prompt({ requestId, sessionId, mode: 'queue', content, clientTimeZone })` |
| 分支 | `POST /synapse/api/host/fork` | `sessionController.fork({ sessionId, atSeq })` |
| 侧问 /btw | `POST /synapse/api/host/btw` | `fork` → `resolveAgent` → `agent.ctx.tools.restrict` → `permissionPresets.set(session, 'read-only')`（**不归档**，见 §5.3） |
| 改名 | `POST /synapse/api/host/rename` | `sessionController.rename({ sessionId, title })` |
| 归档 / 取消归档 | `POST /synapse/api/host/archive` | `workspaceController.archiveSession({ sessionId })` / `unarchiveSession` |

几个不能想当然的点：

- **`atSeq` 是事件序号，不是索引，而且是闭区间。** 画布的 entry id 就是事件 `seq` 补零到 8 位（`dshEntryId`），所以 `Number(entryId)` 正好是逆运算；画布说的「从这一轮分叉」= 保留这一轮，与 harness 的闭区间语义一致。注意 DSH 的 id 是**十进制**，pi 的 entry id 是 8 位**十六进制**——形状一样、意思完全不同，所以 `forkBoundary()` 用十进制正则校验，把混淆当场报错。
- **`mode: 'queue'` 而不是 `'steer'`。** 队列是在当前轮之后追加，steer 会打断当前轮——画布发一条消息不该打断正在跑的轮次。
- **`requestId` 必须自己铸。** 宿主把它记成用户消息的 `rpcId` 并据此去重，重试要用同一个身份。
- **图片字段叫 `mediaType`（不是 pi-web 的 `mimeType`），且是闭集**（`image/png|jpeg|webp|gif`）。不在集合里的类型在这里就报出具体类型，而不是等附件准入抛一个笼统的 `session/attachment-invalid`。模型不支持图片输入时 harness 会拒（`MODEL_DOES_NOT_SUPPORT_IMAGES`），这是真实错误，不绕过。
- **归档不传 `stopActivity`。** DSH 自己的归档命令也不传：正在跑的会话会被**拒绝**（`workspace/session-active`），而不是静默把那一轮杀掉。
- **`setTools` 保持 false。** DSH 根本没有「按会话固定工具清单」这回事（工具限制只存在于 subagent 描述符和权限预设里），所以不把那个按钮露出来。`btw` 是另一回事：它由宿主自己实现（§5.3），能力位是 true。
- **归档只影响 DSH 自己的侧栏。** `sessionController.list()` 不按归档集过滤（归档集是 workspace registry 的全局状态，由客户端 UI 用来过滤列表），所以归档后画布卡片照旧在——这与 pi-web 一致（那边归档也只隐藏 pi-web 自己的列表）。
- **harness 的拒绝会带原文。** DSH 的 Remote 失败靠 `code` 判别（不用 `instanceof`），域内 code（`session/fork-unavailable`、`workspace/session-active`…）在 adapter 里转成 `HostRequestError` → 路由回 400 + harness 原话；`gateway/internal` 是 harness 自己的故障，继续走 500。

### 5.3 /btw 侧问在 DSH 上怎么落地

侧问要三件事：继承真实上下文、只给一部分工具、不弄脏主列表。三件都做不到「像 pi-web 那样做」，分别如下。

**继承上下文**：`sessionController.fork({ sessionId, atSeq })`，与分支同一条路。画布的侧问按钮带着所在卡片的 `data-seq`，所以 DSH 上的侧问继承的是**到那一轮为止**的上下文（pi-web 那半仍按它一直以来的做法从会话末尾分叉）。

**只给一部分工具：`agent.ctx.tools.restrict({ allow })`。** 三个实测结论决定了代码形状：

- **agent preset 那条路是死的。** 会话跑过一轮后 `agentPresets.select(agent, preset)` 抛 `agent-preset/locked`（「This session has already started」），fork 出来的子会话同样 locked，连换回 standard 也拒。所以「给侧问一个只读 preset」不成立。
- **restrict 是作用域上的效应，不是会话状态。** 它挂在 `agent.ctx` 上（`agent` 来自 `sessionController.resolveAgent(sessionId)`），所以**进程一重启就没了**。重启后侧问的工具面靠画布自己重钉（下面）。
- **它只挡「继承来的」工具。** 注册在 agent 自己那层上的工具不受 allow 影响（实测：钉 read/grep/glob 之后 `subagent` 还在），而且把这种名字写进 `allow` 会被 harness 当场拒绝（`tools.restrict() names unknown global tool …`，报文里带全部已知名字）。所以 `/synapse/api/status` 报两套：`tools`（这个会话实际能看见的）与 `pinnableTools`（可以写进 `allow` 的），画布的 chips 只用后者——否则就是摆一个必然失败的选择。
- **空清单不是「不给工具」。** `{ allow: [] }` 实测返回一个 disposer 但什么都不挡，所以空清单在画布和 adapter 两处都被当场拒（`侧问至少要给一个工具`），而不是静默变成「全给」。

**只读：`permissionPresets.set(session, 'read-only')`。** 这是**durable** 的那一半：它往子会话自己的日志里追加 `permission/preset` + `sandbox/mode` + `approval/policy`，重启后仍在。`read-only` 是 profile 里配好的 preset 名（`sandbox: read-only` / `approval: ask`），不是本插件发明的；profile 里没这个名字就当场报 `permission: unknown preset "read-only"`。

⇒ 两者分工：**restrict 管「模型面前摆哪些工具」（进程内、重启丢），权限预设管「沙箱与审批」（落进日志、重启在）**。

**重启后重钉。** 画布的 btw 线程本来就存了 `tools` 字段（`src/synapse.js` 的 `linkSessionThread`），adapter 在 `subscribe()` 里监听 `agent/created`：只要是画布记为 btw 的子会话，就在它被重新唤起的那一刻再 `restrict` 一次。时机是它被 `announce` 的时候——resume 事务里，任何一轮都还没开始，所以不存在「先跑一轮再钉」的窗口。

- 键是 agent **对象**（`WeakSet`）：同一个 agent 只钉一次（每次调用都会叠一层 restriction），而 agent 释放后重建的新对象会被重新钉。
- 监听器抛异常会**让那次 resume 失败**（`agent/created` 是 serial 分发），所以名字过期（harness 升过级、工具改了名）只写 stderr 并放过——durable 的沙箱那一半仍然在，总比把用户锁在自己的会话外面好。

**为什么不归档（与 pi-web 分道扬镳）。** pi-web 的 btw 会归档子会话，让主列表干净。DSH 上**不能这么做**：归档会给会话挂上 `ArchivedSessionGate`，它对已归档会话提出的每一步 `agent/pre-step` 一律 reject，于是那一轮以 `turn/end { kind: 'blocked' }` 收场——没有模型请求、没有报错。实测：fork 完就归档，紧接着的第一条侧问就答不出来；而 `sessionController.prompt` 对已归档会话**也不报错**（它返回 200，只是那一轮什么都不做），所以画布会一直停在「正在回复」。

⇒ 代价换了个方向：DSH 上的侧问**留在 harness 自己的会话列表里**（不清爽），但它能答、能继续问。`/synapse/api/status` 的能力位如实反映（`btw: true`、`setTools: false`），画布按钮的提示语也改成「不自动归档（DSH 的归档会拦住它发言）」，不再承诺清空列表。

**工具词表是宿主的。** pi 的只读预设是 `read/grep/find/ls`，DSH 没有 `find`/`ls`、却有 `web_fetch`/`web_search`，所以默认集是 DSH 自己的五个：`read, grep, glob, web_fetch, web_search`（`src/adapters/dsh.js` 的 `BTW_DEFAULT_TOOLS`，经 `/synapse/api/status` 的 `defaultBtwTools` 报给画布）。

**候选清单只在有活会话时给得出。** 工具面是逐 agent 的，所以 `btwTools()` 只查 `ctx.agents.get(id)`（活着的），**绝不为了回答一个 GET 去 resume 一个冷会话**；拿不到就报空数组，画布的 chips 就只剩默认那五个。画布因此在打开草稿卡时用当前会话再问一次 `/synapse/api/status?session=<父会话>`（那时父会话通常刚跑过、还活着），问到就长出其余可钉的名字。

## 6. 验证

一条命令跑完整套（自己起隔离 harness、自己清理）：

```bash
npm run verify:dsh
```

`scripts/verify-dsh.mjs` 做的是：临时 home 建 profile → `dsh plugin add link:<repo>` → 拷一份 `.credentials.yaml`（它要真的调模型）→ `dsh rescue --no-open` → 用 playwright 把画布当插件验 44 项（标签入口/能力/宿主文案/新建+发消息/追问/分支/侧问（真 fork、chips、工具面真的被砍）/改名/归档/跟着宿主换工作区/拒绝报文/无页面错误）→ 杀进程树、删临时 home。前置：`dsh` 在 PATH 上 + 有凭据；缺一个就直接报错退出，不降级。

标签与设置面板另有独立探针（都自己起隔离 home，跑完删掉）：

```bash
node B:/vibe_program/tmp/probe-dsh-tab-settings.mjs   # 15 项：标签出/收画布 + 设置面板三项真的生效
node B:/vibe_program/tmp/probe-dsh-welcome.mjs        # 诊断：欢迎页的入口与标签行的存在性
```

**它验不到「重启后」**：整个套件活着的是同一个 harness，而 `/btw` 的工具钉正是重启会丢的那一半。那一段在独立探针里（它自己会重启 harness）：

```bash
node B:/vibe_program/tmp/probe-dsh-btw.mjs   # 13 项：fork/钉工具/不归档/真模型侧无 pwsh/重启后重钉/归档确实会让它变哑
```

侧问那一项用一次真模型来证「工具面被砍」：让侧问自己说它有没有 pwsh（宿主把整套工具、含 pwsh，给普通会话，所以「没有 pwsh」只可能是被钉住了）。注意工具**被拒**也会记一条 `tool/call`（`Error: unknown tool`）——判定要看结果是不是 error，不能只看有没有那次调用。

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
59. **两份会话列表就是同一份信息看两遍。** 画布自己的侧栏和宿主的侧栏列的是同一批会话；在 DSH 里直接不渲染它（`synapse:chrome`）。代价是画布的「会话可见性开关」（眼睛）和它的「新会话」按钮随之消失：前者目前没有替代入口（藏了一个会话只能去改 `workspaces.json`），后者宿主自己有；空工作区的地图仍有「新建会话」。
60. **注入的 UI 与遮罩的层级要先想清楚再动手。** 地图视图下画布遮罩盖着中间列，所以在自动化里先切回「对话」再点 DSH 的输入框（否则 `locator.click` 只会等到 30s 超时）。这是验证脚本的坑，不是产品的：真实用户不会去点被遮住的东西。
61. **归档会拦住会话发言，`prompt` 还不报错。** 归档给会话挂上 `ArchivedSessionGate`（`ctx.on('agent/pre-step')` → `{kind:'reject'}`），那一轮以 `turn/end {kind:'blocked'}` 结束：没有模型请求、没有错误、`sessionController.prompt` 照样返回 200。所以「把侧问归档掉以保持列表干净」在 DSH 上是把侧问变成哑巴（实测：fork 完就归档，紧接着第一条侧问就答不出来）。`/btw` 因此**不归档**（§5.3），代价是侧问留在 harness 自己的会话列表里；画布上「从画布移除这个侧问」那个按钮对 DSH 的提示语也跟着改成「归档后只能查看，要再发言得先取消归档」。
62. **工具限制是 agent 作用域上的效应，不是会话状态。** `tools.restrict({allow})` 挂在 `agent.ctx` 上（不是写进会话日志），所以：① 进程重启后就没了，得在 `agent/created` 上重新钉（§5.3）；② 注册在 agent 自己那层上的工具不受它影响（实测钉 read/grep/glob 后 `subagent` 仍在），把这些名字写进 `allow` 会被当场拒绝——所以 chips 的候选只能是 `view(agent).restrictableNames`（状态接口里叫 `pinnableTools`），`schemas(agent)` 只能用来报「这个会话实际看得见什么」（`tools`）；把后者当选项清单就是把「摆一个必然失败的选择」当成功能；③ `{allow: []}` 是 no-op 而不是「全不给」，空清单必须自己拒。
63. **宿主的 `[role="tablist"]` 不止一个，而「有当前会话」不等于「有标签行」。** 侧栏自己就是一排 tab（实测 `_tabStrip_…`），所以「任何 tablist」不是要问的问题；而欢迎页会为自己的输入框保留一个会话、却不渲染会话标签行（实测：`tabs: []` 但 `currentSessionId()` 非空）。所以：① 认「哪一排里有我们自己注册的标签」（`conversationTabList()`）；② 浮动胶囊的显示条件看 DOM，不看会话 id。搞错的症状是欢迎页的入口消失，而地图没有其它入口。
64. **标签是宿主的状态，画布不能自己藏遮罩就完事。** 点 对话 是宿主切标签，我们只会在视图卸载时收遮罩；但欢迎页浮动胶囊打开的那层遮罩**没有任何东西会卸载它**（地图视图从没被挂载过），于是切到会话后画布还盖在对话上（实测：套件点输入框被 iframe 拦住，30s 超时）。两条修法合起来才完整：`syncMapWithHost()`（标签行说当前不是地图 → 收遮罩）与 `leaveMap()`（只有真的渲染了标签行的宿主才由它接管，否则自己收）。
65. **`postCurrent` 的去重会把首次加载需要的那一条吃掉。** 画布 iframe 是在插件 apply **之后**才加载的，`apply` 末尾那条 `synapse:current-session` 落在还没装监听的文档上就没了；而 `if (id === lastSessionId) return` 让 `map-ready` 时的重发也变成 no-op —— 于是画布永远不知道宿主在哪（用户看到的：地图固定在某个工作区不动）。修法：`postCurrent(force)`，`map-ready` 那一处强制发（`bridge.js` 与 `client.js` 两处都有这个坑，一起修了）。
