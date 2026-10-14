# pi-synapse 设计方案

> 把 [dsh-synapse](https://github.com/liangmianya/dsh-synapse) 的「投影层 + 画布 UI」抽成宿主无关的独立包，并为 pi-web 提供第一个 adapter。
>
> 状态：**设计稿，未开工**。所有结论基于对 dsh-synapse v0.4.2 源码与本机 pi-web 0.12.0 / pi 1.1.0 的实测。

---

## 1. 目标与非目标

### 目标

1. 一个**宿主无关的 npm 包** `pi-synapse`：画布 UI + 工作区元数据存储 + 投影内核，不依赖任何 agent 框架。
2. 一个 **pi-web adapter**：把 pi 的会话（JSONL）与运行时能力接进核心。
3. 对 pi-web **零侵入**或最小侵入：不改 pi-web 的会话/模型/工具/权限，不启第二个 agent 运行时。
4. 保留 dsh-synapse 的架构边界：**会话日志是唯一事实来源，画布只是投影 + 组织元数据**。

### 非目标（明确排除）

- 不做 TUI 版本（pi extension 的 `ctx.ui.custom()` 是终端组件，渲染不了 HTML 画布）。
- 不支持 pi 的 RPC / print / JSON 模式。
- 不重写对话引擎、不接管 prompt、不修改 pi 的会话文件格式。
- 第一版不做「在画布内直接发消息」（pi-web 的 prompt 通道需进一步验证，见 §8 风险）。

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
│  pi-synapse (core)         宿主无关                       │
│                                                          │
│  canvas/   app.js  styles.css        ← 从 dsh-synapse 搬 │
│  store/    WorkspaceStore            ← 从 dsh-synapse 搬 │
│  server/   createSynapseServer()     路由 + 静态资源      │
│  adapter/  SynapseAdapter 契约        ← 新写              │
│  project/  投影内核（按 adapter 的条目类型分发）← 新写     │
└──────────────────────────┬──────────────────────────────┘
                           │ adapter 契约（§6）
┌──────────────────────────┴──────────────────────────────┐
│  @pi-synapse/pi-web-adapter                               │
│                                                          │
│  listSessions()  → GET /api/sessions                     │
│  readHistory()   → GET /api/sessions/:id/context         │
│  subscribe()     → GET /api/agent/:id/events (SSE)       │
│  openSession()   → window.postMessage → 宿主跳转          │
│  forkSession()   → POST /api/sessions/:id/fork           │
└──────────────────────────┬──────────────────────────────┘
                           │ 宿主集成（§7）
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
- 在 pi-web 里：由集成层调用（见 §7）

同一个 handler 两处复用。

---

## 4. 数据模型

### 4.1 复用 dsh-synapse 的结构，字段中立化

```jsonc
// $PI_SYNAPSE_HOME/workspaces.json（默认 ~/.pi/synapse/workspaces.json）
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
- **不做** dsh→pi 的元数据自动导入（DSH 与 pi 的 sessionId 不同源，硬映射会造出幽灵卡片）。若要迁移，提供显式 CLI：`pi-synapse import --from ~/.dsh/synapse/workspaces.json`，只迁 `position` / `color` / `title` / 工作区划分，丢弃会话关联。

---

## 5. 投影规则（pi entry → 卡片）

pi 的会话是 append-only JSONL，`id`/`parentId` 组成**树**（不是 dsh 的线性 seq）。这是投影内核的主要差异点。

### 5.1 entry 类型分发

| pi entry | 卡片动作 | 备注 |
|---|---|---|
| `session`（header） | 建 workspace（按 `cwd` 分组）+ thread | 只读一次 |
| `message` role=`user` | **新建卡片**（一次提问 = 一张卡） | 排除 `isRuntimeContextText` 类注入 |
| `message` role=`assistant` | 折叠进当前卡片，作为答案 | 抽 `text` 块；`thinking` 块可折叠展示 |
| `message` role=`assistant` 的 `toolCall` 块 | 折叠进该回答的 `process[]`，按 `call.id` 配对 | 不单独成卡（沿用 dsh 行为） |
| `message` role=`toolResult` | 按 `toolCallId` 找到 `process` 条目，写 `result` / `error` | 结果先到则进 `pendingProcess` |
| `message` role=`system` | 忽略 | 体积大且无对话价值 |
| `compaction` | 生成一张 `kind:"error"` 风格的分隔卡（可选，M2） | 提示上下文被压缩 |
| `branch_summary` | 生成一张 `kind:"todo"` 风格的分隔卡（可选，M2） | 标注分支切换 |
| `session_info` | 更新 thread.title | |
| `custom` / `custom_message` | 默认忽略；`display:true` 的 custom_message 可作为 user 卡 | |
| `model_change` / `thinking_level_change` / `usage` / `label` / `context_edit` | 忽略 | |
| 未知 type | 忽略（前向兼容） | |

### 5.2 树的处理（与 dsh 的核心差异）

dsh 用 `session.inheritedEventCount` 作为 fork 的持久化切点，投影时只 replay 子会话的 live tail。

pi 的对应物是 **JSONL 树本身**：同一会话文件内的分支（`/tree` 产生的兄弟节点）与跨文件的 fork（`/fork` 产生的 `parentSession` header）是两种不同的关系，必须分别处理。

- **会话内分支**：沿 `parentId` 从当前 leaf 回溯到 root，得到**活跃分支**。非活跃分支的 entry 不进投影（否则卡片会重复）。
  - 需要确定 leaf：取最后一条 entry 的 `id`；或从 `/api/agent/:id` 的 state 里读。
  - 简化方案：第一版只投影**活跃分支**，非活跃分支在卡片上不显示（不追求 dsh 那样的完整树视图）。
- **跨文件 fork**：`session` header 的 `parentSession` 指向父会话文件。投影时：
  - 找到父会话对应的 thread，把新 thread 的 `parentId` 指向它；
  - 子会话的 header 之后就是它自己的 tail，天然不重复。
  - 注意：本机实测 `GET /api/sessions` 的列表项**不含** `parentSession` 字段，需要直接读 JSONL 首行（adapter 有文件读权限）。

### 5.3 截断与防抖

沿用 dsh-synapse 的两条经验（都在源码注释里写明是踩坑修复）：

- 单条消息投影上限 **8000 字符**，超出加 `——…（详情查看全文）` 标记。
- 投影写入**按事件突发合并**（原实现 800ms 防抖 + microtask 批处理），否则每个事件一次全量写会把主线程打满（dsh issue #13）。

---

## 6. Adapter 契约

core 只认这一个接口。adapter 的能力按等级标注，core 对缺失能力做降级。

```ts
interface SynapseAdapter {
  /** 稳定标识，用于 UI 显示与本地存储命名空间 */
  readonly id: string                    // 'pi-web' | 'dsh' | ...

  /** 元数据文件的默认路径（宿主可覆盖） */
  defaultDataFile(): string

  /** 列出全部会话（含 cwd / 标题 / 父会话 / 文件路径） */
  listSessions(): Promise<HostSession[]>

  /** 读一个会话的完整 entry 序列（已按时间/树序排好，供投影消费） */
  readEntries(sessionId: string): Promise<HostEntry[]>

  /** 订阅实时事件；返回退订函数 */
  subscribe(onEvent: (event: HostEvent) => void): () => void

  /** 能力声明：core 据此隐藏不支持的 UI 按钮 */
  capabilities(): {
    sendMessage: boolean
    forkSession: boolean
    openSession: boolean
    archiveSession: boolean
  }

  // —— 以下按 capabilities() 可选实现 ——
  sendMessage?(sessionId: string, text: string): Promise<void>
  forkSession?(sessionId: string, entryId: string): Promise<string>
  openSession?(sessionId: string): Promise<void>
}

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
  - 备选（更干净但更重）：adapter 直接产出规范化的 `Card` 对象，core 只做布局。**待定，见 §8**。
- **能力降级**：pi-web adapter 的 M1 版 `sendMessage: false`（通道已验证可用，但 M1 不做写操作；M3 开启），UI 上隐藏「追问」输入框，只保留「打开会话」跳回原生界面。
- **`readEntries` 返回树序**：pi adapter 需要自己做「回溯活跃分支」的工作，把线性序列交给 core。core 不需要理解 `parentId`。

---

## 7. 宿主集成（pi-web 侧）

pi-web 是**预构建的 Next.js 产物**（`npm i -g @agegr/pi-web` 装的是 `.next/` 二进制），**无法通过插件机制加路由或改页面**。这是本方案最大的工程约束，有三种做法：

### 方案 A：pi-web 启动器包装（推荐，零上游修改）

- 发布 `pi-synapse-piweb` CLI：`pi-synapse start` → 起 core 的 server（自带 `/synapse/*`），**同时** spawn `pi-web`。
- 用户访问 `http://127.0.0.1:30142/`（core 的页面），core 用 iframe 嵌 pi-web 的 `127.0.0.1:30100/?session=<id>`，顶部一条「对话 / 会话地图」切换条 —— **与 dsh-synapse 在 DSH 里的交互完全一致**。
- 打开会话 = 改 iframe 的 src（`?session=` 已实测支持）。
- 优点：不碰 pi-web 一行代码，升级 pi-web 不受影响。
- 缺点：pi-web 被套在 iframe 里，PWA / 快捷键 / 新标签页行为受限；端口多一层。

### 方案 B：反向代理注入（体验最好，维护成本中等）

- core 起一个反代：`/synapse/*` → core handler；其余 → `127.0.0.1:30100`。
- 对 HTML 响应做**流式注入**：在 `<head>` 末尾插一段 JS（顶栏按钮 + 消息桥），在 `<body>` 末尾插 overlay 容器。
- 优点：单端口、单页面、无 iframe，观感与 dsh-synapse 在 DSH 里一致。
- 缺点：依赖 pi-web 的 HTML 结构；pi-web 升级后注入点可能失效（用 `</head>` / `</body>` 这种稳定锚点，风险可控）。

### 方案 C：等上游支持（最干净，不可控）

pi-web 已有「下游集成」先例（`pi-web:session-row-contextmenu`、`pi-web:tab-open-session` 都是给 Electron 壳用的浏览器事件）。可以向上游提 issue/PR，请求一个「插件注册自定义视图 / 注册路由」的能力。在落地前不作为主线。

**建议**：M1 用**方案 A** 打通（快、稳、可验证），M3 再评估是否切方案 B。

### 集成层必须做的事（无论 A 还是 B）

1. **Host 校验**：core 的 `/synapse/api` 只接受 `localhost` / `127.0.0.1`（沿用 dsh 的 `trustedHosts` 设计，防 DNS rebinding）。
2. **不绕过 pi-web 的鉴权**：若用户设了 `PI_WEB_PASSWORD`，core 不能成为绕过口。方案 A/B 都要把 pi-web 的登录态（cookie）透传校验。
3. **主题同步**：把 pi-web 的 dark 状态透给画布（dsh 用 `synapse:theme` 消息做的）。
4. **`?session=` 深链**：打开会话后同步 URL，保证刷新回到同一会话。

---

## 8. M0 实测结果（2026-10-12，已完成）

验证环境：pi-web **0.12.0**、pi **1.1.0**、Node 24.14.0、Windows。数据源：本机 154 个会话 / 30 个 cwd 目录。

### 结论一览

| # | 问题 | 结论 | 对设计的影响 |
|---|---|---|---|
| R1 | pi-web 无插件机制 | ✅ 确认无路由注册能力 | 必须包装层；**方案 B 已实测可行**（见下） |
| R2 | `?session=` 深链 | ⚠️ **需换实现方式** | 见下方「重要修正」 |
| R3 | 画布内发消息 | ✅ **通道可用** | `capabilities().sendMessage = true` 可开 |
| R4 | 活跃 leaf 判定 | ✅ **规则已确定** | 末行 = leaf，沿 `parentId` 回溯 |
| R5 | fork 关系获取 | ✅ 确认列表 API 不含 | 读 JSONL 首行 `parentSession` |
| R6 | `app.js` 单文件耦合 | ✅ 确认 136 个顶层声明 | 先搬运不重构 |
| R7 | 版本漂移 | 待持续观察 | 已记录验证版本 |
| R8 | 元数据并发写 | 待实现时处理 | 沿用 dsh 方案 |

### R4：活跃分支判定（已验证）

对 5 个含分支的真实会话逐一验证：

- 规则：**文件末行 = 当前 leaf**，沿 `parentId` 回溯到 root = 活跃分支。
- `/api/sessions/:id/context` 返回的条目 **100% 落在活跃分支内**（5/5 会话）。
- 非活跃分支的条目数：2 / 23 / 4 / 4 / 2 —— 数量不大，但确实存在（`/tree` 会产生）。
- **两种分支在真实数据里都存在**：会话内分支 5 个，跨文件 fork 4 个。

判定代码（已验证）：

```js
function activeBranch(entries) {
  const nodes = entries.filter(e => e.type !== 'session' && e.id)   // header 不是树节点
  const byId = new Map(nodes.map(e => [e.id, e]))
  const path = []
  for (let cur = nodes.at(-1)?.id; cur != null; cur = byId.get(cur)?.parentId) {
    if (path.includes(cur)) break
    path.push(cur)
  }
  return path.reverse()
}
```

> 踩坑记录：`session` header 有 `id` 但**没有 `parentId` 键**，若用 `e.parentId ?? null` 统一处理会把它算成第二个 root（本机 154/154 全部误判）。必须先按 `type` 排除。

### R2：已定案 —— 切会话只能靠整页导航

实测 + 源码（pi-web v0.12.0 `lib/tab-session.ts` / `lib/initial-navigation.ts` / `components/AppShell.tsx`）：

1. **pi-web 没有反嵌入限制** —— 无 `X-Frame-Options`、无 CSP `frame-ancestors`，**可以**被 iframe 嵌入。
2. **深链是纯客户端消费** —— `/?session=<id>` 与 `/` 的 HTML **字节完全相同**（md5 一致），SSR 不预取会话数据；`?cwd=` 同理。
3. **`?session=` 只在页面初始化时读取一次**：`useState(() => getInitialNavigation(searchParams))`，`searchParams` 全文件**无任何 effect 响应**。因此**改 URL 不会切会话，只有页面加载才会**。
4. **pi-web 不监听任何 `pi-web:*` 浏览器事件**（全仓 `addEventListener("pi-web:...")` 为 0 处）。

#### 三次纠错记录（`pi-web:tab-open-session` 的真实身份）

| 版本 | 当时的说法 | 是否正确 |
|---|---|---|
| 初版 | cancelable 浏览器事件（类比 `session-row-contextmenu`） | ❌ |
| 第二版 | localStorage key，外部集成协议 | ❌ |
| **最终（源码确认）** | **sessionStorage，pi-web 自用，不是外部协议** | ✅ |

源码（`lib/tab-session.ts`）的注释直接说明：

> *Per-tab "open session" memory. … **sessionStorage is the only per-tab store the browser offers**: it survives reloads and in-app navigations and is never shared with other tabs.*

关键差异：**sessionStorage 不跨标签页共享**，且 `withTabOpen()` 只在 **URL 没有 `cwd`/`session` 时**才把它当回退。写入方是 pi-web 自己（`AppShell.tsx` 的 effect），**不是外部集成接口**。

#### 定案

pi-web 官方 e2e（`e2e/session-navigation.mjs`）给出两条真实可行路径：

```js
// ① 整页导航 —— 外部集成的唯一稳定入口
await page.goto(`${base}/?session=${a.id}`, { waitUntil: "domcontentloaded" })

// ② 点击会话行链接 —— 无刷新，但要求该行已渲染
await link(page, b.id).click()
assert.ok(await documentKept(page), "a plain click must not reload the page")
```

路径 ② 的障碍：**会话列表是虚拟化的**（`SessionSidebar.tsx` 注释明确提到 "virtualized rows"），画布要点击必须先驱动侧边栏滚动/展开项目，脆弱且依赖 React 内部状态。

**结论**：

- **M1 用整页导航**（方案 A/B 通用）：`location.href = '/?session=' + id`。
- **M2 可选优化**：注入脚本 `postMessage` → pi-web 侧模拟点击。**非必需**，不建议在 M2 投入。

> 补充：`?session=` 本来就是设计给**新标签页/冷加载**的入口（`sessionDeepLink()` 服务于 `Ctrl+Click` 开新标签，见 pi-web issue #1167）。

### R3：发消息通道（已验证可用）

- 端点：`POST /api/agent/:id`，**判别字段是 body 的 `type`（不是 `command`）**。
- 实测 `{"type":"prompt","message":"..."}` 在一个新建会话上**成功执行**（`success: true`，agent 真的跑了）。
- 之前看到的 `prompt_rejected` **不是权限或前置条件问题**，而是该会话**正在流式中**——pi 要求此时显式传 `streamingBehavior: 'steer' | 'followUp'`。
- 另一条路径：`POST /api/agent/new` 支持 `{"cwd": "...", "type": "ensure_session"}`，返回 `{sessionId, model, thinkingLevel}`，用于在指定 cwd 上确保一个可用会话。
- 可用命令集（40+，从 pi-web bundle 提取）：`prompt` `steer` `follow_up` `abort` `fork` `clone` `navigate_tree` `compact` `clear_queue` `get_state` `get_messages` `get_session_stats` `get_last_assistant_text` `set_model` `set_thinking_level` `set_session_name` `set_tools` `bash` `abort_bash` `reload` 等。

**代价与注意**：发消息会真的启动 agent。设计上必须：

- 画布内发消息前，先确认会话状态（`GET /api/agent/:id` 的 `isStreaming`），流式中走 `steer` / `followUp`，否则传普通 `prompt`。
- 未激活的会话发消息会**激活它**（写扩展生命周期条目、占用内存直到 idle 超时 600s）。这是预期行为，但 UI 上要有提示。

### 方案 B（反代注入）已实测可行

用一个 30 行 Node 反代验证：

- ✅ **HTML 注入成功**：在 `</head>` 前插入脚本，上游 11215 字节 → 代理 11258 字节。
- ✅ **API 透传**：`/api/sessions` 返回全部 154 个会话。
- ✅ **SSE 流式透传正常**：`/api/agent/:id/events` 的 `text/event-stream` 逐块转发无阻塞。
- ✅ 注入锚点稳定：`</head>` / `</body>` 各出现 1 次。

### R9 纠错：pi-web 的 Origin 规则是「必须等于自身 Host」，不是「只接受无 Origin」

上一版把规则写成了「只接受无 Origin」。读了 `middleware.js` 与源码 `proxy.ts` 的真实实现并逐项实测后修正：

```js
// middleware.js 的真实逻辑（简化）
if (path.startsWith('/api/')) {
  if (!trustedHost(req)) return 403                      // Host 白名单
  const hasOriginOrFetchSite = headers.has('origin') || headers.has('sec-fetch-site')
  if (!hasOriginOrFetchSite) return 200                  // 无二者 → 放行
  if (headers.get('sec-fetch-site') === 'cross-site') return 403
  const origin = headers.get('origin')
  if (!origin) return 200
  if (origin === `${protocol}//${host}`) return 200        // ← Origin 等于自身 Host → 放行
  return 403
}
```

实测矩阵：

| 请求 | 结果 |
|---|---|
| 无 `Origin` | **200** |
| `Origin: http://127.0.0.1:30100`（= Host） | **200**（GET 与 POST 均 200） |
| `Origin: http://127.0.0.1:30142`（跨源） | **403** |
| `Host: evil.test` | **403**（Host 白名单） |

