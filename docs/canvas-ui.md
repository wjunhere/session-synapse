# 画布 UI：视觉语言与交互

> 「长什么样、点了会怎样」：编辑部式极简这套视觉语言、卡片的状态、地图显示规则、以及一串只有看图才能发现的手感问题。
> 改 `src/canvas/styles.css`、`app.js` 的渲染与交互之前读这篇。

相关：[host-integration.md](host-integration.md)（数据从哪来）、[verification.md](verification.md)（验证脚本靠类名与 `data-*` 选元素）

## 规则（改样式前先读）


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


## 19. 进行中卡片的蓝色动效（2026-10-13，已完成）

会话正在回答时，该会话**最新一张卡片**向外呼吸一层蓝色光晕（`--info` `#1f6c9f`，暗色 `#93c1e6`），2.6s 一个周期；回复落盘即灭。

**2026-10-15 改版：光晕，不是线。** 初版是「边框变蓝 + 一圈 3px 半透明 ring」。实测观感问题是：1px 的蓝边读起来像**静态状态**（一个被选中的样式），而不是「正在进行中」；ring 的 3px 是硬边，看着像给卡片套了个纸盒。现在边框保持中性的 `--line` 发丝线，动效全部交给 `box-shadow`：模糊半径 **6px → 34px**、扩散 **1px → 2px**、颜色的 alpha 由 `--stream-glow-soft` 升到 `--stream-glow`，三者在同一个 `ease-in-out` 周期里一起走，于是读起来像「光在吐纳」而不是「开关灯」。颜色由主题变量给（两个 alpha、一个色相），所以暗色主题不再需要第二套 keyframes（旧的 `card-streaming-dark` 已删）。

选形时实测过 4 个候选（spread 8 / blur 34 spread 2 / 双层 / blur 30 spread 0）：单层 `blur 34px spread 2px` 在明暗两种主题下都是最没有可见硬边的，最终采用。侧问挂件（`.btw-widget.is-running`）同一天也统一成同一形状的光晕，只是**紫色**（`--violet`）且半径随 170×32 的身量缩小（`blur 4px → 18px`，变量 `--btw-glow*`）—— 以前它也是「实心紫边 + 3px 环」，与卡片同类问题。

两个「进行中」的来源必须都点亮：

| 来源 | 时机 | 为什么必要 |
|---|---|---|
| `state.pendingReplies` | 画布自己发消息，**同步**置位 | 这时宿主的 SSE 流还没开，只靠 live-reply 会让卡片头几秒看起来没反应 |
| `state.liveReplies`（bridge 的 SSE） | 流式期间 | 宿主侧发起的回复（在 pi-web 里发的）只有这条路能知道 |

判定收敛在 `isThreadStreaming(threadId)`，并且**只点亮该线程的最新一张卡**（`conversationCard` 里比对 `state.canvasCards.at(-1)`）—— 之前的轮次早已回答完，整条链都亮是噪音。

关键坑：`applyLiveReplyToCard` 为了不闪不抖是**绕过 render() 直接改那一格 innerHTML** 的，所以流式开始时 `is-streaming` 类不会随 render 出现 —— 必须在那条路径里手动 `classList.toggle`，并把同线程更早卡片上的类摘掉（新的一轮开始，旧的「正在回答」就不成立了）。

动效只动 `box-shadow`，不动几何 —— 卡片有虚拟化、拖拽和连线锚点都依赖 left/top，任何会触发 layout 的动画都会和它们打架。`prefers-reduced-motion` 下动画关掉，但**光晕停在最亮的那一帧保留**：状态提示不能因为减少动画就消失，那会让这个状态在无障碍模式下不可见。

验证 `scripts/verify-streaming-card.mjs` 用真实 prompt 全链路断言：类、**外发光是 `--info` 蓝**、**边框没有被染蓝**（动效回到「一条蓝线」就是退步）、动画名、结束熄灭，五项独立检查。它也踩了一遍「探测 thread 必须按 cwd 限定」的老坑（第一版命中了别的会话，测出假阴性）。

