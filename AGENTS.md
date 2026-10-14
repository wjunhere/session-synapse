# pi-synapse 开发须知

面向 agent 的项目开发要点。设计决策与实测记录见 `docs/design.md`。

## 项目结构

```
src/
  store/workspace-store.js   画布元数据存储 + 版本迁移（宿主无关）
  project/pi.js              pi JSONL → 规范化投影条目
  project/context-usage.js   上下文占用的估算（复刻 pi 的 getContextUsage）
  models/registry.js         provider/model → contextWindow（读 pi 的模型配置）
  adapters/contract.js       adapter 契约与能力声明
  adapters/pi.js             读 pi 会话文件、watch 变化
  synapse.js                 投影引擎：adapter → store
  server/routes.js           /synapse/api/* 与静态资源
  server/guard.js            Host 白名单、JSON body 解析
  server/proxy.js            同源反代 + HTML 注入
  canvas/app.js              画布 UI 主文件（渲染 / 交互 / 动作，仍在继续往下拆）
  canvas/state.js            画布状态对象 + 写回 localStorage 的几个 helper
  canvas/storage.js          localStorage 读写与取值校验（键、默认值、废弃键清理）
  canvas/host.js             与宿主的全部对话（Synapse 的 /synapse/api 与 pi-web 的 /api）
  canvas/format.js           文本/时间/token 格式化 + 上下文圆环
  canvas/markdown.js         卡片用的 markdown 子集（含渲染缓存）
  canvas/icons.js            图标集
  canvas/images.js           图片附件管线（读取 + 大图压缩 + prompt payload）
  canvas/bridge.js           注入 pi-web 的切换条与消息桥
bin/pi-synapse.js            CLI
```

三层单向依赖：**canvas/store ← synapse ← adapter**。core 不出现任何宿主专有名词。

## 必须知道的坑

