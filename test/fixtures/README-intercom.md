# dsh-session-intercom.json 怎么录的

这份 fixture 是一次真实跨会话呼叫的会话日志：隔离实例里会话 A 通过 dsh-intercom 呼叫会话 B，
B 真的跑了一轮、用 intercom 工具回了 `ok`。进程侧的证据是：投递响应 `{"delivered":true}`，
B 的 roster 状态从 `idle` → `thinking` → `idle`，B 的日志里有 1 个 `turn/start`、4 个
`assistant/message`、3 个 `tool/call`，A 的日志里收到回信（`source.kind === 'intercom'`，
`senderSessionId` 是 B）。

用途：投影单测的输入。要点是那条 relay 事件：

```json
{"kind":"intercom","form":"relay","senderSessionId":"session-…","messageId":"…"}
```

日志格式与读法见 `scripts/dsh-session-events.mjs`（DSH 每个落盘批次一个 zstd 帧，
一次性 `zstdDecompressSync` 只能解出第一帧）。

## 录制步骤

全程只在临时 `DSH_HOME` 里做，绝不向真实用户会话发消息（`POST /intercom/send` 会让目标
会话真的跑起来）。下面的 `<临时目录>` 指工作盘上的一个空目录，`<dsh>` 是 dsh CLI，
`<dsh-intercom>` 是本机 dsh-intercom 仓库的路径。

```bash
DSH=<dsh>
HOME_TMP=<临时目录>/probe-home

# 1. 隔离 profile（从默认 profile 复制插件配置，不含会话）
DSH_HOME=$HOME_TMP $DSH rescue --from-default-profile web --dump-config
# 2. 只复制一份凭据，不动原文件
cp ~/.dsh/.credentials.yaml $HOME_TMP/.credentials.yaml
# 3. 装两个插件（都指向本地仓库）
DSH_HOME=$HOME_TMP MSYS2_ARG_CONV_EXCL='*' $DSH plugin --profile rescue add 'link:<dsh-intercom>'
DSH_HOME=$HOME_TMP MSYS2_ARG_CONV_EXCL='*' $DSH plugin --profile rescue add 'link:<本仓库>'
# 4. 起实例（挑一个没占用的端口，--no-open 不开浏览器）
DSH_HOME=$HOME_TMP MSYS2_ARG_CONV_EXCL='*' $DSH rescue --no-open --port 30170

# 5. 造两个会话（请求体写成文件，中文别内联进 curl 参数）
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"cwd":"<临时目录>/cwd-a"}' http://127.0.0.1:30170/synapse/api/host/session
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"cwd":"<临时目录>/cwd-b"}' http://127.0.0.1:30170/synapse/api/host/session

# 6. 呼叫：from 必须是本进程托管的会话；delivered:true 只说明投进队列了
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"from":"session-<A>","to":"session-<B>","message":"收到请只回复：ok"}' \
  http://127.0.0.1:30170/intercom/send
# 等 20s，roster 里 B 的 status 回到 idle 说明这一轮跑完了

# 7. 读 B 的日志（会话目录名由 cwd 编码而来）
node scripts/dsh-session-events.mjs "$HOME_TMP/sessions/--…cwd-b--/session-<B>/session.v4.jsonl.zstd" --types
node scripts/dsh-session-events.mjs "$HOME_TMP/sessions/--…cwd-b--/session-<B>/session.v4.jsonl.zstd" --json > raw.jsonl
```

原生 exe 的 argv 按系统 ACP 转码，中文正文内联进 `curl` 会乱码：写成文件后
`--data-binary @文件`，或以 `/` 开头的参数加 `MSYS2_ARG_CONV_EXCL='*'`。

## 从 raw.jsonl 到 fixture 的净化

事件对象一个字段都没编：只删事件、只改字符串。

1. 丢掉 `system/message` 与 `request/header`（宿主内部请求头，占了大头）；
2. 路径脱敏：探针工作目录 → `/probe/workspace`（header 的 `cwd`、relay 正文里的来源 cwd、
   `runtime-context` 的 sections 与 content 两份拷贝一起改），dsh-intercom 技能目录 →
   `/probe/dsh-intercom`，DSH 实现 checkout → `/probe/harness`；
3. 断言成品里不再出现盘符路径、仓库目录名、用户名、探针目录名。

`runtime-context`（5 段）、`skill-catalog`、`time-context` 三类注入事件都保留着：它们
`source.kind` 既不是 `user` 也不是 `intercom`，正好当投影「只放行人和 intercom」的反例。
