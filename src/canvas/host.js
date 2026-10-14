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
 * pi-web's own view (`post`).
 */

export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? '请求失败')
  return body
}

// The canvas is served from the same origin as pi-web (through the proxy), so
// session actions are plain requests rather than a postMessage bridge.
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

/** Ask the parent frame to switch pi-web's view. */
export function post(type, payload = {}) {
  if (window.parent === window) return
  window.parent.postMessage({ source: 'pi-synapse', type, ...payload }, window.location.origin)
}

// Opening a session is a whole-page navigation: pi-web reads `?session=` only
// while it initializes, and it exposes no in-page switch API. The parent frame
// performs it, because the navigation must happen in pi-web's own document.
export function openSessionInHost(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  post('synapse:open-session', { sessionId })
}

export async function hostCommand(type, payload = {}) {
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('该节点没有关联的会话')
  const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, ...payload }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) throw new Error(body.error?.message ?? body.error ?? '宿主未接受这条命令')
  return body.data ?? body
}

/** Ask the host for a usable session on a cwd, creating one when needed. */
export async function hostEnsureSession(cwd) {
  const response = await fetch('/api/agent/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, type: 'ensure_session' }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) throw new Error(body.error ?? '宿主无法创建会话')
  return { id: body.sessionId }
}

export async function hostForkSession(sessionId, entryId = undefined) {
  // `fork_branch` forks at a SPECIFIC entry and is the host's own command
  // (pi-web's "ask in a new chat" uses exactly this); the REST fork endpoint
  // always forks at the current leaf and cannot express "branch off turn N".
  if (typeof entryId === 'string' && entryId !== '') {
    const data = await hostCommand('fork_branch', { sessionId, entryId })
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

/**
 * Create a /btw side question.
 *
 * Three host calls, no Synapse-invented mechanism:
 *   1. fork        — the only way to inherit REAL history; a text-injected
 *                    context would need a model-calling runtime the canvas
 *                    does not have.
 *   2. set_tools   — pin read-only tools. pi-web persists this as a `custom`
 *                    entry inside the NEW session file, so the parent keeps
 *                    its own loadout.
 *   3. archive     — keep pi-web's main list clean. The session stays fully
 *                    usable from pi-web's archive view, so a btw question can
 *                    still be continued there later.
 */
export async function hostBtwSession(sessionId, tools) {
  const forked = await hostForkSession(sessionId)
  await hostCommand('set_tools', { sessionId: forked.id, toolNames: tools })
  try {
    await piWeb('/api/sessions/ui-state', {
      method: 'POST',
      body: JSON.stringify({ action: 'set', ids: [forked.id], archived: true }),
    })
  } catch {
    // Archiving is cosmetic: a side question that failed to archive is still a
    // working side question, so this must not fail the whole action.
  }
  return forked
}