**结论**：这是标准的 CSRF 防护。**画布页面（另一端口）无法直接 fetch pi-web**，因为浏览器会自动带 `Origin: http://127.0.0.1:30142`。

**解决方式（方案 B 同时解决）**：

- 反代让画布与 pi-web **同源** → `Origin` 自动等于 Host → 200。
- 若坚持跨端口：反代需**剥离 `Origin` 头**再转发（可行但更脆弱，不推荐）。

> 另有一个**例外**：`/api/sessions/:id/export` 的 GET 导航请求（`sec-fetch-mode: navigate` + `sec-fetch-dest: document` + `sec-fetch-user: ?1`）可豁免 `origin`/`sec-fetch-site` 检查。

### 修正后的方案选择

| 方案 | 状态 | 说明 |
|---|---|---|
| A（iframe 嵌 pi-web） | 可用，有妥协 | 零上游修改；但切会话靠重载 iframe，且**跨源 fetch 被 Origin 校验挡住**，必须由反代或注入脚本代劳 |
| **B（反代 + HTML 注入）** | ✅ **已实测，推荐为 M1 主线** | 单端口同源，一次解决 CORS、Host 校验、切会话、观感四个问题；注入锚点稳定 |
| C（等上游支持） | 保持观望 | 上游已有 `pi-web:*` 浏览器事件先例，但无路由/视图注册能力 |

**新建议**：M1 直接走方案 B。风险从「能否注入」降级为「注入点会不会随版本变」，而 `</head>`/`</body>` 是最稳定的锚点。

### 已验证的 API 清单（可直接进 adapter）

> 验证基准：**pi-web v0.12.0**（commit `894e1a2`）+ **pi 1.1.0** + Node 24.14.0。
> 源码已克隆到 `.pi-web-src/`（开发期参考，**不纳入交付包**，已在 `.gitignore` 中排除）。

| 用途 | 端点 | 备注 |
|---|---|---|
| 会话列表 | `GET /api/sessions` | 含 `cwd`/`firstMessage`/`messageCount`/`transient`；**不含** `parentSession` |
| 会话元数据 | `GET /api/sessions/:id` | |
| 活跃分支消息（窗口化） | `GET /api/sessions/:id/context` | 含 `entryIds`/`hasMore`/`turnsBefore`；**条数少于文件** → **M1 不用它** |
| fork | `POST /api/sessions/:id/fork` | 从当前 leaf 分叉；响应含 `relation.originSessionId` |
| 实时状态 | `GET /api/agent/:id` | `running`/`isStreaming`/`model`/`contextUsage` |
| 实时事件 | `GET /api/agent/:id/events` | SSE（仅 per-session，**无全局流**） |
| 运行中集合 | `GET /api/agent/running` | 轻量，适合轮询 |
| 命令通道 | `POST /api/agent/:id` | body 的 `type` 判别 |
| 新会话/激活 | `POST /api/agent/new` | `type: "ensure_session"` |
| 归档/项目顺序 | `GET`+`POST` `/api/sessions/ui-state` | POST 的 action 枚举：`set`/`restore`/`rename-project`/`pin-project`/`add-projects`/`move-project` |
| 会话重命名 | `PATCH /api/sessions/:id` | body `{name}` → 追加 `session_info` 条目 |
| 会话删除 | `DELETE /api/sessions/:id` | |

### pi-web 源码里值得直接借鉴的实现

| 文件 | 价值 |
|---|---|
| `lib/agent-event-wire.ts` | 客户端事件过滤/瘦身规则（剥 `partial`、丢 system message、截断 codemode 快照）——**画布复用同一套投影语义即可与 pi-web 一致** |
| `lib/agent-event-stream.ts` | SSE 背压策略、150ms 工具更新合并、重连快照语义 |
| `lib/initial-navigation.ts` + `lib/tab-session.ts` | 深链/标签记忆的权威语义（含完整单测） |
| `lib/session-links.ts` | `sessionDeepLink()` 与 `isPlainActivation()` 的点击规则 |
| `e2e/session-navigation.mjs` | 切会话的权威做法与断言方式 |
| `middleware.js`（构建产物） / `proxy.ts` | Host 白名单与 Origin 校验规则 |

### 实测中发现的额外事实

1. **`/context` 是窗口化的，不是全量**：2882 条消息的会话只返回 101 条（`hasMore: true`，`turnsBefore: 38`）。**画布要从完整历史重建，必须由 adapter 直接读 JSONL**，不能只靠 API。
2. **真实会话的 entry 类型分布**（跨 154 会话、57341 条 message）：`message` 57341、`custom` 1091、`custom_message` 541、`context_edit` 309、`model_change` 250、`thinking_level_change` 171、`compaction` 37、`session_info` 14。投影内核需覆盖这些。
3. **`session_info` 承载会话名**（`/name` 设置），比 `firstMessage` 更适合做卡片标题。
4. **fork 产物的 header 带 `parentSession`** 指向父会话文件路径 —— 这是跨文件 fork 关系的唯一来源。
5. **idle 超时默认 600s**（`PI_WEB_IDLE_TIMEOUT_MS`），会话被驱逐后内存态释放、磁盘成为权威。
6. **无全局 SSE**：`/api/agent/events` 实际是 **JSON**（返回 `{"running":false}`），不是事件流。唯一的事件流是 per-session 的 `/api/agent/:id/events` 与 `/api/terminal/:id/events`。
7. **会话可写能力**（已验证）：
   - 改名：`PATCH /api/sessions/:id`，body `{name}` → 追加 `session_info` 条目。
   - 归档/置顶/项目重命名：`POST /api/sessions/ui-state`，body `{action, ids?, ...}`；action 枚举为 `set` / `restore` / `rename-project` / `pin-project` / `add-projects` / `move-project`。
   - 删除：`DELETE /api/sessions/:id`。
8. **pi-web 自己的 UI 状态存在 `~/.pi/agent/pi-web-session-state.json`**（不是 session 目录里）：含 `revision` / `sessions.{archivedAt,pinnedAt}` / `projects` / `projectOrder` / `projectNames`。画布若想复用「归档」与「项目顺序」语义，读写这个文件即可。
9. **`transient` 会话**：列表项有 `transient` 字段（本机 154 个均为 false）。subagent 会话可能标为 transient，投影时建议跳过。

### 未决问题关闭记录（M1 开工前阻塞项已清空）

| # | 未决问题 | 状态 | 结论 |
|---|---|---|---|
| **U1** | `pi-web:tab-open-session` 的消费时机 | ✅ **已关闭**（读源码） | 见下方「U1 结论」 |
| **U2** | 反代下画布如何驱动 pi-web 切会话 | ✅ **已关闭** | 见下方「U2 结论」 |
| **U3** | `fs.watch` 在 Windows 上的可靠性 | ✅ **已关闭**（实测） | 见下方「U3 结论」 |
| **U4** | SSE 的 `message_update` 载荷结构 | ✅ **已关闭**（源码 + 实测） | 见下方「U4 结论」 |
| **U5** | 读 `/api/agent/:id` 是否会把会话拉进内存 | 低风险，待观察 | 轮询 `/api/agent/running`（轻量）而非逐会话读 state |
| **U6** | pi-web 升级兼容性 | 缓解措施明确 | 锁定已验证版本；启动时探测端点 |
| **U7** | 注入锚点稳定性 | ✅ **已确认稳定** | `</head>` / `</body>` 各 1 次；注入失败降级方案 A |

#### U1 结论：`pi-web:tab-open-session` 是 **sessionStorage**，且是 pi-web 内部机制，**不能用于外部切会话**

源码：`lib/tab-session.ts`（v0.12.0，带完整注释与单测 `lib/tab-session.test.mjs`）。

**纠错（第三次修正这个点）**：

