# 架构与数据模型

> 「东西是怎么搭起来的」：目标、分层、数据模型、adapter 契约、仓库结构。
> 这里是最初的设计稿（写在开工之前），后来的实际偏差都在各主题文档里。

相关：[projection.md](projection.md)（数据怎么进来）、[host-integration.md](host-integration.md)（宿主接口）、[runtime.md](runtime.md)（跑起来之后）、[../AGENTS.md](../AGENTS.md)（开发须知与文档索引）

## 1. 目标与非目标

### 目标

1. 一个**宿主无关的 npm 包** `session-synapse`：画布 UI + 工作区元数据存储 + 投影内核，不依赖任何 agent 框架。
2. 一个 **pi-web adapter**：把 pi 的会话（JSONL）与运行时能力接进核心。
3. 对 pi-web **零侵入**或最小侵入：不改 pi-web 的会话/模型/工具/权限，不启第二个 agent 运行时。
4. 保留 dsh-synapse 的架构边界：**会话日志是唯一事实来源，画布只是投影 + 组织元数据**。

### 非目标（明确排除）

- 不做 TUI 版本（pi extension 的 `ctx.ui.custom()` 是终端组件，渲染不了 HTML 画布）。
- 不支持 pi 的 RPC / print / JSON 模式。
- 不重写对话引擎、不接管 prompt、不修改 pi 的会话文件格式。
- 第一版不做「在画布内直接发消息」（pi-web 的 prompt 通道需进一步验证，见 [history.md](history.md) §9 风险与未决）。

---

## 2. 可行性结论（已验证）

dsh-synapse 的三层绑定中，**只有投影内核必须重写**，UI 层与存储层可整体复用。

| 层 | dsh-synapse 依赖 | pi-web 对应能力 | 结论 |
|---|---|---|---|
| 画布 UI（`app.js` ~1800 行 + `styles.css`） | 只依赖浏览器 + `postMessage` + `/synapse/api/*` | 任意宿主可实现同名接口 | **可复用**，改消息名即可 |
| 元数据存储（`WorkspaceStore` ~300 行） | `node:fs` JSON 文件 | 无关 | **直接复用**，只需字段改名 |
| 投影内核（`projectableEvent` ~300 行） | DSH 事件 `user/message` `assistant/message` `tool/call` `tool/result` `turn/end` `todo/write` | pi JSONL entry | **重写** |
| 宿主桥（`client.js` 336 行） | `ctx.sessions.retain/binding`、`ctx.uiConversation.target('chat')`、`__ModuleLoader__` | pi-web HTTP API + SSE | **重写** |

### 实测到的 pi-web 能力（本机 30100 端口）

| 能力 | 端点 / 机制 | 实测结果 |
|---|---|---|
| 会话列表（含 cwd、firstMessage、messageCount） | `GET /api/sessions` | ✅ |
| 单个会话元数据 | `GET /api/sessions/:id` | ✅ |
| 上下文消息（含 toolCall / toolResult） | `GET /api/sessions/:id/context` | ✅ 129 条消息，`entryIds` 对齐 |
| 实时状态（running / isStreaming / model / contextUsage） | `GET /api/agent/:id` | ✅ |
| **实时事件流（SSE）** | `GET /api/agent/:id/events` | ✅ `text/event-stream`，含 `message_start` `message_update` `tool_execution_update` `tool_execution_end` `agent_end` |
| 运行中会话集合 | `GET /api/agent/running` | ✅ |
| Agent 命令通道（prompt / steer / fork / abort / compact / set_model …） | `POST /api/agent/:id`，body 的**判别字段是 `type`** | ✅ 30+ 命令；`{"type":"get_state"}` 成功 |
| 会话 fork | `POST /api/sessions/:id/fork` | ✅ 返回新 sessionId |
| 归档 / 项目顺序 | `GET /api/sessions/ui-state` | ✅ `archivedAt` / `projectOrder` |
| 按会话深链 | `/?session=<sessionId>` | ✅ 页面初始化时读取 |
| 打开新标签页 | `pi-web:tab-open-session` 浏览器事件 | ✅ 存在于 page.js |
| Host 校验（DNS rebinding 防护） | 非 loopback Host → 403 | ✅ 已实测 403 |

