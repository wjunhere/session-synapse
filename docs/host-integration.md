# 宿主集成（pi-web 侧）

> 画布之外的那一半：pi-web 的 HTTP 契约、反代与注入、导航、分支与侧问（btw）、图片附件、改名与归档、能力门控。
> 这些接口全是 pi-web 的内部实现，**升级 upstream 必须重新核对**（版本见 [README.md](README.md)）。

相关：[canvas-ui.md](canvas-ui.md)（宿主状态怎么画出来）、[verification.md](verification.md)（探测纪律：别对真实会话发消息）、[runtime.md](runtime.md)（反代与注入在服务端的那半）

## 导航约定


- **点卡片本体 = 进详情视图**（定位到那一轮），**不跳 pi-web**。pi-web 入口是卡片 footer 的「pi-web」按钮和详情头部的「在 pi-web 中打开」，两者都是显式动作。`openSessionInHost` 是整页跳转，只能由这两个入口触发。
- **无锚点进详情 = 落在最新一条消息**（btw 挂件 / 顶部「详情」tab 都没有锚点）。`render()` 里的 `detailScrollByThread` 记忆**只在无锚点时生效**，显式进入必须定位到目标，否则会被上次访问的旧偏移劫持。
- **卡片 ID 尾部是十六进制串**（`77e0044c`），不是数字。锚点正则是 `/:turn:([^:]+)$/`；写成 `(\d+)` 会让每一张卡都匹配失败并静默落到最新（已实际发生，且旧测试只断言「详情打开了」所以没拦住）。`:turn:empty` 是空线程占位卡，按无锚点处理。
- **侧栏行跟随当前视图**：地图上 = 选中 + 平移聚焦该会话的卡片；转写里 = 切到该会话并落在最新一轮。不要让它固定跳某个视图 —— 上一版改成固定进详情，直接让「在画布上定位某条会话」失去入口。
- **详情视图里不要对 `<button>` 用 ellipsis 依赖 `width:auto`**：按钮的 `auto` 宽度是 shrink-to-fit，不会撑满容器。要裁剪必须显式 `display: block`（或给确定宽度）+ 父级 flex 上下文。
- **结构性 `display` 必须写在各自的选择器里，禁止用 `.a, .b, .c { display: flex }` 这种共享列表**：删一个类时整行被删，其余组件静默失去布局（标题曾因此涨到 1126px）。
- 卡片检查器（card-inspector）已删除：点卡片直接进详情后它就没有入口了，相关 state/CSS 一并清掉，别再引用。
- **选中文字后的「追问」浮标：取消选区得画布自己动手。** `pointerdown` 在正文以外必须 `selection.removeAllRanges()`：空白画布那一支的平移手势会 `preventDefault()`，而那个默认行为恰好就是浏览器用来取消选区的；右键则根本不会取消（不修就是「选了字永远取消不掉，浮标点完又回来」——`pointerup` 会让它重新点亮）。正文内（`.thread-answer` / `.message-body`）**不碰**：那是新选区的起点，也是「选中→右键→复制」的路径。验证 `scripts/verify-selection-dismiss.mjs`（断言选区本身，不只断言按钮）；在选中处右键要用**选区自己的 rect**，元素中心通常不在选中的字上。
- **居中的 `translate` 不能写成 `transform: translateX(-50%)`。** 全局 `button:active { transform: scale(.98) }` 会把 `transform` **整个换掉**，于是卡片抓手（`.node-handle`）一按下就右跳 13px 并缩小（实测）。居中一律用 `translate: -50% 0` 这一类**独立属性**，`transform` 留给交互效果；抓手也显式 `transform: none` 退出那个按扁效果（抓起一张卡的反馈是卡抬起，不是抓手缩一下）。验证 `scripts/verify-card-drag.mjs` —— 它断言的是「**按下时**也居中」，只验静止态会漏掉。
- **抓手静止时也得是一个小台（白底 + `--line` 发丝边），不能只留三个裸点。** 裸点正好骑在卡片顶边的发丝线上，中间那个与线糊成一条、另两个像胜点沾在边上（用户原话：「看起来很奇怪」）。四种处理渲染对比过：裸点 / 静止即小台 / 台子在卡片外 / 抓手在卡片内 —— 只有「静止即小台」既读得出是抓手又不吵，且静止→hover 只变边框与点色、形状位置都不动。


