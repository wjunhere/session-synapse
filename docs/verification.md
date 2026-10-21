# 静态检查、测试与探测纪律

> 「怎么确认自己没改坏」：`npm run check` 的基线、单测、`npm run verify` 全套回归，以及**动真实会话之前必须遵守的探测纪律**。
> 任何要跑服务或写会话文件的验证都读这篇。

相关：[../AGENTS.md](../AGENTS.md)（只留了三条命令与铁律）、[canvas-ui.md](canvas-ui.md)（观感类改动只能看图验，不能靠断言）

## 静态检查

```bash
npm run check                             # tsc -p jsconfig.json，交付代码基线 0
```

```bash
npm run check                             # tsc -p jsconfig.json，交付代码基线 0
```

- **本仓库的 LSP 曾经只报语法错**：没有 `jsconfig/tsconfig` 时 `checkJs` 关闭，一个拼错的标识符或不存在的方法都会显示 OK。`jsconfig.json` 已开，`include` 只含交付代码（`src` + `bin`），基线 **0 问题** —— 基线为 0 才有意义，否则真错误会被噪音淹。
- **改了先校准再信**：往 `src/` 放一个只有语义错的文件（未声明的名字、字符串上调用不存在的方法），`npm run check` 必须以退出码 1 报出这两条，再去读那串 “OK”。
- **TypeScript 7 要显式 `types: ["node"]`**（不再自动包含 `@types/*`），所以 `typescript` + `@types/node` 是 devDependency。
- **`test/` 与 `scripts/` 故意不在 `include` 里**：它们是开发用探测代码，多处 `frame.evaluate()` 里用浏览器全局，合起来约 79 条诊断（全是良性），会把真问题埋掉。要审它们就临时放宽 `include`。`src/canvas/vendor/` 同样被排除：那是第三方构建产物（mermaid、temml），不手改。
- **语言服务器（tsserver，内置 TS 5.x）比本地 `tsc`（7.x）宽松**：本轮 TS 7 报出 5 条 TS 5 看不见的错误（`@param {object}` 太泛导致的取属性失败）。以 `npm run check` 为准。
- **LSP 会缓存改动前的版本** —— 改完 typedef 后必须 `lsp reload` 再测，否则会看到已经不存在的错误。


## 测试

```bash
npm test                                  # 178 个单测（投影 28 + DSH 投影 11 + DSH 写操作映射 13 + 卡片间呼叫 12 + 上下文 17 + 存储 38 + 画布设置 5 + 转写窗口 6 + markdown 15 + 实例锁 14 + pi-web 动作 15 + 会话对账 4）
npm run verify                            # 全套回归：起服务 → 26 个套件 → 清理 → 汇总表（需要 pi-web 在 30100）
npm run verify:dsh                        # DSH 适配：自己起隔离 harness（需要 dsh CLI + 凭据 + 旁边的 dsh-intercom），57 项
npm run verify -- --skip-browser           # 只跑非浏览器套件
```

**两个回归入口是分开的**，因为世界不同：`npm run verify` 的 26 个套件是 pi-web 的下游（画布靠反代与它同源），`npm run verify:dsh` 自己拉起一个 harness（画布是它的插件、同进程）。后者用临时 `DSH_HOME`，不碰真实会话，但**会真的调模型**（新建会话/发消息）——与 `verify-send.mjs` 对 pi-web 做的一样：投影与写操作链路没法用替身验。

`npm run verify:dsh` 的前置不止 dsh CLI 与凭据：**还得有旁边的 `dsh-intercom`**。卡片间呼叫那一项要真发一条 intercom 消息，而隔离 home 里只装本仓库插件的话 `/intercom/roster` 回 404、按钮自然不出现（第一版就是这么假 FAIL 的）。套件默认找 `../dsh-intercom`，用 `DSH_INTERCOM_PATH` 指到别处；找不到就直接 fatal 报清楚，**不降级**。

套件里的 **F2 段**验的是卡片间呼叫的整条路，全部在隔离 home 内：真点卡片上的呼叫按钮 → 选择器列出另一个活会话并排除自己 → 真发 `/intercom/send` → 对方会话的日志里出现 relay（`kind:call`、带呼叫方与正文）→ 切到对方的画布，看到那张「呼叫」卡片并能跳回呼叫方。**必须用隔离 home**：发一条就会让目标会话真的跑一轮（铁律 6 的同源纪律）。

