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
 *
 * WHERE THE SWITCH BAR LIVES: in the header's own action corner — the row that
 * holds “open in application”, the overflow menu and the panel toggle — so it
 * sits beside them instead of floating over the session title. DSH publishes no
 * slot for that corner, so the bar is moved into it by DOM, matched on the
 * CSS-module LOCAL name (`*_headerCorner`, stable across builds while the hash
 * prefix is not). Two consequences worth stating:
 *
 *   - the overlay starts BELOW that header, so the header (and the switch bar
 *     inside it) stays visible and clickable in map view — a bar inside a header
 *     the canvas covers would be unreachable exactly when it is needed;
 *   - when the corner is absent (a fullscreen frame, a future layout), the bar
 *     falls back to its own container as a floating pill and the reason is
 *     logged — a placement, never a feature, degrades.
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
    // The header's action corner, by CSS-module local name.
    const HEADER_CORNER = '[class*="_headerCorner"]'
    // How far down the canvas starts: the header's own bottom edge, published as
    // a custom property so the overlay's `inset` can read it.
    const HEADER_BOTTOM_VAR = '--synapse-header-bottom'

    module.exports.inject = ['sessions']
    module.exports.apply = (/** @type {any} */ ctx) => {
      if (document.getElementById(HOST_ID) !== null) return

      const style = document.createElement('style')
      style.textContent = `
        /* In the header corner: the app's own small-button metrics and design
           tokens, so it reads as part of the row and follows the theme. */
        .synapse-switch{display:flex;align-items:center;gap:2px;height:28px;margin-inline-end:4px}
        .synapse-switch button{height:28px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;padding:0 10px;color:var(--dsw-alias-label-secondary,#615e58);font:500 12px/1 inherit;white-space:nowrap;cursor:pointer}
        .synapse-switch button:hover{background:var(--dsw-alias-interactive-bg-hover,#f4f3f0);color:var(--dsw-alias-label-primary,#111111)}
        .synapse-switch button.active{background:var(--dsw-alias-button-primary-fill,#111111);color:var(--dsw-alias-label-primary-foreground,#fff)}
        .synapse-switch button:focus-visible{outline:2px solid var(--dsw-alias-border-l3,#111111);outline-offset:2px}
        /* No corner to sit in: back to a floating pill above everything. */
        .synapse-host > .synapse-switch{position:fixed;z-index:400;top:calc(var(--dsh-frame-chrome-top, 0px) + 12px);left:50%;transform:translateX(-50%);height:auto;gap:2px;border:1px solid var(--dsw-alias-border-l2,#eaeaea);border-radius:7px;background:var(--dsw-alias-bg-base,rgba(255,255,255,.94));padding:3px;backdrop-filter:blur(10px)}
        /* Starts below the host header so the header stays usable in map view. */
        .synapse-overlay{position:fixed;z-index:300;inset:var(${HEADER_BOTTOM_VAR}, 0px) 0 0 0;background:var(--dsw-alias-bg-base,#f7f6f3)}
        .synapse-overlay[hidden]{display:none}
        .synapse-overlay iframe{display:block;width:100%;height:100%;border:0}
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

      // ---------- placement ----------
      /**
       * Move the bar into the header corner, and keep the overlay starting below
       * that header.
       *
       * Called from a MutationObserver as well as at startup, because React owns
       * that corner: a session switch or a theme change re-renders the header and
       * can drop a node it did not create. The check is cheap and idempotent —
       * one query and one rect read when nothing moved.
       */
      let placementFrame = 0
      function syncPlacement() {
        const corner = document.querySelector(HEADER_CORNER)
        if (corner === null) {
          if (switchBar.parentElement !== host) host.prepend(switchBar)
          document.documentElement.style.setProperty(HEADER_BOTTOM_VAR, '0px')
          return
        }
        if (switchBar.parentElement !== corner) corner.prepend(switchBar)
        const header = corner.closest('header') ?? corner
        const bottom = Math.round(header.getBoundingClientRect().bottom)
        if (bottom > 0) document.documentElement.style.setProperty(HEADER_BOTTOM_VAR, `${bottom}px`)
      }
      const schedulePlacement = () => {
        if (placementFrame !== 0) return
        placementFrame = window.requestAnimationFrame(() => { placementFrame = 0; syncPlacement() })
      }
      const placementObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedulePlacement)
      placementObserver?.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
      window.addEventListener('resize', schedulePlacement)

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
      const onSwitchClick = event => {
        const button = event.target instanceof Element ? event.target.closest('button') : null
        if (button === null) return
        show(button.dataset.view)
      }
      switchBar.addEventListener('click', onSwitchClick)
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

      // ---------- live replies ----------
      // Two things the canvas needs while a turn runs: that the session IS
      // running (authoritative, straight from the host's session list) and the
      // assistant text as it streams. The text lives in the session's own event
      // window, where in-flight chunks arrive as transient `assistant/live-chunk`
      // rows; reading them requires holding a reference, so only RUNNING
      // sessions are retained.
      const SESSION_SOURCE = 'synapse'
      const live = new Map()
      let runningIds = new Set()

      /** Concatenated text deltas of one window, in block order. */
      const liveText = window => {
        const parts = []
        for (const entry of window?.entries ?? []) {
          if (entry.type !== 'transient') continue
          const chunk = entry.event?.data?.chunk
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push({ index: chunk.index ?? 0, text: chunk.text })
        }
        return parts.sort((left, right) => left.index - right.index).map(part => part.text).join('')
      }

      const publishLive = id => {
        const record = live.get(id)
        send('synapse:live-reply', { sessionId: id, running: true, text: record?.source === undefined ? '' : liveText(record.source.getSnapshot()) })
      }

      const detachLive = (id, record) => {
        record.unsubscribe?.()
        record.reference.release()
        live.delete(id)
      }

      /**
       * Attach/release live readers and report running state.
       *
       * RE-ENTRANCY: this runs from a `ctx.sessions.list` subscriber, and
       * `ctx.sessions.retain()`/`release()` publish into that same snapshot —
       * the retention counts are part of a list row. Without the guard the
       * first retain re-enters this function from inside itself and recurses
       * until the stack blows (measured: `RangeError: Maximum call stack size
       * exceeded` raised from the client store's subscriber, with the whole
       * client UI left half-updated). Dropping the nested pass is safe: the
       * outer one is still running and finishes the same work.
       */
      let syncingLive = false
      const syncLive = () => {
        if (syncingLive) return
        syncingLive = true
        try {
          const snapshot = ctx.sessions.list.getSnapshot()
          const next = new Set(snapshot.ids.filter(id => snapshot.byId[id]?.running === true))
          for (const id of next) {
            if (live.has(id)) continue
            try {
              const reference = ctx.sessions.retain(id, { source: SESSION_SOURCE })
              const record = { reference, source: undefined, unsubscribe: undefined }
              live.set(id, record)
              void reference.ready.then(() => {
                // The reference may have been released while the open was in flight.
                if (live.get(id) !== record) return
                record.source = reference.binding.eventSource
                record.unsubscribe = record.source.subscribe(() => publishLive(id))
                publishLive(id)
              }, () => {})
            } catch {
              // A session that cannot be retained still reports its running state.
            }
          }
          for (const [id, record] of [...live]) {
            if (next.has(id)) continue
            detachLive(id, record)
            send('synapse:live-reply', { sessionId: id, running: false, text: '' })
          }
          // First report for a session that just started running; the text
          // arrives when the retained window opens.
          for (const id of next) if (!runningIds.has(id)) publishLive(id)
          runningIds = next
        } finally {
          syncingLive = false
        }
      }

      // ---------- messages from the canvas ----------
      const onMessage = event => {
        if (event.origin !== location.origin) return
        const data = event.data
        if (data === null || typeof data !== 'object' || data.source !== CHILD_SOURCE) return
        if (data.type === 'synapse:map-ready') {
          postTheme()
          postCurrent()
          // A freshly loaded canvas missed every earlier transition, so the
          // running set is re-reported in full rather than diffed.
          runningIds = new Set()
          syncLive()
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
        syncLive()
      })

      ctx.effect(() => () => {
        switchBar.removeEventListener('click', onSwitchClick)
        document.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('resize', schedulePlacement)
        window.removeEventListener('message', onMessage)
        placementObserver?.disconnect()
        themeObserver?.disconnect()
        unsubscribeSessions()
        for (const [id, record] of [...live]) detachLive(id, record)
        host.remove()
        style.remove()
        document.documentElement.style.removeProperty(HEADER_BOTTOM_VAR)
      }, 'synapse: view switch')

      syncPlacement()
      postTheme()
      postCurrent()
      syncLive()
    }
    return module.exports
  },
})