| 版本 | 我说过 | 实际 |
|---|---|---|
| 初版 | cancelable 浏览器事件 | ❌ |
| 第二版 | localStorage key，外部集成协议 | ❌ |
| **现在** | — | ✅ **sessionStorage，pi-web 自用** |

源码注释写得很清楚：

> *Per-tab "open session" memory. A browser tab remembers the session it showed last, so a reload restores **this** tab's session instead of `pi-web:last-open-by-workspace`… **sessionStorage is the only per-tab store the browser offers**: it survives reloads and in-app navigations and is never shared with other tabs.*

关键事实：

- 存储介质是 **sessionStorage**（不是 localStorage）→ **不跨标签页共享**，且注入脚本若非同一 tab 上下文则完全无效。
- 写入方是 pi-web 自己（`AppShell.tsx` 的 effect：`setTabOpenSession(selectedSession.id)`），读取方是 `withTabOpen()` 在 **mount 时**应用。
- 它**不是**外部集成协议，而是一个 **URL 缺失时的回退**：`withTabOpen` 只在 URL 没有 `cwd`/`session` 时才生效。

#### U2 结论：切会话只能靠 **页面加载（URL）**，没有无刷新通道

源码证据（`components/AppShell.tsx`）：

```tsx
const searchParams = useSearchParams()
const [initialNavigation, setInitialNavigation] = useState(() => getInitialNavigation(searchParams))
// setInitialNavigation 全文件只出现在第 638 行（tab memory 恢复）
```

- `searchParams` **只在 `useState` 初始化器里读一次**，**没有任何 effect 响应 URL 变化**。
- 没有 `window.__pi*` 之类的全局暴露供外部调用。
- pi-web 自己的切换函数（`handleSelectSession` / `handleNewSession`）是 React 闭包内部函数，外部不可达。

**但 pi-web 官方 e2e 测试给出了权威的可行路径**（`e2e/session-navigation.mjs`）：

```js
// 方案 1：整页导航（权威、稳定）
await page.goto(`${base}/?session=${a.id}`, { waitUntil: "domcontentloaded" })

// 方案 2：点击会话行链接（无刷新，但要求会话行在 DOM 里）
await link(page, b.id).click()
assert.ok(await documentKept(page), "a plain click must not reload the page")
```

**关键约束（新发现）**：会话列表是**虚拟化**的（`SessionSidebar.tsx` 注释提到 "virtualized rows"）。DOM 点击要求目标行已渲染且可见，画布需要先驱动侧边栏滚动/展开项目，复杂度高且脆弱。

**因此定案**：

- **M1 用整页导航**：`location.href = '/?session=' + id`（方案 B 下同源，且路径不变）。观感是重载，但**这是 pi-web 唯一稳定的外部切会话入口**。
- **M2 可选优化**：注入脚本在 pi-web 侧挂一个监听器，由画布 `postMessage` 转发，pi-web 侧再模拟点击或直接调用内部函数——但这依赖 React 内部状态，属脆弱方案，**非必需**。

> 这也解释了为什么 `?session=` 是「纯客户端消费」：它本来就是设计给 **新标签页/冷加载** 的入口（`sessionDeepLink()` 就是给 `Ctrl+Click` 开新标签用的）。

#### U3 结论：`fs.watch` 可用，但**事件数不可信**，必须「watch 只作信号 + 重读 diff 作真相」

实测（Node 24.14.0 / Windows，recursive 模式）：

| 实验 | 结果 |
|---|---|
| 新建目录 + 新建文件 | ✅ 3 个事件（`rename` 目录 / `rename` 文件 / `change` 文件），filename 精确到相对路径 |
| 5 文件 × 20 次并发追加（100 次写） | ⚠️ **101 个 change 事件**，涉及 **6** 个文件（多出 1 个） |
| 50 次突发追加（无 sleep） | ⚠️ 恰好 50 个事件（本次巧合，**不能当作保证**） |
| 200 文件目录追加 30 个 | 写入 45ms，31 个事件 |
| 真实 `~/.pi/agent/sessions` 递归 watch | ✅ `recursive: true` 可用，无 error |

**结论**：

- Windows 上 `fs.watch(..., {recursive:true})` **可用**，事件粒度够用（能拿到文件名）。
- **事件数与实际写入数不相等**（可能多也可能少）→ **绝不能**用事件数当写入数。
- 正确用法：**watch 只作「有变化」的信号**，收到后**重读文件 + 按 `id`/行数 diff** 得到真相。实测「突发 50 次写 → 重读得到 50 行」✅ 成立。
- 轮询兜底可行：50ms 间隔的 `stat().size` 变化检测有效（实测 25 次轮询捕获到 80 字节）。
- **建议**：watch（主）+ 低频轮询（兜底，如 3–5s）双保险，这与 pi-web 自己的做法一致。

#### U4 结论：SSE 的 `message_update` **不含完整 `partial`**，文本靠 `_delta` 增量拼

源码：`lib/agent-event-wire.ts` + `lib/agent-event-stream.ts`（v0.12.0）。

**`message_update` 的载荷结构**（服务端已剥掉 `partial`）：

```ts
// 服务端把 assistantMessageEvent.partial 剥离，只留增量：
const { partial: _partial, ...deltaEvent } = assistantMessageEvent
return { type: "message_update", assistantMessageEvent: deltaEvent }
```

**`assistantMessageEvent.type` 的完整枚举**（从 pi SDK 提取）：

```
start · text_start · text_delta · text_end · thinking_start · thinking_delta
thinking_end · toolcall_start · toolcall_delta · toolcall_end · done · error
```

**因此画布拿到流式文本的唯一方式**：

- 维护一个按 `contentIndex` 索引的块状态机；
- `text_delta` → 追加 `.delta` 到文本块；`text_end` → 以 `content` 定稿（权威内容，会替换累积值）；
- `thinking_delta` / `toolcall_delta` 同理，分别进思考块与工具调用参数；
- **`*_end` 事件永远不会被丢弃**（背压时可丢的只有 `*_delta` 和 `tool_execution_update`）。

**额外发现的背压规则（重要，直接影响画布实现）**：

- `tool_execution_update` 携带**整个部分结果**，下一次 update 或 `tool_execution_end` 会完全取代它 → **只保留最新一条**即可，可安全丢弃中间态。
- 服务端会**合并** `tool_execution_update`（150ms 窗口，`TOOL_UPDATE_COALESCE_MS`）。
- 高水位 512 KB 后开始丢可重建事件；积压超 16 MB（`PI_WEB_SSE_BACKLOG_LIMIT_BYTES`）则**直接断开**让客户端重连重取快照。
- 重连时服务端会先发 `connected`，再回放缓存事件，最后若有 `streamingMessage` 快照则补一条 `message_start`。

**对画布的含义**：不需要自己实现增量拼接的容错——**直接以 `*_end` 与 `message_end` 的完整内容为准**，`_delta` 只用于「边写边显」的乐观渲染。

> 注：本次 U4 只用**已在运行**的会话做只读 SSE 观测（拿到真实的 `tool_execution_update`），`message_update` 的结构由源码确定，**未启动任何 agent run**。

### 探测造成的副作用与恢复（记录在案）

M0 探测期间对一个真实会话（`01a12375`）产生了副作用，且**分了两个阶段**：

1. 一次空消息 `prompt`（`{"type":"prompt","message":""}`）**没有报错**，而是启动了这个会话的 agent run，写入 5 条条目（user + assistant + toolResult + assistant）。
2. 后续用 `navigate_tree` 修复内存态时，又触发了扩展生命周期条目（`plannotator` / `remote-pi:*`）写入，并造成一个**悬空 `parentId` 引用**（新条目指向已被截断的条目）。

另有一处副作用容易被忽略：探测用的一次性 cwd 目录 `b:\vibe_program\pi-synapse\_probe` **被写进了 pi-web 的 `~/.pi/agent/pi-web-session-state.json` 的 `projectOrder`**（revision 7 → 8），因为它被当成一个真实项目。

**恢复过程与最终状态**：

- 会话文件截断回原始 **649 行**；**无悬空 `parentId` 引用**；无探测条目残留。
- 内存态通过 `navigate_tree` 回到干净 leaf，并等 idle 驱逐（600s）释放。
- `pi-web-session-state.json` 中的 `_probe` 条目已移除，`revision` 递增以失效 pi-web 的 mtime+revision 缓存。
- 环境校验：**154 个会话 / 30 个 cwd 目录**，与探测前一致；临时目录、fork 产物、代理进程、备份文件均已清除。

**教训（写进 M1 的测试规范）**：

- **不要对真实会话做「空消息」类探测** —— pi 会把它当成有效 prompt 并启动真实 run。
- 需要探测 prompt 通道时，**先用 `/api/agent/new` + `ensure_session` 造一个一次性 cwd 的会话**，探测完删掉整个 cwd 目录。
- **一次性会话的 cwd 也会污染 pi-web 的 `pi-web-session-state.json`**（projectOrder）—— 探测后必须一并清理。
- 涉及会写盘的探测，先记录基线（行数 + 末行 id + 悬空引用数 + `ui-state.revision`），结束后逐项比对。

---

## 9. 风险与未决问题（M0 后更新）

| # | 问题 | 影响 | 缓解 |
|---|---|---|---|
| R1 | pi-web 无插件机制 | 需包装层 | **方案 B 已实测可行**，作为 M1 主线 |
| R2 | ~~深链会切会话~~ → **深链纯客户端消费** | 「打开会话」不能靠改 src | M1 用 A2（iframe 重载），M2 优化为 A1（事件派发） |
| R3 | ~~通道未验证~~ → **通道可用** | — | 开 `sendMessage`；注意流式时需 `streamingBehavior` |
| R4 | ~~leaf 判定~~ → **规则已定** | — | 末行 + 回溯；注意 header 无 `parentId` 键 |
| R5 | `parentSession` 不在列表 API | fork 关系需读文件 | adapter 读 JSONL 首行 |
| R6 | `app.js` 单文件耦合 | 改造成本 | 先搬运不重构 |
| R7 | 上游版本漂移 | adapter 失效 | 版本探测 + 降级；已验证 pi-web 0.12.0 / pi 1.1.0 |
| R8 | 元数据文件并发写 | 布局丢失 | 文件锁 + 外部修改告警；文档写明单实例 |
| **R9（新）** | **pi-web 拒绝带 `Origin` 的跨源请求** | 画布无法跨端口 fetch | **反代同源**（方案 B）；规则是 `Origin` 必须等于自身 Host |
| **R10（新）** | **`/context` 窗口化** | 画布重建不完整 | adapter 直读 JSONL，API 仅用于增量/状态 |
| **R11（已关闭）** | ~~localStorage 协议的消费时机未知~~ → **sessionStorage，pi-web 自用** | — | 不用它；切会话靠整页导航（U2） |
| **R12（新）** | **无全局 SSE，只 per-session** | 画布无法订阅「所有会话」的实时流 | **watch 文件（主）+ 低频轮询（兜底）** 拿新条目；SSE 只对运行中会话开（U3/U4） |
| **R13（新）** | 同名会话在 `?session=` 与列表里都是 UUID | 实际上无歧义 | — |
| **R14（新）** | 同名/fork 会话的**标题**来自 `session_info` | 影响卡片标题质量 | adapter 读 `session_info.name`，回退到 `firstMessage` |

### 待定决策（需要你拍板）

1. **投影归属**：core 持有 projector（adapter 只给 `raw`），还是 adapter 直接产出规范化卡片？
   - 前者：新增宿主 = 1 个 projector 文件，core 里出现宿主名词。
   - 后者：core 完全中立，但每个 adapter 都要重写一遍「卡片语义」。
   - **倾向**：前者，因为 dsh 与 pi 的卡片语义高度一致，重复实现不划算。
2. **是否支持 DSH 作为第二个 adapter**：建议 **M4 再做**，作为架构的回归测试。
3. **包名与发布**：单包（core + 内置 pi-web adapter）还是 monorepo？先单包。
4. **画布数据源**：既然 `/context` 窗口化，是否干脆**完全不依赖 `/context`**，投影只读 JSONL + SSE 增量？
   - ✅ **已定**：是。JSONL 是唯一完整来源，`/api/agent/*` 只用于状态与命令，`/context` 不用。
5. **实时性策略**：无全局 SSE，是否接受「watch 文件为主 + SSE 补流式」？
   - ✅ **已定**：是（U3/U4 已验证）。`fs.watch(recursive)` 只作信号，收到后重读 + diff；对**运行中**会话额外开 SSE 拿 `_delta` 做乐观渲染，`*_end`/`message_end` 定稿。
6. **可写能力边界**：画布是否允许改名/归档/删除会话？
   - 可行（`PATCH /api/sessions/:id` 改名、`POST /api/sessions/ui-state` 归档/置顶、`DELETE /api/sessions/:id` 删除）。
   - **倾向**：M1 只读；M2 只开「改名」（低风险）；归档/删除放 M3 并加二次确认。
7. **是否向上游提 issue**：pi-web 无官方集成点，我们依赖其内部契约。
   - **倾向**：M3 提一个 feature request（请官方提供「外部集成可调用的切会话/打开画布」接口），作为 R6 的长期解。

---

## 10. M2 实测结果（2026-10-12，已完成）

M2 的 5 项里有 4 项在 M1 复刻 `app.js` 时已随代码带过来，所以 M2 的实际工作是**逐项在 pi 数据下验证并修差异**。

### 结论一览

| 项 | 结果 | 修的差异 |
|---|---|---|
| fork 连线 | ✅ 4/4 全部正确 | 无（`parentSessionFile` 配对已工作） |
| 分支折叠 | ✅ 43→39→43 | 无（`app.js` 自带） |
| compaction 分隔卡 | ✅ 37/37 投影正确 | **projector 改用独立 kind** + 画布标签 |
| 主题同步 | ✅ 双向正确 | **改读 `data-theme` 而非 `prefers-color-scheme`** |
| 流式「边写边显」 | ✅ 长度 3→53，最终字节精确 | 无（bridge 的 `_delta` 拼接正确） |