两个套件专门守详情视图（`docs/canvas-ui.md` §35）：`verify-detail-window.mjs` 守「只渲染最后 50 条 + 显示更早的 + 空闲时一次都不重写 DOM + 真鼠标点击不被重建吞掉」，`verify-markdown.mjs` 守 mermaid/LaTeX/表格/嵌套列表的渲染。后者靠**发一条带全部语法的 prompt** 造数据（prompt 本身就是会话里的用户消息），所以既不造假数据也不用等模型写出图来。

### 浏览器从哪来（`scripts/browser.mjs`）

套件不写死任何人的机器：驱动是 `playwright`（devDependency），浏览器按以下顺序取第一个能用的，`npm run verify` 会把选中的那个打出来：

1. `CHROME_PATH` —— 显式指定一个 Chromium/Chrome 可执行文件（要把一次运行钉在某个二进制上时用）；
2. `playwright` 自己那版下载的 chromium（`npx playwright install chromium` 装的就是它）；
3. **ms-playwright 缓存里最新的 `chromium-<rev>`**，不管是谁下载的 —— 缓存是跨 playwright 版本共享的，而 `npm i` 换一次 playwright 版本不应该逼人重新下载 150MB；
4. 机器上装的 Chrome（`channel: 'chrome'`）。

`PLAYWRIGHT_CORE` 可以指向仓库外的另一个 playwright/playwright-core（路径或 `file://` URL）。套件断言的是 DOM 与几何而不是像素，所以四个都能跑；本仓当前的期望值是在 chromium 1243 上量的（`CHROME_PATH` 可以把它钉回来）。

单独跑某个套件（脚本统一读 `BASE`，默认 `http://127.0.0.1:30143`）：

```bash
node scripts/e2e-real-data.mjs            # 真实数据投影，报告卡片/工具统计
node scripts/verify-context.mjs           # 上下文占用 vs pi 自身算法（逐会话，容差 64 token）
node scripts/verify-single-instance.mjs   # 单实例锁：同端口/换端口都拒绝、陈旧锁自动接管、锁看起来极旧但持有者活着时也不接管
node scripts/verify-canvas.mjs            # 画布渲染（需先启动服务）
node scripts/verify-folding.mjs           # 分支折叠
node scripts/verify-theme.mjs             # 主题同步（含手动覆盖）
node scripts/verify-btw.mjs               # 侧问全链路 25 项（需传 PROBE_CWD）
node scripts/verify-detail-rows.mjs       # 详情视图无空行
node scripts/verify-ring-levels.mjs       # 圆环 ok/warn/danger 三档配色
node scripts/verify-card-header.mjs       # 卡片标题与圆环的间距（防标题压住圆环）
node scripts/verify-switch-bar.mjs        # 视图切换入口只有一个可见（防出现两个切换条）
node scripts/verify-streaming-card.mjs    # 进行中的卡片有蓝色呼吸光晕（需传 PROBE_CWD）
node scripts/verify-selection-dismiss.mjs # 选中文字后的「追问」浮标：点别处连选区一起取消
node scripts/verify-card-drag.mjs         # 卡片抓手：按下也居中、拖动状态、位置记住、方向键移动
node scripts/verify-navigation.mjs        # 点卡片进详情（不跳 pi-web）+ 无锚点落在最新消息
node scripts/verify-session-removal.mjs   # 会话删除后的对账（A 段可独立跑；B 段需服务 + PROBE_CWD）
node scripts/verify-visibility.mjs        # 地图显示规则：7 天默认 + 侧栏眼睛按钮（需服务 + PROBE_CWD）
node scripts/verify-follow.mjs            # 画布跟着宿主的会话换工作区（需服务 + PROBE_CWD）
node scripts/verify-image-paste.mjs       # 卡片内粘贴图片（需传 PROBE_CWD）
node scripts/verify-streaming.mjs         # 流式「边写边显」（需传 PROBE_CWD）
node scripts/verify-send.mjs              # 画布内发消息（需传 PROBE_CWD）
node scripts/verify-writes.mjs            # 改名 + pi-web 归档 + 能力门控（需传 PROBE_CWD）
node scripts/verify-branch.mjs             # 分支：最新卡有入口、旧卡不报错、历史按轮截断（需传 PROBE_CWD）
node scripts/drop-probe-workspace.mjs     # 清掉探测 cwd 在 workspaces.json 里留下的工作区
node scripts/clean-probes.mjs             # 清掉探测留下的一切（工作区/会话目录/pi-web 状态/锁）——必须先停服务
node scripts/verify-clean-probes.mjs      # clean-probes 自己：不许碰活实例的锁与临时文件（--dry-run，无副作用）
```

