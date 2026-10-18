# 服务端运行期：路由、能力声明、单实例锁、写盘

> 进程跑起来之后的事：`/synapse/api/*` 与反代注入、能力声明、单实例锁（最危险的那块）、写盘失败的后果。
> 改 `src/server/`、`src/store/instance-lock.js`、`bin/synapse.js`、或任何会写 `workspaces.json` 的东西之前读这篇。

相关：[architecture.md](architecture.md)（分层）、[verification.md](verification.md)（`verify-single-instance` / `verify-clean-probes`）

## 17. M5 修复：单实例强制（实例锁）

[projection.md](projection.md) §16 记录了一个 545 MB 的数据文件。修掉工具折叠不幂等之后，还有**第二个成因**没有解决：当时**同时有 3 个 `synapse` 进程在跑**，都在写同一个 `workspaces.json`。

### 为什么「只检查端口」不够

先实测了一个被忽略的失败模式：

```
$ node bin/synapse.js start --port 30142   # 实例 A：正常
$ node bin/synapse.js start --port 30142   # 实例 B：端口被占
synapse: Error: listen EADDRINUSE: address already in use 127.0.0.1:30142
$ wmic process ... | grep -c synapse
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

## 22. 静态检查：能力声明与实现脱节，两个端点 500（2026-10-14，已修）

本轮对全仓做 LSP 静态检查（`jsconfig.json` + `checkJs`），共 149 条发现。其中**两条是真
bug**，都靠 `curl` 实证：

| 端点 | 修前 | 根因 |
|---|---|---|
| `POST /synapse/api/sessions/open` | **500** `TypeError: this.adapter.openSession is not a function` | 守卫测的是能力，不是方法 |
| `POST /synapse/api/threads/:id/branch`（不带 sessionId） | **500** `TypeError: this.adapter.forkSession is not a function` | 同上（实测还有第三种：若只改成 `typeof === 'function'` 而不拒绝，会静默造出 `sessionId: null` 的僵尸节点 —— 既不能追问也不能打开，比 500 更糟） |

根因是**把两个不同的问题混成一个**。`capabilities()` 回答的是「**画布**能对宿主做什么」：
pi-web 的写入由浏览器发起（同源），所以能力为 `true`，而适配器上根本没有对应方法。
`bin/synapse.js` 声明 `{openSession: true, forkSession: true, sendMessage: true, ...}`，
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

## 25. 写盘失败会让进程静默消失（2026-10-13，已修）

`markDirty()` 里是 `void this.flush()`。磁盘满时 `save()` 抛错 → **未处理拒绝 → Node 直接
退出，不打印任何东西**，只在磁盘上留下一个 `.tmp`（实测两次：pid 35780 与 25620 的 `.tmp`
与锁文件都留着，进程无输出消失）。修法：`flush()` 挂 `.catch` 打印错误并继续服务 —— 内存
状态仍然有效，下次 flush 会重试。单测 `a failed save reports the error and does not kill the
process` 用替换后的 `save()` 抛 ENOSPC 来守这条。

### 排查这类「服务莫名死掉」的正确顺序

1. **先确认端口上是谁**：`netstat -ano | grep <port>` 拿 PID，再用
   `wmic process where "ProcessId=<pid>" get CommandLine` 看它是不是**父进程**。
   实测过一次两个 `bin/synapse.js --port 30142` 同时在跑（38872 持锁并监听、46040 是它
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

## 32. `clean-probes` 删掉了活实例的锁与写入中的临时文件（2026-10-15，已修）

### 怎么发现的

验证选取修复时按规矩跑 `clean-probes.mjs`，输出里多了两行「清掉 workspaces.json.15456.tmp / workspaces.json.lock」。
同时用户那份**正在跑**的实例（PID 15456，端口 30142，默认数据文件）日志里出现：

```
synapse: 写入 …\workspaces.json 失败: ENOENT: no such file or directory,
         rename '…\workspaces.json.15456.tmp' -> '…\workspaces.json'
