/**
 * Everything the canvas says to the host, in one place.
 *
 * Two channels, and the difference matters:
 *
 *   - `/synapse/api/*` is Synapse's own HTTP API (`api`).
 *   - `/api/*` is pi-web's, reached directly because the proxy puts the canvas
 *     on pi-web's origin. These calls MUST run in the browser: pi-web requires
 *     `Origin` to equal its own `Host`, and a server-side fetch has no page
 *     origin at all — which is also why the write actions live here rather than
 *     in the Synapse server.
 *
 * The parent frame is a third channel, used only for things that must change
 * the host's own view (`post`).
 *
 * WHERE A WRITE GOES is the host's decision, not the canvas's: `/synapse/api/status`
 * reports a `writeTransport`, and `useWriteTransport()` installs it.
 *
 *   - `'host'` (pi-web) — the browser calls the host's own API as above.
 *   - `'synapse'` (DSH) — the browser calls `/synapse/api/host/*` and the host
 *     plugin, which runs inside the harness and owns the session services,
 *     performs it. A page cannot reach those services, and pi-web's trick does
 *     not transfer: there is no origin to share with a cordis service.
 *
 * The canvas only ever calls the SEMANTIC operations below (`hostSendMessage`,
 * `hostForkSession`, …), so no host's command vocabulary leaks into `app.js`.
 */

export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? '请求失败')
  return body
}

/**
 * Call pi-web's own API. The proxy makes the canvas same-origin with pi-web, so
 * this is a plain relative fetch — but it must run in the BROWSER: pi-web
 * requires `Origin` to equal its own `Host`, and a server-side fetch has no
 * page origin at all.
 */
export async function piWeb(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) throw new Error(body.error?.message ?? body.error ?? '宿主拒绝了这次操作')
  return body
}

/** Ask the parent frame to switch the host's view. */
export function post(type, payload = {}) {
  if (window.parent === window) return
  window.parent.postMessage({ source: 'synapse', type, ...payload }, window.location.origin)
}

// Opening a session is a whole-page navigation on pi-web: it reads `?session=`
// only while initializing and exposes no in-page switch API, so the parent
// frame performs it, in pi-web's own document. DSH's parent answers the same
// message by asking its workspace UI to show that session.
export function openSessionInHost(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  post('synapse:open-session', { sessionId })
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/**
 * Which channel the semantic write operations use.
 *
 * Defaults to `'host'` because that is what the canvas did before the field
 * existed: a status response that omits `writeTransport` (an older server, a
 * page loaded against a host that never answered) must not silently reroute
 * writes to routes that may not be there.
 */
let writeTransport = 'host'

/**
 * Install the transport the host reported.
 *
 * An unknown value throws instead of falling back: it means the canvas and the
 * host disagree about the protocol, and guessing would send the write to the
 * wrong place — the exact failure this field exists to prevent.
 *
 * @param {string|undefined} name
 */
export function useWriteTransport(name) {
  if (name === undefined) return
  if (name !== 'host' && name !== 'synapse') throw new Error(`宿主报告的写操作通道无法识别：${String(name)}`)
  writeTransport = name
}

function requireSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('该节点没有关联的会话')
  return sessionId
}

/** pi-web's command channel for one session. */
async function hostCommand(type, payload) {
  const sessionId = requireSession(payload.sessionId)
  const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, ...payload }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) throw new Error(body.error?.message ?? body.error ?? '宿主未接受这条命令')
  return body.data ?? body
}

/** Send one message (with its images) into a session. */
export async function hostSendMessage(sessionId, text, images = []) {
  requireSession(sessionId)
  if (writeTransport === 'synapse') {
    await api('/synapse/api/host/prompt', { method: 'POST', body: JSON.stringify({ sessionId, text, images }) })
    return
  }
  await hostCommand('prompt', { sessionId, message: text, images })
}