## 分支与 fork


- **pi 的 fork 复制父会话历史**（同 entry id、同顺序），所以「子会话只含自己的轮次」必须靠 `inheritedEntryCount` 截断。它被硬编码成 0 过，后果是父会话整段历史被重画成分支自己的轮次（实测 13 轮全部重复）。
- **判据只能是与父文件的 entry id 前缀比对**：复制的条目保留**原时间戳**，全部早于子会话 header，时间戳无法区分「复制来的」与「新增的」。
- **`inheritedEntryCount` 传的是「最后一个继承条目的 id」，不是数量**。数量与 entry id 无法比较（id 是 8 位十六进制，`'927f88e9' < 34` 恒为 false），历史上有两处因此静默失效：`app.js` 的分支挂载点、以及点击处理里的 `Number.isInteger(entryId)` 校验（导致每一张卡的分支按钮都报「请等待最终回答」）。
- **从指定一轮分叉走 `POST /api/agent/:id {type:'fork_branch', entryId}`**（pi-web 的「在新对话中提问」用它）；`POST /api/sessions/:id/fork`（body `{}`）只能从当前 leaf 分叉，表达不了「从第 N 轮分叉」。
- **分支按钮的显示条件只要求「有回答」**。曾被 `childCount === 0 || canContinue === true` 双重排除，恰好把最新卡（两个条件都成立）的入口删掉了。


## 图片附件


- 图片走宿主自己的 `prompt` 通道：`images:[{type:'image',data:<base64 无前缀>,mimeType}]`，上限 **10 张 / 单张 10MB**，>1MB 且非 gif 先在客户端压到最长边 1024（照抄 pi-web，别自己定策略）。
- **`[图片]` 标记不许写进 `message.text`**：`settlePendingReply` 用文本精确相等判断回复是否到达，混进标记会让带图消息永远匹配不上（卡片一直「正在回复」）。投影存 `imageCount`，显示层用 `displayText()` 拼标记。
- **pi 对每张图收固定 4800 字符（1200 token）**，只对 user / custom / toolResult 收。user 折进 `usageChars`；toolResult 折进 `process[].imageChars`（锚点分支单独加），否则圆环少报。
- **空文本消息要留住**：投影的 `note()` 和存储的 `noteProjection()` 都曾因「文本为空」丢掉只有图片的消息（那一轮会从画布上消失）。标题回落 `[图片]`。
- 报错结束的一轮也算答复：`settlePendingReply` 必须认 `error` 条目，否则 `pendingReplies` 永远不结算。
- 流式状态的类（`is-streaming`）添加与清除必须**对称**：它是 DOM 补丁路径加的，只在 render 里删会在 `canReplaceView()` 为 false 时漏掉。


## 7. 宿主集成（pi-web 侧）

pi-web 是**预构建的 Next.js 产物**（`npm i -g @agegr/pi-web` 装的是 `.next/` 二进制），**无法通过插件机制加路由或改页面**。这是本方案最大的工程约束，有三种做法：

### 方案 A：pi-web 启动器包装（推荐，零上游修改）