验证脚本统一读 `BASE` 环境变量（默认 `http://127.0.0.1:30143`），换端口跑时不要再改脚本。

`npm run verify`（`scripts/verify-all.mjs`）是首选入口：它用**隔离的临时数据文件**起服务、在一次性 cwd 里造探测会话、跑完调 `clean-probes.mjs`，失败时保留 run 目录（含每个套件的日志）。它**不启停 pi-web**（杀掉用户自己启的比报错更糟），也**不碰**你真实的画布数据。

单独跑脚本仍可以，但注意两件事：① `verify-branch` 与 `verify-session-removal` 结束时**会删掉 `PROBE_CWD`**，所以串行跑多个脚本前必须先 `mkdir -p` 回来（harness 在每个套件前重建它；少了这步的表现是 `POST /api/agent/new` 报 `Directory does not exist`，看起来像代理坏了）；② `clean-probes.mjs` 支持 `--data <path>`，把「画布工作区」那半指向隔离文件，会话目录与 pi-web 状态照旧清真实的。

调试截图（`synapse-verify-canvas.png` / `-btw.png` / `-navigation.png` / `-streaming-card.png`）与 `e2e-real-data` 的画布数据都写在**系统临时目录**，跑完不再在仓库根目录积尘（以前它们落在 `_nav.png` / `_btw/` / `_e2e/`，而且路径写死了本机盘符，在别的机器上直接失败）。


## 28. 一条命令跑全套回归（M4-3，2026-10-14）

`npm run verify` = `scripts/verify-all.mjs`：按前置条件检查上游 pi-web → 用**隔离的临时数据文件**与一次性
`PROBE_CWD` 起 `bin/synapse.js start` → 顺序跑 26 个套件（每个都带 `BASE`/`PROBE_CWD`）→
停服务 → `clean-probes.mjs --data <临时文件>` → 打一张表。每个套件的完整输出写到 `<run>/logs/`，**成功才删
run 目录，失败保留并打印路径**。它不启停 pi-web（杀掉用户自己启的比明确报错更糟），也不碰用户真实的
`workspaces.json`。CI（`.github/workflows/ci.yml`）只跑 `npm run check` + `npm test`。仓库已建：`wjunhere/session-synapse`
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
3. **探针留下的第二个工作区会拖垮后面的套件（新套件 `verify-follow` 踩到）。** 它必须在两个目录各造一条
   会话，于是数据文件里多了一个比共享探测目录更新的工作区。后面的 `verify-image-paste` / `-btw` /
   `-branch` / `-streaming-card` 用 `opts.find(o => o.includes(probeTitle))` 按**标题子串**选工作区
   （`probeTitle` 是 `cwd`），而新工作区叫 `cwd-b` 也包含 `cwd` 且排在最前 → 它们选到了一个已经被删掉的
   目录（`400 Directory does not exist`、卡片一张都没有）。两个修法一起上：新套件结束时把那个工作区的
   线程删掉（`DELETE /synapse/api/threads/:id`，store 会把空掉的投影工作区一并移除，并记住这条会话
   不该再被投影），这样后续套件看到的仍是原来那个「最近活跃」的工作区；按标题子串选工作区这件事本身
   仍然很脆，改套件时注意。