1. **`session` header 有 `id` 但没有 `parentId` 键。** 用 `e.parentId ?? null` 统一处理会把它算成第二个 root，导致每个会话都被误判有多个根。必须按 `type !== 'session'` 排除。
2. **pi 没有 turn/step 编号。** 一轮 = 两个 user 消息之间的所有条目，其中助手条目可能有多个（每个工具回合一个），且常常没有正文。工具调用按「最近一条 assistant/error 消息」折叠，未到达时先进 `pendingProcess`。
3. **工具结果靠 `parentId` 定位回合。** 一个 `toolResult` 条目的 `parentId` 就是发起调用的那个 assistant 条目。
4. **`/api/sessions/:id/context` 是窗口化的**（2882 条消息只返回 101 条，`hasMore: true`）。画布重建必须直读 JSONL，不能用它。
5. **pi-web 拒绝跨源 `/api/*`**：`Origin` 必须等于请求自身的 `Host`。反代必须**剥离 `Origin` 头**并统一 `Host`。
6. **反代必须处理 gzip。** 浏览器发 `Accept-Encoding: gzip`，pi-web 会返回压缩的 HTML；直接注入会损坏页面。代理对 HTML 请求统一 `accept-encoding: identity`，并对其他编码做解压兜底。
7. **`pi-web:tab-open-session` 是 sessionStorage，不是外部接口。** 它只在 URL 没有 `?session=` 时作回退，且不跨标签页。切会话只能整页导航（`?session=`）。
8. **pi-web 的 z-index 到 220**（侧边栏 200、拖拽把手 220）。注入的覆盖层用 300，切换条用 400。
9. **注入脚本在 `<head>` 里执行**，此时 `document.body` 可能还不存在。脚本用 `defer`，并对 body 缺失做兜底。
10. **`STATE_VERSION` 不能复用 1。** 旧格式 v1 是 `workspaces[].events`（无 `threads`），复用会每次重启都重新迁移自己的输出，工作区翻倍。当前是 5。
11. **`fs.watch` 事件数不可信。** Windows 上 100 次写入产生过 101 个事件。只能当作「有变化」的信号，真相靠重读 + mtime/size diff，并配低频轮询兜底。
12. **SSE 的 `message_update` 不含 `partial`**（服务端已剥离）。文本靠 `text_delta` 增量拼，`text_end` 是权威内容；`*_end` 永不被丢弃。因此流式长度会**先增后小幅回退**（`text_end` 用权威内容替换累积值），这是设计意图，不是 bug。
13. **pi 的 fork 不复制历史。** 子会话只含自己的条目，header 的 `parentSession` 指向父文件。因此 `inheritedEntryCount` 恒为 0，父子连线靠 `parentSessionFile` 与 `sessionFile` 配对。
14. **pi-web 的主题是 `pi-theme` 三态偏好**（auto/light/dark），解析结果在 `documentElement.dataset.theme` + `dark` class。**必须读这个，不能用 `prefers-color-scheme`**，否则忽略用户手动选择。用 `MutationObserver` 监听变化。
15. **画布用 CSS transform 缩放，卡片可能在视口外且永远不可点击。** 验证交互时直接派发事件（`dispatchEvent(new MouseEvent('click', {bubbles:true}))`），且必须锁定同一个 `data-card` —— 重渲染后 `.first()` 会指向另一张卡。
16. **写操作必须在浏览器里发起。** 改名/归档直接调 pi-web 的 API，**不能**放到服务端：Node 的 `fetch` 要求绝对 URL（相对路径报 `Failed to parse URL`），且 pi-web 要求 `Origin` 等于自身 `Host`，服务端请求没有页面 origin，补绝对 URL 也会 403。服务端只通过 `/synapse/api/status` **声明能力**。
17. **pi-web 的归档两个方向都是 `action: "set"`**（`archived: true/false`）。`action: "restore"` 是回放精确 prior-values 快照，用于 undo，不是「取消归档」。归档键是会话**族**的根，独立会话的根是它自己。
18. **会话名从列表 API 读**（`/api/sessions` 的 `name` 字段）。`/api/sessions/:id` 的 `info.name` **不是**名字载体，但改名确实会写入会话文件的 `session_info` 条目。
19. **画布数据文件会累积历史探测的 thread。** 按 `.first()` 选按钮会点到旧探测会话上，得出「功能没生效」的错误结论。验证时必须先把 `sessionId` 映射成 `threadId`，再按 `data-thread` 精确点击。
20. **画布无法应答扩展 UI 对话框**（`extension_ui_request`，如 remote-pi 的「Agent name:」）。依赖这类对话框的会话在画布上发消息后可能没有正文回复，需回 pi-web 原生界面处理。
21. **本机默认模型 `qoder-cn/dfmodel` 不可用**（返回 `stopReason: "error"` 且内容为空）。测流式前先 `set_model` 换到 `trae/deepseek-v4.1-flash`，否则会误判成「流式坏了」。
22. **上下文占用必须从文件算，不能用 pi-web 的 `contextUsage`。** `/api/agent/:id` 只对**已在内存中**的会话返回该字段（其余 600s idle 后被驱逐）。画布要覆盖**所有**会话，所以复刻 pi 的 `getContextUsage`：以最近一条**带 usage 的条目**为锚点，加上之后新增内容的字符估算，再除以模型上下文窗口。细节与实测见 `docs/design.md` §15。
23. **`usage` 锚点会被「只思考/只调工具」的轮次带走。** 这类 assistant 条目没有 `text`，只有 `thinking`/`toolCall`；若因「没正文」就丢掉它，估算会退回纯字符数（实测差 30k+ tokens）。projector 为此产出 `kind:'usage'` 条目。
24. **`usageChars` 一个字段汇总 pi 会数、画布不显示的部分**（thinking 的长度 + toolCall 参数的 `JSON.stringify` 长度）。拆成多个字段会在「一个 entry 产出多个投影项」时被重复计数。**`arguments`（缩进美化版）不能用来估 token，会高估。**
25. **投影是「合并」不是「重建」。** 同一 thread 反复投影只往 `messages` 追加，删条目不会自动消失。只用于计算、不应持久化的 kind（如 `usage`）必须在 `normalizeState` 里清理（`dropTransientMessages`），否则永久留成空行。
26. **`custom` 条目不能一概忽略。** `customType === 'pi-web:tool-selection'` 是 pi-web 固定在会话里的工具集（btw 靠它），`cleared: true` 表示撤销固定。其余 `custom` 才是纯扩展状态。
27. **`set_tools` 是会话级、写进会话文件**（`custom` 条目），不是每轮设置。btw 的顺序必须是 **fork → set_tools → prompt**：fork 前会话不存在，set_tools 无处可写；prompt 前必须设好，否则第一轮用父会话的完整工具集。
28. **pi-web 的 fork 只能从当前 leaf 分叉**（body 是 `{}`，不接受 entryId）。所以 btw 与「创建分支」底层同一个调用，价值在**只读工具 + 自动归档 + 折叠挂件**三条，不在「继承上下文」。
29. **btw 的归档是「可逆的干净」，不是「隐藏」。** 会话移出 pi-web 主列表，但**归档视图里完整可见、可继续** —— 这正是路线 2 的承诺。归档失败不能算失败（挂件照样能用）。
30. **btw 的三个写调用全在浏览器侧**（同坑 16）。服务端只多一个 `/synapse/api/threads/:id/link`，用于登记浏览器建好的 thread，免得等 4s 重扫才出现。
31. **btw thread 不进 `conversationCards`。** 它渲染成父卡片下方的挂件（`btwWidget`，位置由 `btwSlot` 现算，不进图布局），因为它不是主链上的一轮。提交后**不要**切到详情视图，否则刚建出的挂件立刻被藏起来。
32. **工具折叠必须幂等**（曾导致 545MB 数据文件）。`foldToolProcess` 曾经只在「最近一条 assistant 消息」里找 callId，但**投影是合并的、每次重扫都重新折叠每条 entry** —— 重扫时最近那条消息已经不是当初发起调用的那条，于是每扫一遗追加一份副本。实测重复率 86.9%、单 call 最多重复 104 次。修法：查已存 callId 时**扫描整个 thread**（消息的 `process` + `pendingProcess`）。探测手法：按 callId 去重，对比源文件 `toolCall` 条数。
33. **测写盘 bug 前先确认只有一个实例在跑。** 验证脚本反复「重启服务」时，若只 kill 当前监听的 PID，先前启动但绑定失败的实例仍会留在后台同时写同一个文件。用 `wmic process where "name='node.exe'" get ProcessId,CommandLine | grep -i pi-synapse` 清干净。
34. **`context_edit` 与 compaction 一样会使锚点失效。** 它是“从上下文里移除一个块”（实测 312 条全是 `replacement: null`），会使上下文变小。
35. **失去锚点后的估算是「从最后一次 compaction 起」而非全量。** compaction 会用摘要**替换**它之前的历史；若把整份 transcript 加起来，曾把一个 pi 认为 0.3% 的会话报成 94.6%，会让用户误以为上下文快爆了。
36. **单实例锁键在「数据文件」上，不是端口也不是进程。** 最危险的重复实例恰好是「端口绑定失败但进程不退出」——它从未服务过任何请求，却会一直跑投影定时器重写文件（实测就是这样涨到 545MB 的）。只查端口会正好漏掉它。锁文件是 `<data>.instance`，用 `wx` 原子创建。
37. **Windows 上 `child.kill('SIGINT')` 会直接杀死进程，不跑任何 JS handler**（实测：`SIGINT` 和 `exit` 监听器都不触发，`signalCode` 直接是 `SIGINT`）。所以被杀实例**必然**留下锁文件，`--force` 不应是常规路径——**重接管陈旧锁才是主路径**，`holderIsAlive` 的逻辑必须对。
38. **Windows 会回收 PID**，所以「该 PID 存在」不等于「持有者还活着」。回收的 PID 会让死实例看起来活着、把用户永久锁在外面。用 `commandLineLooksLikeOurs()`（wmic / `/proc`/ `ps`）做第二判据；读不到命令行时**不能当作已死**（那会让第二个实例抢走活锁、损坏数据），改由 `staleAfterMs` 兼底。
39. **启动顺序：先抢锁 → 再绑端口 → 最后投影。** 锁必须在任何写盘之前拿到（WorkspaceStore 首次运行就会建文件，迁移也会写）；端口必须在投影之前绑（端口冲突是这个进程最常见的失败，应在此刻干净退出）。
40. **投影只增不减，删除要靠对账。** `scan()` 报得出「新增/变更」，报不出「删除」（文件已经没了），所以 `Synapse` 自己跑定时对账：`adapter.listSessions()` 为权威，**连续两次缺失才删**，活集为空而画布有卡则整轮跳过（那是读失败，不是用户删光了）。`hiddenSessionIds` 只剪本轮确认删除的 id。pi-web 的**归档≠删除**（文件还在 → 仍会出现在 listSessions 里），这条是承重墙，见 `docs/design.md` §26。
41. **变更水位线只能由 `scan()` 推进，不能被 `listSessions()` 碰。** 两者曾共用一张 `known` 表（顺手当 header 缓存），结果对账每 5 秒调一次 `listSessions()`，会把刚变过的文件提前记成「已看过」→ 下一轮 `scan()` 判定无变化 → **那次追加永远不会被投影**。实测表现：卡片一直「正在回复」（最终 assistant 条目丢失）、3 轮探测只有 2 张卡。现在 `known`（path → signature，只归 watcher）与 `headers`（path → {signature, header}，只归 listSessions）是两张表。