- 发布 `session-synapse-piweb` CLI：`synapse start` → 起 core 的 server（自带 `/synapse/*`），**同时** spawn `pi-web`。
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
5. **当前会话同步（`synapse:current-session`）**：画布用它把侧栏行标成「当前」、把镜头对到那一轮，**并用它决定画布该显示哪个工作区**（宿主在哪，地图就在哪）。两个硬要求：
   - **画布的 `map-ready` 到达时重发一次，不能只发「变化」。** iframe 是在注入脚本之后才加载的，注入那一刻发出的第一条落在还没装监听的文档上就没了；而两边都有 `if (id === lastSessionId) return` 的去重，于是「重复」永远不会发生 —— 实测后果是首次加载时画布根本不知道宿主在哪，工作区只能按「最近活跃」猜（用户看到的就是「地图固定在某个工作区」）。
   - **只有真的换了会话才推**：画布那边「用户自己选的工作区」只在宿主的会话 id 变化时被覆盖，周期性地重发同一个 id 会把用户选的地方拽回去（验证 `scripts/verify-follow.mjs` 最后一项就等 6 秒断言它纹丝不动）。
6. **宿主侧的会话列表要能被画布反查到工作区**：`GET /synapse/api/workspaces` 的每条摘要带 `sessionIds`，画布用它回答「这条会话属于哪个工作区」，不用把每个工作区都拉下来。

---

## 15.4–15.7 `/btw` 侧问（M5）

> 从原 design.md 的 §15（M5 实测）里拆出来的侧问那半 —— 上下文圆环那半在 [context-usage.md](context-usage.md)。

### 15.4 `/btw`：与「创建分支」的区别在哪

必须诚实记录：**pi-web 的 fork 只能从当前 leaf 分叉**（`POST /api/sessions/:id/fork` 的 body 是 `{}`，不接受 entryId）。所以 `/btw` 与「创建分支」底层是**同一个调用**。

那 `/btw` 的价值在三件事上：

1. **限定工具** —— 草稿卡里逐项勾选（默认 `read/grep/find/ls`），`set_tools` 落到新会话文件（`custom` 条目，`pi-web:tool-selection`），父会话不受影响
2. **自动归档** —— 会话移出 pi-web 主列表，但**归档视图里完整可见、可打开、可继续**
3. **折叠挂件** —— 画布上收纳成父卡片下方的小挂件

顺序不能变：**fork → set_tools → prompt**。fork 前会话不存在，set_tools 无处可写；prompt 前必须设好，否则第一轮会用父会话的完整工具集。

归档失败**不算失败** —— 挂件照样能用，只是 pi-web 列表里多一条。

DSH 上这三件事的形态不同（工具由 `tools.restrict` 钉、**不能归档**），见 [dsh-desktop.md](dsh-desktop.md) §5.3；工具词表也由宿主报（`/synapse/api/status` 的 `tools` / `pinnableTools` / `defaultBtwTools`），画布不自带一套。

### 15.5 为什么不用 pi-btw 的机制

参考实现 `@narumitw/pi-btw` 用的是「文本注入 + `completeSimple` 直接调模型 + 只存内存」，因此**临时、不落盘**。但它的代价是**没有工具执行循环** —— `completeSimple` 是纯模型调用。要在画布里复刻，就得让服务端起一个「轻量模型调用」通道，等于**在 session-synapse 里再实现一个 mini agent 循环**，违背项目「不另造运行时」的边界。

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


## 坑（本主题）

编号是全仓库的 ID，索引见 [README.md](README.md)。

