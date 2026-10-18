# 投影：从 pi 会话文件到卡片

> 「一遍遍读 JSONL，把它变成画布上的轮次」这一层的事：投影规则、工具调用折叠、会话消失后的对账。
> 改 `src/project/`、`src/store/`、`src/synapse.js` 之前读这篇。

相关：[context-usage.md](context-usage.md)（同一份 JSONL 上算出的上下文占用）、[architecture.md](architecture.md)（数据模型与分层）、[runtime.md](runtime.md)（谁在什么时候触发投影）

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

排查中另一个干扰因素：**同时有 3 个 `synapse` 进程在跑**（我之前几轮验证遗留的），三者都在写同一个 `workspaces.json`。日志里已有明确告警：

```
synapse: 另一个实例正在写入 workspaces.json——请只运行一个实例
```

**教训**：验证脚本反复「重启服务」时，如果只是 `taskkill` 当前监听的 PID，先前启动但绑定失败的实例仍会留在后台。**测一个会写盘的 bug 前，必须先确认只有一个实例**：

```bash
wmic process where "name='node.exe'" get ProcessId,CommandLine | grep -i synapse
```

### 关于 545MB → 70MB 的残余体积

修复后的 70 MB 是**真实负载**，不是泄漏：`tool arguments` 21.7 MB + `tool results` 28.6 MB + 消息结构 8.1 MB + 正文 3.5 MB。来源可核对 —— 154 个会话里 toolResult 输出合计 **29.8 MB**、toolCall 参数合计 **28.2 MB**，与投影后的体积一致。

真正的风险是**单条工具输出没有上限**：一次读到巨型文件就可能让数据文件暴涨。当前真实数据里最大的单条输出只有 1.2 MB，暂不构成问题，但若要长期运行，投影层应对 `process[].result` 施加与消息正文相同的截断策略（`MAX_PROJECTION_LENGTH`）—— 目前只有消息正文有上限，工具输出没有。M6 候选。

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


## 坑（本主题）

编号是全仓库的 ID，索引见 [README.md](README.md)。

1. **`session` header 有 `id` 但没有 `parentId` 键。** 用 `e.parentId ?? null` 统一处理会把它算成第二个 root，导致每个会话都被误判有多个根。必须按 `type !== 'session'` 排除。
2. **pi 没有 turn/step 编号。** 一轮 = 两个 user 消息之间的所有条目，其中助手条目可能有多个（每个工具回合一个），且常常没有正文。工具调用按「最近一条 assistant/error 消息」折叠，未到达时先进 `pendingProcess`。
3. **工具结果靠 `parentId` 定位回合。** 一个 `toolResult` 条目的 `parentId` 就是发起调用的那个 assistant 条目。
4. **`/api/sessions/:id/context` 是窗口化的**（2882 条消息只返回 101 条，`hasMore: true`）。画布重建必须直读 JSONL，不能用它。
11. **`fs.watch` 事件数不可信。** Windows 上 100 次写入产生过 101 个事件。只能当作「有变化」的信号，真相靠重读 + mtime/size diff，并配低频轮询兜底。
25. **投影是「合并」不是「重建」。** 同一 thread 反复投影只往 `messages` 追加，删条目不会自动消失。只用于计算、不应持久化的 kind（如 `usage`）必须在 `normalizeState` 里清理（`dropTransientMessages`），否则永久留成空行。
32. **工具折叠必须幂等**（曾导致 545MB 数据文件）。`foldToolProcess` 曾经只在「最近一条 assistant 消息」里找 callId，但**投影是合并的、每次重扫都重新折叠每条 entry** —— 重扫时最近那条消息已经不是当初发起调用的那条，于是每扫一遗追加一份副本。实测重复率 86.9%、单 call 最多重复 104 次。修法：查已存 callId 时**扫描整个 thread**（消息的 `process` + `pendingProcess`）。探测手法：按 callId 去重，对比源文件 `toolCall` 条数。
40. **投影只增不减，删除要靠对账。** `scan()` 报得出「新增/变更」，报不出「删除」（文件已经没了），所以 `Synapse` 自己跑定时对账：`adapter.listSessions()` 为权威，**连续两次缺失才删**，活集为空而画布有卡则整轮跳过（那是读失败，不是用户删光了）。`hiddenSessionIds` 只剪本轮确认删除的 id。pi-web 的**归档≠删除**（文件还在 → 仍会出现在 listSessions 里），这条是承重墙，见本篇 §26。
41. **变更水位线只能由 `scan()` 推进，不能被 `listSessions()` 碰。** 两者曾共用一张 `known` 表（顺手当 header 缓存），结果对账每 5 秒调一次 `listSessions()`，会把刚变过的文件提前记成「已看过」→ 下一轮 `scan()` 判定无变化 → **那次追加永远不会被投影**。实测表现：卡片一直「正在回复」（最终 assistant 条目丢失）、3 轮探测只有 2 张卡。现在 `known`（path → signature，只归 watcher）与 `headers`（path → {signature, header}，只归 listSessions）是两张表。
