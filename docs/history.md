# 历史档案：里程碑实测记录

> M0–M5 每一轮的实测结论、被否掉的方案与当时的未决问题。**这是档案，不是现状** ——
> 现状在每个主题文档里；这里留着是为了回答「当初为什么这么定 / 为什么没选另一个方案」。

相关：[architecture.md](architecture.md)（这些结论最终落成的结构）、[../AGENTS.md](../AGENTS.md)

> **改名说明（2026-10-18）**：包与 CLI 由 `pi-synapse` 改名为 `session-synapse`（命令行为 `synapse`）。
> 本文是档案，正文里的旧名一律指同一物，不改写。

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

## 13. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0 验证**（✅ 已完成） | 实测 R2–R5 + 反代注入；关闭 U1/U2/U3/U4/U7 | 见 §8 |
| **M1 打通**（✅ 已完成） | 搬 store + canvas，写 pi-web adapter + pi projector，**方案 B 反代 + 注入**，能看画布、能跳会话 | 打开 `http://127.0.0.1:30142` 看到本机 30 个会话目录映射成的工作区，卡片内容与 pi-web 原生对话一致 |
| **M2 补全**（✅ 已完成） | fork 连线、分支折叠、compaction/branch_summary 分隔卡、主题同步、流式「边写边显」 | 见 §10 |
| **M3 体验**（✅ 已完成） | 画布内发消息、改名、pi-web 归档、能力门控 | 见 §11 |
| **M4 收敛**（2 天） | `app.js` 拆分重构、DSH adapter 回归验证抽象、CI + 发布 npm | `pi install` 一条命令可用 |
| **M5 增强**（✅ 已完成） | 卡片上下文占用圆环、`/btw` 侧问（fork + 只读工具 + 自动归档 + 折叠挂件）；顺带修掉工具折叠不幂等与单实例两个严重 bug | 见 [context-usage.md](context-usage.md) §15 / [host-integration.md](host-integration.md) §15.4–15.7 / [projection.md](projection.md) §16 / [runtime.md](runtime.md) §17；`verify-context` 全会话一致，`verify-btw` 25/25，`verify-single-instance` 11/11 |

M4 进度（4 项拆开看）：

| 项 | 状态 |
|---|---|
| `npm run verify` 一条命令 + CI | ✅ 已完成（[verification.md](verification.md) §28；CI 只跑 check + test，已在 `wjunhere/pi-synapse` 上跑通） |
| `app.js` 拆分重构 | 🟡 第一刀完成（[architecture.md](architecture.md) §29：7 个叶子模块 445 行已搬出，2334 → ~1900 行，回归绿）；渲染/交互/动作三层未搬 |
| DSH adapter / 契约测试 | ⬜ 等用户拍板（两条路：真写 dsh-synapse adapter，或改成跑同一批 store 单测的最小契约测试） |
| 发布 npm | ✅ 已发布 `@wjunhere/pi-synapse@0.1.0`（2026-10-14，public；裸名 `pi-synapse` 在 registry 上是 Unpublished 状态，故改用作用域包） |

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