**关键发现**：pi-web 的 Agent 命令通道等价于 pi 的 RPC 命令集（`chunks/6429.js` 中 40+ 个 `case`），因此「发消息 / 分支 / 中断」都有官方 HTTP 入口，不需要私有 API。

---

## 3. 架构

三层，单向依赖：**core ← adapter ← host**。

```
┌─────────────────────────────────────────────────────────┐
│  session-synapse (core)         宿主无关                │
│                                                          │
│  canvas/   app.js  styles.css        ← 从 dsh-synapse 搬 │
│  store/    WorkspaceStore            ← 从 dsh-synapse 搬 │
│  server/   createSynapseServer()     路由 + 静态资源      │
│  adapter/  SynapseAdapter 契约        ← 新写              │
│  project/  投影内核（按 adapter 的条目类型分发）← 新写     │
└──────────────────────────┬──────────────────────────────┘
                           │ adapter 契约（§6）
┌──────────────────────────┴──────────────────────────────┐
│  @session-synapse/pi-web-adapter                        │
│                                                          │
│  listSessions()  → GET /api/sessions                     │
│  readHistory()   → GET /api/sessions/:id/context         │
│  subscribe()     → GET /api/agent/:id/events (SSE)       │
│  openSession()   → window.postMessage → 宿主跳转          │
│  forkSession()   → POST /api/sessions/:id/fork           │
└──────────────────────────┬──────────────────────────────┘
                           │ 宿主集成（[host-integration.md](host-integration.md) §7）
┌──────────────────────────┴──────────────────────────────┐
│  pi-web (未修改的上游) + 一层薄集成                        │
│  · 顶栏「会话地图」入口                                    │
│  · 把 iframe 消息桥到页面上下文                            │
│  · 服务端转发 /synapse/* 到 core 的 handler                │
└─────────────────────────────────────────────────────────┘
```

### 为什么 server 层要抽出来

dsh-synapse 的 `index.js` 把「路由注册 + 业务逻辑」混在一起，其中业务逻辑（WorkspaceStore 的 REST 语义：workspaces / threads / messages / branch）是宿主无关的。抽成 `createSynapseServer()` 返回一个 `(req, res) => boolean` 的纯函数后：

- 在 DSH 里：`ctx.webServer.register({kind:'prefix', path:'/synapse', handler})`
- 在 pi-web 里：由集成层调用（见 [host-integration.md](host-integration.md) §7）

同一个 handler 两处复用。

---

## 4. 数据模型

### 4.1 复用 dsh-synapse 的结构，字段中立化

```jsonc
// $SYNAPSE_HOME/workspaces.json（默认 ~/.pi/synapse/workspaces.json）
{
  "version": 1,                    // 新 schema 版本，从 dsh 的 v4 语义映射
  "hiddenSessionIds": [],          // 用户显式归档/移除的会话，投影时跳过
  "workspaces": [
    {
      "id": "uuid",
      "title": "B:\\cc_program",   // 默认取 cwd，可改
      "createdAt": "...", "updatedAt": "...",
      "threads": [
        {
          "id": "uuid",
          "title": "…",            // 卡片标题
          "parentId": null,        // 分支来源 thread
          "sessionId": "…",        // ← 原 dshSessionId，宿主会话 ID
          "sessionTitle": "…",     // ← 原 dshSessionTitle
          "sessionFile": "…",      // 新增：宿主会话文件路径（pi 有，DSH 无）
          "parentSessionFile": "…",// 新增：fork 来源会话文件
          "position": { "x": 0, "y": 0 },
          "color": "#0f766e",
          "messages": [
            { "id": "uuid", "text": "…", "kind": "user|assistant|todo|error",
              "sourceEntryId": "…", // ← 原 sourceSeq，改为 pi 的 entry id
              "at": "...", "turn": 1, "step": 2, "process": [] }
          ],
          "pendingProcess": []     // 结果先到、助手消息后到时的暂存
        }
      ]
    }
  ]
}
```