### fork：pi 的 fork **不复制历史**（重要）

实测：父会话 548 行，4 个子会话各只 13 行。子会话的 header 带 `parentSession` 指向父文件，但**不继承任何条目**（与 DSH 的 `inheritedEventCount` 语义完全不同）。

- 因此 `replayFrom`/`inheritedEntryCount` 在 pi 下永远是 0，子卡只含它自己的对话 —— 这正是想要的。
- 父子连线靠 `parentSessionFile` 与 thread 的 `sessionFile` 配对，4/4 成功。
- 4 个子会话指向同一个父（一个会话被 `/fork` 四次），画布上表现为父卡有 4 个子节点。

### compaction：需要独立的 kind，不能复用 `todo`

37 个 `compaction` 全部落在活跃分支上，投影正确。但初版复用 `todo` 会让画布把它当普通「记录」且没有专属标签。

改为 `kind: 'compaction'` / `kind: 'branch'`：

- 画布标签明确：「上下文压缩」/「分支摘要」（原先统一显示「记录」）。
- 它们**不成为卡片**（卡片只由 `user` 消息产生），只在会话详情里作为分隔条目出现 —— 行为正确，因为压缩摘要不是一轮提问。
- `branch_summary` 在本机 154 个会话里是 0 条（没用过带摘要的分支切换），投影逻辑已写并单测覆盖。

### 主题：必须读 `data-theme`，不能用 `prefers-color-scheme`

pi-web 的主题是**三态偏好**（`pi-theme` = `auto` / `light` / `dark`），解析结果写在 `documentElement.dataset.theme` 并附带 `dark` class。

初版 bridge 只读 `prefers-color-scheme`，**会忽略用户的手动选择**。改为：

```js
const applied = document.documentElement.dataset.theme
if (applied === 'dark' || applied === 'light') return applied   // 权威
return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
```

并用 `MutationObserver` 监听 `data-theme` / `class` 变化，主题切换即时同步。切换条的 CSS 也从 `@media (prefers-color-scheme)` 改为 `html.dark` / `html[data-theme="dark"]`。

实测（`colorScheme: light` 但手动选 dark）：

| pi-web 偏好 | pi-web `data-theme` | 画布 `data-theme` | 画布底色 |
|---|---|---|---|
| light | light | light | `rgb(245, 247, 250)` |
| dark（覆盖系统） | dark | dark | `rgb(15, 17, 21)` |

### 流式：`_delta` 拼接正确，末尾会「回退」是设计如此

实测长度轨迹：`3 → 6 → 12 → 18 → 26 → 35 → 44 → 53 → 50`，最后 `running: false` 带最终文本 50 字符，**与落盘文件逐字节一致**。

末尾的 53→50 回退是 `text_end` 用权威内容替换累积的 `_delta` —— 这正是设计意图（背压时可丢 `_delta`，`*_end` 永不被丢弃），不是 bug。

### M2 发现的一个测试陷阱（写进纪律）

画布用 CSS `transform` 缩放，卡片可能在视口外且**永远不可点击**。验证交互时必须直接派发事件：

```js
element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
```

且**必须锁定同一个 `data-card`** —— 重渲染后 `.first()` 会指向另一张卡，导致「展开未还原」的假失败。

### 探测纪律补充

流式验证必须用一次性会话，且**要先 `set_model` 换到可用模型**：本机默认 `qoder-cn/dfmodel` 会返回 `stopReason: "error"` 且内容为空，看起来像「流式坏了」，实际是模型不可用。

一次性会话的 cwd 会同时污染两处：会话目录（`~/.pi/agent/sessions/--...--`）与 pi-web 的 `pi-web-session-state.json` 的 `projectOrder`，**必须在停掉服务后**清理（服务在跑时 pi-web 会把它写回去）。

---

## 11. M3 实测结果（2026-10-12，已完成）

### 结论一览

| 项 | 结果 |
|---|---|
| 画布内发消息 | ✅ 走通（消息落盘、agent 真的运行） |
| 会话改名 | ✅ 写入 pi 的 `session_info`，pi-web 与画布同步 |
| pi-web 归档 | ✅ 写入 pi-web 的 `ui-state`，会话文件不动 |
| 能力门控 | ✅ 不支持的动作不渲染按钮 |

### 架构修正：写操作必须在**浏览器**里发起

初版把改名/归档实现成服务端函数（`Synapse.renameSession` → `adapter.renameSession` → `fetch('/api/sessions/...')`），实测直接失败：

```
TypeError: Failed to parse URL from /api/sessions/01a12fd0-...
```

两个原因，缺一不可：

1. **相对 URL 在服务端没有 base**。Node 的 `fetch` 要求绝对 URL；`/api/...` 只在页面上下文里有意义。
2. **pi-web 要求 `Origin` 等于自身 `Host`**。服务端发起的请求没有页面 origin，即便补上绝对 URL 也会被 403（M0 已实测）。

所以写操作全部下沉到画布（浏览器）：

```js
// src/canvas/app.js —— 同源，直接调 pi-web
await piWeb('/api/sessions/<id>', { method: 'PATCH', body: JSON.stringify({ name }) })
await piWeb('/api/sessions/ui-state', { method: 'POST', body: JSON.stringify({ action: 'set', ids: [id], archived }) })
```

服务端**只声明能力**（`/synapse/api/status` 返回 `capabilities`），不代劳写操作。这样既避开了上面的两个问题，也让能力声明与实现不会漂移：能力为 true 就意味着画布真的能做。

### 能力门控

画布启动时读一次 `/synapse/api/status`，据此决定渲染哪些按钮：

| 能力 | 门控的 UI |
|---|---|
| `sendMessage` | 侧边栏「新会话」、空画布的「新建会话」、卡片「继续追问」 |
| `forkSession` | 「创建分支」 |
| `renameSession` | 卡片「改名」 |
| `archiveSession` | 卡片「pi-web 归档」 |
| `openSession` | 「在 pi-web 中打开」 |

能力为 false 时按钮**不渲染**（而非渲染后点击失败）。

### pi-web 归档的两个细节

1. **两个方向都是 `action: "set"`**：归档 `{action:'set', ids, archived:true}`，取消归档 `{action:'set', ids, archived:false}`。`action: "restore"` 是另一回事 —— 它回放一份精确的 prior-values 快照，用于 undo。
2. **键是会话「族」的根**：pi-web 按 family root 记录归档状态；独立会话的根就是它自己。

### 已知限制：画布无法应答扩展 UI 对话框

实测中发现：一次性会话上发消息后，agent 停在一个 **pending extension UI 请求**（`{"method":"input","title":"Agent name:"}`，来自 remote-pi 扩展），第二条回复因此没有产出正文。

- SSE 会推 `extension_ui_request`，画布目前**不渲染也不应答**。
- 影响：若某会话依赖扩展对话框（如要求输入名字/确认），在画布上发消息后可能看起来「没有回复」。
- 缓解：pi-web 原生界面能应答这些对话框；画布的定位是「看全局 + 轻量追问」，复杂交互应回到 pi-web。
- 后续若要支持，需要实现 `extension_ui_response` 的转发（M4 候选）。

### 默认模型不可用（再次确认）

`qoder-cn/dfmodel`（本机默认）返回 `stopReason: "error"` 且内容为空。任何涉及真实 agent 运行的验证都必须先 `set_model` 换到可用模型（如 `trae/deepseek-v4.1-flash`），否则会误判为功能损坏。

### 验证方法的一个陷阱

画布数据文件会**累积历史探测产生的 thread**。按 `.first()` 选按钮会点到旧探测会话上，得出「改名没生效」的错误结论。

正确做法：先通过 `/synapse/api/workspaces/:id` 把 `sessionId` 映射成 `threadId`，再按 `data-thread` 精确点击。

---

## 12. 仓库结构

```text
B:/vibe_program/pi-synapse/
├── package.json
├── README.md                 # 面向使用者
├── AGENTS.md                 # 面向 agent（开发必知事项）
├── docs/
│   └── design.md             # 本文件（设计决策 + 实测记录）
├── src/
│   ├── index.js              # 公开导出
│   ├── synapse.js            # 投影引擎：adapter → store
│   ├── store/
│   │   ├── workspace-store.js    # 画布元数据 + 迁移 + 投影写入
│   │   └── instance-lock.js      # 单实例锁（键在数据文件上）
│   ├── project/
│   │   ├── pi.js                 # pi JSONL → 规范化条目
│   │   └── context-usage.js      # 上下文占用估算（复刻 pi 的 getContextUsage）
│   ├── models/
│   │   └── registry.js           # provider/model → contextWindow
│   ├── server/
│   │   ├── routes.js             # /synapse/api/* 纯 handler
│   │   ├── proxy.js              # 同源反代 + HTML 注入
│   │   └── guard.js              # Host 白名单
│   ├── canvas/
│   │   ├── app.js                # 画布 UI（自 dsh-synapse 移植）
│   │   ├── styles.css
│   │   ├── bridge.js             # 注入 pi-web 的切换条与消息桥
│   │   └── app.html · mark.svg
│   └── adapters/
│       ├── contract.js           # 契约 + 能力声明 + READ_ONLY_TOOLS
│       ├── pi.js                 # 读会话文件、watch 变化
│       └── pi-web-actions.js     # 浏览器侧的 pi-web 写操作（改名/归档/fork/set_tools/btw）
├── bin/
│   └── pi-synapse.js         # CLI
├── scripts/                  # 验证脚本（见 §15.6）
└── test/
    ├── projection-pi.test.js
    ├── context-usage.test.js
    ├── instance-lock.test.js
    ├── workspace-store.test.js
    └── pi-web-actions.test.js
```

---

## 13. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0 验证**（✅ 已完成） | 实测 R2–R5 + 反代注入；关闭 U1/U2/U3/U4/U7 | 见 §8 |
| **M1 打通**（✅ 已完成） | 搬 store + canvas，写 pi-web adapter + pi projector，**方案 B 反代 + 注入**，能看画布、能跳会话 | 打开 `http://127.0.0.1:30142` 看到本机 30 个会话目录映射成的工作区，卡片内容与 pi-web 原生对话一致 |
| **M2 补全**（✅ 已完成） | fork 连线、分支折叠、compaction/branch_summary 分隔卡、主题同步、流式「边写边显」 | 见 §10 |
| **M3 体验**（✅ 已完成） | 画布内发消息、改名、pi-web 归档、能力门控 | 见 §11 |
| **M4 收敛**（2 天） | `app.js` 拆分重构、DSH adapter 回归验证抽象、CI + 发布 npm | `pi install` 一条命令可用 |
| **M5 增强**（✅ 已完成） | 卡片上下文占用圆环、`/btw` 侧问（fork + 只读工具 + 自动归档 + 折叠挂件）；顺带修掉工具折叠不幂等与单实例两个严重 bug | 见 §15 / §16 / §17；`verify-context` 全会话一致，`verify-btw` 25/25，`verify-single-instance` 11/11 |

M4 进度（4 项拆开看）：

| 项 | 状态 |
|---|---|
| `npm run verify` 一条命令 + CI | ✅ 已完成（§28；CI 只跑 check + test，已在 `wjunhere/pi-synapse` 上跑通） |
| `app.js` 拆分重构 | 🟡 第一刀完成（§29：7 个叶子模块 445 行已搬出，2334 → ~1900 行，19/19 回归绿）；渲染/交互/动作三层未搬 |
| DSH adapter / 契约测试 | ⬜ 等用户拍板（两条路：真写 dsh-synapse adapter，或改成跑同一批 store 单测的最小契约测试） |
| 发布 npm | ⬜ 等用户确认名字归属（registry 上 `pi-synapse` 是 Unpublished 状态），另缺 `repository`/`author` 字段 |

### M1 具体任务清单（已按 M0 结论定稿）

1. **脚手架**：`package.json` / 目录结构 / 测试基线（`node --test`）。
2. **搬 store**：`WorkspaceStore` + 迁移链，字段中立化（`dshSessionId` → `sessionId`）。
3. **搬 canvas**：`app.js` + `styles.css` 原样搬运，只改桥接层（`postMessage` 类型名、`/synapse/api/*` 路径）。
4. **pi projector**（新写）：
   - 读 JSONL，按 `type` 分发（排除 `session` header 的 `parentId` 陷阱）；
   - 活跃分支回溯（末行 leaf + `parentId`）；
   - `message` role=user → 新卡；assistant → 折叠；`toolCall`/`toolResult` 按 `callId` 折叠；
   - `session_info.name` → 卡片标题，回退 `firstMessage`；
   - 跨文件 fork：读 header 的 `parentSession` 连线。
5. **pi-web adapter**：
   - `listSessions()` → `GET /api/sessions`（含 `cwd`）+ 读文件补 `parentSession`；
   - `readEntries()` → 直读 JSONL（**不用 `/context`**）；
   - `subscribe()` → `fs.watch`（只作信号）+ 重读 diff；低频轮询兜底；
   - `openSession()` → `location.href = '/?session=' + id`（整页导航）；
   - `capabilities()` → `sendMessage:false` / `forkSession:true` / `openSession:true`。
6. **反代 + 注入**：`/synapse/*` → 画布；其余透传；`</head>` 前插入口按钮与消息桥。
7. **CLI**：`pi-synapse start` 启动反代 + 可选拉起 pi-web。