```

一笔保存没了 —— 它当时正要 rename 的临时文件被**我们**删掉了。同一次删除还抹掉了 `workspaces.json.instance`。

### 根因

`clean-probes` 第 4 步（清锁与临时文件）有两个错：

1. **路径写死**。它扫的是 `~/.pi/agent/synapse`，而不是「本次要清的那份数据文件所在目录」，所以带 `--data <临时文件>` 跑
   （`npm run verify` 每次都是）也会去删**真实**数据文件的附属产物。
2. **不判死活**。`<data>.<pid>.tmp`、`<data>.lock`、`<data>.instance` 的存在只说明「有过写入」或「启动过」，不说明写的人死了。
   见文件就删，等于在别人写盘的中途抽掉它的工作文件。

两个后果的严重程度不同：

| 删掉的 | 后果 |
|---|---|
| `<data>.<pid>.tmp` | 那次写入的 `rename` 报 ENOENT → **那一笔改动静默丢失**（数据没写进文件） |
| `<data>.instance` | 它只在**启动时写一次**、之后从不刷新 → 实例从此没有任何单实例保护，第二个实例可以直接抢写同一份文件（坑 36 的地形：两个写入者互相覆盖） |

所以这条不是「探测清理不方便」，而是**会损坏用户的真实画布数据**。

### 修法

第 4 步现在有两条规矩：

- **只碰本次这份数据文件的附属产物**（`dirname(dataFile)` + `basename(dataFile).` 前缀）。带 `--data` 时天然不再看真实的那个目录。
- **持有者还活着就不碰**：pid 从 `<pid>.tmp` 的文件名、或 `.lock`（裸 PID）/ `.instance`（JSON payload）的内容里读；判活走
  `commandLineLooksLikeOurs`（坑 38 的那把尺子：Windows 会回收 PID）。**判不出来按活着算** —— 留一个陈旧文件无害，
  抢一个活的不行。另外 `.before-drop` 没有 pid，照旧清。

### 验证

`scripts/verify-clean-probes.mjs`（6 项，进 `npm run verify`，非浏览器套件）：临时目录里造出
「活持有者的 `.instance` / `.lock` / `<live>.tmp`」+「死 PID 的 `<dead>.tmp`」+「同目录另一份数据文件的附属产物」，
再用 `--dry-run` 跑真脚本、断言报告里**该留的留、该清的清、别人的一个都不提**。
用 `--dry-run` 是因为它照常算出并打印决策、但不落盘：既能验逻辑，又不会在测试里去动真实的会话目录和 pi-web 状态。

### 顺带发现的两个锁问题（同一轮里一并修了，见 §33）

1. 锁的年龄上限对**活着的**持有者也生效：跑了超过 24 小时的实例，会被下一个启动者判定为陈旧并抢走 → 两个写入者。
2. 锁不会自愈：只在启动时写一次，之后不刷新，所以被误删或年龄过期都不会重新拿回来。

## 33. 锁的两处修复：活实例不再被年龄接管 + 心跳自愈（2026-10-15）

### ① 年龄上限只该管「判不出来」的持有者

`lockIsStale()` 原来是：

```js
if (!holderIsAlive(holder)) return true
… return Date.now() - Date.parse(holder.startedAt) > staleAfterMs
```

`holderIsAlive` 把「判不出来」也算成「活着」（这是对的，坑 38），但它返回的是**布尔**，于是年龄判断分不清
「确定是本进程的活实例」和「PID 存在但读不出命令行」两种情况，把前者也一起判旧了。后果：**跑了超过 24 小时的实例，
它的锁会被下一个启动者判为陈旧并抢走** —— 两个写入者同时重写同一份 88MB 文件，正是这把锁存在的理由。
本机那个 30142 的实例启动于 `2026-10-14T15:58:41Z`，发现时已 23 小时，一小时后就会踏入这个状态。

修法是把判活改成三态（`holderLiveness` → `true` / `false` / `null`），年龄上限**只对 `null` 生效**：

- `false`（进程没了，或 PID 被无关进程回收）→ 陈旧，接管；
- `true`（活着且确认是我们）→ **永不因年龄接管**；
- `null`（读不出命令行）→ 交给年龄上限，这才是「别把用户永久锁在外面」的兜底。

### ② 年龄信号从 `startedAt` 换成锁文件的 mtime，并加心跳

原来的年龄读的是 payload 里的 `startedAt`，那个值从创建的那一刻起只会越来越旧 —— 于是「不刷新」就成了必然，
锁活不过 24 小时。现在：

- **年龄 = now − 锁文件 mtime**（和 `WorkspaceStore` 给 `<data>.lock` 判陈旧用的是同一把尺子）；
- **心跳**每 5 分钟 `utimes(lockPath)` 刷新一次 mtime，`unref()` 过，不会拖住进程退出，`release()` 里清掉。

心跳**只碰 mtime、绝不重写内容**，这条是刻意的：重写有被并发读者看成半个文件的风险，而半截的锁会被判成陈旧 ——
那正好会引发这把锁要防的那种损坏。（顺带保住了 `startedAt` 的语义：它现在是「启动于」，只用于报错信息 —— 本轮手工恢复被误删的锁时也是按真实启动时间填的。）

另外加了一条防守：心跳发现锁的 pid 不是自己（被 `--force` 接管，或被别的实例抢回）时，停止心跳并**在 stderr 喊一次**
—— 那一刻已经有两个写入者了，不能装作没事。

### 验证

- `test/instance-lock.test.js`（13 项，原 10 项）：新增/改写 4 项 ——
  「活持有者不因锁旧被接管」（**它替换掉的旧测试正是断言了这个 bug**：活持有者 + `startedAt` 2020 → 期望接管）、
  「命令行读不出来时年龄仍然接管」（用清空 `PATH` 让 `wmic` 不可用，即真实的「读不出命令行」平台状态）、
  「心跳刷新 mtime」、「锁不再属于自己时不刷新」。
- `scripts/verify-single-instance.mjs`（13 项，原 11 项）新增端到端一条：把活实例的锁**两个年龄信号都做旧**
  （`startedAt` 改 2020 + mtime 改到 epoch），第二个实例仍必须被拒、且锁不能易主。在旧代码下这一条必然红。
- 心跳本身没法端到端等 5 分钟，所以用 `refresh()` 单测覆盖；`refresh` 因此是导出的公开方法（注释里写明了原因）。


## 坑（本主题）

编号是全仓库的 ID，索引见 [README.md](README.md)。

36. **单实例锁键在「数据文件」上，不是端口也不是进程。** 最危险的重复实例恰好是「端口绑定失败但进程不退出」——它从未服务过任何请求，却会一直跑投影定时器重写文件（实测就是这样涨到 545MB 的）。只查端口会正好漏掉它。锁文件是 `<data>.instance`，用 `wx` 原子创建。
37. **Windows 上 `child.kill('SIGINT')` 会直接杀死进程，不跑任何 JS handler**（实测：`SIGINT` 和 `exit` 监听器都不触发，`signalCode` 直接是 `SIGINT`）。所以被杀实例**必然**留下锁文件，`--force` 不应是常规路径——**重接管陈旧锁才是主路径**，`holderIsAlive` 的逻辑必须对。
38. **Windows 会回收 PID**，所以「该 PID 存在」不等于「持有者还活着」。回收的 PID 会让死实例看起来活着、把用户永久锁在外面。用 `commandLineLooksLikeOurs()`（wmic / `/proc`/ `ps`）做第二判据；读不到命令行时**不能当作已死**（那会让第二个实例抢走活锁、损坏数据），改由 `staleAfterMs` 兼底。
39. **启动顺序：先抢锁 → 再绑端口 → 最后投影。** 锁必须在任何写盘之前拿到（WorkspaceStore 首次运行就会建文件，迁移也会写）；端口必须在投影之前绑（端口冲突是这个进程最常见的失败，应在此刻干净退出）。
42. **锁的年龄上限只能对「判不出来」的持有者生效。** `holderLiveness` 是三态（`true` 活着且确认是我们 / `false` 已死或 PID 被回收 / `null` 读不出命令行），年龄只作用于 `null`。曾经它是布尔且年龄判断不分情形，于是**跑了超过 24 小时的活实例会被下一个启动者判为陈旧并抢走** —— 两个写入者重写同一份 88MB 文件，正是这把锁存在的理由。
43. **锁的年龄信号是锁文件的 mtime，不是 payload 里的 `startedAt`**，并且有 **5 分钟心跳**（`utimes`）让它自愈。心跳**只刷 mtime、绝不重写内容**：重写会被并发读者看成半截文件，而半截的锁会被判成陈旧 —— 那正好会引发这把锁要防的损坏。`release()` 里停心跳，心跳 `unref()` 过（测试里忘了 release 不会挂住进程）。
