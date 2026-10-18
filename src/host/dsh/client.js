/**
 * The DSH client half of session-synapse: the 对话 / 会话地图 switch bar and the
 * frame that holds the canvas.
 *
 * Why a frame rather than a native panel: the canvas is a page of its own (its
 * own module graph, stylesheet and fonts) and DSH serves plugin routes from its
 * own web server, so `src="/synapse/"` is same-origin in the browser AND in the
 * Electron shell — the shell forwards every path outside its dist to that same
 * server (docs/dsh-desktop.md §1). Nothing here reaches into the canvas, and
 * nothing in the canvas knows which host it is under.
 *
 * Two constraints this file has to respect:
 *   - A client bundle may `require` only the application's seeded platform
 *     modules, so this file imports nothing at all — plain DOM + postMessage.
 *   - `document.body` may not exist yet when `apply` runs (the pi-web injection
 *     path hit the same floor), hence the DOMContentLoaded fallback.
 */
// `__ModuleLoader__` is the application's own bundle registrant, not a DOM global;
// the cast states that this file only makes sense inside that runtime.
const loader = /** @type {{ load: (definition: { id: string, factory: () => any }) => void }} */ (/** @type {any} */ (window).__ModuleLoader__)
loader.load({
  id: 'session-synapse',
  factory: () => {
    const module = /** @type {{ exports: any }} */ ({ exports: {} })
    // The canvas's own message namespace: `src/canvas/app.js` listens for
    // `synapse-host`, and `src/canvas/host.js` posts as `synapse`.
    const SOURCE = 'synapse-host'
    const CHILD_SOURCE = 'synapse'
    const HOST_ID = 'synapse-host'
    const CANVAS_URL = '/synapse/'
    // DSH's own chrome metric: the band above the content (Windows title bar,
    // macOS traffic lights). The switch bar and the overlay both start below it.
    const CHROME_TOP = 'var(--dsh-frame-chrome-top, var(--dsh-frame-top-clearance, 0px))'

    module.exports.inject = ['sessions']
    module.exports.apply = (/** @type {any} */ ctx) => {
      if (document.getElementById(HOST_ID) !== null) return

      const style = document.createElement('style')
      style.textContent = `
        .synapse-switch{position:fixed;z-index:400;top:calc(${CHROME_TOP} + 12px);left:50%;display:flex;gap:2px;transform:translateX(-50%);border:1px solid #eaeaea;border-radius:7px;background:rgba(255,255,255,.94);padding:3px;backdrop-filter:blur(10px)}
        .synapse-switch button{height:26px;border:0;border-radius:5px;background:transparent;padding:0 12px;color:#615e58;font:500 12px 'Geist Local',-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer;white-space:nowrap;transition:background .2s ease,color .2s ease}
        .synapse-switch button:hover{background:#f4f3f0;color:#111111}
        .synapse-switch button.active{background:#111111;color:#fff}
        .synapse-switch button:focus-visible{outline:2px solid rgba(17,17,17,.5);outline-offset:2px}
        .synapse-overlay{position:fixed;z-index:300;inset:${CHROME_TOP} 0 0 0;background:#f7f6f3}
        .synapse-overlay[hidden]{display:none}
        .synapse-overlay iframe{display:block;width:100%;height:100%;border:0}
        /* DSH publishes the resolved theme on <body>; following that (rather than
           prefers-color-scheme) keeps a manual choice in force. */
        body[data-ds-dark-theme] .synapse-switch{background:rgba(22,24,26,.94);border-color:#26282c}
        body[data-ds-dark-theme] .synapse-switch button{color:#a5a29b}
        body[data-ds-dark-theme] .synapse-switch button:hover{background:#1e2124;color:#f2f1ee}
        body[data-ds-dark-theme] .synapse-switch button.active{background:#f2f1ee;color:#111111}
        body[data-ds-dark-theme] .synapse-overlay{background:#0e0f11}
        html[data-fullscreen] .synapse-switch{top:12px}
        html[data-fullscreen] .synapse-overlay{inset:0}
      `
      document.head.append(style)

      const host = document.createElement('div')
      host.id = HOST_ID
      host.className = 'synapse-host'
      host.innerHTML = '<div class="synapse-switch" role="group" aria-label="视图切换"><button type="button" data-view="dialog" class="active" aria-pressed="true">对话</button><button type="button" data-view="map" aria-pressed="false">会话地图</button></div>'
        + `<section class="synapse-overlay" hidden><iframe title="会话地图" src="${CANVAS_URL}"></iframe></section>`
      // The plugin may be applied before <body> exists.
      if (document.body !== null) document.body.append(host)
      else document.addEventListener('DOMContentLoaded', () => { document.body.append(host) }, { once: true })

      const switchBar = /** @type {HTMLElement} */ (host.querySelector('.synapse-switch'))
      const overlay = /** @type {HTMLElement} */ (host.querySelector('.synapse-overlay'))
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
      }
      switchBar.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest('button') : null
        if (button === null) return
        show(button.dataset.view)
      })
      const onKeyDown = event => { if (event.key === 'Escape' && view === 'map') show('dialog') }
      document.addEventListener('keydown', onKeyDown)

      // ---------- the host's current session ----------
      // The Main view's own reference count is the client's current-session
      // signal (DSH 0.1.7 replaced `list.current` with exactly this); the
      // sidebar's highlighted row is derived from the same fact, so the two stay
      // in step by construction.
      const currentSessionId = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        for (const id of snapshot.ids) {
          if ((snapshot.byId[id]?.retainedBy?.mainView ?? 0) > 0) return id
        }
        return null
      }
      let lastSessionId = null
      function postCurrent() {
        const id = currentSessionId()
        if (id === lastSessionId) return
        lastSessionId = id
        send('synapse:current-session', { session: id === null ? null : { id } })
      }

      // ---------- theme ----------
      const postTheme = () => send('synapse:theme', { dark: document.body?.hasAttribute('data-ds-dark-theme') === true })
      const themeObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(postTheme)
      themeObserver?.observe(document.body ?? document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

      // ---------- messages from the canvas ----------
      const onMessage = event => {
        if (event.origin !== location.origin) return
        const data = event.data
        if (data === null || typeof data !== 'object' || data.source !== CHILD_SOURCE) return
        if (data.type === 'synapse:map-ready') {
          postTheme()
          postCurrent()
          return
        }
        if (data.type === 'synapse:open-session' && typeof data.sessionId === 'string') {
          // Selecting a session and showing its conversation is one workspace
          // navigation action in DSH. Resolved lazily: the ui-workspace client
          // plugin may not have provided the service while this one loads.
          const workspace = ctx.get('uiWorkspace')
          if (workspace === undefined) return send('synapse:bridge-error', { message: '宿主不支持切换会话' })
          try {
            workspace.openSession(data.sessionId)
            show('dialog')
          } catch {
            send('synapse:bridge-error', { message: '关联的 DSH 会话已不可用' })
          }
        }
      }
      window.addEventListener('message', onMessage)

      const unsubscribeSessions = ctx.sessions.list.subscribe(() => {
        postCurrent()
        // A first report for a newly attached session happens here, after the
        // list itself settled.
        if (!overlay.hidden) postCurrent()
      })

      ctx.effect(() => () => {
        switchBar.removeEventListener('click', show)
        document.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('message', onMessage)
        themeObserver?.disconnect()
        unsubscribeSessions()
        host.remove()
        style.remove()
      }, 'synapse: view switch')

      postTheme()
      postCurrent()
    }
    return module.exports
  },
})