## 静态检查

```bash
npm run check                             # tsc -p jsconfig.json，交付代码基线 0
```

- **本仓库的 LSP 曾经只报语法错**：没有 `jsconfig/tsconfig` 时 `checkJs` 关闭，一个拼错的标识符或不存在的方法都会显示 OK。`jsconfig.json` 已开，`include` 只含交付代码（`src` + `bin`），基线 **0 问题** —— 基线为 0 才有意义，否则真错误会被噪音淹。
- **改了先校准再信**：往 `src/` 放一个只有语义错的文件（未声明的名字、字符串上调用不存在的方法），`npm run check` 必须以退出码 1 报出这两条，再去读那串 “OK”。
- **TypeScript 7 要显式 `types: ["node"]`**（不再自动包含 `@types/*`），所以 `typescript` + `@types/node` 是 devDependency。
- **`test/` 与 `scripts/` 故意不在 `include` 里**：它们是开发用探测代码，多处 `frame.evaluate()` 里用浏览器全局、还用 `file:///` 绝对 URL 导入 playwright-core，合起来约 79 条诊断（全是良性），会把真问题埋掉。要审它们就临时放宽 `include`。
- **语言服务器（tsserver，内置 TS 5.x）比本地 `tsc`（7.x）宽松**：本轮 TS 7 报出 5 条 TS 5 看不见的错误（`@param {object}` 太泛导致的取属性失败）。以 `npm run check` 为准。
- **LSP 会缓存改动前的版本** —— 改完 typedef 后必须 `lsp reload` 再测，否则会看到已经不存在的错误。