/** Ask the host for a usable session on a cwd, creating one when needed. */
export async function hostEnsureSession(cwd) {
  if (writeTransport === 'synapse') {
    const body = await api('/synapse/api/host/session', { method: 'POST', body: JSON.stringify({ cwd }) })
    if (typeof body.sessionId !== 'string' || body.sessionId === '') throw new Error('宿主无法创建会话')
    return { id: body.sessionId }
  }
  const response = await fetch('/api/agent/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, type: 'ensure_session' }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) throw new Error(body.error ?? '宿主无法创建会话')
  return { id: body.sessionId }
}

/**
 * Fork a session, at one entry when the host can express it.
 *
 * pi-web's `fork_branch` command forks at a SPECIFIC entry (its own "ask in a
 * new chat" uses exactly this); its REST fork endpoint always forks at the
 * current leaf and cannot express "branch off turn N".
 */
export async function hostForkSession(sessionId, entryId = undefined) {
  requireSession(sessionId)
  const at = typeof entryId === 'string' && entryId !== '' ? entryId : undefined
  if (writeTransport === 'synapse') {
    const body = await api('/synapse/api/host/fork', { method: 'POST', body: JSON.stringify({ sessionId, entryId: at }) })
    if (typeof body.sessionId !== 'string' || body.sessionId === '') throw new Error('宿主无法创建分支')
    return { id: body.sessionId, title: null }
  }
  if (at !== undefined) {
    const data = await hostCommand('fork_branch', { sessionId, entryId: at })
    if (typeof data?.newSessionId !== 'string') throw new Error('宿主无法创建分支')
    return { id: data.newSessionId, title: null }
  }
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || typeof body.sessionId !== 'string') throw new Error(body.error ?? '宿主无法创建分支')
  return { id: body.sessionId, title: body.session?.name ?? null }
}

/** Rename the host's own record of a session. */
export async function hostRenameSession(sessionId, name) {
  requireSession(sessionId)
  const title = String(name ?? '').trim()
  if (title === '') throw new Error('名称不能为空')
  if (writeTransport === 'synapse') {
    await api('/synapse/api/host/rename', { method: 'POST', body: JSON.stringify({ sessionId, title }) })
    return
  }
  await piWeb(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: JSON.stringify({ name: title }) })
}

/** Archive (or restore) the session in the host's own list. */
export async function hostArchiveSession(sessionId, archived = true) {
  requireSession(sessionId)
  if (writeTransport === 'synapse') {
    await api('/synapse/api/host/archive', { method: 'POST', body: JSON.stringify({ sessionId, archived: archived === true }) })
    return
  }
  // pi-web keys archive state by session FAMILY root; a standalone session is
  // its own root. Both directions are `action: "set"` — `restore` is a
  // different request that replays an exact prior-values snapshot for undo.
  await piWeb('/api/sessions/ui-state', {
    method: 'POST',
    body: JSON.stringify({ action: 'set', ids: [sessionId], archived: archived === true }),
  })
}

/**
 * Create a /btw side question: fork with inherited context, pin its tools, keep
 * it out of the host's main session list.
 *
 * Both hosts perform the pin themselves, through `/synapse/api/host/btw` and
 * the `'synapse'` transport (DSH) — a tool loadout there is a scoped effect on
 * one agent, which no page can reach. pi-web is the opposite: it persists a
 * per-session loadout as a `custom` entry in the NEW session file, and its
 * command channel only exists on its own origin, so the browser does it in
 * three calls here:
 *
 *   1. fork      — the only way to inherit REAL history; a text-injected
 *                  context would need a model-calling runtime the canvas does
 *                  not have.
 *   2. set_tools — pin the loadout on the child. The parent is untouched.
 *   3. archive   — keep the main list clean. The session stays fully usable
 *                  from the archive view, so a btw question can still be
 *                  continued there later.
 *
 * pi-web keeps forking at the leaf, as it always has (`entryId` is only
 * expressible on the hosts that take it, and changing pi-web's fork point is
 * not this function's business).
 *
 * @param {string} sessionId
 * @param {string[]} tools  the loadout to pin; must name at least one tool
 * @param {string} [entryId]  fork at this entry instead of at the leaf
 */