**改名对照**（`dshSessionId` → `sessionId` 等）带来一个好处：core 里不再出现任何宿主专有名词，迁移逻辑（v1→v4）只需在新包内做一次。

### 4.2 迁移

dsh-synapse 的 `normalizeState` 有 v1→v4 的迁移链。新包：

- 保留全部迁移代码（历史格式兼容），但把最终版本号重置为 `version: 1`。
- **不做** dsh→pi 的元数据自动导入（DSH 与 pi 的 sessionId 不同源，硬映射会造出幽灵卡片）。若要迁移，提供显式 CLI：`synapse import --from ~/.dsh/synapse/workspaces.json`，只迁 `position` / `color` / `title` / 工作区划分，丢弃会话关联。

---

## 6. Adapter 契约

core 只认这一个接口。adapter 的能力按等级标注，core 对缺失能力做降级。

```ts
interface SynapseAdapter {
  /** 稳定标识，用于 UI 显示与本地存储命名空间 */
  readonly id: string                    // 'pi' | 'dsh' | ...

  /** 元数据文件的默认路径（宿主可覆盖） */
  defaultDataFile(): string

  /** 列出全部会话（含 cwd / 标题 / 父会话 / 标识） */
  listSessions(): Promise<HostSession[]>

  /** 读一个会话的完整 entry 序列（已排好，供投影消费） */
  readHistory(session: HostSession): Promise<SessionHistory>

  /** 订阅实时事件；返回退订函数 */
  subscribe(onChange: (session: HostSession) => void): () => void

  /** 能力声明：core 据此隐藏不支持的 UI 按钮 */
  capabilities(): {
    sendMessage: boolean
    createSession: boolean
    forkSession: boolean
    openSession: boolean
    renameSession: boolean
    archiveSession: boolean
    btw: boolean          // fork + 限定工具 + 只读沙箱（+ 各宿主自己决定要不要归档）
    setTools: boolean
  }

  /**
   * 画布怎么把写操作送达宿主（缺省 'host'）：
   *   'host'    —— 浏览器直接调宿主自己的 API（pi-web：要求 Origin 等于 Host）
   *   'synapse' —— 浏览器调 /synapse/api/host/*，由本进程的 adapter 代做（DSH）
   */
  writeTransport?(): 'host' | 'synapse'

  // —— 以下按 capabilities() 可选实现 ——
  sendMessage?(sessionId: string, text: string, images?: PromptImage[]): Promise<void>
  createSession?(cwd: string | null): Promise<string>
  forkSession?(sessionId: string, entryId?: string): Promise<string>
  openSession?(sessionId: string): Promise<void>
  renameSession?(sessionId: string, name: string): Promise<void>
  archiveSession?(sessionId: string, archived: boolean): Promise<void>

  /**
   * 侧问：fork 出子会话、把它的工具限定成 toolNames、把它放进宿主的只读沙箱。
   * 宿主自己做（画布在两边都碰不到“钉工具”这件事）；要不要把它从宿主的会话
   * 列表里藏起来是宿主的事（pi-web 归档，DSH 不能——见 docs/dsh-desktop.md §5.3）。
   */
  btw?(sessionId: string, entryId?: string, toolNames?: string[]): Promise<{ sessionId: string, tools: string[] }>

  /**
   * 侧问的工具词表：defaults（新的侧问默认给什么）、visible（这个会话实际能
   * 看见什么）、pinnable（可以写进 allow 的）。宿主没有这套词表时整个方法缺席。
   * 拿不到活会话就给空数组——绝不为了一次 GET 去 resume 一个冷会话。
   */
  btwTools?(sessionId?: string): { defaults: string[], visible: string[], pinnable: string[] }
}

// 图片按画布持有的形状传（base64，无 data-URL 前缀）；
// 各宿主对字段的叫法不同（pi-web: mimeType，DSH: mediaType），映射归 adapter。
interface PromptImage { data: string, mimeType: string }

interface HostSession {
  id: string
  cwd: string | null
  title: string | null
  filePath: string | null
  parentSessionFile: string | null
  running: boolean
}

interface HostEntry {
  id: string
  parentId: string | null
  type: string           // 宿主原生类型，交给 projector 分发
  at: string             // ISO
  raw: unknown           // 宿主原始对象，projector 自行解释
}

type HostEvent =
  | { kind: 'entry'; sessionId: string; entry: HostEntry }
  | { kind: 'session/created'; session: HostSession }
  | { kind: 'status'; sessionId: string; running: boolean }
```