**M1 明确不做**：画布内发消息、fork 连线（只做基础的父卡关联）、流式乐观渲染、主题同步、写操作（改名/归档）。

---

## 14. 与 dsh-synapse 的关系

- **许可**：dsh-synapse 是 MIT，可自由 fork/改造。新项目保留 `LICENSE` 与来源说明（`NOTICE` 或 README 致谢）。
- **上游同步**：dsh-synapse 仍在活跃开发（v0.4.2，514★）。canvas 层的 bug 修复建议**反向 cherry-pick**，所以 canvas 目录保持与上游相同的文件边界（`app.js` / `styles.css`），不做拆分，直到 M4。
- **不要做的事**：不要把 DSH 的适配代码硬塞进新包伪装成「通用」——契约的价值在于真的能被两个宿主实现，而 DSH adapter（M4）就是它的检验。
---

## 15. M5 实测结果（2026-10-12，已完成）

两个新功能：**卡片上下文占用圆环**与 **`/btw` 侧问**。两者都建立在一个原则之上 —— 能复用 pi/pi-web 已有机制就不另造运行时。

### 结论一览

| 项 | 结果 |
|---|---|
| 上下文占用（全部会话） | ✅ 153/153 与 pi 自身算法一致（容差 64 token） |
| 圆环弧长 = 占用比例 | ✅ 浏览器实测 `arc=1.80 / expected=1.81` |
| 三档配色（ok/warn/danger） | ✅ 互不相同（真实数据最高 61%，测不到 warn/danger，需注入验证） |
| `/btw` fork 继承上下文 | ✅ 子会话带父会话历史 |
| `/btw` 只读工具 | ✅ `["read","grep","find","ls"]` 落进会话文件 |
| `/btw` 自动归档 | ✅ 移出主列表，**归档视图仍完整可见** |
| 挂件收纳 + 可追问 | ✅ 折叠挂件 + 详情里可继续追问 |
| 端到端 | ✅ 25/25 项通过 |

### 15.1 上下文占用：为什么不能用 pi-web 的字段

`GET /api/agent/:id` 会返回 `contextUsage`，但**只对已在内存中的会话**（600s idle 后驱逐）。画布必须覆盖全部 154 个会话，因此改为复刻 pi 的 `getContextUsage()`：

```
锚点  = 最近一条带 usage 的条目          ← 不一定是 assistant
尾随  = 锚点之后所有条目的字符数 / 4
失效  = 锚点之后出现 compaction/context_edit → 丢弃锚点
百分比 = (usage发起的 totalTokens + 尾随) / model.contextWindow
```

`contextWindow` 取自 `~/.pi/agent/models.json`（用户配置优先）+ `models-store.json`（拉取的缓存）。实测 **147/154** 能解析出窗口；解析不出的会话**不画圆环**（而不是画一个假的）。

### 15.2 三个必须踩过的坑（否则数字会错得离谱）

修这三个坑的过程，是「先校准测量工具」的典型案例 —— 我写了一个逐会话比对脚本（`scripts/verify-context.mjs`）把画布的数字和 pi 的算法对拍，才暴露出偏差。

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 部分会话差 **30k+ token** | 「只思考/只调工具」的 assistant 轮次没有 `text`，投影时被整条丢掉 → **锚点丢失** | projector 产出 `kind:'usage'` 条目承载它 |
| 2 | 单个会话差 **7403 token** | thinking 块的长度没算进尾随估算 | `usageChars` 汇总 thinking 长度 |
| 3 | 仍差 **7401 token** | `arguments` 用的是**缩进美化版**，比 pi 数的 `JSON.stringify` 会长 | 用 compact 长度，不用展示版 |

修完后偏差从「10 个会话、最大 95k」降到「5 个会话、最大 6 token」（≈0.006%，视觉上无差别）。这 6 token 的残差来自投影会 trim 正文而 pi 数原始字节。

**另一个反直觉的点**：锚点自己的 `process[].result`（工具输出）属于**尾随**上下文而非锚点 —— 因为 usage 是锚点生成那一刻的快照，之后折进来的工具结果还没被计费。而 `arguments`（锚点自己吐出来的）**不能**再加，它已经含在 usage 里了。

### 15.3 `kind:'usage'` 暴露的存储模型问题

`usage` 条目只服务于计算，不该渲染。但把它写成 message 后发现：**画布数据文件里积了 723 条空正文消息**。

根因是**投影是「合并」而不是「重建」** —— `projectionThread` 找到已有 thread 就往后追加，从不删除。所以一个「不该持久化」的 kind 一旦写进去就永久留下，并渲染成一行空记录。

修法有两层：`projectSession` 现在把 usage 条目只喂给估算器（`refreshContextUsage` 在投影循环之后跑），不写 message；`normalizeState` 里加 `dropTransientMessages`，把历史遗留的清理掉。实测 723 → 0。

### 15.4 `/btw`：与「创建分支」的区别在哪

必须诚实记录：**pi-web 的 fork 只能从当前 leaf 分叉**（`POST /api/sessions/:id/fork` 的 body 是 `{}`，不接受 entryId）。所以 `/btw` 与「创建分支」底层是**同一个调用**。

那 `/btw` 的价值在三件事上：

1. **只读工具** —— `set_tools` 落到新会话文件（`custom` 条目，`pi-web:tool-selection`），父会话不受影响
2. **自动归档** —— 会话移出 pi-web 主列表，但**归档视图里完整可见、可打开、可继续**
3. **折叠挂件** —— 画布上收纳成父卡片下方的小挂件

顺序不能变：**fork → set_tools → prompt**。fork 前会话不存在，set_tools 无处可写；prompt 前必须设好，否则第一轮会用父会话的完整工具集。

归档失败**不算失败** —— 挂件照样能用，只是 pi-web 列表里多一条。

### 15.5 为什么不用 pi-btw 的机制

参考实现 `@narumitw/pi-btw` 用的是「文本注入 + `completeSimple` 直接调模型 + 只存内存」，因此**临时、不落盘**。但它的代价是**没有工具执行循环** —— `completeSimple` 是纯模型调用。要在画布里复刻，就得让服务端起一个「轻量模型调用」通道，等于**在 pi-synapse 里再实现一个 mini agent 循环**，违背项目「不另造运行时」的边界。

所以选了「真 fork」：上下文是**真历史**（比文本拼凑更准），工具/MCP 可定制，代价是会话落盘 —— 而 pi 的会话模型本来就是这样。

### 15.6 验证方式

| 脚本 | 作用 | 关键手法 |
|---|---|---|
| `verify-context.mjs` | 上下文占用 vs pi 算法 | 逐会话对拍，容差 64 token，退出码即闸门 |
| `verify-btw.mjs` | 侧问全链路 25 项 | 一次性 cwd；按 `parentId` 限定产物 |
| `verify-ring-levels.mjs` | 圆环三档配色 | 注入隐藏元素读 computed style（真实数据测不到 warn/danger） |
| `verify-detail-rows.mjs` | 详情无空行 | 统计 `.message` 里正文为空的比例 |

**验证脚本的两个必须**：

- 定位 btw 产物**必须按 `parentId` 限定到本次的父卡片** —— 画布数据累积历史探测产物，`find(t => t.kind === 'btw')` 会命中上一次运行的会话
- `PROBE_CWD` 指向的目录**必须先存在**，否则 `/api/agent/new` 返回 400 `Directory does not exist`

### 15.7 探测清理的第三处污染

前两份文档记了两处（会话目录、`projectOrder`），M5 又发现**第三处**：

**pi-web 的 `sessions.<id>.archivedAt` 会存活在会话删除之后。** 探测建出的 btw 会话被删掉后，`pi-web-session-state.json` 里仍留着孤立的归档条目（实测 4 → 10 条，多出的 6 条全是探测会话）。

所以清理清单是三项，且都要在**停掉服务后**做：

1. 会话目录 `sessions/--<cwd>--/`
2. `pi-web-session-state.json` 的 `projectOrder`
3. `pi-web-session-state.json` 的 `sessions.<探测id>` 孤立条目

每次都要 `revision += 1` 让 pi-web 的 mtime+revision 缓存失效。

**另注**：`jq -r` 在 Git Bash 里输出带 `\r`，`while read` 循环里必须先 `tr -d '\r'`，否则路径拼接会失败、误报「孤儿条目」。

---

## 16. M5 修复：工具调用折叠的幂等性（严重）

M5 验证过程中发现了一个**既有严重 bug**：画布数据文件 `workspaces.json` 涨到了 **545 MB**。

### 症状与排查

最初误以为是「探测产物累积」，但清理后文件仍在增长。逐步缩小：

| 排除项 | 测量 | 结论 |
|---|---|---|
| 消息重复 | 16,015 条消息，重复 `sourceEntryId` **0** | 不是消息层 |
| 单条内容过大 | 最长值 91 KB | 不是单条 |
| 探测残留 | 清理后仍增长 | 不是探测 |
| **按 callId 去重** | 227,441 条 process，**唯一 callId 只有 29,837** | ✅ **86.9% 是重复** |

会话文件里只有 **30,074** 个 `toolCall`，画布里却有 227,441 条 process —— **7.6 倍**。最极端的单个 thread 里，同一个 `callId` 重复了 **104 次**。

### 根因

`foldToolProcess` 只在前一条 assistant 消息里查找已有 callId：

```js
const target = [...thread.messages].reverse().find(m => m.kind === 'assistant')
const process = target.process
const found = process.find(item => item.callId === callId)   // ← 只看 target
```

而**投影是「合并」的**：每次重扫都会重新读取整个会话并重新折叠每一条 entry。重扫时 thread 里已经有全部消息，于是「最近一条 assistant 消息」是**最后那条**，而不是当初发起的那个 —— `found` 永远是 `undefined`，于是每次重扫都往最后一条消息里追加一份副本。

流式会话更严重：宿主在会话进行中反复重发条目，重复次数与重扫次数成正比。

### 修法

查找范围从「折叠目标」扩大到**整个 thread**：

```js
let found = callId === '' ? undefined : findProcessEntry(thread, callId)
```

`findProcessEntry` 扫描所有消息的 `process` 与 `pendingProcess`，返回条目**及其所属列表**，这样新 call 仍能追加到当前回合，而已存在的 call 只会被更新。

**关键不变式**：重复折叠必须是无操作（no-op）。回归测试 `a tool call survives many rescans without growing` 断言 10 次重放后状态字节不变。

### 修复效果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 文件大小 | 545 MB（持续增长） | 70.8 MB（重启后不变） |
| process 条目 | 227,441 | 29,902 |
| 唯一 callId | 29,837 | 29,902 |
| 重复率 | **86.9%** | **0%** |
| 单 call 最大重复 | 104× | 1× |

修复后 `29,902` 与源文件的 `30,074` 个 toolCall 基本吻合（差额来自非活跃分支与空白会话）。

### 另一个同时存在的坑：多实例并发写

排查中另一个干扰因素：**同时有 3 个 `pi-synapse` 进程在跑**（我之前几轮验证遗留的），三者都在写同一个 `workspaces.json`。日志里已有明确告警：

```
synapse: 另一个实例正在写入 workspaces.json——请只运行一个实例
```

**教训**：验证脚本反复「重启服务」时，如果只是 `taskkill` 当前监听的 PID，先前启动但绑定失败的实例仍会留在后台。**测一个会写盘的 bug 前，必须先确认只有一个实例**：

```bash
wmic process where "name='node.exe'" get ProcessId,CommandLine | grep -i pi-synapse
```

### 关于 545MB → 70MB 的残余体积

修复后的 70 MB 是**真实负载**，不是泄漏：`tool arguments` 21.7 MB + `tool results` 28.6 MB + 消息结构 8.1 MB + 正文 3.5 MB。来源可核对 —— 154 个会话里 toolResult 输出合计 **29.8 MB**、toolCall 参数合计 **28.2 MB**，与投影后的体积一致。

真正的风险是**单条工具输出没有上限**：一次读到巨型文件就可能让数据文件暴涨。当前真实数据里最大的单条输出只有 1.2 MB，暂不构成问题，但若要长期运行，投影层应对 `process[].result` 施加与消息正文相同的截断策略（`MAX_PROJECTION_LENGTH`）—— 目前只有消息正文有上限，工具输出没有。M6 候选。

---

## 17. M5 修复：单实例强制（实例锁）

§16 记录了一个 545 MB 的数据文件。修掉工具折叠不幂等之后，还有**第二个成因**没有解决：当时**同时有 3 个 `pi-synapse` 进程在跑**，都在写同一个 `workspaces.json`。

### 为什么「只检查端口」不够

先实测了一个被忽略的失败模式：

```
$ node bin/pi-synapse.js start --port 30142   # 实例 A：正常
$ node bin/pi-synapse.js start --port 30142   # 实例 B：端口被占
pi-synapse: Error: listen EADDRINUSE: address already in use 127.0.0.1:30142
$ wmic process ... | grep -c pi-synapse
2                    ← B 没有退出！
```

**B 绑定失败却没有退出**：它已经建好了投影引擎，定时器继续跑，于是**从未服务过任何请求的进程仍在无限重写数据文件**。实测数据文件的 mtime 在持续前进。

结论：**端口冲突恰好是「重复实例」最危险的那个形态**，所以基于端口的防护会正好漏掉它。锁必须键在**数据文件**上。

### 设计

| 决策 | 理由 |
|---|---|
| 锁键在 `dataFile`，不是端口/进程 | 同一份数据只能有一个写入者；而危险形态恰恰是端口冲突那个 |
| 不同 `--data` 互不干涉 | 两个 profile 各自跑是合法的，必须允许 |
| `wx` 原子创建 | 两个进程竞争时保证只有一个能赢，无需额外同步 |
| 锁内含 pid / port / host / startedAt / cwd | 拒绝时要能指名道姓告诉用户是谁占着 |
| 陈旧锁自动接管 | Windows 上被杀实例**必然**留下锁（见下），不自动接管就等于要求用户手动删文件 |
| 释放前校验锁还是自己的 | 慢死的旧实例不能删掉新实例刚抢到的锁 |