## 测试

```bash
npm test                                  # 107 个单测（投影 28 + 上下文 17 + 存储 33 + 实例锁 10 + pi-web 动作 15 + 会话对账 4）
npm run verify                            # 全套回归：起服务 → 20 个套件 → 清理 → 汇总表（需要 pi-web 在 30100）
npm run verify -- --skip-browser           # 只跑非浏览器套件
node scripts/e2e-real-data.mjs            # 真实数据投影，报告卡片/工具统计
node scripts/verify-context.mjs           # 上下文占用 vs pi 自身算法（逐会话，容差 64 token）
node scripts/verify-single-instance.mjs   # 单实例锁：同端口/换端口都拒绝、陈旧锁自动接管
node scripts/verify-canvas.mjs            # 画布渲染（需先启动服务）
node scripts/verify-folding.mjs           # 分支折叠
node scripts/verify-theme.mjs             # 主题同步（含手动覆盖）
node scripts/verify-btw.mjs               # 侧问全链路 25 项（需传 PROBE_CWD）
node scripts/verify-detail-rows.mjs       # 详情视图无空行
node scripts/verify-ring-levels.mjs       # 圆环 ok/warn/danger 三档配色
node scripts/verify-card-header.mjs       # 卡片标题与圆环的间距（防标题压住圆环）
node scripts/verify-switch-bar.mjs        # 视图切换入口只有一个可见（防出现两个切换条）
node scripts/verify-streaming-card.mjs    # 进行中的卡片有蓝色动效（需传 PROBE_CWD）
node scripts/verify-navigation.mjs        # 点卡片进详情（不跳 pi-web）+ 无锚点落在最新消息
node scripts/verify-session-removal.mjs   # 会话删除后的对账（A 段可独立跑；B 段需服务 + PROBE_CWD）
node scripts/verify-visibility.mjs        # 地图显示规则：7 天默认 + 侧栏眼睛按钮（需服务 + PROBE_CWD）
node scripts/verify-image-paste.mjs       # 卡片内粘贴图片（需传 PROBE_CWD）
node scripts/verify-streaming.mjs         # 流式「边写边显」（需传 PROBE_CWD）
node scripts/verify-send.mjs              # 画布内发消息（需传 PROBE_CWD）
node scripts/verify-writes.mjs            # 改名 + pi-web 归档 + 能力门控（需传 PROBE_CWD）
node scripts/verify-branch.mjs             # 分支：最新卡有入口、旧卡不报错、历史按轮截断（需传 PROBE_CWD）
node scripts/drop-probe-workspace.mjs     # 清掉探测 cwd 在 workspaces.json 里留下的工作区
node scripts/clean-probes.mjs             # 清掉探测留下的一切（工作区/会话目录/pi-web 状态/锁）——必须先停服务
```

