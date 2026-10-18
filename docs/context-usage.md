# 上下文占用（圆环里的数字）

> 画布上那个圆环代表「这个会话的上下文被用了多少」。数字必须与 pi 自己算的一致，而 pi-web 的现成字段用不了。
> 改 `src/project/context-usage.js`、`src/models/registry.js` 之前读这篇。

相关：[projection.md](projection.md)（投影条目长什么样）、[verification.md](verification.md)（`verify-context.mjs` 怎么验）

## 15. M5 实测结果（2026-10-12，已完成）

> 原 §15 讲了两个功能，本篇只留**上下文占用**那半；**`/btw` 侧问**那半在 [host-integration.md](host-integration.md) §15.4–15.7（下文的「结论一览」表仍然是当时两个功能合在一起的）。

两个新功能：**卡片上下文占用圆环**与 **`/btw` 侧问**。两者都建立在一个原则之上 —— 能复用 pi/pi-web 已有机制就不另造运行时。

> 下面这张表里与圆环无关的行（`/btw` 那几行）留在这里是为了保留当时的全貌。

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


## 坑（本主题）

编号是全仓库的 ID，索引见 [README.md](README.md)。

22. **上下文占用必须从文件算，不能用 pi-web 的 `contextUsage`。** `/api/agent/:id` 只对**已在内存中**的会话返回该字段（其余 600s idle 后被驱逐）。画布要覆盖**所有**会话，所以复刻 pi 的 `getContextUsage`：以最近一条**带 usage 的条目**为锚点，加上之后新增内容的字符估算，再除以模型上下文窗口。细节与实测见本篇 §15。
23. **`usage` 锚点会被「只思考/只调工具」的轮次带走。** 这类 assistant 条目没有 `text`，只有 `thinking`/`toolCall`；若因「没正文」就丢掉它，估算会退回纯字符数（实测差 30k+ tokens）。projector 为此产出 `kind:'usage'` 条目。
24. **`usageChars` 一个字段汇总 pi 会数、画布不显示的部分**（thinking 的长度 + toolCall 参数的 `JSON.stringify` 长度）。拆成多个字段会在「一个 entry 产出多个投影项」时被重复计数。**`arguments`（缩进美化版）不能用来估 token，会高估。**
34. **`context_edit` 与 compaction 一样会使锚点失效。** 它是“从上下文里移除一个块”（实测 312 条全是 `replacement: null`），会使上下文变小。
35. **失去锚点后的估算是「从最后一次 compaction 起」而非全量。** compaction 会用摘要**替换**它之前的历史；若把整份 transcript 加起来，曾把一个 pi 认为 0.3% 的会话报成 94.6%，会让用户误以为上下文快爆了。