### Windows 上的一个硬事实

原以为 `SIGINT` 会走到 `shutdown()` 里释放锁。实测**不成立**：

```js
child.kill('SIGINT')   // signalCode: 'SIGINT'，但 SIGINT 和 exit 监听器都不触发
```

**由其他进程投递的 `SIGINT` 会在 Node 执行任何 JS 之前终止进程。** 后果是所有被强杀的实例都留下锁文件 —— 这不是要找方法避免的边界情况，而是**常态**。

于是设计重心从「优雅释放」移到「可靠接管」，`holderIsAlive` 成为正确性关键。它要同时防住两个方向：

| 风险 | 后果 | 对策 |
|---|---|---|
| 把活着的实例误判为死 | **两个写入者，数据损坏** | 读不到命令行时**不能**当作已死 |
| 把死实例误判为活 | 用户被永久锁在外面 | ① 命令行第二判据（防 PID 回收）② `staleAfterMs` 兼底（24h） |

这两个方向不对称：**前者的代价是数据损坏，后者的代价只是无法启动**。所以所有不确定都倒向「拒绝启动」。

### 启动顺序

顺序本身就是修复的一部分：

```
1. 抢数据文件锁        ← 必须在任何写盘之前（首次运行就会建文件、迁移也会写）
2. 绑定端口            ← 必须在投影之前（端口冲突是常见失败，应在此刻干净退出）
3. 扫描并投影会话
```

原实现把 `synapse.start()`（含投影定时器）放在 `startServer()` **之前**，所以端口失败时定时器已经在跑了 —— 这正是僵尸进程的来源。

### 验证

`scripts/verify-single-instance.mjs` 走真实 CLI，11 项：

| 检查 | 结果 |
|---|---|
| 第一个实例启动、锁记录 PID | ✅ |
| 同端口的第二个实例被拒绝 | ✅ |
| **换端口的第二个实例也被拒绝** | ✅（端口防护漏掉的正是这条） |
| 无僵尸写入者（数据文件字节不变） | ✅ |
| 持有者被杀后残留锁 → 新实例无需 `--force` 即可启动 | ✅ |
| 接管时给出提示，锁转归新实例 | ✅ |

单测 `test/instance-lock.test.js` 10 项覆盖：正常加解锁、活持有者拒绝、陈旧锁接管、损坏锁不阻塞、不误删他人锁、`--force`、不同数据文件不冲突、PID 回收不锁死、过期锁接管、首次运行自动建目录。

---

## 20. 导航收敛：点卡片进详情、详情默认最新（2026-10-13，已完成）

两个使用问题，同根：**画布有两个「看会话」的目的地，但入口语义互相打架**。

| 原行为 | 问题 |
|---|---|
| 点卡片本体 → `openSessionInHost`（整页跳去 pi-web） | 地图的价值就是在画布里读会话，点一下反而离开应用；且 pi-web 无页内切换，只能整页导航 |
| 详情默认落在顶部 / 上次的滚动偏移 | 长会话打开后看到的是第一句提问；btw 挂件、侧栏、详情 tab 三个入口都没有锚点，全走默认 |

改法：

1. 点卡片 = 进**详情视图**并定位到那一轮（卡片 ID 尾部的 seq 就是消息锚点）。pi-web 变成显式动作（footer 的「pi-web」、详情头部的「在 pi-web 中打开」）。
2. 无锚点进详情 = 落在**最新一条消息**（`scrollIntoView({ block: 'end' })`）。转写打开时应当先看到「回答到哪了」，而不是开头。
3. `detailScrollByThread` 的记忆只在**已在阅读**该转写（无新锚点）时生效 —— 显式进入必须压过上次访问的旧偏移，否则记忆逻辑会劫持定位。
4. 卡片检查器（`card-inspector`，右侧滑出面板）删除：它唯一的入口就是点卡片，新行为让详情视图完全覆盖它的内容（问题 + 回答 + 过程记录 + 继续追问/分支/pi-web），且详情还能发消息。连带的 state 字段、Escape 处理、CSS 56 行一并清掉。

### 20.1 后续修复（同日，用户实测反馈）

**① 标题冲出卡片。** 表面看是 ellipsis 没生效，真因是 `.thread-card-head` **丢了 `display: flex`**：删 card-inspector 那段 CSS 时，我按「含 `card-inspector` 的行」清理残留，而那一行是共享选择器列表 ——

```css
.brand, .top-actions, .thread-card-head, .detail-actions, .detail-head-actions, .detail-head-meta, .card-inspector-meta { display: flex; align-items: center; }
```

整行被删掉，`.thread-card-head` / `.detail-head-actions` / `.detail-head-meta` 一起失去 flex 上下文。后果：标题（`<button>`）在 block 上下文里 **`width: auto` 是 shrink-to-fit（表单控件特性，不像 `<div>` 那样撑满）**，于是涨到文本自然宽度（实测 1126px 压在 310px 卡片上）；`.topic-dot` 也塌成 0 宽。修法是给每个组件写自己的 `display`，并给标题显式 `display: block`（`inline-flex` 的盒子同样按内容定宽，剪不住自己）。

教训：**共享选择器列表让删除变成静默事故**，而我的「验证」当时只是 `grep` 了一下 CSS 残留，没量布局。现已把这类失联变成可测失败 —— `verify-card-header.mjs` 从「只量圆环间距」扩成量四件事：标题裁剪在卡内、head 是 flex、分类圆点有宽度、长标题真的出省略号。

**② 点卡片落到最新而不是那一轮。** 正则写的是 `/:turn:(\d+)$/`，而 entry id 是 **hex 串**（`77e0044c`），**每一张卡都匹配失败**，于是全部走了「无锚点 → 落最新」的分支。改成 `/:turn:([^:]+)$/`，并把 `:turn:empty`（空线程占位卡）显式归入无锚点。

更值得记的是测试失职：上一版的 `verify-navigation` 只断言「点卡片后没离开画布、详情打开了」，把「视区顶部的消息 seq」**打印出来却没断言** —— 测了，但没测在点上。现在断言锚点相对视口顶部的偏移 ≤60px 且未滑到底部（320 条会话实测偏移 0px）。

**③ 侧栏行语义。** 上一版把侧栏行也改成「进详情」，结果**画布上「定位某条会话」失去入口**（`verify-btw` 据此误报「btw 按钮点不到」）。改为**跟随当前视图**：在地图上 = 选中并平移聚焦那条会话的卡片；在转写里 = 切到那条会话（落在最新一轮）。

**④ 流式动效不熄灭（僵尸状态）。** bridge 的 SSE 流被 `syncRunning` 主动 abort 时**不通知画布**，画布 `liveReplies` 里的 `running: true` 就永远留着 —— 蓝色呼吸动画会一直亮着。修在根因：abort 前先向画布发一条 `running: false`（宿主才是「是否在跑」的权威）。这个 bug 一直存在，只是以前没有可见状态暴露它。

**⑤ 弧长断言。** 原来用固定容差 0.01（后改 0.02），而 label 百分比四舍五入到 0.1% 在 1M 窗口上对应弧长 0.028 —— 固定容差必然偶发误报。改为按四舍五入区间判定：`|arc - C·p| ≤ C·0.0005`。

## 21. 卡片内粘贴图片（2026-10-13，已完成）

草稿卡片（新会话 / 追问 / 分支 / 侧问）与转录内的输入框都支持粘贴图片，也有
「图片」按钮走同一条 `attachImages`。图片走的是**宿主自己的 prompt 通道**，没有另造一套：

| 项 | 值 | 来源 |
|---|---|---|
| 每条消息上限 | 10 张 | pi-web `MAX_ATTACHED_IMAGES` |
| 单张上限 | 10MB（base64 解码后） | pi-web `MAX_ATTACHED_IMAGE_BYTES`，服务端复检 |
| 客户端压缩 | >1MB 且非 gif → 最长边 1024、JPEG q0.85 | pi-web 自己的策略，照抄以免白烧上下文 |
| 请求字段 | `images: [{ type:'image', data:<base64 无前缀>, mimeType }]` | pi-web `validateAgentImages` |

### 上下文记账必须按 pi 的规则

pi 的估算器对每个图片块收固定 **`ESTIMATED_IMAGE_CHARS = 4800`**（1200 token），
不看图片实际大小；而且只对 user / custom / toolResult 收，assistant 不收。所以：

- user 与 `custom_message`：把 `4800 × 张数` 折进 `usageChars`（这个字段本来就是
  「pi 会数、画布不显示的部分」）。
- toolResult 含图（截图类工具）：条目自己的 `usageChars` 之外，折叠进 `process[]`
  时要带 `imageChars`，否则「刚跑完截图工具」的那一轮在锚点分支里会少报 1200 token。
- `estimateEntryTokens` 与锚点分支各加一次 `item.imageChars`。

### 三个必须知道的坑

1. **`[图片]` 标记不能写进 `text`。** `settlePendingReply` 是拿「待回复的文本」与
   落盘后的消息文本**精确相等**来判断回复是否到达的；一旦把标记混进 text，带图消息
   就永远匹配不上，卡片会一直显示「正在回复」。所以投影另存 `imageCount`，显示层用
   `displayText()` 现拼标记。
2. **空文本消息会被丢掉两次。** 只发图片不发文字时，投影的 `note()` 与存储的
   `noteProjection()` 都会因「文本为空」返回空数组 —— 那一轮在画布上根本不存在。
   两处都改成「有图就保留」，标题回落成 `[图片]`。
3. **报错结束的一轮以前不结算。** `settlePendingReply` 只认 assistant 消息，而失败的
   一轮只写 `error` 条目 —— `pendingReplies` 永远留着，卡片永远「正在回复」且蓝色边框
   常亮（实测复现）。现在 `error` 也算答复。

### 验证

`scripts/verify-image-paste.mjs` 端到端五项：粘贴出现缩略图 → 宿主收到的 prompt 带
images（type/mimeType/base64）→ 图片落进**会话文件**（用请求里的 sessionId 精确定位文件，
而不是扫目录，否则会命中上一轮运行留下的图）→ 投影保留 `imageCount` → 发送后草稿清空。
测试用的 PNG 由脚本自己生成（`zlib.deflateSync` 拼一个真实 PNG）：pi 会拒绝解码不了的图，
手搓的 1x1 base64 会被换成「Image omitted」，看起来就像「画布没把图送出去」。

### 顺带修掉的三个真 bug（都是这次验证逼出来的）

- **流式结束不熄灯**：`is-streaming` 是流式补丁路径直接加到 DOM 的，但只在 `render()`
  里被移除；`canReplaceView()` 为 false（输入框有焦点、手势进行中、刷新被推迟）时 render
  被跳过，于是**状态已经干净、类还留在 DOM 上**，卡片永远呼吸。加 `markCardStreaming()`
  让添加与清除对称。
- **报错轮次不结算**（见上第 3 条）。
- **详情落点竞态**：锚点滚动原先放在 `requestAnimationFrame` 里，同一帧内后续的 render
  会先记录**滚动前**的位置、再把旧位置恢复回去并排在锚点滚动之后 —— 落点被劫持。实测
  偶发偏移 -5717px（应为 0）。改成同步、并固定「先恢复记忆位置、再应用锚点」的顺序；
  锚点应用后同步写回记忆，否则下一帧 render 又会用旧记忆覆盖它。
- `verify-canvas.mjs` 截图前自己建 `_e2e/`（清理该目录后它曾因写文件失败而判负）。

## 19. 进行中卡片的蓝色动效（2026-10-13，已完成）

会话正在回答时，该会话**最新一张卡片**边框呼吸式变蓝（`--info` `#1f6c9f`，暗色 `#93c1e6`），2.2s 一个周期；回复落盘即灭。

两个「进行中」的来源必须都点亮：

| 来源 | 时机 | 为什么必要 |
|---|---|---|
| `state.pendingReplies` | 画布自己发消息，**同步**置位 | 这时宿主的 SSE 流还没开，只靠 live-reply 会让卡片头几秒看起来没反应 |
| `state.liveReplies`（bridge 的 SSE） | 流式期间 | 宿主侧发起的回复（在 pi-web 里发的）只有这条路能知道 |

判定收敛在 `isThreadStreaming(threadId)`，并且**只点亮该线程的最新一张卡**（`conversationCard` 里比对 `state.canvasCards.at(-1)`）—— 之前的轮次早已回答完，整条链都亮是噪音。

关键坑：`applyLiveReplyToCard` 为了不闪不抖是**绕过 render() 直接改那一格 innerHTML** 的，所以流式开始时 `is-streaming` 类不会随 render 出现 —— 必须在那条路径里手动 `classList.toggle`，并把同线程更早卡片上的类摘掉（新的一轮开始，旧的「正在回答」就不成立了）。

动效只动 `box-shadow` 和 `border-color`，不动几何 —— 卡片有虚拟化、拖拽和连线锚点都依赖 left/top，任何会触发 layout 的动画都会和它们打架。`prefers-reduced-motion` 下动画关掉，但**蓝色边框保留**：状态提示不能因为减少动画就消失，那会让这个状态在无障碍模式下不可见。

验证 `scripts/verify-streaming-card.mjs` 用真实 prompt 全链路断言：类、边框颜色、动画名、结束熄灭，四项独立检查。它也踩了一遍「探测 thread 必须按 cwd 限定」的老坑（第一版命中了别的会话，测出假阴性）。