4. **CI 上的红是测试的模拟不跨平台，不是产品错（公开仓库后的第一次 CI 就红在这里）。**
   `instance-lock.test.js` 里那条「命令读不到时用年龄回收锁」用 `PATH=''` 把 `wmic` 拿走 —— 那是
   Windows 的真实状态，但 Linux 读命令行走的是 `/proc/<pid>/cmdline`，不需要 PATH，所以命令照样读到了：
   holder 的 argv 里有字面 `synapse` → 判定「是我们自己的」→ 拒绝回收 → 断言失败。修法两半：① 那条
   保留成 Windows-only（`{ skip: process.platform !== 'win32' }`，在 Linux 上显式 skipped 而不是红）；
   ② 把三向决策本身提出来当纯函数测（`lockIsStale(holder, { staleAfterMs, mtimeMs, liveness })`，liveness
   改成入参），这样「已死 / 是我们 / 无法确认」三种答案在任何平台都能断言 —— 而这三种答案搞错的代价
   分别是「两个写者」与「永久锁死」，本来就该直接测。复现平台差异用 WSL：
   `wsl.exe -e bash -lc "cd /mnt/b/work/proj && node --test test/*.test.js"`。

### 一个被顺便修正的测试前提

`verify-single-instance` 的「无僵尸写入者」原本是「启动后 6 秒内文件字节不变」。holder 在**收敛期本来就该写**
（store 把投影写合并成一次尾部 flush；在它下面变化的会话会被重新投影），所以这条检查在忙的机器上会把合法写入
报成僵尸。实测对照：单独起一个实例后连续采样 25 秒，大小从 t=1 起就是恒定的 83.5MB —— 说明对账**没有**周期性
写盘（这是它必须满足的性质）。检查已改为**收敛**语义：每秒采样，连续 3 次相同即通过，20 秒内不收敛才失败 ——
失控的写入者永不收敛，而收敛的写入者几秒内就停。

---


## 探测纪律


- **不要对真实会话发消息或空消息** —— pi 会当成有效 prompt 启动真实 agent run 并写入会话文件。
- 需要测 prompt 通道时，先用 `POST /api/agent/new {"type":"ensure_session"}` 造一次性 cwd 的会话，用完删掉整个 cwd 目录。
- 一次性会话的 cwd 会污染 pi-web 的 `~/.pi/agent/pi-web-session-state.json`（`projectOrder`），必须一并清理。
- 涉及写盘的探测，先记录基线（行数 + 末行 id + 悬空引用数 + ui-state revision），结束后逐项比对。
- **pi-web 的 `ui-state` 归档标记存活在会话删除之后**：探测建出的 btw 会话被删掉后，`pi-web-session-state.json` 的 `sessions.<id>.archivedAt` 仍是孤立条目。清理时除了会话目录和 `projectOrder`，还要删这些 orphan，并把 `revision` 再 +1。
- **`PROBE_CWD` 指向的目录必须先存在**，否则 `POST /api/agent/new` 返回 400 `Directory does not exist`（不是「代理坏了」）。
- **验证脚本里定位 btw 产物必须按 `parentId` 限定到本次的父卡片**。画布数据累积历史探测产物，`find(t => t.kind === 'btw')` 会命中上一次运行的会话，得出错误结论（同坑 19）。
- **探测会话要 `set_thinking_level: off` 并换用会写正文的模型**。`trae/deepseek-v4.1-flash` 实测只产出 `thinking`、正文为空 → 卡片没有回答 → 依赖「有回答」的功能（分支按钮等）测不出来，会误判成功能坏了。
- **探测模型可以用 `PROBE_PROVIDER` / `PROBE_MODEL` 换掉**（默认 `trae/DeepSeek-V4-Flash`；`verify-streaming-card` / `verify-btw` / `verify-branch` / `verify-image-paste` 认这两个变量）。provider 会整体挂掉：所有 assistant 条目 `stopReason: 'error'` 且正文为空，表现为「没有动效类」/「卡片上没有分支按钮」。这不是画布的 bug —— 用 `/api/agent/new` + `prompt` 直接打也能复现（绕开画布），先换个能写正文的模型排除模型因素（实测 `cc-switch-open-code-go/deepseek-flash` 可用）。注意 `verify-btw` 里「一次性会话产出助手回复」是写死的 `true`，所以 provider 挂掉时它也会 PASS —— 真正的症状是后面「卡片上没有 btw 按钮」。
- **跑完验证必须 `node scripts/clean-probes.mjs`（先停服务）**。探测会话是真实会话：会话目录、画布工作区、pi-web 的 `projectOrder`/孤儿归档标记都会留下，累积到 24 个 thread / 85MB 数据文件，每次保存要写 78MB。
- **`clean-probes` 绝不能碰活实例的锁与临时文件 —— 它以前会，后果是真人丢数据。** 它曾经写死扫 `~/.pi/agent/synapse` 并见文件就删，于是 `npm run verify`（`--data <临时文件>`）把用户正在跑的那个实例的 `<data>.<pid>.tmp` 和 `<data>.instance` 一起删了：前者让那次写入的 rename 报 ENOENT（**那一笔改动静默丢失**），后者只在启动时写一次，于是那个实例**从此裸奔**（第二个实例可以同时写同一份文件，正是坑 36 的地形）。现在两条规矩：① 只碰**本次 `--data` 那份数据文件**的附属产物；② 持有者还活着就不碰（pid 从文件名或 JSON 里读，判活走 `commandLineLooksLikeOurs`，**判不出来按活着算**）。回归：`verify-clean-probes.mjs`（用 `--dry-run` 只验决策不落盘）。
- **端口上的进程可能是父进程**：先 `netstat` 拿 PID，再 `wmic process where "ProcessId=<pid>" get CommandLine` 看它是不是在跑 `bin/synapse.js`。实测过两个实例同时在跑（一个持锁监听、一个是它的子进程），只 kill 监听的那个会留下另一个继续写文件（同坑 33/36）。残留的 `workspaces.json.<pid>.tmp` 表示「写到一半死的」。
- **动手前先列全部实例，不要只列监听端口的那个**：`wmic process where "name='node.exe'" get ProcessId,ParentProcessId,CommandLine`，任何命令行里含 `synapse.js` 的都算。本轮实测发现**第三个实例**在 30143 端口、用 `--data <临时文件>` 跑了很久（另一个会话/更早的调试留下的），它一直在写自己的 78MB 副本 —— 这才是「服务反复莫名死掉」的真凶，而只 kill 30142 上的监听者永远看不到它。
- 一次性会话的 cwd 会污染两处：会话目录 + pi-web 的 `pi-web-session-state.json` 的 `projectOrder`。**必须在停掉服务后清理**，否则 pi-web 会把它写回去。


