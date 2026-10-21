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
 * WHERE THE MAP LIVES: as a `conversation.view` slot entry — the same mechanism
 * 对话 / 轨迹 / 提示词 use. The host renders the tab, owns which one is active,
 * remembers it per session and switches on click, so there is no button of ours
 * to re-inject after a re-render. Two consequences worth stating:
 *
 *   - our component is mounted exactly while the map tab is active, so MOUNTING
 *     shows the canvas and UNMOUNTING hides it: the host's tab state is the only
 *     source of truth (Escape and "open this session" ask the host to activate
 *     the chat view instead of hiding the overlay behind its back);
 *   - the canvas stays an IFRAME in a fixed overlay positioned over the
 *     conversation area (below the header, the frame's centre column), not a
 *     child of the view: re-parenting an iframe reloads it, so mounting the
 *     canvas as the view body would reload the whole page — camera, selection,
 *     module graph — on every flip between 对话 and 会话地图.
 *
 * The old switch bar survives for the two cases a tab cannot cover: a host that
 * never declares `conversation.view`, and the welcome screen (no session → no
 * tab strip), where the map would otherwise be unreachable. It keeps its own
 * fallback placement as a floating pill for the same reason as before.
 */
// `__ModuleLoader__` is the application's own bundle registrant, not a DOM global;
// the cast states that this file only makes sense inside that runtime.
const loader = /** @type {{ load: (definition: { id: string, factory: (require: (name: string) => any) => any }) => void }} */ (/** @type {any} */ (window).__ModuleLoader__)
loader.load({
  // MUST be the package's own `name`, character for character: this id is the
  // module graph's row id, so a mismatch leaves the factory unregistered and the
  // client half never loads — the host renders its own UI and nothing of ours
  // (no tab, no switch bar), with no error anywhere. Verified end to end by
  // `npm run verify:dsh` (it mounts the package into a real harness).
  id: '@wjunhere/session-synapse',
  factory: require => {
    // `react` is a platform seed of the application's module table (every
    // official client bundle requires it); a view is a React component, so
    // there is no way around it. The indirection is deliberate: this file is
    // type-checked by `tsc`, which would otherwise try to RESOLVE the module
    // name against node_modules and fail (the seed exists only in the browser).
    const requireSeed = /** @type {(name: string) => any} */ (require)
    const react = requireSeed('react')
    const module = /** @type {{ exports: any }} */ ({ exports: {} })
    // The canvas's own message namespace: `src/canvas/app.js` listens for
    // `synapse-host`, and `src/canvas/host.js` posts as `synapse`.
    const SOURCE = 'synapse-host'
    const CHILD_SOURCE = 'synapse'
    const HOST_ID = 'synapse-host'
    const CANVAS_URL = '/synapse/'
    // The conversation view we register. `order` places the tab after 对话 (0),
    // 轨迹 (10) and 提示词 (20), which is where a map of the sessions belongs.
    const VIEW_ID = 'synapse-map'
    const VIEW_LABEL = '会话地图'
    const VIEW_ORDER = 30
    // The header's action corner, by CSS-module local name. Only used for the
    // fallback switch bar (see the file header).
    const HEADER_CORNER = '[class*="_headerCorner"]'
    // The frame's centre column: where the canvas belongs, so the host keeps its
    // own sidebar beside it instead of being half covered.
    const CENTRE_COLUMN = '[class*="_centerCol"]'
    // The host's conversation tab strip: the tab list that carries OUR tab. The
    // app has more than one tablist (the sidebar has its own), so "any
    // [role=tablist]" is not the question being asked — and the label we
    // registered is what makes this one ours.
    const TAB_LIST = '[role="tablist"]'
    // Where the canvas starts, published as custom properties so the overlay's
    // geometry can read them.
    const FRAME_VARS = { top: '--synapse-top', left: '--synapse-left', width: '--synapse-width' }

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
        /* The hidden attribute has to beat display:flex above. */
        .synapse-switch[hidden]{display:none}
        /* No corner to sit in: back to a floating pill above everything. */
        .synapse-host > .synapse-switch{position:fixed;z-index:400;top:calc(var(--dsh-frame-chrome-top, 0px) + 12px);left:50%;transform:translateX(-50%);height:auto;gap:2px;border:1px solid var(--dsw-alias-border-l2,#eaeaea);border-radius:7px;background:var(--dsw-alias-bg-base,rgba(255,255,255,.94));padding:3px;backdrop-filter:blur(10px)}
        /* Starts below the host header and covers the centre column only, so the
           host's sidebar stays usable beside the canvas in both views. */
        .synapse-overlay{position:fixed;z-index:300;top:var(${FRAME_VARS.top}, 0px);left:var(${FRAME_VARS.left}, 0px);width:var(${FRAME_VARS.width}, 100vw);bottom:0;background:var(--dsw-alias-bg-base,#f7f6f3)}
        .synapse-overlay[hidden]{display:none}
        .synapse-overlay iframe{display:block;width:100%;height:100%;border:0}
        /* The view body the host renders for us: an anchor to measure, never the
           canvas itself (re-parenting the iframe would reload it). */
        .synapse-view-anchor{width:100%;height:100%}
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
       * Move the FALLBACK bar into the header corner, and keep the overlay in the
       * frame's centre column below that header.
       *
       * Called from a MutationObserver as well as at startup, because React owns
       * that frame: a session switch, a theme change or a sidebar toggle
       * re-renders it and can drop a node it did not create. The check is cheap
       * and idempotent — one query and two rect reads when nothing moved.
       *
       * With the map on its own tab the overlay only needs the second half: the
       * conversation area IS the centre column below the header, so the same
       * geometry covers exactly the area our view was mounted into.
       */
      let placementFrame = 0
      function syncPlacement() {
        if (!switchBar.hidden) {
          const corner = document.querySelector(HEADER_CORNER)
          if (corner === null) {
            if (switchBar.parentElement !== host) host.prepend(switchBar)
          } else if (switchBar.parentElement !== corner) {
            corner.prepend(switchBar)
          }
        }
        const corner = document.querySelector(HEADER_CORNER)
        const root = document.documentElement.style
        const header = corner?.closest('header') ?? null
        const top = header === null ? 0 : Math.round(header.getBoundingClientRect().bottom)
        root.setProperty(FRAME_VARS.top, `${top}px`)
        // The centre column is the frame's own seat for the main panel; without
        // it (a layout we do not know) the canvas takes the full width.
        const centre = document.querySelector(CENTRE_COLUMN)
        if (centre === null) {
          root.setProperty(FRAME_VARS.left, '0px')
          root.setProperty(FRAME_VARS.width, '100vw')
          return
        }
        const rect = centre.getBoundingClientRect()
        root.setProperty(FRAME_VARS.left, `${Math.round(rect.left)}px`)
        root.setProperty(FRAME_VARS.width, `${Math.round(rect.width)}px`)
      }
      const schedulePlacement = () => {
        if (placementFrame !== 0) return
        placementFrame = window.requestAnimationFrame(() => { placementFrame = 0; syncPlacement(); updateSwitchVisibility(); syncMapWithHost() })
      }
      const placementObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedulePlacement)
      placementObserver?.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
      window.addEventListener('resize', schedulePlacement)

      // ---------- view switching ----------
      //
      // The host's tab is the source of truth: mounting the view shows the
      // canvas, unmounting hides it. `show()` therefore only ever moves the
      // overlay and marks the fallback bar — asking the host to change tabs is a
      // separate act (`activateChat`), never something this file fakes.
      let view = 'dialog'
      function show(next) {
        view = next
        overlay.hidden = next !== 'map'
        for (const button of buttons) {
          const active = button.dataset.view === next
          button.classList.toggle('active', active)
          button.setAttribute('aria-pressed', String(active))
        }
        if (next === 'map') schedulePlacement()
      }
      const onSwitchClick = event => {
        const button = event.target instanceof Element ? event.target.closest('button') : null
        if (button === null) return
        if (button.dataset.view === 'dialog') return void leaveMap()
        show('map')
      }
      switchBar.addEventListener('click', onSwitchClick)

      /**
       * Ask the host to make the chat view active for one session.
       *
       * This is how the map is LEFT whenever a tab strip exists: hiding our
       * overlay while the map tab stayed active would leave an empty view behind
       * it. Returns false when there is no tab to switch (or no session), which
       * is the signal to fall back to hiding the overlay alone.
       */
      function activateChat(sessionId) {
        const conversation = sessionId === null ? undefined : ctx.get('uiConversation')
        if (conversation === undefined || typeof sessionId !== 'string') return false
        try {
          conversation.binding(sessionId).activate('chat')
          return true
        } catch {
          // The session can be gone between the click and the call; the caller
          // hides the overlay instead, and the tab strip corrects itself.
          return false
        }
      }

      /**
       * Leave the map: back to the conversation when the host owns the tabs.
       *
       * Only a host that actually RENDERS the tab strip owns the map's
       * visibility: the welcome screen retains a session (so `activateChat`
       * happily succeeds) but has no tabs to switch, and hiding the overlay is
       * then this file's job.
       */
      function leaveMap() {
        const hostOwnsTabs = conversationTabList() !== null
        if (!hostOwnsTabs || !activateChat(lastSessionId)) show('dialog')
      }

      const onKeyDown = event => { if (event.key === 'Escape' && view === 'map') leaveMap() }
      document.addEventListener('keydown', onKeyDown)

      // ---------- the map as one of the host's conversation views ----------
      //
      // Registering a view is how 对话 / 轨迹 / 提示词 themselves get their tab:
      // the host renders the tab strip from `slots.entries('conversation.view')`,
      // keeps the active one per session, and mounts that view's component in
      // the conversation area. So there is nothing to inject and nothing to keep
      // in sync — the two effects inside `MapView` are the whole integration.
      //
      // `slots` arrives with the renderer plugin, which may apply after us: the
      // wait is `ctx.inject`, and a host that never provides it simply keeps the
      // switch bar below.
      let viewRegistered = false
      // Whether the host currently has our view mounted. With a tab strip that
      // is the ONLY thing that may show the canvas (see the effect below), and
      // the welcome screen's pill is the only other source of `view === 'map'`.
      let mapViewMounted = false
      /** The tab strip our own tab lives in, or null when none is rendered. */
      function conversationTabList() {
        for (const list of document.querySelectorAll(TAB_LIST)) {
          const tabs = [...list.querySelectorAll('[role="tab"]')]
          if (tabs.some(tab => (tab.textContent ?? '').trim() === VIEW_LABEL)) return list
        }
        return null
      }

      /**
       * What the host's tab strip says: `true` the map is the active view,
       * `false` another one is, `null` there is no strip to ask.
       *
       * The host marks the active tab with `aria-selected` and/or an
       * `*_tabActive` class (CSS-module hash prefixes change per build, the local
       * name does not), so both are accepted.
       */
      function hostShowsMap() {
        const list = conversationTabList()
        if (list === null) return null
        const tabs = [...list.querySelectorAll('[role="tab"]')]
        const active = tabs.find(tab => tab.getAttribute('aria-selected') === 'true') ?? tabs.find(tab => /Active/.test(tab.className))
        if (active === undefined) return null
        return (active.textContent ?? '').trim() === VIEW_LABEL
      }

      /**
       * Keep the fallback bar in step with the host.
       *
       * The tab strip is a DOM fact, not a session-list fact: the welcome screen
       * retains a session for its own composer but renders no tabs (measured), so
       * a current session id is NOT evidence that a tab exists. With a tab strip
       * the bar is hidden — the tab REPLACED it, not duplicated it — and without
       * one it is the only way in, as a floating pill (that screen has no header
       * corner either).
       */
      function updateSwitchVisibility() {
        const needed = !viewRegistered || conversationTabList() === null
        if (switchBar.hidden === !needed) return
        switchBar.hidden = !needed
        if (needed) schedulePlacement()
      }

      /**
       * Follow the host when it switches away from the map.
       *
       * Clicking 对话 is the host's own tab switch, so nothing unmounts and the
       * view's cleanup never runs — which matters for an overlay the welcome
       * screen's pill opened (our view was never mounted at all).
       */
      function syncMapWithHost() {
        if (view === 'map' && !mapViewMounted && hostShowsMap() === false) show('dialog')
      }

      /**
       * The view body the host renders while the map tab is active.
       *
       * It renders an anchor rather than the canvas itself (see the file header:
       * re-parenting the iframe would reload it), and treats mount/unmount as the
       * host's answer to "is the map the active view".
       */
      function MapView() {
        const anchor = react.useRef(null)
        react.useEffect(() => {
          mapViewMounted = true
          show('map')
          schedulePlacement()
          const node = anchor.current
          if (node === null || typeof ResizeObserver === 'undefined') return () => { mapViewMounted = false; show('dialog') }
          // The conversation area resizes with the host's own panels, so the
          // overlay follows the anchor rather than only the window.
          const observer = new ResizeObserver(schedulePlacement)
          observer.observe(node)
          return () => {
            observer.disconnect()
            mapViewMounted = false
            show('dialog')
          }
        }, [])
        return react.createElement('div', { className: 'synapse-view-anchor', ref: anchor })
      }

      ctx.inject(['slots'], scope => scope.slots.inject('conversation.view', () => {
        const dispose = scope.slots.register({
          name: 'conversation.view',
          id: VIEW_ID,
          order: VIEW_ORDER,
          label: () => VIEW_LABEL,
          inject: () => ({}),
        }, MapView)
        viewRegistered = true
        updateSwitchVisibility()
        return () => {
          viewRegistered = false
          dispose()
          updateSwitchVisibility()
        }
      }))

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
      // The canvas iframe loads AFTER the plugin applies, so the first post (and
      // any later one) can land in a document that has no listener yet — hence
      // `force` on the canvas's own `map-ready`, which is the one moment we know
      // it is listening. Without it the canvas never learns the host's current
      // session on a first load: the guard below suppresses every repeat.
      let lastSessionId = null
      function postCurrent(force = false) {
        const id = currentSessionId()
        if (id === lastSessionId && !force) return
        lastSessionId = id
        send('synapse:current-session', { session: id === null ? null : { id } })
        // …and the map's visibility becomes the host's business: an overlay the
        // user opened from the welcome-screen pill must not stay on top of the
        // conversation that just appeared.
        syncMapWithHost()
      }

      // ---------- theme + the host's design values ----------
      //
      // The canvas is an IFRAME, so it cannot read these itself: custom properties
      // do not cross a document boundary. Reading them here and pushing them over
      // the bridge is what lets the map follow the host's palette and typeface
      // instead of carrying a second design language into the window.
      const HOST_TOKENS = {
        bg: '--dsw-alias-bg-base',
        surface: '--dsw-alias-bg-layer-2',
        hover: '--dsw-alias-interactive-bg-hover',
        line: '--dsw-alias-border-l2',
        ink: '--dsw-alias-label-primary',
        ink2: '--dsw-alias-label-secondary',
        ink3: '--dsw-alias-label-tertiary',
        font: '--dsw-font-family',
        radiusSm: '--dsw-radius-sm',
      }
      const hostTokens = () => {
        const style = getComputedStyle(document.body ?? document.documentElement)
        const tokens = {}
        for (const [key, name] of Object.entries(HOST_TOKENS)) {
          const value = style.getPropertyValue(name).trim()
          if (value !== '') tokens[key] = value
        }
        return tokens
      }
      const postTheme = () => send('synapse:theme', { dark: document.body?.hasAttribute('data-ds-dark-theme') === true, tokens: hostTokens() })
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
          postCurrent(true)
          // The canvas brings no chrome of its own: this host already shows its
          // own sidebar and header (see `synapse:chrome` in app.js).
          send('synapse:chrome', { embedded: true })
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
            // A Team member is a delegated child session: the host maps it to a
            // transcript only through its durable parent address, not a bare
            // child id. Everything else opens by plain SessionId.
            const address = typeof ctx.sessions.subagentAddress === 'function' ? ctx.sessions.subagentAddress(data.sessionId) : undefined
            workspace.openSession(address ?? data.sessionId)
            // "Open this session" means its CONVERSATION: with the map on its own
            // tab the host would otherwise stay on whatever view that session
            // last had — the map — which is not what the button promises.
            activateChat(data.sessionId)
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
        for (const name of Object.values(FRAME_VARS)) document.documentElement.style.removeProperty(name)
      }, 'synapse: view switch')

      syncPlacement()
      updateSwitchVisibility()
      syncMapWithHost()
      postTheme()
      postCurrent()
      syncLive()
    }
    return module.exports
  },
})