## 18. 画布 UI 重构：编辑部式极简（2026-10-13，已完成）

目标：把画布从「淡蓝 SaaS 面板」换成一套有主张的编辑排版系统，同时**不动任何 DOM 契约**。

### 不变的契约（重构的红线）

验证脚本全部依赖类名与 `data-*` 属性选元素，所以重构只改「长什么样」，不改「叫什么」：

| 必须保留 | 谁在用 |
|---|---|
| `.thread-card` / `.thread-answer` / `.context-ring` / `.context-ring-arc` / `.context-ring-track` / `.context-ring-tip` | `verify-btw` / `verify-ring-levels` |
| `.graph-fold-button` / `.btw-widget` / `.btw-widget-open` / `.btw-widget-badge` / `.btw-widget-title` | `verify-btw` / `verify-folding` |
| `.detail-view` / `.detail-badge` / `.detail-tools` / `.message-composer textarea` / `.message` / `.message-body` / `.message-role` | `verify-btw` / `verify-detail-rows` |
| `.new-workspace`、全部 `data-action="…"` | `verify-writes` / 事件委托 |

卡片几何常数（`CARD_WIDTH/HEIGHT`、连线锚点、`btwSlot`、虚拟化包围盒）也一并没有动 —— 换尺寸会连带改布局算法，那是另一件事。

### 设计令牌

两套主题共用一组变量，亮/暗并排写在同一文件里，便于逐对审查：

- **底色**：暖骨白 `#f7f6f3`（画布）＋ 纸白 `#ffffff`（卡面）。正文 `#2f3437`，绝不用纯黑。
- **结构**：发丝线 `#eaeaea`，分隔线 `#dcdbd6`。视觉层次靠线，不靠阴影。
- **语义淡彩**：`#e1f3fe`/`#1f6c9f`（信息）、`#edf3ec`/`#346538`（正常）、`#fbf3db`/`#956400`（警告）、`#fdebec`/`#9f2f2d`（失败）、`#f2eff9`/`#5a4a86`（侧问）。**颜色只承载语义**：失败、侧问、工具数、上下文压力，没有一处是装饰。
- **阴影**：`0 1px 2px rgba(17,17,17,.04)`（常态）→ `0 4px 14px rgba(17,17,17,.05)`（悬停）。实际接近不存在。

### 字体是本地随包的

画布可能跑在**没有外网**的机器上（它就是给本机 pi 会话用的），所以 Google Fonts CDN 不可用：

- 正文/UI：**Geist**（拉丁子集 29KB），中文回落到 `PingFang SC` / `Microsoft YaHei`。
- 展示面（品牌字、详情标题、空状态）：**Newsreader** 衬线（拉丁可变字重子集 58KB），中文回落到宋体族。
- 元数据（轮次、token、百分比、工具名、时间、ID）：等宽栈 `Geist Mono → Cascadia Mono`。

字体经 `/synapse/fonts/*.woff2` 由 `createAssetHandler` 发出。**这两个文件必须以 Buffer 读**，按 utf8 读会破坏字体表 —— 这是 `routes.js` 里加 `binary` 分支的原因。

字体是**故意**只做拉丁子集的：中文用系统字，一是体积（思源宋体一个压缩子集本身就接近百余 KB，且多个 unicode-range 文件），二是本项目面向本机开发机，macOS/Windows 两边的中文系统字质量足够。

### 布局层面的改动

| 位置 | 改动 | 理由 |
|---|---|---|
| 顶栏 | 左侧新增「工作区 / 当前目录」masthead 行，中间留给 `对话 / 会话地图` | 顶栏原本一半是空白；现在它回答「我在哪个工作区」 |
| 侧栏 | 会话行改为**索引**：序号 + 标题 + 分支/btw 标记；标题头带计数 | 侧栏是索引不是菜单 |
| 画布底 | 22px 点阵（`radial-gradient`，`rgba(17,17,17,.05)`） | 纯色底在拖动时看不出位移；点阵提供参照又不抢戏 |
| 连线 | `#dcdbd6`，被选中会话的高亮连线改**墨黑**（原来是蓝） | 蓝色不在新色板里 |
| 卡片 | 圆角 7px→10px，发丝边框，hover 才抬起；标题让出右上角 30px 给圆环 | 圆环是绝对定位在右上角，长标题会与之重叠（实测「请只回复两个字：好的。」压住了圆环） |
| 卡片 footer | 四个宿主写操作（改名 / pi-web 归档 / 详情 / pi-web）收成纯图标 + tooltip，只留「归档」带文字 | 五个带字按钮在 310px 卡片上换行成两行（实测截图） |
| 详情视图 | 转录改成**无卡片的文档行**，靠发丝线分隔；标题用衬线大字号，下加「N 条记录 · 最后更新时间」 | 嵌套卡片在窄栏里很吵；时间取**最后一条条目的时间戳**而不是 `Date.now()`，否则每次渲染都变 |
| 图标 | 自绘 16px 几何基元，统一 1.5 描边、圆接头 | 原图标来自多个图标集（含一个 2KB 的复杂路径），粗细不一 |
| 线程配色 | 按线程在列表中的位置取 `--info/--ok/--violet/--warn/--danger` 轮转，用于侧栏圆点、卡片标题点、被选中连线 | 原来全站写死同一个蓝 |

### 两个切换条的重复（已修）

画布顶栏本来就有自己的 `对话 / 地图` 切换（`.view-switch`），而 `bridge.js` 注入到 pi-web 的切换条（`.pi-synapse-switch`，`position:fixed` 居中）是**进入**画布的入口。地图打开后 overlay 盖住宿主页面，两个一模一样的切换控件就并排出现了 —— 因为一个是 fixed 居中、一个是顶栏栅格的中列，两者 x 不同（实测 685 vs 817），所以才看得出是「两个」。

第一版修法是「地图打开时隐藏宿主条」，但这依赖两份代码版本一致 —— 宿主页面若没刷新（bridge 是随 HTML 一次性发下去的），旧 bridge 不认 `hidden`，两个条又同时出现。最终方案改为**单一代码路径**：

- 画布内**不再渲染** `对话 / 会话地图` 切换（连同 `data-action="close"` 分支、`synapse:close` 消息一起删掉 —— 没有发送者的消息处理器也是死代码）。
- 宿主切换条是唯一入口，两个方向都由它管；画布内的 `地图 / 详情` tab 是另一条轴（画布内部视图），与它不冲突。

这也是**唯一**能同时满足「旧页面 / 新页面任意组合」的方案：只要 DOM 里只可能存在一份切换条，版本错开也不会复现。

### 与上游注入切换条的一致性

`bridge.js` 注入到 pi-web 里的 `对话 / 会话地图` 切换条是 `position:fixed`、**独立于画布 iframe** 的另一份样式，所以它得单独跟着改：同样的暖白/发丝线/`#111` 选中态、同样的 Geist 字体栈（此时页面里没有 `@font-face`，回落到系统 sans，这是可接受的降级）。`mark.svg` 也从「粗黑＋两个亮蓝圆点」换成墨黑主干＋紫/蓝两个淡彩分叉，与卡片配色同一套色。

### 验证

| 脚本 | 结果 |
|---|---|
| `npm test`（85 项单测） | ✅ 85/85 |
| `verify-canvas` | ✅ 无页面错误 |
| `verify-btw`（全链路 25 项） | ✅ 25/25 |
| `verify-folding` | ✅ 折叠 23→19 → 展开还原 23 |
| `verify-detail-rows` | ✅ 空行 0 |
| `verify-ring-levels` | ✅ 三档配色互不相同（绿 `#346538` / 琥珀 `#956400` / 红 `#9f2f2d`） |
| `verify-theme` | ✅ 亮/暗两套都随 pi-web 手动偏好切换 |
| `verify-card-header`（新增） | ✅ 标题与圆环间距 8px（原来标题的省略号会直接压在圆环上） |
| `verify-switch-bar`（新增） | ✅ 对话视图只有宿主切换条、地图视图只有画布内切换条 |
| `verify-streaming-card`（新增） | ✅ 提交后 2.5s 内亮起、回复落盘后立即熄灭（真实 prompt 全链路） |
| `verify-navigation`（新增） | ✅ 320 条的长会话，无锚点进入直接落在最后一条；点卡片不离开画布 |
| `verify-send` / `verify-streaming` / `verify-writes` | ✅ 发消息、流式递增、改名 + pi-web 归档均不受影响 |

顺带修了两处验证脚本的硬编码 BASE：`verify-ring-levels.mjs` 与 `verify-detail-rows.mjs` 原来写死 `30142`，与其它脚本的 `process.env.BASE ?? …` 不一致，换端口跑就会连不上。

新增 `scripts/drop-probe-workspace.mjs`：清理探测 cwd 在 `workspaces.json` 里留下的工作区（按 cwd 子串匹配，写前备份，其它工作区逐字不动）。


## 22. 静态检查：能力声明与实现脱节，两个端点 500（2026-10-14，已修）

本轮对全仓做 LSP 静态检查（`jsconfig.json` + `checkJs`），共 149 条发现。其中**两条是真
bug**，都靠 `curl` 实证：

| 端点 | 修前 | 根因 |
|---|---|---|
| `POST /synapse/api/sessions/open` | **500** `TypeError: this.adapter.openSession is not a function` | 守卫测的是能力，不是方法 |
| `POST /synapse/api/threads/:id/branch`（不带 sessionId） | **500** `TypeError: this.adapter.forkSession is not a function` | 同上（实测还有第三种：若只改成 `typeof === 'function'` 而不拒绝，会静默造出 `sessionId: null` 的僵尸节点 —— 既不能追问也不能打开，比 500 更糟） |

根因是**把两个不同的问题混成一个**。`capabilities()` 回答的是「**画布**能对宿主做什么」：
pi-web 的写入由浏览器发起（同源），所以能力为 `true`，而适配器上根本没有对应方法。
`bin/pi-synapse.js` 声明 `{openSession: true, forkSession: true, sendMessage: true, ...}`，
`createPiAdapter` 却只在传入同名函数时才把方法挂上去 —— 实测三者都是 `undefined`。

`contract.js` 里**本来就有正确的 helper**：`requireCapability()` 同时检查
`caps[name] === true` 与 `typeof adapter[name] === 'function'`。但 `synapse.js` 手工写的
守卫只测了前半个条件，而 `requireCapability` **定义了却从未被使用**（死代码，恰好是能防住
这个 bug 的那段）。现在三处都走它，并把它的消息改成 `routes.js` 认得的
「当前宿主不支持 …」前缀 —— 那个前缀会被映射成 **400**（调用方的问题，不是服务端故障），
而不是笼统的 500。

### 其余发现的分类

- **死代码**：`loadThreadHistory` 是空桩却被带参调用 6 次（`Expected 0 arguments, but got 1`），
  `historyBySession` / `historyRequests` 从未被填充；一并删除，并在原位留下「为什么不需要
  二次读会话」的说明。
- **契约与实现漂移**（静态检查正是靠这个变吵的）：`AdapterCapabilities` 被引用但从未定义；
  `SessionHistory` 缺 `contextWindow`/`model`；`HostSession` 缺 `blank`/`modified`/`size`/
  `mtimeMs`；`createProxy` 声明了它并不使用的 `port`；`acquireInstanceLock` 漏了
  `staleAfterMs`；`createPiAdapter` 漏了 `options.models`；`forkSession` 的签名漏了 `entryId`。
- **投影器没有契约类型**（`test/projection-pi.test.js` 27 条）：投影在一个数组里跑多种
  `kind`，TS 无法按 `kind` 收窄联合类型，于是每次读 `text`/`usageChars`/`callId` 都报
  「属性不存在」。补一个 `ProjectionEntry` typedef 后 27 条**全部消失且不新增错误**。
- **`app` 的声明类型**（`app.js` 13 条）：`document.querySelector('#app')` 推出 `Element`，
  于是所有 `addEventListener` 回退到通用 `Event` 重载，每个读 `clientX`/`pointerId`/
  `clipboardData` 的处理器都报错。一处注解修掉全部。
- **`El` 收窄**（`.focus()`/`.click()`/`.dataset`）：`querySelector` 返回 `Element`，没有
  这些成员；用 `htmlElement()` helper 与 `instanceof` 守卫替代强转。
- **闭包收窄**：`cycleMembers` 在循环里被重新赋值，TS 因此作废收窄；改成出栈时取一次
  局部快照（语义等价且更清楚），而不是加非空断言。

### 基线

`src/` + `bin/`：**0 问题**，用 `npm run check`（`tsc -p jsconfig.json`，devDependencies：
`typescript` + `@types/node`）。这个检查本身也校准过：往 `src/` 放一个只有语义错的文件，
它必须以退出码 1 报出「未声明的名字」与「字符串上调用不存在的方法」。

两个版本差异值得记住：**TypeScript 7 要显式 `types: ["node"]`**（不再自动包含 `@types/*`，
否则每个 `process` 都报缺类型），且 **TS 7 比语言服务器内置的 5.x 更严** —— 本轮 TS 7 报出
5 条 TS 5 看不见的错误，全是 `@param {object}` 太泛导致的取属性失败（`options.models`、
`estimateContextTokens` 的 `entries`），说明“类型写得太泛”和“没有类型”一样会把错误藏住。

`test/` 与 `scripts/` 剩余 79 条全是良性（`file:///` 绝对导入 playwright-core、
`frame.evaluate()` 里的浏览器全局、单元测试里刻意的不完整 `Response` 替身），
已按「探针代码」从 `include` 排除，理由写在 `jsconfig.json` 里。

## 23. 分支（「分支」按钮）曾完全不可用（2026-10-13，已修）


