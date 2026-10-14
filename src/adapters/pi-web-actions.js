/**
 * pi-web write actions, expressed as plain HTTP calls.
 *
 * These run in the BROWSER, where the canvas shares pi-web's origin (the proxy
 * guarantees it). That matters: a relative URL like `/api/sessions` only
 * resolves in a page context, and pi-web rejects any request whose `Origin`
 * does not equal its own `Host`.
 *
 * Endpoints (verified against pi-web 0.12.0):
 *   - open      whole-page navigation to `/?session=<id>`; pi-web reads the
 *               parameter only while initializing and has no in-page switch.
 *   - fork      POST /api/sessions/:id/fork
 *   - prompt    POST /api/agent/:id  { type: 'prompt' }
 *   - rename    PATCH /api/sessions/:id  { name }
 *   - archive   POST /api/sessions/ui-state  { action: 'set', ids, archived }
 */
import { capabilities, READ_ONLY_TOOLS } from './contract.js'

/** A host that rejects the call for a reason worth showing to the user. */
export class HostRequestError extends Error {}

async function requestJson(url, init, what, fetchImpl) {
  let response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    throw new HostRequestError(`${what}失败：${error?.message ?? error}`)
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) {
    throw new HostRequestError(body.error?.message ?? body.error ?? `${what}失败（HTTP ${response.status}）`)
  }
  return body
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl]      pi-web origin; same-origin by default
 * @param {(sessionId: string) => void} [options.navigate]  override for tests
 * @param {typeof fetch} [options.fetch]  override for tests
 */
export function createPiWebActions(options = {}) {
  const base = options.baseUrl ?? ''
  // `fetch` needs its two real parameters rather than a spread of `args`: a
  // spread of a rest array is not a tuple, so the override does not typecheck
  // against `typeof fetch`.
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  const navigate = options.navigate ?? (sessionId => {
    window.location.href = `/?session=${encodeURIComponent(sessionId)}`
  })

  async function openSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new HostRequestError('缺少会话 ID')
    navigate(sessionId)
  }

  async function forkSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new HostRequestError('缺少会话 ID')
    const body = await requestJson(
      `${base}/api/sessions/${encodeURIComponent(sessionId)}/fork`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      '创建分支',
      fetchImpl,
    )
    if (typeof body.sessionId !== 'string') throw new HostRequestError('宿主未返回新会话 ID')
    return body.sessionId
  }

  async function sendMessage(sessionId, text) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new HostRequestError('缺少会话 ID')
    const message = String(text ?? '').trim()
    if (message === '') throw new HostRequestError('消息不能为空')
    // A session that is streaming rejects a plain prompt, so queue instead.
    const state = await fetchImpl(`${base}/api/agent/${encodeURIComponent(sessionId)}`).then(r => r.json()).catch(() => null)
    const streaming = state?.state?.isStreaming === true
    const payload = { type: 'prompt', message }
    if (streaming) payload.streamingBehavior = 'followUp'
    await requestJson(
      `${base}/api/agent/${encodeURIComponent(sessionId)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      '发送消息',
      fetchImpl,
    )
  }

  async function renameSession(sessionId, name) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new HostRequestError('缺少会话 ID')
    const trimmed = String(name ?? '').trim()
    if (trimmed === '') throw new HostRequestError('名称不能为空')
    await requestJson(
      `${base}/api/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: trimmed }) },
      '重命名会话',
      fetchImpl,
    )
  }

  async function archiveSession(sessionId, archived) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new HostRequestError('缺少会话 ID')
    // Both directions are `action: "set"`; `restore` is a different request
    // that replays an exact prior-values snapshot for undo.
    // The state is keyed by the session FAMILY root, which for a standalone
    // session is its own id.
    await requestJson(
      `${base}/api/sessions/ui-state`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set', ids: [sessionId], archived: archived === true }),
      },
      archived === true ? '归档会话' : '取消归档',
      fetchImpl,
    )
  }

  /**
   * Pin a session's tool loadout.
   *
   * pi-web persists the selection as a `custom` entry in the session file, so
   * it is per-session and durable — a /btw side question keeps its read-only
   * tools without touching the parent session.
   */
  async function setTools(sessionId, toolNames) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new HostRequestError('缺少会话 ID')
    await requestJson(
      `${base}/api/agent/${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'set_tools', toolNames: Array.isArray(toolNames) ? toolNames : [] }),
      },
      '设置工具',
      fetchImpl,
    )
  }

  /**
   * A /btw side question.
   *
   * This is deliberately a composition of three existing host calls rather
   * than a Synapse invention:
   *
   *   1. fork — the only way to inherit real history (text-injection would
   *      need a model-calling runtime, which the canvas does not have);
   *   2. set_tools — pin the loadout to read-only. pi-web persists this as a
   *      `custom` entry in the NEW session's file, so the parent is untouched.
   *   3. archive — keep the main pi-web list clean. The session stays fully
   *      usable from the archive view, so a btw question can be continued.
   *
   * The fork must exist before set_tools: tool selection is per-session state
   * and cannot be applied to a session that is not on disk yet.
   *
   * @returns {Promise<{sessionId: string, tools: string[], archived: boolean}>}
   *   `archived` reports whether the best-effort archive call succeeded: false
   *   means the side thread exists but is still in pi-web's main list.
   */
  async function btw(sessionId, { tools = READ_ONLY_TOOLS } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new HostRequestError('缺少会话 ID')
    const pinned = Array.isArray(tools) ? tools.filter(name => typeof name === 'string') : [...READ_ONLY_TOOLS]
    const forked = await forkSession(sessionId)
    await setTools(forked, pinned)
    // Archiving is best-effort: a btw question whose archive call fails is
    // still a working side thread, so it must not be reported as a failure.
    let archived = true
    try {
      await archiveSession(forked, true)
    } catch {
      archived = false
    }
    return { sessionId: forked, tools: pinned, archived }
  }

  return {
    openSession,
    forkSession,
    sendMessage,
    renameSession,
    archiveSession,
    setTools,
    btw,
    capabilities: () => capabilities({
      openSession: true,
      forkSession: true,
      sendMessage: true,
      renameSession: true,
      archiveSession: true,
      setTools: true,
      btw: true,
    }),
  }
}