验证脚本统一读 `BASE` 环境变量（默认 `http://127.0.0.1:30143`），换端口跑时不要再改脚本。

`npm run verify`（`scripts/verify-all.mjs`）是首选入口：它用**隔离的临时数据文件**起服务、在一次性 cwd 里造探测会话、跑完调 `clean-probes.mjs`，失败时保留 run 目录（含每个套件的日志）。它**不启停 pi-web**（杀掉用户自己启的比报错更糟），也**不碰**你真实的画布数据。

单独跑脚本仍可以，但注意两件事：① `verify-branch` 与 `verify-session-removal` 结束时**会删掉 `PROBE_CWD`**，所以串行跑多个脚本前必须先 `mkdir -p` 回来（harness 在每个套件前重建它；少了这步的表现是 `POST /api/agent/new` 报 `Directory does not exist`，看起来像代理坏了）；② `clean-probes.mjs` 支持 `--data <path>`，把「画布工作区」那半指向隔离文件，会话目录与 pi-web 状态照旧清真实的。

调试截图（`pi-synapse-verify-canvas.png` / `-btw.png` / `-navigation.png` / `-streaming-card.png`）与 `e2e-real-data` 的画布数据都写在**系统临时目录**，跑完不再在仓库根目录积尘（以前它们落在 `_nav.png` / `_btw/` / `_e2e/`，还会因为路径写死 `B:/vibe_program/…` 而在别的机器上直接失败）。