export async function hostBtwSession(sessionId, tools, entryId = undefined) {
  requireSession(sessionId)
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('侧问至少要给一个工具')
  const at = typeof entryId === 'string' && entryId !== '' ? entryId : undefined
  if (writeTransport === 'synapse') {
    const body = await api('/synapse/api/host/btw', { method: 'POST', body: JSON.stringify({ sessionId, entryId: at, tools }) })
    if (typeof body.sessionId !== 'string' || body.sessionId === '') throw new Error('宿主无法创建侧问')
    return { id: body.sessionId, title: null }
  }
  const forked = await hostForkSession(sessionId)
  await hostCommand('set_tools', { sessionId: forked.id, toolNames: tools })
  try {
    await hostArchiveSession(forked.id, true)
  } catch {
    // Archiving is cosmetic: a side question that failed to archive is still a
    // working side question, so this must not fail the whole action.
  }
  return forked
}

// ---------------------------------------------------------------------------
// session-to-session calls (dsh-intercom's panel routes)
// ---------------------------------------------------------------------------

/**
 * The intercom panel routes are reached exactly like `/synapse/api/*`: a plain
 * relative fetch from the page, because they are served by the SAME web server
 * that serves this canvas. Two consequences the callers depend on:
 *
 *   - It must be same-origin. The routes send no CORS header, so a page on any
 *     other origin cannot read the answer — which is also why pi-web (a
 *     different origin, and no intercom at all) can never use them.
 *   - The transport gate is explicit and never falls back. `dsh-intercom` is an
 *     independent package; guessing at a route that is not there would turn a
 *     missing plugin into a broken button.
 */
function requireIntercomTransport() {
  if (writeTransport !== 'synapse') throw new Error('当前宿主没有会话互通通道')
}

/** A session id that must be present; `what` names it in the error. */
function requireTarget(id, what) {
  if (typeof id !== 'string' || id === '') throw new Error(`${what}不能为空`)
  return id
}

/**
 * One call to the panel routes.
 *
 * Deliberately NOT `api()`: that helper reports `body.error ?? '请求失败'`, and a
 * refused send answers 502 with `{ delivered: false, reason }` — the reason IS
 * the message the user needs ("Session not found"), so it must not be replaced
 * by a generic one.
 */
async function intercomRequest(path, options = {}) {
  requireIntercomTransport()
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? body.reason ?? '会话互通请求失败')
  return body
}

/**
 * The live intercom roster: `{ enabled, transport, sessions, senders }`.
 *
 * This doubles as the availability probe. "The plugin is not installed" is a
 * 404 here, which is an ordinary answer rather than a failure to report, so the
 * probe caller is allowed to swallow the throw — see `app.js`, where a failed
 * probe only means the call button is not rendered.
 */
export async function intercomRoster() {
  return intercomRequest('/intercom/roster')
}

/**
 * Send one message from a local session to another session.
 *
 * `from` must be a session THIS harness process hosts (the roster's `senders`);
 * the panel rejects anything else with a 400. The receiving session treats the
 * message as a real turn, which is why the canvas asks for confirmation first.
 */
export async function intercomSend(from, to, message) {
  requireTarget(from, '呼叫方')
  requireTarget(to, '目标会话')
  if (typeof message !== 'string' || message.trim() === '') throw new Error('呼叫内容不能为空')
  await intercomRequest('/intercom/send', { method: 'POST', body: JSON.stringify({ from, to, message }) })
}

/**
 * Set a session's intercom alias.
 *
 * Called after a rename so the caller shows up as a name in the OTHER session's
 * transcript instead of an id prefix. `dsh-intercom` publishes this alias from
 * the process that hosts the session, so only a local session can be named; it
 * also mirrors the alias onto the session title.
 */
export async function intercomName(sessionId, alias) {
  requireTarget(sessionId, '会话')
  const name = String(alias ?? '').trim()
  if (name === '') throw new Error('呼叫方名字不能为空')
  await intercomRequest('/intercom/name', { method: 'POST', body: JSON.stringify({ session: sessionId, alias: name }) })
}