5. **pi-web 拒绝跨源 `/api/*`**：`Origin` 必须等于请求自身的 `Host`。反代必须**剥离 `Origin` 头**并统一 `Host`。
6. **反代必须处理 gzip。** 浏览器发 `Accept-Encoding: gzip`，pi-web 会返回压缩的 HTML；直接注入会损坏页面。代理对 HTML 请求统一 `accept-encoding: identity`，并对其他编码做解压兜底。
7. **`pi-web:tab-open-session` 是 sessionStorage，不是外部接口。** 它只在 URL 没有 `?session=` 时作回退，且不跨标签页。切会话只能整页导航（`?session=`）。
8. **pi-web 的 z-index 到 220**（侧边栏 200、拖拽把手 220）。注入的覆盖层用 300，切换条用 400。
9. **注入脚本在 `<head>` 里执行**，此时 `document.body` 可能还不存在。脚本用 `defer`，并对 body 缺失做兜底。
12. **SSE 的 `message_update` 不含 `partial`**（服务端已剥离）。文本靠 `text_delta` 增量拼，`text_end` 是权威内容；`*_end` 永不被丢弃。因此流式长度会**先增后小幅回退**（`text_end` 用权威内容替换累积值），这是设计意图，不是 bug。
13. **pi 的 fork 不复制历史。** 子会话只含自己的条目，header 的 `parentSession` 指向父文件。因此 `inheritedEntryCount` 恒为 0，父子连线靠 `parentSessionFile` 与 `sessionFile` 配对。
14. **pi-web 的主题是 `pi-theme` 三态偏好**（auto/light/dark），解析结果在 `documentElement.dataset.theme` + `dark` class。**必须读这个，不能用 `prefers-color-scheme`**，否则忽略用户手动选择。用 `MutationObserver` 监听变化。
16. **写操作必须在浏览器里发起。** 改名/归档直接调 pi-web 的 API，**不能**放到服务端：Node 的 `fetch` 要求绝对 URL（相对路径报 `Failed to parse URL`），且 pi-web 要求 `Origin` 等于自身 `Host`，服务端请求没有页面 origin，补绝对 URL 也会 403。服务端只通过 `/synapse/api/status` **声明能力**。
17. **pi-web 的归档两个方向都是 `action: "set"`**（`archived: true/false`）。`action: "restore"` 是回放精确 prior-values 快照，用于 undo，不是「取消归档」。归档键是会话**族**的根，独立会话的根是它自己。
18. **会话名从列表 API 读**（`/api/sessions` 的 `name` 字段）。`/api/sessions/:id` 的 `info.name` **不是**名字载体，但改名确实会写入会话文件的 `session_info` 条目。
20. **画布无法应答扩展 UI 对话框**（`extension_ui_request`，如 remote-pi 的「Agent name:」）。依赖这类对话框的会话在画布上发消息后可能没有正文回复，需回 pi-web 原生界面处理。
26. **`custom` 条目不能一概忽略。** `customType === 'pi-web:tool-selection'` 是 pi-web 固定在会话里的工具集（btw 靠它），`cleared: true` 表示撤销固定。其余 `custom` 才是纯扩展状态。
27. **`set_tools` 是会话级、写进会话文件**（`custom` 条目），不是每轮设置。btw 的顺序必须是 **fork → set_tools → prompt**：fork 前会话不存在，set_tools 无处可写；prompt 前必须设好，否则第一轮用父会话的完整工具集。
28. **pi-web 的 fork 只能从当前 leaf 分叉**（body 是 `{}`，不接受 entryId）。所以 pi-web 上的 btw 与「创建分支」底层同一个调用，价值在**限定工具 + 自动归档 + 折叠挂件**三条，不在「继承上下文」。（DSH 的 `/btw` 能按事件序号分叉，所以那边继承的是到那一轮为止的上下文 —— 同一个按钮，两个宿主的行为不同，见 [dsh-desktop.md](dsh-desktop.md) §5.3。）
29. **btw 的归档是「可逆的干净」，不是「隐藏」。** 会话移出 pi-web 主列表，但**归档视图里完整可见、可继续** —— 这正是路线 2 的承诺。归档失败不能算失败（挂件照样能用）。
30. **btw 的三个写调用全在浏览器侧**（同坑 16）。服务端只多一个 `/synapse/api/threads/:id/link`，用于登记浏览器建好的 thread，免得等 4s 重扫才出现。
31. **btw thread 不进 `conversationCards`。** 它渲染成父卡片下方的挂件（`btwWidget`，位置由 `btwSlot` 现算，不进图布局），因为它不是主链上的一轮。提交后**不要**切到详情视图，否则刚建出的挂件立刻被藏起来。