## 坑（本主题）

编号是全仓库的 ID，索引见 [README.md](README.md)。

15. **画布用 CSS transform 缩放，卡片可能在视口外且永远不可点击。** 验证交互时直接派发事件（`dispatchEvent(new MouseEvent('click', {bubbles:true}))`），且必须锁定同一个 `data-card` —— 重渲染后 `.first()` 会指向另一张卡。
19. **画布数据文件会累积历史探测的 thread。** 按 `.first()` 选按钮会点到旧探测会话上，得出「功能没生效」的错误结论。验证时必须先把 `sessionId` 映射成 `threadId`，再按 `data-thread` 精确点击。
21. **本机默认模型 `qoder-cn/dfmodel` 不可用**（返回 `stopReason: "error"` 且内容为空）。测流式前先 `set_model` 换到 `trae/deepseek-v4.1-flash`，否则会误判成「流式坏了」。
33. **测写盘 bug 前先确认只有一个实例在跑。** 验证脚本反复「重启服务」时，若只 kill 当前监听的 PID，先前启动但绑定失败的实例仍会留在后台同时写同一个文件。用 `wmic process where "name='node.exe'" get ProcessId,CommandLine | grep -i synapse` 清干净。

---

## 附：一个被修掉的历史问题

## 24. 探测工作区会永久堆积（2026-10-13，已修）

`_probe-cwd` 每跑一次验证就多留一个工作区（实测累积到 24 个 thread），而探测会话是**真实
会话**：pi 写进 sessions 目录、投影建出真实工作区、pi-web 记进 `projectOrder`。删掉 cwd
目录并不会清掉这些，于是 `workspaces.json` 一路涨到 **85MB**（16,791 条消息 / 31,768 个
process 项 / 29 个工作区），每次保存要写 78MB 临时文件 + rename + 备份。

`scripts/clean-probes.mjs` 一次清干净四类残留：画布工作区、会话目录、pi-web 的孤儿归档
标记 + `projectOrder` + revision、以及锁与 `.tmp`。**必须先停服务**：store 状态在内存里，
下一次变更会把整份文件重写回去。判定用「末段路径包含 `probe`/`_e2e`」而不是前缀 ——
前缀判据漏掉了 `_e2eranch-probe`。

