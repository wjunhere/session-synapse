# session-synapse 文档

按「你要动什么」找入口。每篇只讲自己的事，越往下越细；**不要一次全读**。

| 你要动的东西 | 先读 |
|---|---|
| 模块边界、数据模型、adapter 契约、仓库结构 | [architecture.md](architecture.md) |
| pi JSONL → 卡片、工具折叠、会话删除对账 | [projection.md](projection.md) |
| 上下文占用圆环里的数字 | [context-usage.md](context-usage.md) |
| pi-web 接口、导航、分支/侧问、图片、改名与归档 | [host-integration.md](host-integration.md) |
| DeepSeek Harness（desktop app / web profile）适配 | [dsh-desktop.md](dsh-desktop.md) |
| 画布长什么样、卡片哪些状态、手感 | [canvas-ui.md](canvas-ui.md) |
| 服务端路由、能力声明、单实例锁、写盘 | [runtime.md](runtime.md) |
| 静态检查、单测、验证套件、探测纪律 | [verification.md](verification.md) |
| 早期里程碑实测记录（M0–M5，历史档案） | [history.md](history.md) |

- 面向使用者：[../README.md](../README.md)
- 面向 agent 的必读要点：[../AGENTS.md](../AGENTS.md) —— 本目录是它的下钻层
- 上游版本：pi-web **0.12.0**（commit `894e1a2`）、pi **1.1.0**、Node 24.14.0。adapter 依赖 pi-web 的内部 HTTP 契约，升级要重新核对端点与字段

## 约定

- **编号是全仓库的 ID，切文件时不动。** 正文里的 `§15`、`坑 22` 都靠编号互相引用（同一篇里的 `§N` 直接指本文件，跨篇的写成 `文件.md §N`）。
- 实测数据、被否掉的方案、踩过的坑都留在原处，不因为「过时」删掉 —— 它们是「为什么现在是这样」的唯一证据。

## 坑编号 → 文件

| 坑 | 文件 |
|---|---|
| 1–4、11、25、32、40、41 | [projection.md](projection.md) |
| 5–9、12–14、16–18、20、26–31 | [host-integration.md](host-integration.md) |
| 10 | [architecture.md](architecture.md) |
| 15、19、21、33 | [verification.md](verification.md) |
| 22–24、34、35 | [context-usage.md](context-usage.md) |
| 36–39、42、43 | [runtime.md](runtime.md) |
| 44–55 | [dsh-desktop.md](dsh-desktop.md) |