### 契约设计要点

- **`raw` 透传**：投影规则住在 core 的 `project/` 目录（按 `adapter.id` 分文件），而不是 adapter 里。这样新增宿主只需加一个 projector 文件 + 一个 adapter 文件，不用动 core。
  - 备选（更干净但更重）：adapter 直接产出规范化的 `Card` 对象，core 只做布局。**待定，见 [history.md](history.md) §8**。
- **能力降级**：pi-web adapter 的 M1 版 `sendMessage: false`（通道已验证可用，但 M1 不做写操作；M3 开启），UI 上隐藏「追问」输入框，只保留「打开会话」跳回原生界面。
- **`readEntries` 返回树序**：pi adapter 需要自己做「回溯活跃分支」的工作，把线性序列交给 core。core 不需要理解 `parentId`。

---

## 14. 与 dsh-synapse 的关系

- **许可**：dsh-synapse 是 MIT，可自由 fork/改造。新项目保留 `LICENSE` 与来源说明（`NOTICE` 或 README 致谢）。
- **上游同步**：dsh-synapse 仍在活跃开发（v0.4.2，514★）。canvas 层的 bug 修复建议**反向 cherry-pick**，所以 canvas 目录保持与上游相同的文件边界（`app.js` / `styles.css`），不做拆分，直到 M4。
- **不要做的事**：不要把 DSH 的适配代码硬塞进新包伪装成「通用」——契约的价值在于真的能被两个宿主实现，而 DSH adapter（M4）就是它的检验。
---

## 29. app.js 拆分（M4-1）：先把叶子模块搬出去（2026-10-14）

`app.js` 原本 2334 行（占全部源码 29%），是个自 dsh-synapse 搬过来的经典脚本。第一刀拆出 **7 个无环叶子
模块**，共 445 行，行为不变：

| 模块 | 装什么 | 依赖 |
|---|---|---|
| `icons.js` | 图标常量集 | — |
| `format.js` | 文本/时间/token 格式化 + 上下文圆环 | — |
| `markdown.js` | 卡片用的 markdown 子集 + 渲染缓存 | format |
| `storage.js` | localStorage 读写、取值校验、废弃键清理 | — |
| `state.js` | `state` 对象 + 写回 localStorage 的 helper | storage |
| `images.js` | 图片读取/压缩/prompt payload | format |
| `host.js` | 与宿主的全部对话（两个 HTTP 通道 + 父页面消息） | — |

入口改为 `type="module"`；`createAssetHandler` 从「一张资产表」改为「`/synapse/<name>.js` → `src/canvas/`」的
规则（否则每加一个模块都要同时记得注册路由，漏了只在浏览器里表现为模块加载失败）；`npm run build` 原本逐文件
`node --check`，改为直接跑 `tsc -p jsconfig.json`（新增模块自动覆盖）。

### 拆模块顺手踩的两个坑（都比普通 bug 费时）

1. **页面全局作用域不是模块作用域。** 经典脚本里顶层 `const state` 是全局词法绑定，验证脚本用
   `page.evaluate(() => state.draft…)` 能直接读到；换成模块后就是 `state is not defined`。修法：画布显式暴露
   `window.__synapse = { state }`，两个脚本改成读这个句柄（把隐性契约变成显性一行）。