用户报「最新卡右侧没有分支选项，之前的卡点了报『请等待这张卡片的最终回答』」。实测三个
独立缺陷叠在一起，**都不是 pi 的限制**：pi 有 `fork_branch`（pi-web 的「在新对话中提问」
就用它），能按 `entryId` 精确截断历史。

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| 1 | 点击处理用 `Number.isInteger()` 校验 entry id | pi 的 id 是 8 位十六进制（`927f88e9`），`Number()` → `NaN`，**每一张卡都失败** | 改成按非空字符串判断 |
| 2 | 最新卡被 `childCount === 0 \|\| canContinue === true` 双重排除 | 最新卡恰好两个条件都成立 → 按钮消失 | 只要求「有回答」即可分支 |
| 3 | `atSeq` 只存进 draft、**从未被读取**，fork 走的是 `/api/sessions/:id/fork`（只能从 leaf） | 从旧一轮分叉实际得到的是「从最新分叉」 | 改用 `POST /api/agent/:id {type:'fork_branch', entryId}` |

### 还有一个更隐蔽的：分叉会复制父会话的历史

`inheritedEntryCount` 被**硬编码成 0**，而 pi 的 fork **确实复制**父分支（实测：分叉一个
13 轮的会话，子文件有 1310 条消息、13 个 user 轮次的 entry id 与父完全相同）。于是画布
把父会话整段历史重画成分支自己的轮次 —— 分支看起来就是父会话的复制品。

判据不能用时间戳：**复制的条目保留原时间戳**，全部早于子会话的 header，无法区分「复制来的」
与「自己新增的」。唯一可靠的判据是**与父文件的 entry id 前缀比对**（同 id、同顺序）。适配器
现在读父文件，数出共享前缀，返回**最后一个继承条目的 id**（不是数量：数量与 entry id
无法比较，`'927f88e9' < 34` 恒为 false）。

顺带修掉同一类错误：`app.js` 里 `candidate.sourceEntryId < seedLength` 也是「十六进制字符串
与数字比大小」，恒为 false，所以「分支挂在哪一轮下面」从来没生效过。

### 验证

`scripts/verify-branch.mjs`（10 项）：最新卡有分支按钮且**同时保留追问**、旧卡点击不报错、
草稿标题正确、子会话**只含自己的轮次**（未截断会是 4）、第一问是自己的问题、`seed` 边界
正确、父子挂载正确。

探测会话必须 **`set_thinking_level: off` 且换用会写正文的模型**：`trae/deepseek-v4.1-flash`
实测三次都只产出 `thinking` 块、正文为空（`stopReason: stop`）→ 投影只有 `usage` 条目 →
卡片没有回答 → 没有分支按钮。测试会误判成「功能坏了」，实际是探测模型的问题。

## 24. 探测工作区会永久堆积（2026-10-13，已修）

`_probe-cwd` 每跑一次验证就多留一个工作区（实测累积到 24 个 thread），而探测会话是**真实
会话**：pi 写进 sessions 目录、投影建出真实工作区、pi-web 记进 `projectOrder`。删掉 cwd
目录并不会清掉这些，于是 `workspaces.json` 一路涨到 **85MB**（16,791 条消息 / 31,768 个
process 项 / 29 个工作区），每次保存要写 78MB 临时文件 + rename + 备份。

`scripts/clean-probes.mjs` 一次清干净四类残留：画布工作区、会话目录、pi-web 的孤儿归档
标记 + `projectOrder` + revision、以及锁与 `.tmp`。**必须先停服务**：store 状态在内存里，
下一次变更会把整份文件重写回去。判定用「末段路径包含 `probe`/`_e2e`」而不是前缀 ——
前缀判据漏掉了 `_e2eranch-probe`。

## 25. 写盘失败会让进程静默消失（2026-10-13，已修）

`markDirty()` 里是 `void this.flush()`。磁盘满时 `save()` 抛错 → **未处理拒绝 → Node 直接
退出，不打印任何东西**，只在磁盘上留下一个 `.tmp`（实测两次：pid 35780 与 25620 的 `.tmp`
与锁文件都留着，进程无输出消失）。修法：`flush()` 挂 `.catch` 打印错误并继续服务 —— 内存
状态仍然有效，下次 flush 会重试。单测 `a failed save reports the error and does not kill the
process` 用替换后的 `save()` 抛 ENOSPC 来守这条。

### 排查这类「服务莫名死掉」的正确顺序

1. **先确认端口上是谁**：`netstat -ano | grep <port>` 拿 PID，再用
   `wmic process where "ProcessId=<pid>" get CommandLine` 看它是不是**父进程**。
   实测过一次两个 `bin/pi-synapse.js --port 30142` 同时在跑（38872 持锁并监听、46040 是它
   的子进程），只 kill 监听的那个会留下另一个继续写文件（坑 33/36）。
2. **再找残留证据**：`.instance` 锁、`workspaces.json.<pid>.tmp`、`before-drop` 备份。
   有 `.tmp` 就是**写到一半死的**，不是正常退出。
3. **不要靠重跑**：非确定性失败先测资源（磁盘余量、内存峰值、实例数），不要重复跑同一把尺。
   本轮实测磁盘 98% 满（余 6GB），但单独写 80MB 是成功的 —— 所以「磁盘满」不是直接原因。
4. **列实例要列全，不能只看监听端口的那个**：`wmic process where "name='node.exe'" get
   ProcessId,ParentProcessId,CommandLine`。本轮真正的元凶是**第三个实例**：`-p 30143 --data
   C:/Users/wjun/AppData/Local/Temp/synapse-branch-probe.json`，来自更早的调试，一直在写自己的
   78MB 副本。只 kill 30142 上的监听者永远看不到它，而它会持续抢磁盘与 CPU，表现为「服务时好时坏」。
   用监督进程（`spawn` 包一层，把 exit code / signal / 尾部输出落盘）跑完整套回归，退出计数为 0，
   才排除了「服务自己会死」。

---

## 26. 幽灵卡片：投影只增不删（2026-10-14，已修）

**症状**：造一个一次性会话 → 投影成卡片 → 删掉会话文件 → 等 30 秒，卡片仍在，`sessionId` 已失效。
点卡片上的「pi-web」会跳到一个不存在的会话。

**根因**：`WorkspaceStore.syncSessions(sessions, removedSessionIds)` 的删除分支从来没被执行过 ——
`Synapse.syncSessions()` 只传了第一个参数，`/synapse/api/sessions/sync` 在画布里没有任何调用方（死端点），
而 adapter 的 `scan()` 只上报「新增/变更」，删除是文件监视器报不出来的事件（文件已经没了）。
投影因此只增不减：卡片永久残留、`hiddenSessionIds` 无限增长、数据文件只涨不缩（实测已到 90MB）。

**修法**：`Synapse` 自己跑一个对账定时器（默认 5 秒），用宿主权威的 `adapter.listSessions()` 与自己
「相信存在的会话集」比对。三条保守规则（这是承重设计，改动前先读）：

1. **连续两次扫描都缺失才删**。单次缺失的另一种解释是「这一次读不到」（目录项正在被重写、
   文件被锁），而后者的代价不对称：卡片位置按 thread id 存，删掉重建就是新 id、用户手动摆的
   位置和折叠状态全部丢失。
2. **活会话集为空、而画布上还有会话 → 整轮跳过**（连「缺失计数」都不加）。那是目录读失败，
   不是「用户把宿主里的会话全删了」。宁可留着幽灵，也不能清空画布。
3. **pi-web 的归档 ≠ 删除**。归档只写 pi-web 的 ui-state，会话文件仍在磁盘上，所以它仍然出现在
   `listSessions()` 里 —— 这正是「归档≠删除」的承重墙，单测与 verify 脚本都固定了它。
   `hiddenSessionIds` 只剪「本轮确认删除的 id」，不剪「本轮没看见的 id」，否则一次临时读失败就会
   抹掉用户的归档意图。

`sessionFile` 为空的 thread（画布刚建、还没投影过）不受影响：判据是 `thread.sessionId` 与
`removedSessionIds` 的交集，画布自建 thread 的 `sessionId` 是 `null`。

**顺带修掉的性能坑**：`readHeader()` 原本是 `readFile()` 全文读再取首行，而 `listSessions()` 要对每个
会话调用它。本机 sessions 目录 **179 个会话 / 561MB**，按 5 秒一轮就是每轮半 GB。改为**有界首块读取**
（16KB 起，仅在首行超长时翻倍）并把「mtime+size → header」缓存成 `scan()` 与 `listSessions()` 共用的
一张表，未变更的文件不再重读。

**验证**：`test/workspace-store.test.js` 5 条（删除移除卡片/仍存在的保留/空掉的工作区消失/
归档标记剪枝/仍存活时不剪）+ `test/session-reconcile.test.js` 4 条（两次缺失才删、活集为空不清空、
归档≠删除、数据文件里遗留的 thread 也会被对账）+ `scripts/verify-session-removal.mjs` 12/12
（A 段：临时宿主目录 + 真实 adapter + 定时器；B 段：对运行中的服务造真实一次性会话，删文件后
卡片由服务自己的定时器移除，且没有误删其他会话）。

**测试基建的一处副产物**：`Synapse.stop()` 改为返回 store 的 flush promise。原先 `void this.store.flush()`
与测试的临时目录 `rm` 竞态，写入落在 `rm` 中间 → `ENOTEMPTY`（store 的投影写是 800ms 延迟合并的）。

---

## 27. `verify-context` 的「pi 侧」漏了图片计费（2026-10-14，已修）

`scripts/verify-context.mjs` 自带一份 pi 算法的复刻（`piEstimate`/`rawMessageTokens`）做对照。它只在
`block.type === 'text' | 'thinking' | 'toolCall' | content` 上累加字符，**没有图片块**，而 pi 的
`estimateTokens` 对 `user` / `custom` / `toolResult` 角色里的 image 块收固定
`ESTIMATED_IMAGE_CHARS = 4800`（已在 `@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`
核对）。于是画布（按 pi 的规则计费）反而被当成错的：

| 会话 | mine | pi（脚本） | Δ | 解释 |
|---|---|---|---|---|
| `--B--deeptutor--/2026-08-31T07-32-26…` | 132961 | 131759 | 1202 | 锚点后 1 个带图的 `toolResult` → 4800 字符 = 1200 token |
| `--B--vibe_program-pi-synapse--/2026-10-13T14-05-48…` | 284700 | 264284 | 20416 | 锚点被 `context_edit` 作废走回退分支，全分支 17 张图 → 17×1200 = 20400 |

两个 Δ 都被图片计费解释到个位数，所以是**对照物**错，不是画布错。修法：`rawMessageTokens` 按 pi 的角色
白名单补上 4800/图的计费。修后 `verify-context` 169 个会话 0 超出容差（退出码 0）。

教训：**对照实现漏了后来新增的特性时，会把正确的一方报成错误的一方。** 看到「新的不一致」先核对
两侧的规则版本，别先改被测代码。

---

## 28. 一条命令跑全套回归（M4-3，2026-10-14）

`npm run verify` = `scripts/verify-all.mjs`：按前置条件检查上游 pi-web → 用**隔离的临时数据文件**与一次性
`PROBE_CWD` 起 `bin/pi-synapse.js start` → 顺序跑 19 个套件（每个都带 `BASE`/`PROBE_CWD`/`CHROME_PATH`）→
停服务 → `clean-probes.mjs --data <临时文件>` → 打一张表。每个套件的完整输出写到 `<run>/logs/`，**成功才删
run 目录，失败保留并打印路径**。它不启停 pi-web（杀掉用户自己启的比明确报错更糟），也不碰用户真实的
`workspaces.json`。CI（`.github/workflows/ci.yml`）只跑 `npm run check` + `npm test`。仓库已建：`wjunhere/pi-synapse`
（私有，main 跟踪 origin/main），首推即跑通（~15s）。

### 它第一次跑就抓出两个真问题

1. **`PROBE_CWD` 被上一个套件删掉了。** `verify-branch` 与 `verify-session-removal` 结束时删掉自己的探测
   cwd，下一个套件调 `POST /api/agent/new` 就得到 `400 Directory does not exist`，测试报「一次性会话:
   null / 创建失败」——看上去像代理坏了。修法：harness 在**每个套件前**重建 `PROBE_CWD`。这正是「手工一个个跑」
   不会暴露、而串行跑才会暴露的问题。
2. **投影的变更水位线被对账偷走了（严重）。** 为了不让 5 秒一轮的对账重读 561MB，我把 header 缓存与
   watcher 的 `known` 表合成了一张。后果：`listSessions()` 会把刚变过的文件提前记成「已看过」，下一次
   `scan()` 判定无变化 → **那次追加永远不会被投影**。实测现象：卡片一直卡在「正在回复」（最终 assistant
   条目从未到位）、3 轮探测只挂 2 张卡。修法：`known`（只归 watcher）与 `headers`（只归 listSessions）分开
   （见 AGENTS.md 坑 41）。

### 一个被顺便修正的测试前提

`verify-single-instance` 的「无僵尸写入者」原本是「启动后 6 秒内文件字节不变」。holder 在**收敛期本来就该写**
（store 把投影写合并成一次尾部 flush；在它下面变化的会话会被重新投影），所以这条检查在忙的机器上会把合法写入
报成僵尸。实测对照：单独起一个实例后连续采样 25 秒，大小从 t=1 起就是恒定的 83.5MB —— 说明对账**没有**周期性
写盘（这是它必须满足的性质）。检查已改为**收敛**语义：每秒采样，连续 3 次相同即通过，20 秒内不收敛才失败 ——
失控的写入者永不收敛，而收敛的写入者几秒内就停。

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