## 30. 地图默认只画活跃会话 + 侧栏显示/隐藏（2026-10-14）

需求：一个目录积累的会话太多，画布默认只画**最近 7 天有活动**的；侧栏每一行加一个开关，关掉的会话
卡片不再出现在画布上。

### 决策

1. **可见性是三态，不是布尔。** 数据文件里 `thread.hidden` = `true`（用户收起）/ `false`（用户手动放回）
   / 缺省（交给 7 天默认）。纯布尔无法表达「我手动放回了一条老会话」——下一个 render 就又把它收了。
2. **可见性存在画布数据文件（服务端），不是 localStorage。** 「我收起过这条」应当换个浏览器/重开页面
   仍然成立，和画布归档（`removeThread` → `hiddenSessionIds`）同一语义；拖动位置那种纯排版才留在
   localStorage。写入走已有的 `PATCH /synapse/api/threads/:id { hidden }`。
3. **活跃时间从消息的 `at` 算，绝不用 `thread.updatedAt`。** store 每次 UI 写入都把它刷成 now（拖动卡片、
   改名、剪切等），用它会得到一个荒谬的结果：把一张老卡片拖一下，它就“变活跃”并回到画布上。
4. **7 天阈值放在画布（客户端）。** 它是纯渲染决策，服务端不需要知道；侧栏仍然列出**全部**会话，
   否则被收起的就再也找不回来了。
5. **卡片集统一走 `canvasThreads()`**（地图、reveal/pan 目标、折叠遍历共用）。不统一的话，被收起的 thread
   仍然占车道、当镜头目标、当折叠根，而它们不渲染 —— 现象是“点定位没反应”。
6. **地图空掉时必须清空 `state.canvasCards` / `canvasGraph` / `mountedCardIds`。** 这几个值在渲染之外也被读，
   留着上一份非空集合会让刚收起的卡片看起来还在（实测：`verify-visibility` 的收起断言整批失败）。
7. **默认打开的工作区取 `updatedAt` 最新的那个**（原来是 `summaries[0]`，它是创建顺序 → 往往就是卡片最少
   的老工作区）。不这么改，新用户（或全新的数据文件）第一眼就是空地图 —— 这正是新功能第一次跑全套时
   `verify-card-header` 挂掉的原因（它量不到任何卡片）。
8. **点一条已收起的行 → 直接打开它的转写**：地图上没有它的卡片，reveal/pan 无处可去，不然看起来像点坏了。

### 实测与验证

- `scripts/verify-visibility.mjs`：16 项，含「收起后卡片离开画布 + 服务端记住 + 重载仍收起 + 还能放回」，
  以及 7 天规则（**直接写一个 8 天前的真实会话文件**——没法等七天，而投影读的就是文件，所以这是真实输入）。
- 断言看**画布自己的 card 模型** `state.canvasCards`，不看 DOM：地图上的卡片是虚拟化的，视口外的卡本来
  就不在 DOM 里，只看 DOM 会把“未挂载”当成“已收起”。
- store 单测 2 条：三态切换（`true` / `false` / `null` 清回默认 / 非布尔报错）+ 重启后 `hidden` 仍在。
- 全套 20 个套件绿（新增 `verify-visibility`，因为它会写会话所以进 `npm run verify` 的默认集合）。

## 31. 选中文字后的「追问」浮标无法取消（2026-10-15，已修）

### 现象

在卡片正文里选中一段文字会浮出一个「追问」按钮（`selection-followup`），但**选中状态再也取消不掉**：
点空白画布、点侧栏、右键，黄色高亮一直亮着，按钮点完又回来。

### 根因：两件事各错一半