2. **ASI 陷阱：不能以 `(` 开头的行。** 本仓库不写行尾分号，于是 `history.scrollRestoration = 'manual'`
   后面接一行 `(window).__synapse = { state }` 被解析成 `'manual'(window)`：画布抛
   `"manual" is not a function`，**整页空白**，外层页面无任何报错（只有 iframe 的 pageerror 有），而
   验证脚本只会报「等不到 select 出现」——看起来像画布没加载数据，实际是模块执行就挂了。
   探测方法：`frame.evaluate(() => document.querySelector('#app').innerHTML.length)` 为 0 就是没渲染，
   再加上 `page.on('pageerror')` 的堆栈。

### 还没搬的（下一步）

剩下的 ~1900 行是渲染（`render`/`conversationCard`/`btwWidget` 等）、交互（拖拽/缩放/选区追问/流式补丁/轮询）
与动作（发消息/改名/归档/分支/btw）。它们互相依赖密集（都读写同一个 `state`、都要调 `render`），拆法必须是
`cards.js`（卡模型 + 布局几何，依赖 state/format）← `render.js`（纯 HTML 构建）← `interaction.js`（事件与 DOM 补丁）
与 `actions.js`（用户动作，依赖 host/render/cards）← `app.js`（启动与委派事件）。本轮到此为止：每刀之后都应
跑一次 `npm run verify`（19 个套件约 10 分钟），而一刀的收益在递减。

---


## 现状：目录与分层

> 随代码走的一版；M0 时那份更短的清单在 git 历史里。

```
src/
  store/workspace-store.js   画布元数据存储 + 版本迁移（宿主无关）
  store/instance-lock.js     单实例锁（键在数据文件上）
  project/pi.js              pi JSONL → 规范化投影条目
  project/dsh.js             DSH 事件 → 同一套投影词汇
  project/context-usage.js   上下文占用的估算（复刻 pi 的 getContextUsage）
  models/registry.js         provider/model → contextWindow（读 pi 的模型配置）
  adapters/contract.js       adapter 契约、能力声明与「宿主拒绝了」错误类
  adapters/pi.js             读 pi 会话文件、watch 变化
  adapters/pi-web-actions.js 浏览器侧的 pi-web 写操作（改名/归档/fork/set_tools/btw）
  adapters/dsh.js            DSH 会话语料 + 进程内写操作（sessionController / workspaceController）
  host/dsh/index.js          DSH 插件宿主半区（注册路由、拿锁、启停投影）
  host/dsh/client.js         DSH 插件客户端半区（切换条、主题、流式、打开会话）
  synapse.js                 投影引擎：adapter → store
  server/routes.js           /synapse/api/* 与静态资源
  server/guard.js            Host 白名单、JSON body 解析
  server/proxy.js            同源反代 + HTML 注入
  canvas/app.js              画布 UI 主文件（渲染 / 交互 / 动作，仍在继续往下拆）
  canvas/state.js            画布状态对象 + 写回 localStorage 的几个 helper
  canvas/storage.js          localStorage 读写与取值校验（键、默认值、废弃键清理）
  canvas/host.js             与宿主的全部对话（写操作的两条通道都在这里选）
  canvas/host-labels.js      宿主名与文案（按钮标题、空状态提示）
  canvas/format.js           文本/时间/token 格式化 + 上下文圆环
  canvas/markdown.js         卡片用的 markdown 子集（含渲染缓存）
  canvas/icons.js            图标集
  canvas/images.js           图片附件管线（读取 + 大图压缩 + prompt payload）
  canvas/bridge.js           注入 pi-web 的切换条与消息桥
bin/synapse.js               CLI
```

三层单向依赖：**canvas/store ← synapse ← adapter**。core 不出现任何宿主专有名词。

## 坑（本主题）

编号是全仓库的 ID，索引见 [README.md](README.md)。

10. **`STATE_VERSION` 不能复用 1。** 旧格式 v1 是 `workspaces[].events`（无 `threads`），复用会每次重启都重新迁移自己的输出，工作区翻倍。当前是 5。
