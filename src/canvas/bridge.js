/**
 * Injected into every pi-web HTML response: the pi-web half of the canvas.
 *
 * This mirrors how the original dsh-synapse integrates with DSH — a switch bar
 * plus a full-screen iframe — because pi-web offers no plugin surface to add a
 * route or a view. The proxy is what makes the iframe same-origin, which in
 * turn is what lets the canvas call `/api/*` at all.
 *
 * Responsibilities:
 *   - the 对话 / 会话地图 switch bar
 *   - the iframe overlay holding the canvas
 *   - relaying the current session, theme, and live replies to the canvas
 *   - relaying the canvas's session actions back into pi-web
 *
 * It only uses what is publicly observable (the URL, the agent SSE stream) and
 * never reaches into pi-web's React internals.
 */
;(() => {
  const SOURCE = 'pi-synapse-host'
  const CHILD_SOURCE = 'pi-synapse'
  const HOST_ID = 'pi-synapse-host'
  const CHROME_TOP = 'var(--pi-synapse-chrome-top, 0px)'

  if (document.getElementById(HOST_ID) !== null) return

  const style = document.createElement('style')
  style.textContent = `
    .pi-synapse-switch{position:fixed;z-index:400;top:12px;left:50%;display:flex;gap:2px;transform:translateX(-50%);border:1px solid #eaeaea;border-radius:7px;background:rgba(255,255,255,.94);padding:3px;backdrop-filter:blur(10px)}
    .pi-synapse-switch button{height:26px;border:0;border-radius:5px;background:transparent;padding:0 12px;color:#615e58;font:500 12px 'Geist Local',-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer;white-space:nowrap;transition:background .2s ease,color .2s ease}
    .pi-synapse-switch button:hover{background:#f4f3f0;color:#111111}
    .pi-synapse-switch button.active{background:#111111;color:#fff}
    .pi-synapse-switch button:focus-visible{outline:2px solid rgba(17,17,17,.5);outline-offset:2px}
    .pi-synapse-overlay{position:fixed;z-index:300;inset:0;background:#f7f6f3}
    .pi-synapse-overlay[hidden]{display:none}
    .pi-synapse-overlay iframe{display:block;width:100%;height:100%;border:0}
    /* Follow pi-web's resolved theme (it publishes a dark class), so a manual
       preference overrides the system setting here too. */
    html.dark .pi-synapse-switch,html[data-theme="dark"] .pi-synapse-switch{background:rgba(22,24,26,.94);border-color:#26282c}
    html.dark .pi-synapse-switch button,html[data-theme="dark"] .pi-synapse-switch button{color:#a5a29b}
    html.dark .pi-synapse-switch button:hover,html[data-theme="dark"] .pi-synapse-switch button:hover{background:#1e2124;color:#f2f1ee}
    html.dark .pi-synapse-switch button.active,html[data-theme="dark"] .pi-synapse-switch button.active{background:#f2f1ee;color:#111111}
    html.dark .pi-synapse-overlay,html[data-theme="dark"] .pi-synapse-overlay{background:#0e0f11}
  `
  document.head.append(style)

  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'pi-synapse-host'
  host.innerHTML = '<div class="pi-synapse-switch" role="group" aria-label="视图切换"><button type="button" data-view="dialog" class="active" aria-pressed="true">对话</button><button type="button" data-view="map" aria-pressed="false">会话地图</button></div><section class="pi-synapse-overlay" hidden><iframe title="会话地图" src="/synapse/"></iframe></section>'
  // The script is injected into <head>, where `document.body` may not exist yet.
  if (document.body !== null) document.body.append(host)
  else document.addEventListener('DOMContentLoaded', () => document.body.append(host), { once: true })

  // `querySelector` types its result as `Element`, which has no `hidden` and no
  // `contentWindow` — and this code already relies on the markup just assigned
  // above, so the casts state that assumption instead of leaving it implicit.
  const switchBar = /** @type {HTMLElement} */ (host.querySelector('.pi-synapse-switch'))
  const overlay = /** @type {HTMLElement} */ (host.querySelector('.pi-synapse-overlay'))
  const frame = /** @type {HTMLIFrameElement} */ (host.querySelector('iframe'))
  const buttons = [...switchBar.querySelectorAll('button')]

  const send = (type, payload = {}) => {
    if (frame.contentWindow === null) return
    frame.contentWindow.postMessage({ source: SOURCE, type, ...payload }, location.origin)
  }

  // ---------- view switching ----------
  let view = 'dialog'
  function show(next) {
    view = next
    overlay.hidden = next !== 'map'
    for (const button of buttons) {
      const active = button.dataset.view === next
      button.classList.toggle('active', active)
      button.setAttribute('aria-pressed', String(active))
    }
    if (next === 'map') {
      document.documentElement.style.setProperty('--pi-synapse-chrome-top', '0px')
      void syncRunning()
    }
  }

  switchBar.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (button === null) return
    show(button.dataset.view)
  })

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || view !== 'map') return
    show('dialog')
  })

  // ---------- current session ----------
  const currentSessionId = () => new URLSearchParams(location.search).get('session')
  let lastSessionId = null

  function postCurrent() {
    const id = currentSessionId()
    if (id === lastSessionId) return
    lastSessionId = id
    send('synapse:current-session', { session: typeof id === 'string' && id !== '' ? { id } : null })
  }

  // pi-web is client-rendered, so the URL can change without a reload.
  setInterval(postCurrent, 1_000)

  // ---------- live replies ----------
  // The canvas is a separate document, so the stream is re-read here. Only
  // sessions that are actually streaming get a subscription. Text is rebuilt
  // from `text_delta` chunks; `text_end` carries the authoritative block, so a
  // dropped delta cannot leave the canvas permanently short.
  const streams = new Map()

  function textOfBlocks(blocks) {
    if (!Array.isArray(blocks)) return ''
    return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  }

  function openStream(sessionId) {
    if (streams.has(sessionId)) return
    const controller = new AbortController()
    const record = { controller, text: '' }
    streams.set(sessionId, record)
    void (async () => {
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/events`, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!response.ok || response.body === null) return
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frameText of frames) handleFrame(sessionId, record, frameText)
        }
      } catch {
        // A closed stream is normal: the session stopped or the page navigated.
      } finally {
        streams.delete(sessionId)
      }
    })()
  }

  function handleFrame(sessionId, record, frameText) {
    for (const line of frameText.split('\n')) {
      if (!line.startsWith('data:')) continue
      let event
      try {
        event = JSON.parse(line.slice(5).trim())
      } catch {
        continue
      }
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        record.text = textOfBlocks(event.message.content)
        send('synapse:live-reply', { sessionId, running: true, text: record.text })
        continue
      }
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent
        if (update === null || typeof update !== 'object') continue
        if (update.type === 'text_delta' && typeof update.delta === 'string') {
          record.text += update.delta
          send('synapse:live-reply', { sessionId, running: true, text: record.text })
        } else if (update.type === 'text_end' && typeof update.content === 'string') {
          record.text = update.content
          send('synapse:live-reply', { sessionId, running: true, text: record.text })
        }
        continue
      }
      if (event.type === 'agent_end' || event.type === 'session_shutdown') {
        send('synapse:live-reply', { sessionId, running: false, text: record.text })
        record.controller.abort()
        streams.delete(sessionId)
      }
    }
  }

  async function syncRunning() {
    if (view !== 'map') return
    try {
      const response = await fetch('/api/agent/running')
      if (!response.ok) return
      const body = await response.json()
      const ids = Array.isArray(body.runningSessionIds) ? body.runningSessionIds.filter(id => typeof id === 'string') : []
      for (const id of ids) openStream(id)
      for (const [id, record] of [...streams]) {
        if (ids.includes(id)) continue
        // Tell the canvas BEFORE aborting. A stream can end without ever
        // delivering `agent_end` (dropped connection, server restart), and the
        // canvas has no other way to learn the run is over — without this its
        // "session is answering" state outlives the answer forever.
        send('synapse:live-reply', { sessionId: id, running: false, text: record.text })
        record.controller.abort()
        streams.delete(id)
      }
    } catch {
      // Offline or shutting down; the next tick retries.
    }
  }

  // ---------- theme ----------
  // pi-web resolves its own preference (which can override the system setting)
  // and publishes the result on `documentElement.dataset.theme`. Reading that
  // is authoritative; `prefers-color-scheme` alone would ignore a manual choice.
  const resolvedTheme = () => {
    const applied = document.documentElement.dataset.theme
    if (applied === 'dark' || applied === 'light') return applied
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  const postTheme = () => send('synapse:theme', { dark: resolvedTheme() === 'dark' })
  new MutationObserver(postTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', postTheme)

  // ---------- messages from the canvas ----------
  window.addEventListener('message', async event => {
    if (event.origin !== location.origin) return
    const data = event.data
    if (data === null || typeof data !== 'object' || data.source !== CHILD_SOURCE) return
    if (data.type === 'synapse:map-ready') {
      postTheme()
      postCurrent()
      void syncRunning()
      return
    }
    // Opening a session leaves the canvas: pi-web reads `?session=` only while
    // it initializes, and it exposes no in-page switch API.
    if (data.type === 'synapse:open-session' && typeof data.sessionId === 'string') {
      location.href = `/?session=${encodeURIComponent(data.sessionId)}`
    }
  })

  setInterval(() => { void syncRunning() }, 5_000)
  postCurrent()
  postTheme()
})()