### 导航约定（改动前先读）

- **点卡片本体 = 进详情视图**（定位到那一轮），**不跳 pi-web**。pi-web 入口是卡片 footer 的「pi-web」按钮和详情头部的「在 pi-web 中打开」，两者都是显式动作。`openSessionInHost` 是整页跳转，只能由这两个入口触发。
- **无锚点进详情 = 落在最新一条消息**（btw 挂件 / 顶部「详情」tab 都没有锚点）。`render()` 里的 `detailScrollByThread` 记忆**只在无锚点时生效**，显式进入必须定位到目标，否则会被上次访问的旧偏移劫持。
- **卡片 ID 尾部是十六进制串**（`77e0044c`），不是数字。锚点正则是 `/:turn:([^:]+)$/`；写成 `(\d+)` 会让每一张卡都匹配失败并静默落到最新（已实际发生，且旧测试只断言「详情打开了」所以没拦住）。`:turn:empty` 是空线程占位卡，按无锚点处理。
- **侧栏行跟随当前视图**：地图上 = 选中 + 平移聚焦该会话的卡片；转写里 = 切到该会话并落在最新一轮。不要让它固定跳某个视图 —— 上一版改成固定进详情，直接让「在画布上定位某条会话」失去入口。
- **详情视图里不要对 `<button>` 用 ellipsis 依赖 `width:auto`**：按钮的 `auto` 宽度是 shrink-to-fit，不会撑满容器。要裁剪必须显式 `display: block`（或给确定宽度）+ 父级 flex 上下文。
- **结构性 `display` 必须写在各自的选择器里，禁止用 `.a, .b, .c { display: flex }` 这种共享列表**：删一个类时整行被删，其余组件静默失去布局（标题曾因此涨到 1126px）。
- 卡片检查器（card-inspector）已删除：点卡片直接进详情后它就没有入口了，相关 state/CSS 一并清掉，别再引用。

### 分支与 fork（改动前先读）

- **pi 的 fork 复制父会话历史**（同 entry id、同顺序），所以「子会话只含自己的轮次」必须靠 `inheritedEntryCount` 截断。它被硬编码成 0 过，后果是父会话整段历史被重画成分支自己的轮次（实测 13 轮全部重复）。
- **判据只能是与父文件的 entry id 前缀比对**：复制的条目保留**原时间戳**，全部早于子会话 header，时间戳无法区分「复制来的」与「新增的」。
- **`inheritedEntryCount` 传的是「最后一个继承条目的 id」，不是数量**。数量与 entry id 无法比较（id 是 8 位十六进制，`'927f88e9' < 34` 恒为 false），历史上有两处因此静默失效：`app.js` 的分支挂载点、以及点击处理里的 `Number.isInteger(entryId)` 校验（导致每一张卡的分支按钮都报「请等待最终回答」）。
- **从指定一轮分叉走 `POST /api/agent/:id {type:'fork_branch', entryId}`**（pi-web 的「在新对话中提问」用它）；`POST /api/sessions/:id/fork`（body `{}`）只能从当前 leaf 分叉，表达不了「从第 N 轮分叉」。
- **分支按钮的显示条件只要求「有回答」**。曾被 `childCount === 0 || canContinue === true` 双重排除，恰好把最新卡（两个条件都成立）的入口删掉了。

### 图片附件（改动前先读）

