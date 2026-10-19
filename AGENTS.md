# session-synapse 开发须知

把 pi 的会话文件投影成一张可拖拽的画布，并把它嵌进 pi-web。面向 agent 的开发要点，**细节在 `docs/`**。

## 命令

```bash
npm run check          # tsc -p jsconfig.json，基线必须是 0
npm test               # 136 个单测
npm run verify         # 全套回归（需 pi-web 在 30100）：起服务 → 23 个套件 → 清理 → 汇总表
npm run verify:dsh     # DSH 适配（需 dsh CLI + 凭据）：自己起隔离 harness，43 项
```

改了代码先 `npm run check`；改了行为跑相关套件（清单与探测纪律见 `docs/verification.md`）。**观感类改动只能看图验，不能靠断言。**

## 改之前读哪篇

| 要动的东西 | 先读 |
|---|---|
| 分层、数据模型、adapter 契约、仓库结构 | `docs/architecture.md` |
| pi JSONL → 卡片、工具折叠、会话删除对账 | `docs/projection.md` |
| 上下文占用圆环的数字 | `docs/context-usage.md` |
| pi-web 接口、导航、分支/侧问、图片、改名归档 | `docs/host-integration.md` |
| 画布视觉与交互 | `docs/canvas-ui.md` |
| 服务端路由、能力声明、单实例锁、写盘 | `docs/runtime.md` |
| 静态检查、验证套件、探测纪律 | `docs/verification.md` |
| DSH / dsh desktop 适配（服务面、装插件、转发规则） | `docs/dsh-desktop.md` |

`docs/README.md` 是索引：还有「坑编号 → 文件」对照表。**跨篇引用的编号（`§15`、`坑 22`）是全仓库 ID，别重编号。**

## 铁律

这些都是「不遵守就静默坏掉、而且很难查」的那几条。专题规则在各自文档里。

1. **不写行尾分号，所以任何一行都不能以 `(` 或 `[` 开头。** `history.scrollRestoration = 'manual'` 后面接 `(window).__synapse = …` 会被解析成 `'manual'(window)` → 抛 `"manual" is not a function`，**画布整页空白而外层页面无任何报错**（只有 iframe 的 pageerror 有）。
2. **类名与 `data-*` 是验证脚本的选元素契约。** 改样式可以，改名字必须同步改 `scripts/verify-*.mjs`。
3. **居中用 `translate`，不要用 `transform: translateX(-50%)`。** 全局 `button:active { transform: scale(.98) }` 会把 `transform` 整个换掉（抓手曾因此按下即右跳 13px）。
4. **结构性 `display` 必须写在各自的选择器里**，禁止 `.a, .b, .c { display: flex }` 这种共享列表 —— 删一个类会静默带走其余组件的布局。
5. **写操作必须在浏览器里发起**（改名/归档/fork）：服务端 `fetch` 没有页面 origin，pi-web 要求 `Origin` 等于自身 `Host`。服务端只用 `/synapse/api/status` 声明能力。
6. **探测不许对真实会话发消息**（pi 会当成真 prompt 跑起来并写文件）；用完必须清干净。做法见 `docs/verification.md`。
7. **同一份画布数据只能有一个写入者。** 动手杀进程前先列全部实例（`wmic process where "name='node.exe'" get ProcessId,CommandLine` 里凡是 `synapse.js` 都算），只 kill 监听端口的那个会留下另一个继续写文件 —— 这是数据被放大的真凶。
8. **`clean-probes` / 任何清理脚本都不许碰活实例的锁与临时文件。** 删掉写入中的 `<data>.<pid>.tmp` 会让那笔保存静默丢失，删掉 `<data>.instance` 会让实例从此裸奔。

## 已验证的上游版本

pi-web **0.12.0**（commit `894e1a2`）、pi **1.1.0**、Node 24.14.0。上游源码克隆在 `.pi-web-src/`（开发期参考，已 gitignore）。adapter 依赖 pi-web 的内部 HTTP 契约，升级要重新核对端点与字段。

DSH 侧：dsh **0.2.1-rc.2**（desktop app 内置运行时，profile `~/.dsh/profiles/desktop`）。DSH adapter 依赖 `ctx.webServer` / `ctx.sessions` / `ctx.sessionQuery` 与 client 侧的 `ctx.sessions` / `ctx.uiWorkspace`，升级同样要重新核对。

## 文档约定

- `README.md` 面向使用者，不写实现细节。
- `AGENTS.md`（本文件）只放**开发必知**：命令、读哪篇、铁律。
- 其余一切（设计取舍、实测数据、被否掉的方案、踩过的坑）放 `docs/`，按主题分篇，入口 `docs/README.md`。