1. **画布的拖拽手势吃掉了浏览器的「点击即取消选区」。** `app` 的 `pointerdown` 平移处理器对空白处调用
   `event.preventDefault()`（必须调，否则平移拖拽会顺手把沿途卡片正文选成一片）。而这个默认行为恰好就是
   浏览器用来取消选区/落光标的那个 —— 于是点空白处置空。
2. **画布自己也不敢清。** 原来的 `pointerdown` 只做 `hideSelectionFollowup()`（藏按钮）。按钮藏了，但
   `pointerup` 又触发 `queueSelectionFollowup()`，`updateSelectionFollowup()` 一看选区还在、又在卡片正文里，
   就**把按钮重新点亮**。所以现象是「点了没反应」，而不是「藏了又被点亮」这么明显。

右键更彻底：浏览器对次键**从不**取消选区，所以右键必然留着高亮（这也是为什么用户两种键都试过）。

### 修法

`pointerdown` 里按「这次按下是不是在正文里」分流：

- **在正文里**（`.thread-answer` / `.message-body`）：什么都不做。这是**新选区的起点**，交给浏览器；
  也正是「选中 → 右键 → 复制」那条路要保住的（右键必须落在选中的字上，落在同一元素的空白处
  Chromium 会自己清掉选区 —— 这是浏览器的规矩，不是我们的）。
- **在别处**：`hideSelectionFollowup()` 之外再 `selection.removeAllRanges()`。空白画布、侧栏、其它卡片
  的抬头/页脚、工具按钮都归这一支。
- 浮标自己（`.selection-followup`）先 `preventDefault()` 再 return：点它时选区必须活着，因为紧接着要
  读所选文字开草稿（其实读的是 `selectionFollowup.text` 那份快照，但不该在按下的一瞬间就把高亮抹掉，
  否则点击过程本身会闪一下）。

### 验证

`scripts/verify-selection-dismiss.mjs`（6 项，已进 `npm run verify`）：选中文字 →
断言浮标出现（前置）→ 空白画布左键 / 空白画布右键 / 侧栏空白，三处都要求**选区与按钮同时收起**
→ 反向两条：在**选中的字上**右键必须保留选区（右键复制）、点「追问」必须把所选文字带进草稿。

三条纪律：

- **断言选区本身，不只断言按钮。** 高亮是浏览器画的，按钮只是它的影子；只藏按钮等于没修。
- **卡片要挑视口中央附近的。** 卡片是虚拟化的，视口外的卡不在 DOM 里，playwright 拒绝点击视口外元素
  （报 `element is outside of the viewport`）—— 第一版就因此在「右键正文」这步假失败过一次。
- **在选中处右键要用选区自己的 rect**（相对 `.thread-answer` 的坐标），不能用元素中心：中心通常不在
  选中的字上，Chromium 会按「点在别处」处理并清掉选区。

## 34. 卡片抓手：按下时跳位、状态不可读，与重新设计（2026-10-15）

### 两个真问题

**① 按下即右跳 13px。** 抓手（`.node-handle`）的居中写的是 `transform: translateX(-50%)`，而全局有条
`button:active { transform: scale(.98) }` —— `transform` 是**一个属性**，`scale(.98)` 把 `translateX(-50%)`
整个替换掉了。实测（同一把尺子，修前/修后）：按下瞬间 `transform` 从 `matrix(1,0,0,1,-13,0)` 变成
`matrix(0.98,0,0,0.98,0,0)`，抓手中心相对卡片中心从 **0px 变成 +13px**（正好半个身位），松开再弹回去。
这正是用户看到的「状态条会偏离中心」，也顺带解释了「拖动的动画不好看」——那一跳加一个 2% 的按扁回弹。

**② 拖动过程没有可读状态。** 光标一直是 `grab`（拖起来该是 `grabbing`），卡片自己不抬起，连杆不加深，
抓手也只在 hover 时有一点点边框变化。用户看不出「现在是谁在被移动」。

### 重新设计（沿用编辑部式极简的既有语言）