- 图片走宿主自己的 `prompt` 通道：`images:[{type:'image',data:<base64 无前缀>,mimeType}]`，上限 **10 张 / 单张 10MB**，>1MB 且非 gif 先在客户端压到最长边 1024（照抄 pi-web，别自己定策略）。
- **`[图片]` 标记不许写进 `message.text`**：`settlePendingReply` 用文本精确相等判断回复是否到达，混进标记会让带图消息永远匹配不上（卡片一直「正在回复」）。投影存 `imageCount`，显示层用 `displayText()` 拼标记。
- **pi 对每张图收固定 4800 字符（1200 token）**，只对 user / custom / toolResult 收。user 折进 `usageChars`；toolResult 折进 `process[].imageChars`（锚点分支单独加），否则圆环少报。
- **空文本消息要留住**：投影的 `note()` 和存储的 `noteProjection()` 都曾因「文本为空」丢掉只有图片的消息（那一轮会从画布上消失）。标题回落 `[图片]`。
- 报错结束的一轮也算答复：`settlePendingReply` 必须认 `error` 条目，否则 `pendingReplies` 永远不结算。
- 流式状态的类（`is-streaming`）添加与清除必须**对称**：它是 DOM 补丁路径加的，只在 render 里删会在 `canReplaceView()` 为 false 时漏掉。

### 探测纪律

- **不要对真实会话发消息或空消息** —— pi 会当成有效 prompt 启动真实 agent run 并写入会话文件。
- 需要测 prompt 通道时，先用 `POST /api/agent/new {"type":"ensure_session"}` 造一次性 cwd 的会话，用完删掉整个 cwd 目录。
- 一次性会话的 cwd 会污染 pi-web 的 `~/.pi/agent/pi-web-session-state.json`（`projectOrder`），必须一并清理。
- 涉及写盘的探测，先记录基线（行数 + 末行 id + 悬空引用数 + ui-state revision），结束后逐项比对。
- **pi-web 的 `ui-state` 归档标记存活在会话删除之后**：探测建出的 btw 会话被删掉后，`pi-web-session-state.json` 的 `sessions.<id>.archivedAt` 仍是孤立条目。清理时除了会话目录和 `projectOrder`，还要删这些 orphan，并把 `revision` 再 +1。
- **`PROBE_CWD` 指向的目录必须先存在**，否则 `POST /api/agent/new` 返回 400 `Directory does not exist`（不是「代理坏了」）。
- **验证脚本里定位 btw 产物必须按 `parentId` 限定到本次的父卡片**。画布数据累积历史探测产物，`find(t => t.kind === 'btw')` 会命中上一次运行的会话，得出错误结论（同坑 19）。
- **探测会话要 `set_thinking_level: off` 并换用会写正文的模型**。`trae/deepseek-v4.1-flash` 实测只产出 `thinking`、正文为空 → 卡片没有回答 → 依赖「有回答」的功能（分支按钮等）测不出来，会误判成功能坏了。
- **跑完验证必须 `node scripts/clean-probes.mjs`（先停服务）**。探测会话是真实会话：会话目录、画布工作区、pi-web 的 `projectOrder`/孤儿归档标记都会留下，累积到 24 个 thread / 85MB 数据文件，每次保存要写 78MB。
- **端口上的进程可能是父进程**：先 `netstat` 拿 PID，再 `wmic process where "ProcessId=<pid>" get CommandLine` 看它是不是在跑 `bin/pi-synapse.js`。实测过两个实例同时在跑（一个持锁监听、一个是它的子进程），只 kill 监听的那个会留下另一个继续写文件（同坑 33/36）。残留的 `workspaces.json.<pid>.tmp` 表示「写到一半死的」。
- **动手前先列全部实例，不要只列监听端口的那个**：`wmic process where "name='node.exe'" get ProcessId,ParentProcessId,CommandLine`，任何命令行里含 `pi-synapse.js` 的都算。本轮实测发现**第三个实例**在 30143 端口、用 `--data <临时文件>` 跑了很久（另一个会话/更早的调试留下的），它一直在写自己的 78MB 副本 —— 这才是「服务反复莫名死掉」的真凶，而只 kill 30142 上的监听者永远看不到它。
- 一次性会话的 cwd 会污染两处：会话目录 + pi-web 的 `pi-web-session-state.json` 的 `projectOrder`。**必须在停掉服务后清理**，否则 pi-web 会把它写回去。

### 画布 UI（风格化改动前先读）

- **画布是一个 ES 模块图**（`app.html` 用 `<script type="module">`），模块作用域**不是**全局作用域：验证脚本读画布内部状态必须走画布显式暴露的句柄 `window.__synapse.state`（曾经可以裸读 `state`，拆模块后变成 `state is not defined`，而且报错在**脚本**里、不在画布里）。新增模块不用改路由：`/synapse/<name>.js` 由 `createAssetHandler` 的规则直接映射到 `src/canvas/`（名字限 `[a-z0-9-]`，防目录穿越）。
- **本仓库的代码不写行尾分号，所以任何一行都不能以 `(` 或 `[` 开头。** `history.scrollRestoration = 'manual'` 后面接一行 `(window).__synapse = …` 会被解析成 `'manual'(window)` → 抛 `"manual" is not a function`，画布整页空白且**外层页面无任何报错**（只有 iframe 的 pageerror 有），排查成本极高。要么写成 `const x = …` 再赋值，要么前面补分号。
- **地图只画「该显示的」会话。** `threadVisibility(thread)` 返回 `'shown' | 'hidden' | 'stale'`：`thread.hidden === true/false` （写进画布数据文件，由侧栏眼睛按钮 PATCH `/synapse/api/threads/:id` 设置）是用户的显式选择，优先；否则看**最近 7 天**（`RECENT_WINDOW_DAYS`）。**活跃时间从 `thread.messages` 里的 `at` 算，不用 `thread.updatedAt`** —— 拖动卡片/改名都会把 `updatedAt` 刷成 now，那样一张被拖过的老卡片会自己回到画布上。卡片集必须总是走 `canvasThreads()`（地图、reveal/pan 目标、折叠遍历共用），否则被收起的 thread 仍会占车道/镜头目标/折叠根。
- **地图没有卡片时（`clearCanvasCards()`）必须把 `state.canvasCards` / `canvasGraph` / `mountedCardIds` 一并清空**：这几个值在渲染之外也被读（折叠、连接线缓存、reveal），留着上一份非空集合会让刚被收起的卡片看起来还在。空状态与「全部在 7 天之外」是两种文案。
- **默认打开的工作区是 `updatedAt` 最新的那个**，不是 `summaries[0]`（后者按创建顺序，往往就是卡片最少的老工作区）。
- **侧栏一行的结构是 `.tree-item` 包着两个按钮**：`.tree-row[data-thread]`（`data-action="select-thread"`，验证脚本点它选会话）与 `[data-action="toggle-visibility"][data-thread]`（眼睛）。按钮不能嵌套（HTML 会默默丢掉内层），所以包装层必须有。验证脚本：`scripts/verify-visibility.mjs`。
- 类名与 `data-*` 是验证脚本的选元素契约，**改样式可以，改名字要同步改 `scripts/verify-*.mjs`**。
- 颜色只承载语义（失败/侧问/工具数/上下文压力），新增颜色先问「它代表什么」。
- 字体是本地随包的（`src/canvas/fonts/*.woff2`，只做拉丁子集，中文走系统字）。新增字体资源必须走 `createAssetHandler` 的 `binary` 分支，按 utf8 读会破坏 woff2。
- 行与行之间靠 1px `#eaeaea` 发丝线分层，不用阴影堆叠。

## 已验证的上游版本

pi-web **0.12.0**（commit `894e1a2`）、pi **1.1.0**、Node 24.14.0。

上游源码克隆在 `.pi-web-src/`（开发期参考，已在 `.gitignore` 排除，不纳入交付）。adapter 依赖的是 pi-web 的内部 HTTP 契约，升级时需重新核对端点与字段。

## 文档约定

- `README.md` 面向使用者，不写实现细节。
- `AGENTS.md`（本文件）只放开发必须知道的事。
- 具体经验、实测数据、设计取舍放 `docs/`。