| 状态 | 以前 | 现在 |
|---|---|---|
| 静止 | 实心白底 + 发丝边框 + `···` 文字，26×14，压在卡片顶边 | **一个小台**：白底 + `--line` 发丝边 + 三个点，80% 不透明，30×18；点用 `box-shadow` 画（字号/字体的点径与垂直度量会把 `···` 顶到框边，实测偏上且不齐） |
| hover | 边框变深 | 发丝边转 `--line-strong`、点转 `--ink-2`、整体到不透明（**形状不变**，所以没有位移） |
| 按下 | 右跳 13px + 整体缩到 98% | `cursor: grabbing`，`transform: none`（退出按扁）；反馈交给卡片 |
| 拖动中 | 没有区别 | 卡片 `.is-dragging`：抬起（`--shadow-drag`，instant，不做 ease-in）、边框转 `--ink-3`、`z-index: 5` 压住邻居；**关联连线加深**（`.dragging-connector`）——移动时能看见它连着谁 |
| 松开 | 无 | 类被移除 → 阴影按卡片自己的 200ms 缓回来，即「落回」 |

**为什么静止也得是个「台」而不是只留点。** 第一版把静止态做成「只留三个 55% 的点」，实际渲出来很难看：
点正好骑在卡片顶边的发丝线上，中间那个与线糊成一条，另外两个像胜点沾在边上。于是把四种处理渲出来对比：
**A 裸点骑线** / **B 静止就是安静的小台**（白底 + `--line`，半隐） / **C 台子整体挪到卡片外、底边贴着卡片** / 
**D 抓手移到卡片内部**。结论：A 就是用户报的「很奇怪」；C 飘在卡片外看着像悬浮的碎屑，与卡片脱钩；D 丢掉了「卡片顶端的小标签」
这个现成语义，而且占到卡片内容的地盘。**只有 B 既读得出是抓手、又不吵** —— 卡片顶边被小台截断一下是故意的
（夹页标签的既视感），而且从静止到 hover 只有边框与点色变深，形状与位置完全不动。


另外补了**键盘替代**：抓手本来就是个可聚焦的 `<button>`，于是方向键 8px 一步、`Shift` 1px 微调
（WCAG 2.2.6/2.2.7：作者控制的拖拽不能是唯一手段；`ui-ux-pro-max` 把「Dragging Movements」列为 High）。

### 顺带的重构

`bindDragHandle` 里那段「写回五处状态」的逻辑抽成了 `placeCard()`，因为现在有两条调用路径（指针拖拽每帧一次、
方向键每按一次），而它要同步的东西有五个：`state.cardPositions`、position-key 别名、虚拟化模型
`state.canvasCardsById`、卡片的 inline `left/top`、以及连线。只有调用方决定何时落盘（拖拽只在松手时
`rememberCardPosition()` 写一次 localStorage）。连线加深走 `markDraggedConnectors()`，复用已有的
`connectorPathsByCard` 缓存，不扫全 SVG。

### 验证

`scripts/verify-card-drag.mjs`（14 项，进 `npm run verify`）：静止时**每张挂载的卡**偏移 ≤1px；按下时仍居中
（回归点，修前 13px）、不被按扁、`is-dragging`、`cursor: grabbing`、阴影/边框变强；拖动中跟随指针
（按 zoom 折算）、连线加深、仍居中；松开后状态消失、位置写进 localStorage 且就是落点；方向键 24px/1px。

抓手长什么样属于观感，没法断言，所以那一轮是靠**渲染对比**定的：骊个候选各渲明/暗两套、静止/hover 两个状态，
裁到只剩「卡片顶边 + 抓手」再放大看。这类改动的验收方式就得是看图，而不是加一条 CSS 断言。

关键手法：**卡片必须完整落在视口内**。卡片是虚拟化的，视口外的卡仍在 DOM 里但坐标在屏幕外，拿它按鼠标
谁也点不到 —— 第一版探针因此全程 `offset=0`、看着像「没问题」，实际什么都没测到。

