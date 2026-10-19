/**
 * @type {HTMLElement}
 *
 * Typed, not left as `querySelector`'s `Element | null`: on a plain `Element`
 * every `addEventListener` falls back to the generic `Event` overload, so each
 * handler reading `event.clientX` / `pointerId` / `clipboardData` / `detail`
 * was reported as a type error even though the runtime event is a
 * PointerEvent / MouseEvent / ClipboardEvent. The element is guaranteed by
 * app.html, and the whole module already assumes it.
 */
import { state, persistCardPositions, persistCollapsedCards, persistQuickPhrases, rememberBranchAnchor, rememberCardPosition, resetCardPositions, resetCanvasCamera } from './state.js'
import { escapeHtml, displayText, laneColor, formatTime, formatTokens, contextRing } from './format.js'
import { inlineMarkdown, renderMarkdown } from './markdown.js'
import { ICON, ICON_PATHS, closeIcon, RENAME_ICON, HOST_ARCHIVE_ICON, EYE_ICON, EYE_OFF_ICON } from './icons.js'
import { MAX_IMAGES, MAX_IMAGE_BYTES, compressImageFile, releaseDraftImages, promptImages, draftMessageText } from './images.js'
import { MAX_QUICK_PHRASES, MAX_QUICK_PHRASE_LENGTH } from './storage.js'
import { api, post, openSessionInHost, useWriteTransport, hostSendMessage, hostEnsureSession, hostForkSession, hostRenameSession, hostArchiveSession, hostBtwSession } from './host.js'
import { hostLabels } from './host-labels.js'
const app = /** @type {HTMLElement} */ (document.querySelector('#app'))
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

// The verification scripts inspect the live canvas state (which draft is open,
// which replies are pending) from inside `page.evaluate`. In a classic script
// the top-level `const state` was reachable from the page as a global lexical
// binding; an ES module's scope is NOT, so splitting this file into modules
// silently broke those probes — the failure showed up as `state is not
// defined` inside the SUITE, not in the canvas. Exposed deliberately, under one
// name, so the contract is visible in one place.
//
// Written as `const` + assignment on purpose: a line STARTING with `(` after a
// semicolon-less statement is read as a call — `… = 'manual'` followed by
// `(window).__synapse = …` parses as `'manual'(window)`, which throws
// `"manual" is not a function` at load time and leaves the canvas blank.
const debugWindow = /** @type {any} */ (window)
debugWindow.__synapse = { state }
const CARD_WIDTH = 310
const CARD_HEIGHT = 276
const CARD_GAP_Y = 42
const CAMERA_INSET_X = 56
const CAMERA_INSET_Y = 56
// Cards outside the viewport (plus this world-space margin) are not mounted
// into the DOM; the margin pre-mounts cards just before they scroll into view
// so panning never flashes empty space.
const VIEWPORT_MARGIN = 1400

const threadColor = threadId => laneColor((state.workspace?.threads ?? []).findIndex(thread => thread.id === threadId))
const currentThread = () => state.workspace?.threads.find(thread => thread.id === state.activeId) ?? state.workspace?.threads[0] ?? null
const threadById = threadId => state.workspace?.threads.find(thread => thread.id === threadId) ?? null
/** The projected context-window figure for a thread, or null when unknown. */
const contextUsageFor = threadId => threadById(threadId)?.contextUsage ?? null
const threadListTitle = thread => thread.sessionTitle ?? thread.title ?? questionFor(thread)

// ---------------------------------------------------------------------------
// Which threads get cards
// ---------------------------------------------------------------------------
// A workspace accumulates sessions and most of them are finished work, so the
// canvas draws the ACTIVE ones and leaves the rest one click away in the sidebar
// instead of drawing everything. Two rules, in this order:
//
//   1. an explicit choice by the user (`thread.hidden`, persisted in the canvas
//      data file) always wins;
//   2. otherwise the recent-activity window decides, so a quiet workspace gets
//      quieter on its own instead of needing to be tidied up.
//
// Activity is read from the thread's own MESSAGES, never from `thread.updatedAt`:
// the store bumps `updatedAt` on every UI write — dragging a card, renaming a
// session — so a dragged old card would look recent and reappear the next time
// the canvas reloaded.
const RECENT_WINDOW_DAYS = 7
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000

/** Epoch ms of the thread's last message, or null when nothing is datable. */
function threadActivityAt(thread) {
  // A reply in flight is activity by definition, even before it lands in the
  // session file (an optimistic message may carry no usable timestamp).
  if (state.pendingReplies.has(thread.sessionId) || state.liveReplies.has(thread.sessionId)) return Date.now()
  let latest = 0
  for (const message of thread.messages ?? []) {
    const at = Date.parse(message.at ?? '')
    if (Number.isFinite(at) && at > latest) latest = at
  }
  if (latest === 0) {
    const created = Date.parse(thread.createdAt ?? '')
    if (Number.isFinite(created)) latest = created
  }
  return latest === 0 ? null : latest
}

/**
 * `'shown'` | `'hidden'` | `'stale'`.
 *
 * `'stale'` is the default hiding (nothing recent happened) and `'hidden'` is
 * the user's own choice. Keeping them apart is what lets the sidebar say WHY a
 * row is off the canvas — 7 天没动静 vs 你自己收起来的。
 */
function threadVisibility(thread) {
  if (thread.hidden === true) return 'hidden'
  if (thread.hidden === false) return 'shown'
  const activity = threadActivityAt(thread)
  return activity === null || Date.now() - activity <= RECENT_WINDOW_MS ? 'shown' : 'stale'
}

const isThreadVisible = thread => threadVisibility(thread) === 'shown'

/**
 * The threads the canvas is drawing right now. Every card set — the map, the
 * reveal/pan targets, the collapse pass — must come from THIS, or a hidden
 * thread would still own a card slot, a camera target or a collapse root that
 * nothing renders.
 */
const canvasThreads = () => (state.workspace?.threads ?? []).filter(isThreadVisible)

/**
 * Persist a thread's visibility and mirror it locally.
 *
 * `hidden` is tri-state in the data file, but this button only ever writes the
 * two explicit states — it must not hand an old session back to the default
 * window a moment after the user pulled it onto the canvas.
 */
async function setThreadVisibility(thread, hidden) {
  try {
    await api(`/synapse/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ hidden }) })
    thread.hidden = hidden
    state.error = ''
  } catch (error) {
    setError(error)
    return
  }
  if (hidden) state.selectedCardId = null
  render()
}

function openBtw(parent, anchorId = undefined, atSeq = undefined) {
  if (parent.sessionId === null) return setError('该节点没有关联的会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  // `atSeq` is the entry the side question inherits THROUGH: a question asked
  // about turn 3 is not helped by turn 9, and the hosts that can fork at an
  // event (DSH) do it there. Hosts that cannot ignore it (`hostBtwSession`).
  state.draft = {
    kind: 'btw', parentId: parent.id, anchorId, atSeq, text: '', sending: false,
    tools: [...state.btwDefaultTools],
    toolOptions: [...state.btwToolOptions],
  }
  render()
  window.setTimeout(() => htmlElement('[data-draft] textarea')?.focus(), 0)
  void refreshBtwTools(parent.sessionId)
}

/**
 * Chip names: what the draft may pick at all, plus anything it already has.
 *
 * The union is what keeps a selected tool from losing its chip when the host
 * cannot describe this session (no live agent) or describes a shorter list
 * than the defaults.
 */
function btwChipNames(options, selected) {
  const names = [...selected]
  for (const name of options) {
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Ask the host what tools THIS session has.
 *
 * The page-load answer may predate any live session, and a host may only
 * describe the tools of a session it has composed (listing them never
 * activates anything). So the draft asks again, naming the session it hangs
 * under, and replaces the chips when the answer arrives — unless the draft is
 * gone or the user has since chosen something else.
 */
async function refreshBtwTools(sessionId) {
  const draft = state.draft
  if (draft === null || draft.kind !== 'btw' || sessionId === null) return
  const status = await api(`/synapse/api/status?session=${encodeURIComponent(sessionId)}`)
  if (state.draft !== draft) return
  // `pinnableTools` is the set a pin may NAME (a tool registered in the agent's
  // own layer survives any allow list, and naming it is refused), so it wins
  // over the visible set whenever the host reports one.
  const options = Array.isArray(status?.pinnableTools) && status.pinnableTools.length > 0 ? status.pinnableTools
    : Array.isArray(status?.tools) ? status.tools
    : []
  draft.toolOptions = btwChipNames(options, draft.tools)
  render()
}

/**
 * Query an element that is known to be an HTMLElement.
 *
 * `document.querySelector` types its result as `Element`, which has neither
 * `focus` nor `click` — so every `?.focus()` in this file was reported as using
 * a property that does not exist, on a value that is always focusable at
 * runtime. A missing or non-focusable match stays a no-op, exactly as `?.` was.
 *
 * @param {string} selector
 * @returns {HTMLElement|null}
 */
function htmlElement(selector) {
  const found = document.querySelector(selector)
  return found instanceof HTMLElement ? found : null
}

/**
 * @param {unknown} [error]
 *   `unknown`, not a string default: callers pass an Error from a catch, and a
 *   `''` default made the parameter infer as `string`, so the `instanceof`
 *   check below looked like it was testing a string.
 */
function setError(error = '') {
  state.error = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '')
  render()
}

// There is deliberately no history loader: every projected message already
// travels inside the thread payload, so the canvas never needs a second read of
// the session. (A stub used to sit here and was called with a thread argument
// six times while doing nothing — dead plumbing that also read as if a reload
// were happening.)

function canReplaceView() {
  return state.draft === null && !state.dragging && !state.canvasGesture && Date.now() >= state.canvasRefreshAfter && !document.activeElement?.matches('textarea')
}

function deferCanvasRefresh(delay = 700) {
  state.canvasRefreshAfter = Math.max(state.canvasRefreshAfter, Date.now() + delay)
}

function currentHostThread(threads = state.workspace?.threads ?? []) {
  const id = state.currentSession?.id
  return typeof id === 'string' ? threads.find(thread => thread.sessionId === id) : undefined
}

// pi has one workspace layer: the projection groups sessions by cwd. The
// sidebar therefore lists the projection workspaces directly.
function workspaceChoices() {
  return state.summaries.map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.cwd, sessionIds: [], source: 'projection' }))
}

/**
 * Which workspace to open when the canvas has none: the most recently touched.
 *
 * Not `summaries[0]`: the list is in creation order, so the first entry is the
 * OLDEST workspace — with the recent-activity default that is exactly the one
 * most likely to have nothing to draw, and a first impression of an empty map
 * reads as broken. `updatedAt` is the workspace's last activity (projection
 * writes the newest message's time; the canvas writes `now` when the user
 * rearranges it), which is the honest definition of 最近活跃.
 */
function defaultWorkspaceId() {
  const latest = [...state.summaries].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0]
  return latest?.id ?? null
}

async function refreshSummaries({ renderAfter = true } = {}) {
  const before = JSON.stringify(state.summaries)
  const body = await api('/synapse/api/workspaces')
  state.summaries = body.workspaces
  const changed = before !== JSON.stringify(state.summaries)
  const current = state.workspace?.id
  if (state.selectedHostWorkspaceId === null && current !== null && !state.summaries.some(item => item.id === current)) state.workspace = null
  const selected = state.summaries.find(item => item.id === state.selectedHostWorkspaceId)
  if (selected !== undefined && (changed || state.workspace === null)) await openWorkspace(selected.id, { renderAfter })
  else if (state.workspace === null) {
    const fallback = defaultWorkspaceId()
    if (fallback !== null) await openWorkspace(fallback)
  } else if (renderAfter && changed && canReplaceView()) render()
  return changed
}

async function openWorkspace(id, { renderAfter = true } = {}) {
  const load = ++state.workspaceLoad
  state.selectedHostWorkspaceId = id
  const body = await api(`/synapse/api/workspaces/${id}`)
  if (load !== state.workspaceLoad) return
  if (state.workspace?.id !== body.workspace.id) resetCanvasCamera()
  state.workspace = body.workspace
  const currentThread = currentHostThread(state.workspace.threads)
  state.activeId = currentThread?.id ?? (state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null)
  if (currentThread !== undefined) revealConversationThread(conversationCards(canvasThreads()), currentThread.id)
  if (renderAfter && canReplaceView()) render()
}

async function refreshProjection() {
  const summariesChanged = await refreshSummaries({ renderAfter: false })
  if (!summariesChanged || state.workspace === null || !canReplaceView()) return summariesChanged
  await openWorkspace(state.workspace.id)
  return true
}

function openNewSession() {
  if (state.draft !== null) return
  state.mode = 'canvas'
  state.activeId = null
  state.selectedCardId = null
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'new', text: '', sending: false }
  state.error = ''
  resetCanvasCamera()
  render()
  window.setTimeout(() => htmlElement('[data-draft] textarea')?.focus(), 0)
}

/** Rename the host session; the canvas mirrors whatever the host accepts. */
async function renameThread(thread) {
  const current = thread.sessionTitle ?? thread.title ?? ''
  const next = window.prompt('重命名这个会话（会写入宿主的会话记录）', current)
  if (next === null) return
  const name = next.trim()
  if (name === '' || name === current) return
  try {
    // The canvas does not talk to the host's own API itself: which channel a
    // write takes is the host's decision (`writeTransport`), and `host.js` owns
    // both of them.
    await hostRenameSession(thread.sessionId, name)
    if (state.workspace !== null) {
      const target = state.workspace.threads.find(item => item.id === thread.id)
      if (target !== undefined) {
        target.title = name
        target.sessionTitle = name
      }
    }
    state.error = ''
  } catch (error) {
    setError(error)
    return
  }
  render()
}

/** The host's own archive: the session file stays, the host's sidebar hides it. */
async function archiveInHost(thread, archived = true) {
  if (thread.sessionId === null) return setError('该节点没有关联的会话')
  try {
    await hostArchiveSession(thread.sessionId, archived)
    state.error = ''
    await refreshProjection()
  } catch (error) {
    setError(error)
  }
}

async function archiveThread(thread) {
  if (!window.confirm(`归档画布中的「${thread.title}」及其分支？原会话会保留，${state.hostLabels.archiveHint}。`)) return
  await api(`/synapse/api/threads/${thread.id}`, { method: 'DELETE' })
  state.detailScrollByThread.delete(thread.id)
  state.detailTargetCardId = state.detailThreadId === thread.id ? null : state.detailTargetCardId
  if (state.workspace !== null) {
    const removed = new Set([thread.id])
    for (let changed = true; changed;) {
      changed = false
      for (const item of state.workspace.threads) {
        if (item.parentId !== null && removed.has(item.parentId) && !removed.has(item.id)) {
          removed.add(item.id)
          changed = true
        }
      }
    }
    state.workspace.threads = state.workspace.threads.filter(item => !removed.has(item.id))
    for (const key of [...state.cardPositions.keys()]) {
      if ([...removed].some(id => key.startsWith(`${id}:`))) state.cardPositions.delete(key)
    }
    let collapsedChanged = false
    for (const key of [...state.collapsedCardIds]) {
      if ([...removed].some(id => key.startsWith(`${id}:`))) {
        state.collapsedCardIds.delete(key)
        collapsedChanged = true
      }
    }
    if (collapsedChanged) persistCollapsedCards()
    state.activeId = state.activeId !== null && state.workspace.threads.some(item => item.id === state.activeId)
      ? state.activeId
      : state.workspace.threads[0]?.id ?? null
    render()
  } else {
    state.activeId = null
  }
  await refreshSummaries()
}

function focusDraftInput() {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement)) return
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

function openContinue(parent, anchorId = undefined, text = '') {
  if (parent.sessionId === null) return setError('该节点没有关联的会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'continue', parentId: parent.id, anchorId, text, sending: false }
  render()
  window.setTimeout(focusDraftInput, 0)
}

function openBranch(parent, atSeq = undefined, anchorId = undefined) {
  if (parent.sessionId === null) return setError('该节点没有关联的会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  // `atSeq` is the entry the fork happens AT (pi's fork_branch cuts history
  // there); `anchorId` is the canvas card the new branch hangs under. Both are
  // needed: the first is a pi entry id, the second a canvas card id.
  state.draft = { kind: 'branch', parentId: parent.id, atSeq, anchorId, text: '', sending: false }
  render()
  window.setTimeout(() => htmlElement('[data-draft] textarea')?.focus(), 0)
}

async function sendMessage(thread, text, images = []) {
  if (thread.sessionId === null) throw new Error('该节点没有关联的会话')
  if (state.pendingReplies.has(thread.sessionId)) throw new Error('该会话正在回复，请稍后再发送')
  // The optimistic row shows the markers too, and its text has to be what the
  // projection will produce or the pending reply never settles (settling matches
  // the pending text against the persisted message).
  state.pendingReplies.set(thread.sessionId, { text: draftMessageText(text, images), at: Date.now(), imageCount: images.length })
  state.error = ''
  render()
  try {
    await hostSendMessage(thread.sessionId, text, promptImages(images))
  } catch (error) {
    state.pendingReplies.delete(thread.sessionId)
    render()
    throw error
  }
}

async function submitDraft() {
  const draft = state.draft
  const text = draft?.text.trim() ?? ''
  const images = draft?.images ?? []
  // An image with no words is a complete message (a pasted screenshot).
  if (draft === null || (text === '' && images.length === 0)) return
  const branchPosition = draft.kind === 'branch' && state.workspace !== null ? draftPlacement(conversationCards(canvasThreads()))?.position : undefined
  draft.sending = true
  state.error = ''
  render()
  try {
    if (draft.kind === 'new') {
      const session = await hostEnsureSession(state.workspace?.cwd ?? state.currentSession?.cwd)
      await hostSendMessage(session.id, text, promptImages(images))
      releaseDraftImages(draft)
      state.draft = null
      render()
      window.setTimeout(() => {
        void refreshProjection().catch(() => {})
      }, 150)
      return
    }
    const parent = state.workspace?.threads.find(thread => thread.id === draft.parentId)
    if (parent === undefined) throw new Error('来源会话不存在')
    if (draft.kind === 'continue') {
      releaseDraftImages(draft)
      state.draft = null
      await sendMessage(parent, text, images)
      return
    }
    if (draft.kind === 'btw') {
      await submitBtwDraft(draft, parent, text, images)
      return
    }
    // Fork at the requested turn: pi's `fork_branch` truncates the copied
    // history at that entry, so branching off turn 5 really yields a session
    // holding turns 1–5 — not the whole conversation. Without the entry id the
    // host forks at the current leaf and every branch starts from the latest
    // message, which made 「分支」 look broken on earlier cards.
    const session = await hostForkSession(parent.sessionId, draft.atSeq)
    if (draft.anchorId !== undefined) rememberBranchAnchor(session.id, draft.anchorId)
    const result = await api(`/synapse/api/threads/${parent.id}/branch`, { method: 'POST', body: JSON.stringify({ title: draftMessageText(text, images).slice(0, 42), sessionId: session.id, sessionTitle: session.title, position: branchPosition }) })
    if (state.workspace !== null && !state.workspace.threads.some(thread => thread.id === result.thread.id || thread.sessionId === result.thread.sessionId)) state.workspace.threads.push(result.thread)
    state.activeId = result.thread.id
    releaseDraftImages(draft)
    state.draft = null
    state.pendingReplies.set(result.thread.sessionId, { text: draftMessageText(text, images), at: Date.now(), imageCount: images.length })
    render()
    await hostSendMessage(result.thread.sessionId, text, promptImages(images))
    await refreshProjection()
  } catch (error) {
    if (draft.kind === 'branch') {
      state.pendingReplies.delete(state.workspace?.threads.find(thread => thread.id === state.activeId)?.sessionId)
      if (state.draft !== null) state.draft = { ...draft, sending: false }
    } else {
      state.draft = { ...draft, sending: false }
    }
    setError(error)
  }
}

/**
 * Run a /btw side question: fork with inherited context, pin read-only tools,
 * archive in pi-web so the main session list stays clean, then prompt.
 *
 * The order matters. `set_tools` is per-session state, so it can only be
 * applied once the forked session exists on disk — and it must land BEFORE the
 * prompt, or the first turn would run with the parent's full tool loadout.
 *
 * The btw thread is registered with Synapse so it appears as a widget
 * immediately; the projection rescan would eventually notice the new session
 * file, but waiting for it would leave the user with no feedback.
 */
async function submitBtwDraft(draft, parent, text, images = []) {
  // An empty loadout is not "no restriction": the harness treats it as a
  // no-op, so the side question would keep the parent's full tool plane. It is
  // refused here as well as on the host, because this is where the user can
  // still do something about it.
  const tools = draft.tools ?? state.btwDefaultTools
  if (tools.length === 0) throw new Error('侧问至少要给一个工具（空清单等于不限制）')
  const forked = await hostBtwSession(parent.sessionId, tools, draft.atSeq)
  const title = draftMessageText(text, images).replaceAll(/\s+/g, ' ').trim().slice(0, 42)
  const result = await api(`/synapse/api/threads/${parent.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: forked.id, title, kind: 'btw', tools }),
  })
  if (state.workspace !== null && !state.workspace.threads.some(thread => thread.id === result.thread.id || thread.sessionId === result.thread.sessionId)) {
    state.workspace.threads.push(result.thread)
  }
  state.activeId = result.thread.id
  releaseDraftImages(draft)
  state.draft = null
  // Stay on the map: the btw widget is the side question's home, and jumping to
  // the detail view would hide the widget the user just created. The widget
  // shows the live reply as it streams, so nothing is lost.
  state.mode = 'canvas'
  state.pendingReplies.set(result.thread.sessionId, { text: draftMessageText(text, images), at: Date.now(), imageCount: images.length })
  render()
  await hostSendMessage(result.thread.sessionId, text, promptImages(images))
  await refreshProjection()
}

function threadsById() { return new Map((state.workspace?.threads ?? []).map(thread => [thread.id, thread])) }

function pendingUserIndex(messages, pending) {
  return messages.findLastIndex(message => message.kind === 'user' && message.text === pending.text && new Date(message.at).getTime() >= pending.at - 2_000)
}

function settlePendingReply(thread, messages) {
  const pending = state.pendingReplies.get(thread.sessionId)
  if (pending === undefined) return false
  const userIndex = pendingUserIndex(messages, pending)
  // An `error` entry settles the turn too: a run that failed never writes an
  // assistant message, and waiting for one left the card saying 「正在回复」
  // (with its streaming halo) forever after a failed turn.
  const answered = messages.slice(userIndex + 1).some(message => message.kind === 'assistant' || message.kind === 'error')
  if (userIndex === -1 || !answered) return false
  state.pendingReplies.delete(thread.sessionId)
  return true
}

function messagesFor(thread) {
  // A runtime-context snapshot is internal host state, never a user turn.
  // Filter here as well as during persistence so existing saved workspaces
  // immediately render one question and its answer as one card.
  const messages = (thread.messages ?? []).filter(message => !(message.kind === 'user' && typeof message.text === 'string' && message.text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')))
  const pending = state.pendingReplies.get(thread.sessionId)
  if (pending === undefined) return messages
  if (settlePendingReply(thread, messages)) {
    state.liveReplies.delete(thread.sessionId)
    return messages
  }
  const liveReply = state.liveReplies.get(thread.sessionId)
  const liveAssistant = liveReply?.running ? { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() } : { kind: 'assistant', text: '', pending: true, at: new Date().toISOString() }
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex !== -1) return [...messages, liveAssistant]
  return [...messages, { kind: 'user', text: pending.text, pending: true, at: new Date(pending.at).toISOString() }, liveAssistant]
}

function latestMessage(thread, kind) { return [...messagesFor(thread)].reverse().find(message => message.kind === kind) }
function questionFor(thread) {
  const question = latestMessage(thread, 'user')
  // `displayText` re-joins an image-only message with its markers, so a pasted
  // screenshot names its own card instead of leaving it blank.
  if (question !== undefined) return displayText(question)
  return thread.sessionTitle ?? '等待用户提问'
}
function answerFor(thread) { return latestMessage(thread, 'assistant') ?? null }

function overlapsCard(position, other) {
  return position.x < other.x + CARD_WIDTH && position.x + CARD_WIDTH > other.x
    && position.y < other.y + CARD_HEIGHT && position.y + CARD_HEIGHT > other.y
}

function firstAvailableCardPosition(position, occupied) {
  const candidate = { x: Math.round(position.x), y: Math.max(82, Math.round(position.y)) }
  while (true) {
    const collisions = occupied.filter(other => overlapsCard(candidate, other))
    if (collisions.length === 0) return candidate
    candidate.y = Math.max(...collisions.map(other => other.y + CARD_HEIGHT + CARD_GAP_Y))
  }
}

function connectorPath(fromPosition, toPosition) {
  const fromX = fromPosition.x + CARD_WIDTH
  const fromY = fromPosition.y + CARD_HEIGHT / 2
  const toX = toPosition.x
  const toY = toPosition.y + CARD_HEIGHT / 2
  const bend = Math.min(110, Math.max(36, Math.abs(toX - fromX) * .2))
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`
}

function connectorPathFromElements(fromCard, toCard) {
  const fromX = Number.parseFloat(fromCard.style.left) + CARD_WIDTH
  const fromY = Number.parseFloat(fromCard.style.top) + CARD_HEIGHT / 2
  const toX = Number.parseFloat(toCard.style.left)
  const toY = Number.parseFloat(toCard.style.top) + CARD_HEIGHT / 2
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) return null
  const bend = Math.min(110, Math.max(36, Math.abs(toX - fromX) * .2))
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`
}

function selectorValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Connector paths are rebuilt together with the canvas DOM; cache the mapping
// from card id to its incident paths so dragging never scans the whole SVG.
let connectorPathsByCard = new Map()
function cacheCardConnectors() {
  connectorPathsByCard = new Map()
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  for (const path of viewport.querySelectorAll('.connectors path[data-from]')) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (fromId === null || toId === null) continue
    for (const id of [fromId, toId]) {
      const paths = connectorPathsByCard.get(id)
      if (paths === undefined) connectorPathsByCard.set(id, new Set([path]))
      else paths.add(path)
    }
  }
}

function refreshCardConnectors(cardId) {
  const paths = connectorPathsByCard.get(cardId)
  if (paths === undefined || paths.size === 0) return
  const byId = state.canvasCardsById
  if (byId === undefined) return
  for (const path of paths) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (fromId === null || toId === null) continue
    const fromCard = byId.get(fromId)
    const toCard = byId.get(toId)
    if (fromCard === undefined || toCard === undefined) continue
    // Data-driven endpoints: the counterpart card may be unmounted (outside
    // the viewport) but its position is still authoritative.
    path.setAttribute('d', connectorPath(fromCard.position, toCard.position))
  }
}

function initialCanvasCamera(cards) {
  const draft = state.draft?.kind === 'new' ? { id: 'draft:new', position: { x: 86, y: 82 } } : draftPlacement(cards)
  // Focus the active conversation's latest turn, not its first: after many
  // rounds the canvas should open where work is happening, at the newest card.
  const activeCards = state.activeId === null || state.activeId === undefined ? [] : cards.filter(card => card.hostThreadId === state.activeId)
  const active = activeCards.at(-1)
  const focus = draft ?? active ?? cards[0]
  const position = focus?.position
  if (position === undefined) return { x: 0, y: 0 }
  return { x: CAMERA_INSET_X - position.x * state.zoom, y: CAMERA_INSET_Y - position.y * state.zoom }
}

function placeConversationCards(cards) {
  const saved = new Map(cards.flatMap(card => {
    if (card.positionLocked !== true) return []
    const position = state.cardPositions.get(card.id) ?? state.cardPositions.get(card.positionKey)
    return position === undefined ? [] : [[card.id, { x: position.x, y: position.y }]]
  }))
  const occupied = []
  for (const card of cards) {
    const position = saved.get(card.id)
    if (position !== undefined) {
      card.position = position
      continue
    }
    card.position = firstAvailableCardPosition(card.naturalPosition ?? card.position, occupied)
    occupied.push(card.position)
  }
  return cards
}

function layoutConversationGraph(cards, threads) {
  const childrenByThread = new Map()
  for (const thread of threads) {
    if (thread.parentId === null) continue
    const children = childrenByThread.get(thread.parentId) ?? []
    children.push(thread.id)
    childrenByThread.set(thread.parentId, children)
  }
  const laneByThread = new Map()
  const visitThread = threadId => {
    if (laneByThread.has(threadId)) return
    laneByThread.set(threadId, laneByThread.size)
    for (const childId of childrenByThread.get(threadId) ?? []) visitThread(childId)
  }
  for (const thread of threads) if (thread.parentId === null) visitThread(thread.id)
  for (const thread of threads) visitThread(thread.id)

  const byId = new Map(cards.map(card => [card.id, card]))
  const positioned = new Map()
  const positionFor = (card, visiting = new Set()) => {
    if (positioned.has(card.id)) return positioned.get(card.id)
    if (visiting.has(card.id)) return { x: 86, y: 82 + (laneByThread.get(card.hostThreadId) ?? 0) * (CARD_HEIGHT + CARD_GAP_Y) }
    visiting.add(card.id)
    const parent = card.parentId === null ? undefined : byId.get(card.parentId)
    const parentPosition = parent === undefined ? undefined : positionFor(parent, visiting)
    const position = {
      x: parentPosition === undefined ? 86 : parentPosition.x + 365,
      y: 82 + (laneByThread.get(card.hostThreadId) ?? 0) * (CARD_HEIGHT + CARD_GAP_Y),
    }
    visiting.delete(card.id)
    positioned.set(card.id, position)
    return position
  }
  for (const card of cards) {
    card.naturalPosition = positionFor(card)
    if (!card.positionLocked) card.position = card.naturalPosition
  }
  return placeConversationCards(cards)
}

function conversationCards(threads) {
  const cards = []
  const cardsByThread = new Map()
  for (const thread of threads) {
    // A /btw side question is rendered as a widget under its parent card, not
    // as turn cards: it is not a turn in the main chain, and giving it nodes
    // would misrepresent the conversation's shape.
    if (thread.kind === 'btw') continue
    const messages = messagesFor(thread)
    const turns = []
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const question = messages[messageIndex]
      if (question.kind !== 'user') continue
      const replies = []
      const errors = []
      let processCount = 0
      for (let replyIndex = messageIndex + 1; replyIndex < messages.length; replyIndex++) {
        const reply = messages[replyIndex]
        if (reply.kind === 'user') break
        if (reply.kind === 'assistant') replies.push(reply)
        if (reply.kind === 'error') errors.push(reply)
        if (Array.isArray(reply.process)) processCount += reply.process.length
        else if (reply.kind === 'tool') processCount += 1
      }
      const answer = replies.at(-1) ?? null
      const error = errors.at(-1) ?? null
      const turnIndex = turns.length
      const id = `${thread.id}:turn:${question.sourceEntryId ?? messageIndex}`
      const previous = turns.at(-1)
      const positionKey = `${thread.id}:turn-index:${turnIndex}`
      const naturalPosition = previous === undefined ? { x: 86, y: 82 } : { x: previous.naturalPosition.x + 365, y: previous.naturalPosition.y }
      const savedPosition = state.cardPositions?.get(id) ?? state.cardPositions?.get(positionKey)
      const positionLocked = savedPosition !== undefined
      const position = positionLocked ? savedPosition : naturalPosition
      turns.push({
        id,
        positionKey,
        hostThreadId: thread.id,
        sourceParentId: thread.parentId,
        parentId: null,
        sourceEntryId: question.sourceEntryId,
        turnIndex,
        naturalPosition,
        position,
        positionLocked,
        question: displayText(question),
        answer,
        error,
        processCount,
        // Declared here rather than only assigned on the newest turn below, so
        // every card carries the same shape (a reader that ran before the
        // assignment would otherwise see `undefined`).
        canContinue: false,
      })
    }
    const liveReply = state.liveReplies.get(thread.sessionId)
    const latestTurn = turns.at(-1)
    if (liveReply?.running && latestTurn !== undefined && (latestTurn.answer === null || latestTurn.answer.pending === true)) latestTurn.answer = { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() }
    if (turns.length === 0) {
      const id = `${thread.id}:turn:empty`
      const positionKey = `${thread.id}:turn-index:0`
      const naturalPosition = { x: 86, y: 82 }
      const savedPosition = state.cardPositions?.get(id) ?? state.cardPositions?.get(positionKey)
      const positionLocked = savedPosition !== undefined
      turns.push({
      id,
      positionKey,
      hostThreadId: thread.id,
      sourceParentId: thread.parentId,
      parentId: null,
      sourceEntryId: undefined,
      turnIndex: 0,
      naturalPosition,
      position: positionLocked ? savedPosition : naturalPosition,
      positionLocked,
      question: thread.sessionTitle ?? thread.title,
      answer: null,
      error: null,
      processCount: 0,
      canContinue: false,
      })
    }
    turns.at(-1).canContinue = true
    cardsByThread.set(thread.id, turns)
    cards.push(...turns)
  }
  for (const card of cards) {
    const siblings = cardsByThread.get(card.hostThreadId)
    if (card.turnIndex > 0) card.parentId = siblings[card.turnIndex - 1].id
    else {
      const parentCards = cardsByThread.get(card.sourceParentId)
      const sourceThread = threads.find(thread => thread.id === card.hostThreadId)
      const firstChildQuestion = siblings?.[0]
      const seedBoundary = sourceThread?.sourceSeedLength ?? firstChildQuestion?.sourceEntryId
      // A fork inherits every parent entry up to the durable seed boundary. The
      // latest parent question AT that boundary is the exact Turn where this
      // child was born. Canvas coordinates never participate in lineage.
      //
      // `sourceSeedLength` is an entry ID (`927f88e9`), not a count: comparing
      // an id against a number (`'927f88e9' < 34`) is false for every id, which
      // silently sent every branch to the same fallback parent.
      const inheritedTurn = typeof seedBoundary === 'string' && seedBoundary !== ''
        ? parentCards?.filter(candidate => candidate.sourceEntryId === seedBoundary).at(-1)
          ?? parentCards?.filter(candidate => typeof candidate.sourceEntryId === 'string' && candidate.sourceEntryId !== '' && candidate.sourceEntryId <= seedBoundary).at(-1)
        : undefined
      card.parentId = state.branchAnchors.get(card.hostThreadId) ?? inheritedTurn?.id ?? null
    }
  }
  return layoutConversationGraph(cards, threads)
}

function conversationGraphView(cards, collapsedCardIds = state.collapsedCardIds) {
  const cardIds = new Set(cards.map(card => card.id))
  const childrenByParent = new Map()
  for (const card of cards) {
    if (card.parentId === null || !cardIds.has(card.parentId)) continue
    const children = childrenByParent.get(card.parentId) ?? []
    children.push(card.id)
    childrenByParent.set(card.parentId, children)
  }

  const hiddenIds = new Set()
  for (const rootId of collapsedCardIds) {
    if (!cardIds.has(rootId)) continue
    const visited = new Set([rootId])
    const visit = parentId => {
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        hiddenIds.add(childId)
        visit(childId)
      }
    }
    visit(rootId)
  }

  // Persisted collapse roots must remain visible even if malformed metadata
  // contains a cycle where two collapsed nodes otherwise hide each other.
  for (const rootId of collapsedCardIds) hiddenIds.delete(rootId)

  // Post-order accumulation: each card's descendant count is 1 + the sum of
  // its children's subtree sizes, so the whole graph is O(n) instead of a BFS
  // from every card (O(n²) on deep chains). Malformed parent cycles are
  // detected through the DFS path: every member of a cycle reaches every other
  // member plus the union of their off-cycle subtrees, so when the cycle entry
  // pops last, all members are settled to (cycleSize - 1) + off-cycle total,
  // which matches the per-card BFS' unique-descendant count.
  const descendantCounts = new Map()
  const inStack = new Set()
  for (const card of cards) {
    if (descendantCounts.has(card.id)) continue
    const stack = [{ id: card.id, children: childrenByParent.get(card.id) ?? [], index: 0 }]
    const path = [card.id]
    let cycleEntry = null
    let cycleMembers = null
    let cycleOffCycleTotal = 0
    inStack.add(card.id)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top.index < top.children.length) {
        const childId = top.children[top.index++]
        if (descendantCounts.has(childId)) continue
        if (inStack.has(childId)) {
          // Back edge: the nodes from childId up to top.id form a cycle.
          cycleEntry = childId
          cycleMembers = new Set(path.slice(path.indexOf(childId)))
          cycleOffCycleTotal = 0
          continue
        }
        inStack.add(childId)
        path.push(childId)
        stack.push({ id: childId, children: childrenByParent.get(childId) ?? [], index: 0 })
      } else {
        stack.pop()
        path.pop()
        inStack.delete(top.id)
        let count = 0
        // Snapshot the ring: it cannot change while this node pops (only the
        // back-edge branch reassigns it), and reading it into a local keeps the
        // narrowing valid inside the loops below. Using the outer `let`
        // directly made every guarded read report as possibly null.
        const members = cycleMembers
        for (const childId of top.children) {
          if (members !== null && members.has(childId)) continue // ring edge; base count added below
          count += 1 + (descendantCounts.get(childId) ?? 0)
        }
        if (members !== null && members.has(top.id)) cycleOffCycleTotal += count
        if (members !== null && top.id === cycleEntry) {
          // All cycle members have popped (the entry pops last in post-order);
          // settle them so ancestors popping next read the final counts.
          const base = members.size - 1
          for (const id of members) descendantCounts.set(id, base + cycleOffCycleTotal)
          cycleEntry = null
          cycleMembers = null
        } else {
          descendantCounts.set(top.id, count)
        }
      }
    }
  }

  return {
    cards: cards.filter(card => !hiddenIds.has(card.id)),
    childCounts: new Map(cards.map(card => [card.id, childrenByParent.get(card.id)?.length ?? 0])),
    descendantCounts,
  }
}

function revealConversationThread(cards, threadId) {
  const byId = new Map(cards.map(card => [card.id, card]))
  let changed = false
  for (const target of cards.filter(card => card.hostThreadId === threadId)) {
    const visited = new Set([target.id])
    let parentId = target.parentId
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId)
      if (state.collapsedCardIds.delete(parentId)) changed = true
      parentId = byId.get(parentId)?.parentId ?? null
    }
  }
  if (changed) persistCollapsedCards()
}

function canvasConnectors(cards) {
  const index = new Map(cards.map(card => [card.id, card]))
  const links = cards.map(card => {
    const parent = card.parentId === null ? null : index.get(card.parentId)
    if (parent === undefined || parent === null) return ''
    const active = card.hostThreadId === state.activeId && parent.hostThreadId === state.activeId ? ' active-connector' : ''
    return `<path class="${active.trim()}" data-from="${escapeHtml(parent.id)}" data-to="${escapeHtml(card.id)}" d="${connectorPath(parent.position, card.position)}"></path>`
  })
  const placement = draftPlacement(cards)
  if (placement !== null) {
    links.push(`<path class="draft-connector" data-from="${escapeHtml(placement.parent.id)}" data-to="draft" d="${connectorPath(placement.parent.position, placement.position)}"></path>`)
  }
  return links.join('')
}

// A thread is streaming when the host reports a live reply for its session, or
// when the canvas itself is waiting on a message it just sent (that state is
// set synchronously, before the host's stream opens, so the card must not look
// inert during the first seconds of a reply).
const isThreadStreaming = threadId => {
  const thread = threadById(threadId)
  if (thread === undefined || thread === null) return false
  const sessionId = thread.sessionId
  if (sessionId === null || sessionId === undefined) return false
  return state.pendingReplies.has(sessionId) || state.liveReplies.get(sessionId)?.running === true
}

function conversationCard(card, graph) {
  const selected = card.id === state.selectedCardId ? 'selected' : ''
  const source = card.parentId === null ? '会话' : card.turnIndex === 0 ? '分支' : '追问'
  const continueButton = card.canContinue === true
    ? `<button class="graph-continue-button" data-action="open-continue" data-thread="${card.hostThreadId}" data-card="${escapeHtml(card.id)}" aria-label="添加追问" title="添加追问">${ICON(`<path d="${ICON_PATHS.plus}"/>`)}</button>`
    : ''
  const childCount = graph.childCounts.get(card.id) ?? 0
  const collapsed = state.collapsedCardIds.has(card.id)
  const foldLabel = collapsed ? '展开后续对话' : '折叠后续对话'
  const foldButton = childCount === 0 || card.canContinue === true ? '' : `<button class="graph-fold-button${collapsed ? ' collapsed' : ''}" data-action="toggle-card-children" data-card="${escapeHtml(card.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${foldLabel}" title="${foldLabel}">${ICON(`<path d="${ICON_PATHS.minus}"/>${collapsed ? `<path d="${ICON_PATHS.vertical}"/>` : ''}`)}</button>`
  // Branching needs an answer to branch FROM, nothing else: the fork cuts pi's
  // history at that entry. It used to be hidden whenever the card was the
  // thread's newest (`childCount === 0 || canContinue === true`), which removed
  // the affordance from exactly the turn a user is most likely to branch from.
  // The three side buttons sit at different offsets (side question −28px,
  // follow-up +0, branch +28px), so they coexist without colliding.
  const branchFrom = typeof card.answer?.sourceEntryId === 'string' && card.answer.sourceEntryId !== '' ? card.answer.sourceEntryId : ''
  const branchButton = branchFrom === '' ? '' : `<button class="graph-branch-button" data-action="open-branch" data-thread="${card.hostThreadId}" data-card="${escapeHtml(card.id)}" data-seq="${branchFrom}" aria-label="在新对话中分支" title="从这一轮的回答创建分支（复制到此轮为止的历史）">${ICON('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><path d="M4.5 5v4.5a2.5 2.5 0 0 0 2.5 2.5h5"/>')}</button>`
  // The /btw affordance belongs wherever there is an answer to inherit from:
  // on the latest turn it sits beside 「追问」, and on an earlier turn beside
  // 「分支」, so a side question is always one click away. pi-web forks from the
  // current leaf regardless, so the anchor card is a visual choice, not a
  // semantic one — the same is already true of the existing 分支 button.
  const btwButton = state.capabilities.btw !== true || !(typeof card.answer?.sourceEntryId === 'string' && card.answer.sourceEntryId !== '')
    ? ''
    : `<button class="graph-btw-button" data-action="open-btw" data-thread="${card.hostThreadId}" data-card="${escapeHtml(card.id)}" data-seq="${card.answer.sourceEntryId}" aria-label="开启侧问（继承上下文、工具可选）" title="侧问：继承当前上下文，工具在草稿卡里选（默认只读），${state.hostLabels.btwArchiveHint}">${ICON(`<path d="${ICON_PATHS.speaker}"/><path d="${ICON_PATHS.speakerAdd}"/>`)}</button>`
  // Actions the host cannot perform are omitted instead of rendered as
  // buttons that would fail on click.
  // Host-side writes (rename, pi-web's own archive) are rare and destructive,
  // so they sit as icon-only buttons with a tooltip; spelling them out pushed
  // the footer onto a second line on a 310px card. The canvas-side archive
  // keeps its label because it is the reversible, everyday action.
  //
  // The two archives are deliberately separate controls: 「pi-web 归档」changes
  // the host's own list, 「归档」only takes the card off this canvas. A session
  // can legitimately be one without the other, so neither gates the other.
  // A session that is currently answering gets a breathing border on its latest
  // card. Only the newest card of the thread runs the effect: earlier turns are
  // already answered, and lighting the whole chain would read as noise.
  const threadCards = state.canvasCards?.filter(item => item.hostThreadId === card.hostThreadId) ?? []
  const isLatestOfThread = threadCards.at(-1)?.id === card.id
  const running = isLatestOfThread && isThreadStreaming(card.hostThreadId)
  const hostActions = [
    state.capabilities.renameSession === true
      ? `<button data-action="rename-thread" data-thread="${card.hostThreadId}" title="重命名会话" aria-label="重命名会话">${RENAME_ICON}</button>`
      : '',
    state.capabilities.archiveSession === true
      ? `<button data-action="host-archive" data-thread="${card.hostThreadId}" title="在 ${state.hostLabels.name} 中归档此会话" aria-label="在 ${state.hostLabels.name} 中归档此会话">${HOST_ARCHIVE_ICON}</button>`
      : '',
  ].join('')
  return `<article class="thread-card ${selected}${running ? ' is-streaming' : ''}" data-card-id="${escapeHtml(card.id)}" data-position-key="${escapeHtml(card.positionKey)}" data-thread="${card.hostThreadId}" style="left:${card.position.x}px;top:${card.position.y}px;--thread-color:${threadColor(card.hostThreadId)}">
    <button class="node-handle" data-drag-card="${card.id}" aria-label="拖动 ${escapeHtml(card.question)}" title="拖动卡片（方向键也可移动，Shift 微调）"></button>
    ${contextRing(contextUsageFor(card.hostThreadId))}
    ${continueButton}${foldButton}${branchButton}${btwButton}
    <div class="thread-card-head"><span class="topic-dot"></span><button class="thread-title" data-action="show-thread" data-thread="${card.hostThreadId}" data-card="${escapeHtml(card.id)}" title="查看完整会话：${escapeHtml(card.question)}">${escapeHtml(card.question)}</button></div>
    <div class="thread-meta"><span>${source}</span><span>第 ${card.turnIndex + 1} 轮</span>${card.error === null ? '' : '<span class="card-error-status">失败</span>'}${card.processCount > 0 ? `<span class="card-process-count">工具 ${card.processCount}</span>` : ''}</div>
    <div class="thread-answer">${card.answer === null ? (card.error === null ? '<p class="thread-answer-empty">等待助手回复</p>' : '') : card.answer.pending && card.answer.text === '' ? '<p class="thread-answer-pending">正在回复</p>' : `${renderMarkdown(card.answer.text)}${card.answer.pending ? '<p class="thread-answer-pending">正在回复</p>' : ''}`}${card.error === null ? '' : `<p class="thread-answer-error" title="${escapeHtml(card.error.text)}">本轮失败：${escapeHtml(card.error.text)}</p>`}</div>
    <footer><button data-action="show-thread" data-thread="${card.hostThreadId}" data-card="${escapeHtml(card.id)}" title="查看完整会话" aria-label="查看完整会话">${ICON('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>')}详情</button><button data-action="open-host" data-thread="${card.hostThreadId}" data-seq="${typeof card.sourceEntryId === 'string' && card.sourceEntryId !== '' ? card.sourceEntryId : ''}" title="${state.hostLabels.openIn}" aria-label="${state.hostLabels.openIn}">${ICON(`<path d="${ICON_PATHS.external}"/><path d="M9.5 3.5h3v3M12.2 3.8 7.5 8.5"/>`)}${state.hostLabels.openInShort}</button>${hostActions}<button data-action="archive-thread" data-thread="${card.hostThreadId}" title="从画布移除（原会话保留）" aria-label="从画布归档">${ICON(`<path d="${ICON_PATHS.arch}"/><path d="M4 5 5 2.8a.7.7 0 0 1 .6-.4h4.8a.7.7 0 0 1 .6.4L12 5M6 9.5h4"/>`)}归档</button></footer>
  </article>`
}

/**
 * The tool chips of a /btw draft.
 *
 * Multi-select, and the loadout is the user's call: "read-only" is a pi-web
 * preset, not a host-neutral idea, and the two hosts do not even name the same
 * tools. The names come from the host (`defaultBtwTools` starts the selection,
 * `pinnableTools` is what it may be given), so nothing here assumes a
 * vocabulary.
 */
function draftToolChips(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  const names = btwChipNames(draft.toolOptions ?? [], draft.tools)
  const chips = names.map(name => {
    const on = draft.tools.includes(name)
    return `<button class="draft-tool-chip${on ? ' is-on' : ''}" type="button" data-action="toggle-draft-tool" data-tool="${escapeHtml(name)}" aria-pressed="${on}" title="${on ? `不再给侧问 ${escapeHtml(name)} 工具` : `给侧问 ${escapeHtml(name)} 工具`}" ${disabled}>${escapeHtml(name)}</button>`
  }).join('')
  return `<div class="draft-tool-chips" role="group" aria-label="这个侧问可用的工具"><span class="draft-tool-chips-label">工具</span>${chips}</div>`
}

function draftActions(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  return `<div class="draft-actions"><button type="button" data-action="cancel-draft" ${disabled} aria-label="取消" title="取消">${closeIcon()}</button><button class="primary" type="submit" ${disabled} aria-label="发送" title="发送">${ICON(`<path d="${ICON_PATHS.arrowUp}"/>`)}</button></div>`
}

function quickPhraseEditor(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  const phrases = state.quickPhrases.map((phrase, index) => `<div class="draft-quick-phrase-editor-row"><input data-quick-phrase-index="${index}" maxlength="${MAX_QUICK_PHRASE_LENGTH}" value="${escapeHtml(phrase)}" aria-label="快捷词 ${index + 1}" ${disabled}><button type="button" data-action="remove-quick-phrase" data-quick-phrase-index="${index}" aria-label="删除 ${escapeHtml(phrase)}" title="删除" ${disabled}>${closeIcon()}</button></div>`).join('')
  return `<section class="draft-quick-editor" aria-label="编辑快捷词"><div class="draft-quick-editor-list">${phrases}</div><div class="draft-quick-phrase-add"><input maxlength="${MAX_QUICK_PHRASE_LENGTH}" placeholder="添加快捷词" aria-label="添加快捷词" ${disabled}><button class="primary" type="button" data-action="add-quick-phrase" aria-label="添加快捷词" title="添加快捷词" ${disabled}>${ICON(`<path d="${ICON_PATHS.plus}"/>`)}</button></div><button class="draft-quick-editor-close" type="button" data-action="close-quick-phrase-editor" ${disabled}>完成</button></section>`
}

function draftQuickPhrases(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  if (state.quickPhraseEditorOpen) return quickPhraseEditor(draft)
  const phrases = state.quickPhrases.map(phrase => `<button class="draft-quick-phrase" type="button" data-action="insert-quick-phrase" data-quick-phrase="${escapeHtml(phrase)}" ${disabled}>${escapeHtml(phrase)}</button>`).join('')
  return `<div class="draft-quick-phrases" aria-label="常用补充词">${phrases}<button class="draft-quick-phrase-add-button" type="button" data-action="open-quick-phrase-editor" aria-label="管理快捷词" title="管理快捷词" ${disabled}>${ICON(`<path d="${ICON_PATHS.plus}"/>`)}</button></div>`
}

/**
 * Read one image file as base64 (no data-URL prefix), which is the shape the
 * host's prompt command validates.
 */
/**
 * Attach image files to the draft being composed.
 *
 * Everything that cannot be sent is refused with a specific reason instead of
 * being silently dropped: an oversized image that just vanishes looks like a
 * broken paste, and the host would reject the whole prompt anyway.
 */
async function attachImages(files) {
  if (state.draft === null || files.length === 0) return
  const images = state.draft.images ?? (state.draft.images = [])
  const room = MAX_IMAGES - images.length
  if (room <= 0) return setError(`一条消息最多 ${MAX_IMAGES} 张图片`)
  if (files.length > room) setError(`一条消息最多 ${MAX_IMAGES} 张图片，多出的已忽略`)
  for (const file of files.slice(0, room)) {
    if (!file.type.startsWith('image/')) return setError(`不支持的附件类型：${file.type || '未知'}`)
    if (file.size > MAX_IMAGE_BYTES) return setError(`单张图片不能超过 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`)
    const image = await compressImageFile(file)
    images.push({ ...image, previewUrl: URL.createObjectURL(file) })
    render()
  }
}

function removeDraftImage(index) {
  const images = state.draft?.images
  if (!Array.isArray(images) || index < 0 || index >= images.length) return
  const [removed] = images.splice(index, 1)
  if (typeof removed?.previewUrl === 'string') URL.revokeObjectURL(removed.previewUrl)
  render()
}

function insertQuickPhrase(phrase) {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement) || state.draft === null) return
  const start = input.selectionStart
  const end = input.selectionEnd
  const prefix = input.value.slice(0, start)
  const suffix = input.value.slice(end)
  const separator = prefix !== '' && !prefix.endsWith('\n') ? '\n' : ''
  const text = `${prefix}${separator}${phrase}${suffix}`
  if (text.length > input.maxLength) return setError('追问内容不能超过 4000 个字符')
  const caret = prefix.length + separator.length + phrase.length
  input.value = text
  state.draft.text = text
  input.focus()
  input.setSelectionRange(caret, caret)
}

function addQuickPhrase(value) {
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') return false
  if (state.quickPhrases.includes(phrase)) return setError('这个快捷词已经存在')
  if (state.quickPhrases.length >= MAX_QUICK_PHRASES) return setError(`最多保留 ${MAX_QUICK_PHRASES} 个快捷词`)
  state.quickPhrases.push(phrase)
  persistQuickPhrases()
  return true
}

function updateQuickPhrase(index, value) {
  if (!Number.isInteger(index) || index < 0 || index >= state.quickPhrases.length) return
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') {
    state.quickPhrases.splice(index, 1)
  } else if (state.quickPhrases.some((item, itemIndex) => itemIndex !== index && item === phrase)) {
    return setError('这个快捷词已经存在')
  } else {
    state.quickPhrases[index] = phrase
  }
  persistQuickPhrases()
  render()
}

function draftPlacement(cards) {
  const draft = state.draft
  if (draft === null || draft.kind === 'new') return null
  // A btw draft hangs below the card whose btw button opened it, exactly where
  // the finished widget will land, so submitting does not make it jump.
  if (draft.kind === 'btw') {
    const anchor = draft.anchorId === undefined
      ? cards.filter(card => card.hostThreadId === draft.parentId).at(-1)
      : cards.find(card => card.id === draft.anchorId)
    if (anchor === undefined) return null
    // Slot the draft after the side questions already hanging there.
    const existing = state.workspace?.threads.filter(thread => thread.kind === 'btw' && thread.parentId === draft.parentId).length ?? 0
    return { parent: anchor, position: btwSlot(anchor, existing) }
  }
  const parent = draft.anchorId === undefined
    ? cards.filter(card => card.hostThreadId === draft.parentId).at(-1)
    : cards.find(card => card.id === draft.anchorId)
  if (parent === undefined) return null
  return { parent, position: firstAvailableCardPosition({ x: parent.position.x + 365, y: parent.position.y }, cards.map(card => card.position)) }
}

/** Where the Nth btw widget sits: a compact row just below the parent card. */
function btwSlot(card, index) {
  const width = Math.round(CARD_WIDTH / 3)
  const gap = 10
  return { x: card.position.x + index * (width + gap), y: card.position.y + CARD_HEIGHT + 18 }
}

/**
 * One /btw side question, as a collapsed widget under its parent card.
 *
 * A btw thread deliberately produces NO turn cards: it is a side question, not
 * a turn in the main chain, so rendering it as a node would misrepresent the
 * conversation's shape. The widget is the whole surface; clicking it opens the
 * thread's detail view, where the full exchange and the composer live.
 */
function btwWidget(thread, parentCard, index) {
  const position = btwSlot(parentCard, index)
  const title = thread.title ?? thread.sessionTitle ?? '侧问'
  const messages = messagesFor(thread)
  const turns = messages.filter(message => message.kind === 'user').length
  // A card can only be archived from the canvas while pi-web does not hold it
  // archived, and restored only while it does; showing the impossible action
  // was how a permanently archived session looked like an ordinary one.
  const waiting = state.pendingReplies.has(thread.sessionId)
  const usage = contextUsageFor(thread.id)
  const tools = Array.isArray(thread.tools) ? thread.tools.length : null
  const hint = `侧问：${title}${tools === null ? '' : `（工具 ${tools} 个）`}`
  return `<article class="btw-widget${waiting ? ' is-running' : ''}" data-btw-widget="${escapeHtml(thread.id)}" data-thread="${escapeHtml(thread.id)}" style="left:${position.x}px;top:${position.y}px">
    <button class="btw-widget-open" data-action="show-thread" data-thread="${escapeHtml(thread.id)}" title="${escapeHtml(hint)}" aria-label="${escapeHtml(hint)}">
      <span class="btw-widget-badge">btw</span>
      <span class="btw-widget-title">${escapeHtml(title)}</span>
      <span class="btw-widget-turns">${turns === 0 ? '待提问' : `${turns} 问`}</span>
      ${usage === null ? '' : `<span class="btw-widget-usage">${Math.round(usage.percent)}%</span>`}
    </button>
    ${state.capabilities.archiveSession === true ? `<button class="btw-widget-remove" data-action="archive-thread" data-thread="${escapeHtml(thread.id)}" title="从画布移除这个侧问（${state.hostLabels.archiveHint}）" aria-label="移除侧问">${closeIcon()}</button>` : ''}
  </article>`
}

/**
 * Every visible btw widget for the current view.
 *
 * A widget is anchored to a card, so it appears exactly when that card does:
 * collapsing the parent's children hides the widget with them, without the
 * widget ever entering the graph itself.
 */
function btwWidgets(cards, threads, visibleIds = null) {
  const widgets = []
  for (const thread of threads) {
    if (thread.kind !== 'btw' || thread.parentId === null) continue
    // The widget hangs off the LAST card of the parent thread, so a side
    // question opened from turn 3 sits with turn 3 rather than at the top.
    const anchor = [...cards].reverse().find(card => card.hostThreadId === thread.parentId)
    if (anchor === undefined) continue
    // A folded ancestor hides the anchor card; the widget follows it, so a
    // collapsed branch takes its side questions out of view with it.
    if (visibleIds !== null && !visibleIds.has(anchor.id)) continue
    widgets.push(btwWidget(thread, anchor, widgets.length))
  }
  return widgets.join('')
}

// The attach affordance shares one code path with paste (`attachImages`), so a
// screenshot from the clipboard and a file from disk behave identically. The
// file input stays in the DOM (hidden) because its value is what carries the
// picked files, and it is cleared after each pick so the same file can be
// chosen twice.
function draftAttachments(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  const images = draft.images ?? []
  const previews = images.map((image, index) => `<span class="draft-image"><img src="${image.previewUrl}" alt="待发送的图片 ${index + 1}"><button type="button" data-action="remove-draft-image" data-image-index="${index}" aria-label="移除图片 ${index + 1}" title="移除" ${disabled}>${closeIcon()}</button></span>`).join('')
  return `<div class="draft-attachments">${previews === '' ? '' : `<div class="draft-images">${previews}</div>`}<div class="draft-attach-row"><input class="draft-image-input" type="file" accept="image/*" multiple hidden data-image-input aria-label="选择图片"><button class="draft-attach-button" type="button" data-action="pick-images" title="添加图片（也可直接粘贴到输入框）" aria-label="添加图片" ${disabled}>${ICON('<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><circle cx="5.75" cy="6.75" r="1.1"/><path d="M3 11.5l3.2-3 2.3 2.1 2.1-1.9 2.4 2.2"/>')}<span>图片</span></button>${images.length === 0 ? '' : `<span class="draft-attach-count">${images.length}/${MAX_IMAGES}</span>`}</div></div>`
}

function draftCard(cards) {
  const draft = state.draft
  if (draft?.kind === 'new') return `<article class="thread-card draft-card first-session-card" data-card-id="draft" style="left:86px;top:82px;--thread-color:var(--ink)">
    <div class="thread-card-head"><span class="topic-dot"></span><strong>新会话</strong></div>
    <form class="draft-branch-form" data-draft><textarea maxlength="4000" placeholder="输入第一条消息（可直接粘贴图片）" ${draft.sending ? 'disabled' : ''}>${escapeHtml(draft.text)}</textarea>${draftAttachments(draft)}${draftActions(draft)}</form>
  </article>`
  const placement = draftPlacement(cards)
  if (draft === null || placement === null) return ''
  const continuing = draft.kind === 'continue'
  const isBtw = draft.kind === 'btw'
  const heading = isBtw ? '新的侧问 /btw' : continuing ? '新的追问' : '新的分支'
  // The /btw placeholder promises nothing about archiving: whether the child
  // gets hidden from the host's own session list is the host's business
  // (pi-web archives it, DSH must not), and the button's own tooltip carries
  // that host's wording (`hostLabels.btwArchiveHint`).
  const placeholder = isBtw ? '输入侧问（继承当前上下文，工具自选）' : continuing ? '输入追问（可直接粘贴图片）' : '输入这个分支的新问题（可直接粘贴图片）'
  return `<article class="thread-card draft-card${isBtw ? ' draft-btw-card' : ''}" data-card-id="draft" style="left:${placement.position.x}px;top:${placement.position.y}px;--thread-color:${isBtw ? 'var(--violet)' : 'var(--ink)'}">
    <div class="thread-card-head"><span class="topic-dot"></span><strong>${heading}</strong></div>
    <form class="draft-branch-form" data-draft>${draftQuickPhrases(draft)}<textarea maxlength="4000" placeholder="${placeholder}" ${draft.sending ? 'disabled' : ''}>${escapeHtml(draft.text)}</textarea>${isBtw ? draftToolChips(draft) : ''}${draftAttachments(draft)}${draftActions(draft)}</form>
  </article>`
}

function selectionFollowupButton() {
  return `<button class="selection-followup" type="button" data-action="follow-selection" hidden aria-label="基于所选内容创建追问" title="基于所选内容追问">${ICON(`<path d="${ICON_PATHS.speaker}"/><path d="${ICON_PATHS.speakerAdd}"/>`)}<span>追问</span></button>`
}

// Cards are mounted into the DOM only when they intersect the viewport
// (inflated by VIEWPORT_MARGIN) in world coordinates. The camera transform is
// translate(camera) scale(zoom), so screen = world * zoom + camera.
function visibleCardIds(cards) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return new Set(cards.map(card => card.id))
  const bounds = viewport.getBoundingClientRect()
  const left = (-state.canvasCamera.x - VIEWPORT_MARGIN) / state.zoom
  const right = (bounds.width - state.canvasCamera.x + VIEWPORT_MARGIN) / state.zoom
  const top = (-state.canvasCamera.y - VIEWPORT_MARGIN) / state.zoom
  const bottom = (bounds.height - state.canvasCamera.y + VIEWPORT_MARGIN) / state.zoom
  const visible = new Set()
  for (const card of cards) {
    const { x, y } = card.position
    if (x + CARD_WIDTH < left || x > right || y + CARD_HEIGHT < top || y > bottom) continue
    visible.add(card.id)
  }
  return visible
}

// Incrementally mount cards entering the viewport and unmount cards leaving
// it, without rebuilding the canvas. Called after pan/zoom/focus camera moves.
function syncCanvasViewport() {
  if (state.mode !== 'canvas' || state.canvasCards === undefined) return
  const layer = document.querySelector('.cards-layer')
  if (!(layer instanceof HTMLElement)) return
  const visible = visibleCardIds(state.canvasCards)
  for (const cardId of [...state.mountedCardIds]) {
    if (visible.has(cardId)) continue
    const element = layer.querySelector(`[data-card-id="${selectorValue(cardId)}"]`)
    if (element instanceof HTMLElement) element.remove()
    state.mountedCardIds.delete(cardId)
  }
  for (const card of state.canvasCards) {
    if (!visible.has(card.id) || state.mountedCardIds.has(card.id)) continue
    const wrapper = document.createElement('div')
    wrapper.innerHTML = conversationCard(card, state.canvasGraph)
    const element = wrapper.firstElementChild
    if (element instanceof HTMLElement) {
      layer.appendChild(element)
      const handle = element.querySelector('[data-drag-card]')
      if (handle instanceof HTMLElement) bindDragHandle(handle)
    }
    state.mountedCardIds.add(card.id)
  }
}

/**
 * Empty the card model when the map has nothing to draw.
 *
 * The card set is read outside the render path too (`state.canvasCards` for the
 * collapse pass, the connector cache, the reveal/pan targets), so leaving the
 * last non-empty set behind means those readers keep working from cards the
 * canvas no longer draws — measured as 「卡片还在」 for a session that had just
 * been hidden.
 */
function clearCanvasCards() {
  const empty = conversationGraphView([])
  state.canvasCards = empty.cards
  state.canvasCardsById = new Map()
  state.canvasGraph = empty
  state.mountedCardIds = new Set()
}

function renderCanvas() {
  const threads = state.workspace?.threads ?? []
  if (threads.length === 0 && state.draft?.kind !== 'new') {
    clearCanvasCards()
    return `<section class="empty-canvas"><strong>当前工作目录还没有会话</strong><p>${state.capabilities.createSession === true ? '新建一个会话，在画布上输入第一条消息。' : state.hostLabels.startHint}</p>${state.capabilities.createSession === true ? '<div><button class="primary" type="button" data-action="create-session">新建会话</button></div>' : ''}</section>`
  }
  // Cards are built from the VISIBLE threads only: a hidden (or aged-out)
  // session must not occupy a lane, a connector or a card slot. The sidebar
  // still lists every thread, which is what makes the hiding reversible.
  const visibleThreads = threads.filter(isThreadVisible)
  if (visibleThreads.length === 0 && state.draft?.kind !== 'new') {
    clearCanvasCards()
    const stale = threads.filter(thread => threadVisibility(thread) === 'stale').length
    const hidden = threads.length - stale
    const reasons = [stale === 0 ? '' : `${stale} 个超过 ${RECENT_WINDOW_DAYS} 天没有活动`, hidden === 0 ? '' : `${hidden} 个被收起`].filter(reason => reason !== '').join('，')
    return `<section class="empty-canvas"><strong>这个工作区暂时没有要显示的卡片</strong><p>${reasons}。在左侧「会话」列表里点眼睛图标可以把它们放回画布。</p>${state.capabilities.createSession === true ? '<div><button class="primary" type="button" data-action="create-session">新建会话</button></div>' : ''}</section>`
  }
  const allCards = conversationCards(visibleThreads)
  const graph = conversationGraphView(allCards)
  const cards = graph.cards
  state.canvasCards = cards
  state.canvasCardsById = new Map(cards.map(card => [card.id, card]))
  state.canvasGraph = graph
  // An EMPTY canvas must not consume the initial framing: the host's chrome
  // signal and the workspace load race, and a frame computed for zero cards
  // left the first real card outside the viewport (measured: x = -155 inside the
  // frame). So the flag stays false until there is something to frame.
  if (!state.canvasViewInitialized && cards.length > 0) {
    state.canvasCamera = initialCanvasCamera(cards)
    state.canvasViewInitialized = true
    // The viewport is not laid out yet while renderCanvas builds its HTML;
    // center the focused card once the DOM is mounted (render tail).
    state.canvasNeedsCenter = true
  }
  const visible = visibleCardIds(cards)
  state.mountedCardIds = new Set(visible)
  const mounted = cards.filter(card => visible.has(card.id))
  const widgets = btwWidgets(cards, visibleThreads, visible)
  return `<section class="canvas-view"><div class="canvas-viewport"><div class="canvas-content" style="transform:translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})"><svg class="connectors">${canvasConnectors(cards)}</svg><div class="cards-layer">${mounted.map(card => conversationCard(card, graph)).join('')}${widgets}${draftCard(cards)}</div></div></div></section>`
}

function isProcessMessage(message) {
  if (message.kind === 'tool' || message.kind === 'tool-result') return true
  return message.kind === 'assistant' && /(?:^|\n)\s*(?:bash|pwsh|powershell|web_search|web_fetch|browser|read_file|write_file)\s*\n\s*\{/.test(message.text)
}

function processSummary(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140) || '工具调用记录'
}

function threadMessage(thread, message) {
  const isUser = message.kind === 'user'
  const label = isUser ? '你'
    : message.kind === 'assistant' ? 'pi'
    : message.kind === 'error' ? '错误'
    : message.kind === 'compaction' ? '上下文压缩'
    : message.kind === 'branch' ? '分支摘要'
    : '记录'
  const branch = message.kind === 'assistant' && typeof message.sourceEntryId === 'string' && message.sourceEntryId !== ''
    ? `<button class="message-branch" data-action="open-branch" data-thread="${thread.id}" data-seq="${message.sourceEntryId}" title="从此回答创建分支">${ICON(`<path d="${ICON_PATHS.branch}"/><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="11.5" cy="12" r="1.5"/>`)}分支</button>`
    : ''
  const messageId = `${thread.id}:${message.sourceEntryId ?? `${message.kind}:${message.at}`}`
  const collapsible = isProcessMessage(message)
  const expanded = state.expandedMessageIds.has(messageId)
  const fold = collapsible ? `<button class="message-fold" data-action="toggle-message" data-message="${escapeHtml(messageId)}" aria-label="${expanded ? '收起过程记录' : '展开过程记录'}" title="${expanded ? '收起' : '展开'}">${ICON(`<path d="${ICON_PATHS.chevronRight}"/>`)}</button>` : ''
  const process = Array.isArray(message.process) && message.process.length > 0 ? message.process : null
  const body = message.pending && message.text === '' ? '<p class="message-streaming"><span class="streaming-dot"></span>正在回复</p>'
    : `${collapsible && !expanded ? `<p class="message-summary">${escapeHtml(processSummary(message.text))}</p>` : renderMarkdown(displayText(message))}${message.pending ? '<p class="message-streaming"><span class="streaming-dot"></span>正在回复</p>' : ''}${process === null ? '' : processRecords(process, messageId)}`
  const avatar = isUser ? '' : '<span class="message-avatar" aria-hidden="true"></span>'
  return `<article class="message message-${message.kind}${message.pending ? ' message-pending' : ''}${collapsible ? ' message-collapsible' : ''}${expanded ? ' expanded' : ''}" data-message-seq="${typeof message.sourceEntryId === 'string' && message.sourceEntryId !== '' ? message.sourceEntryId : ''}"><header>${avatar}<span class="message-role">${label}</span><time>${formatTime(message.at)}</time>${branch}${fold}</header><div class="message-body">${body}</div></article>`
}

function processRecords(process, messageId) {
  const key = `${messageId}:process`
  const expanded = state.expandedMessageIds.has(key)
  const entries = process.map((entry, index) => {
    const entryKey = `${key}:${index}`
    const entryExpanded = state.expandedMessageIds.has(entryKey)
    const status = entry.error !== null ? '失败' : entry.result === null ? '等待结果' : '完成'
    const argumentsHtml = entry.arguments === null || entry.arguments === '' ? '' : `<pre class="process-args">${escapeHtml(entry.arguments)}</pre>`
    const outcomeHtml = entry.error !== null ? `<pre class="process-error">${escapeHtml(entry.error)}</pre>` : entry.result === null ? '' : `<pre class="process-result">${escapeHtml(entry.result)}</pre>`
    return `<div class="process-entry${entryExpanded ? ' expanded' : ''}"><button class="process-entry-fold" data-action="toggle-message" data-message="${escapeHtml(entryKey)}"><span class="process-entry-name">${escapeHtml(entry.name)}</span><span class="process-status${entry.error !== null ? ' process-status-error' : entry.result === null ? ' process-status-pending' : ' process-status-done'}">${status}</span></button>${entryExpanded ? `<div class="process-entry-body">${argumentsHtml}${outcomeHtml}</div>` : ''}</div>`
  }).join('')
  return `<section class="process-records${expanded ? ' expanded' : ''}"><button class="process-records-fold" data-action="toggle-message" data-message="${escapeHtml(key)}"><span>${expanded ? '收起过程记录' : '过程记录'}</span><span class="process-count">${process.length}</span></button>${expanded ? entries : ''}</section>`
}

function messagesForCard(card) {
  const thread = state.workspace?.threads.find(item => item.id === card.hostThreadId)
  if (thread === undefined) return { thread: null, messages: [] }
  const messages = messagesFor(thread)
  let turnIndex = -1
  let start = -1
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].kind !== 'user') continue
    turnIndex += 1
    if (turnIndex === card.turnIndex) {
      start = index
      break
    }
  }
  if (start === -1) return { thread, messages: [] }
  const end = messages.findIndex((message, index) => index > start && message.kind === 'user')
  return { thread, messages: messages.slice(start, end === -1 ? undefined : end) }
}

function renderThread() {
  const thread = currentThread()
  if (thread === null) return renderCanvas()
  const messages = messagesFor(thread)
  const waiting = state.pendingReplies.has(thread.sessionId)
  const latestAssistantSeq = [...messages].reverse().find(message => typeof message.sourceEntryId === 'string' && message.sourceEntryId !== '')?.sourceEntryId
  // The masthead line reports the transcript's own extent, not a wall clock:
  // the canvas reads session files, so the last entry's timestamp is the only
  // time it can honestly claim.
  const lastAt = messages.at(-1)?.at
  const isBtw = thread.kind === 'btw'
  const badge = isBtw ? '侧问' : thread.parentId === null ? '会话' : '分支'
  // A btw thread reports what it may do: the tool set pi-web pinned on it,
  // which is what makes a side question materially different from a plain fork.
  const tools = isBtw && Array.isArray(thread.tools)
    ? `<span class="detail-tools" title="${state.hostLabels.toolsPinnedBy}">工具 ${thread.tools.length} 个</span>`
    : ''
  const usage = contextUsageFor(thread.id)
  const usageLabel = usage === null ? '' : `<span class="detail-usage" title="上下文占用">${usage.percent.toFixed(1)}% · ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}</span>`
  return `<section class="detail-view"><header class="detail-head"><div class="detail-head-title"><div class="detail-head-meta"><span class="detail-badge${isBtw ? ' detail-badge-btw' : ''}">${badge}</span>${tools}${usageLabel}${thread.sessionTitle ?? thread.title ? `<span class="detail-subtitle">${escapeHtml(thread.sessionTitle ?? thread.title)}</span>` : ''}</div><h1>${escapeHtml(questionFor(thread))}</h1><p class="detail-eyebrow">${messages.length} 条记录${lastAt === undefined ? '' : ` · 最后更新 ${formatTime(lastAt)}`}</p></div><div class="detail-head-actions"><button data-action="open-host" data-thread="${thread.id}" data-seq="${typeof latestAssistantSeq === 'string' && latestAssistantSeq !== '' ? latestAssistantSeq : ''}" title="${state.hostLabels.openIn}此会话">${state.hostLabels.openIn}</button><button data-action="open-branch" data-thread="${thread.id}" title="基于最新回答创建分支">创建分支</button><button class="primary" data-action="show-canvas">返回画布</button></div></header><div class="detail-scroll">${messages.map(message => threadMessage(thread, message)).join('') || '<div class="note-empty">等待这条会话的第一条消息。</div>'}</div><form class="message-composer" data-compose="${thread.id}"><textarea maxlength="4000" placeholder="${isBtw ? '继续这个侧问…' : '继续当前会话…'}" ${waiting ? 'disabled' : ''}></textarea><button class="primary" type="submit" ${waiting ? 'disabled' : ''}>${waiting ? '等待回复' : '发送'}</button></form></section>`
}

function render() {
  // Remember the departing thread's scroll position per thread id, so switching
  // sessions restores each conversation's own place instead of smearing one
  // session's position onto another. It only applies when the user is already
  // READING that transcript (scrolling, composer focus); an explicit entry —
  // clicking a card or a btw widget — must land on its target, not on a stale
  // offset from a previous visit.
  if (state.mode === 'thread' && state.detailThreadId !== null && state.detailTargetCardId === null) {
    const detail = document.querySelector('.detail-scroll')
    if (detail instanceof HTMLElement) state.detailScrollByThread.set(state.detailThreadId, detail.scrollTop)
  }
  state.detailThreadId = state.mode === 'thread' ? state.activeId : null
  const detailScrollTop = state.detailThreadId === null ? null : state.detailScrollByThread.get(state.detailThreadId) ?? null
  const cardScrollTops = new Map()
  if (state.mode === 'canvas') {
    // Key by the unique card id: every card of a session shares data-thread,
    // so keying on it would clobber sibling cards' scroll positions. Only
    // scrollable answers have a position worth preserving; reading the two
    // height properties shares the same forced layout as the scrollTop read.
    for (const answer of document.querySelectorAll('.thread-card[data-thread] .thread-answer')) {
      if (answer.scrollHeight <= answer.clientHeight) continue
      const card = answer.closest('.thread-card')
      if (card instanceof HTMLElement && typeof card.dataset.cardId === 'string') cardScrollTops.set(card.dataset.cardId, answer.scrollTop)
    }
  }
  const workspace = state.workspace
  const threads = workspace?.threads ?? []
  const view = state.mode === 'thread' ? renderThread() : renderCanvas()
  const choices = workspaceChoices()
  const selectedWorkspaceId = state.selectedHostWorkspaceId ?? workspace?.id
  const canvasControls = state.mode === 'canvas' && (threads.length > 0 || state.draft?.kind === 'new') ? `<div class="canvas-controls"><button data-action="layout" title="整理节点" aria-label="整理节点">${ICON(`<path d="${ICON_PATHS.grid}"/>`)}整理</button><button data-action="focus-active" title="定位到当前会话" aria-label="定位到当前会话">${ICON(`<path d="${ICON_PATHS.target}"/>`)}定位</button><button data-action="zoom-out" aria-label="缩小" title="缩小">${ICON(`<path d="${ICON_PATHS.zoomOut}"/>`)}</button><span>${Math.round(state.zoom * 100)}%</span><button data-action="zoom-in" aria-label="放大" title="放大">${ICON(`<path d="${ICON_PATHS.zoomIn}"/>`)}</button></div>` : ''
  const detailAvailable = currentThread() !== null
  const canvasTabs = `<nav class="canvas-tabs" aria-label="会话地图视图"><button class="${state.mode === 'canvas' ? 'active' : ''}" data-action="show-canvas">地图</button><button class="${state.mode === 'thread' ? 'active' : ''}" data-action="show-thread" data-thread="${state.activeId ?? ''}" ${detailAvailable ? '' : 'disabled'}>详情</button></nav>`
  const newSessionButton = state.capabilities.createSession === true
    ? `<button class="new-workspace" type="button" data-action="create-session" ${state.draft !== null ? 'disabled' : ''}>${ICON(`<path d="${ICON_PATHS.plus}"/>`, { className: 'new-session-icon' })}<span>新会话</span></button>`
    : ''
  // The sidebar is an index, not a menu: each row carries its position in the
  // list, its kind, and a colour keyed to the thread's lane on the canvas.
  const visibleCount = threads.filter(isThreadVisible).length
  // 「在地图上的 / 全部」：只报总数、而画布上明显更少时看起来像 bug。
  const countLabel = visibleCount === threads.length ? `${threads.length}` : `${visibleCount} / ${threads.length}`
  const threadRows = threads.map((thread, index) => {
    const visibility = threadVisibility(thread)
    const off = visibility !== 'shown'
    const action = off ? '显示这个会话的卡片' : '隐藏这个会话的卡片'
    const reason = visibility === 'stale' ? `（${RECENT_WINDOW_DAYS} 天前没有活动，默认不显示）` : ''
    // The badge slot carries one thing only — why this row looks the way it does.
    const badge = visibility === 'stale' ? `<i class="tree-stale">${RECENT_WINDOW_DAYS} 天前</i>`
      : thread.kind === 'btw' ? '<i class="tree-btw">btw</i>'
        : thread.parentId === null ? '' : '<i>分支</i>'
    return `<div class="tree-item${off ? ' is-off' : ''}"><button class="tree-row ${thread.id === state.activeId ? 'active' : ''}" data-action="select-thread" data-thread="${thread.id}" style="--thread-color:${laneColor(index)}"><span class="tree-dot"></span><span class="tree-index">${String(index + 1).padStart(2, '0')}</span><span class="tree-title">${escapeHtml(threadListTitle(thread))}</span>${badge}</button><button class="tree-visibility" type="button" data-action="toggle-visibility" data-thread="${thread.id}" aria-pressed="${off ? 'true' : 'false'}" aria-label="${action}${reason}" title="${action}${reason}">${off ? EYE_OFF_ICON : EYE_ICON}</button></div>`
  }).join('')
  const workspacePath = choices.find(item => item.id === selectedWorkspaceId)?.path ?? workspace?.cwd ?? null
  const mastheadLead = `<div class="topbar-lead"><span class="topbar-eyebrow">工作区</span><span class="topbar-title" title="${escapeHtml(workspacePath ?? '')}">${escapeHtml(workspace?.title ?? '未命名工作区')}</span></div>`
  // 切换「对话 / 会话地图」的唯一入口在宿主页面里（bridge 注入的那条，它同时
  // 悬浮在画布上方）。画布内不重复渲染一份：两个看起来一样的切换控件、一个
  // fixed 居中一个在顶栏栅格里，x 不同，用户会看到两个（已实际发生）。
  //
  // 嵌入模式（宿主自己有壳）：侧栏、顶栏、视图标签全部不渲染，工具改为浮动簇 ——
  // 留一条横跨顶部的栏就还是「应用套应用」。
  const embedded = state.embedded
  app.innerHTML = `<main class="synapse-shell ${embedded ? 'embedded' : (state.sidebarCollapsed ? 'sidebar-collapsed' : '')}">${embedded ? '' : `<aside class="sidebar"><div class="sidebar-brand-row"><div class="brand" aria-label="Synapse"><strong>Synapse</strong></div><button class="sidebar-toggle" type="button" data-action="toggle-sidebar" aria-label="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}" title="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}">${ICON('<rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.25"/><path d="M6.25 2.5v11"/>')}</button></div>${newSessionButton}<label class="workspace-label"><span>工作区</span><span class="workspace-select">${ICON('<path d="M2 5.75a1.5 1.5 0 0 1 1.5-1.5h2.2c.4 0 .78.16 1.06.44l.54.54h4.2a1.5 1.5 0 0 1 1.5 1.5v4.52a1.5 1.5 0 0 1-1.5 1.5H3.5a1.5 1.5 0 0 1-1.5-1.5Z"/>')}<select data-action="select-workspace" aria-label="选择工作区" ${state.draft !== null ? 'disabled' : ''}>${choices.map(item => `<option value="${item.id}" title="${escapeHtml(item.path ?? item.title)}" ${item.id === selectedWorkspaceId ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select></span></label><div class="sidebar-heading"><span>会话</span><span class="sidebar-count" title="地图上显示的 / 全部会话">${countLabel}</span></div><nav class="thread-tree">${threadRows || '<p class="tree-empty">暂未同步会话</p>'}</nav></aside>`}${embedded ? '' : `<header class="topbar">${mastheadLead}${canvasControls}</header>`}<section class="main-stage">${state.error ? `<div class="status-message" role="alert"><span>${escapeHtml(state.error)}</span><button data-action="dismiss-error" aria-label="关闭" title="关闭">${closeIcon()}</button></div>` : ''}${embedded ? '' : canvasTabs}${view}${embedded ? canvasControls : ''}${selectionFollowupButton()}</section></main>`
  installDragging()
  cacheCardConnectors()
  // The initial camera from renderCanvas is inset (viewport not laid out yet);
  // center it on the focused card once the canvas DOM is mounted.
  if (state.canvasNeedsCenter) {
    state.canvasNeedsCenter = false
    window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
  }
  for (const [cardId, scrollTop] of cardScrollTops) {
    const answer = app.querySelector(`.thread-card[data-card-id="${CSS.escape(cardId)}"] .thread-answer`)
    if (answer instanceof HTMLElement) answer.scrollTop = scrollTop
  }
  // Detail scroll is applied SYNCHRONOUSLY, always in the same order: the
  // remembered position first, then an explicit target. Deferring either to
  // requestAnimationFrame let a second render in the same frame record the
  // PRE-scroll position and then restore it *after* the anchor jump — the
  // transcript landed thousands of pixels from the turn that was clicked
  // (measured: -5717px). The DOM is already built here, so there is nothing to
  // wait for.
  const scroller = document.querySelector('.detail-scroll')
  if (scroller instanceof HTMLElement && detailScrollTop !== null) scroller.scrollTop = detailScrollTop
  // Jump the detail view to where the user came from. A card id ends in the
  // source sequence of its question (`<thread>:turn:<sourceEntryId>`), which
  // matches the data-message-seq anchor on the rendered messages. That sequence
  // is a hex hash (`77e0044c`), NOT a number — a `(\d+)` pattern silently fails
  // every lookup and drops every card onto the latest message.
  //
  // Without an anchor — a btw widget, the detail tab — land on the thread's
  // LATEST message: a transcript that opens at the top makes a long
  // conversation look like it never got answered.
  const targetCardId = state.detailTargetCardId
  state.detailTargetCardId = null
  // Landing is a ONE-SHOT action per entry into the transcript. It must not be
  // re-applied on every render: the projection poll re-renders once a second,
  // and a repeated "scroll to the newest message" (the no-anchor fallback)
  // yanked the view off the turn the user had just clicked (measured: an
  // anchor that should sit at offset 0 ended up 11423px away, i.e. at the
  // bottom of a 368-message transcript).
  //
  // `state.detailEntered` is set by whoever opens the detail view and cleared
  // here; later renders only restore the position the user scrolled to.
  const entering = state.detailEntered === true
  state.detailEntered = false
  if (scroller instanceof HTMLElement && entering) {
    const match = targetCardId === null ? null : /:turn:([^:]+)$/.exec(targetCardId)
    // `:turn:empty` is the placeholder card of a thread with no messages yet.
    const seq = match === null || match[1] === 'empty' ? null : match[1]
    const anchored = seq === null ? null : app.querySelector(`[data-message-seq="${CSS.escape(seq)}"]`)
    const target = anchored ?? [...scroller.querySelectorAll('.message')].at(-1)
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: anchored === null ? 'end' : 'start' })
      // Record where this lands. The memory block at the top of render is
      // skipped while a target is pending (its scrollTop is still the fresh
      // render's 0), so without this the NEXT render would restore the stale
      // pre-entry position and undo the jump.
      if (state.detailThreadId !== null) state.detailScrollByThread.set(state.detailThreadId, scroller.scrollTop)
    }
  }
}

function renderPreservingDetailScroll() {
  render()
}

function applyCanvasTransform() {
  const content = document.querySelector('.canvas-content')
  if (content instanceof HTMLElement) content.style.transform = `translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})`
}

/** Where a card sits right now, in canvas coordinates. */
function cardPosition(card, cardId) {
  const remembered = state.cardPositions.get(cardId)
  if (remembered !== undefined) return { x: remembered.x, y: remembered.y }
  return { x: Number.parseFloat(card.style.left) || 0, y: Number.parseFloat(card.style.top) || 0 }
}

/**
 * Move ONE card without re-rendering the canvas.
 *
 * Shared by the pointer drag (once per animation frame) and the keyboard nudge
 * (one step per press) so both keep the same four things in sync: the remembered
 * position, its position-key alias, the virtualized card model the viewport and
 * the connectors read, and the card's inline position. Only the caller decides
 * when to persist to localStorage — a drag persists once, on drop.
 */
function placeCard(card, cardId, position) {
  const rounded = { x: Math.round(position.x), y: Math.round(position.y) }
  const aliases = card.dataset.positionKey === undefined ? [] : [card.dataset.positionKey]
  for (const key of [cardId, ...aliases]) state.cardPositions.set(key, rounded)
  const dataCard = state.canvasCardsById?.get(cardId)
  if (dataCard !== undefined) dataCard.position = { x: position.x, y: position.y }
  card.style.left = `${position.x}px`
  card.style.top = `${position.y}px`
  refreshCardConnectors(cardId)
  return aliases
}

/** Darken (or not) the connectors attached to a card that is being dragged. */
function markDraggedConnectors(cardId, dragging) {
  const paths = connectorPathsByCard.get(cardId)
  if (paths === undefined) return
  for (const path of paths) path.classList.toggle('dragging-connector', dragging)
}

function bindDragHandle(handle) {
  handle.addEventListener('pointerdown', event => {
    const cardId = event.currentTarget.dataset.dragCard
    const card = event.currentTarget.closest('.thread-card')
    if (cardId === undefined || !(card instanceof HTMLElement)) return
    event.preventDefault()
    const origin = { x: event.clientX, y: event.clientY, position: { x: Number.parseFloat(card.style.left), y: Number.parseFloat(card.style.top) } }
    let position = origin.position
    let stopped = false
    let frame = 0
    state.dragging = true
    card.classList.add('is-dragging')
    markDraggedConnectors(cardId, true)
    // Coalesce pointermove updates to one DOM pass per animation frame so a
    // high report-rate pointer cannot queue a reflow per event.
    const apply = () => {
      frame = 0
      placeCard(card, cardId, position)
    }
    const move = moveEvent => {
      position = { x: origin.position.x + (moveEvent.clientX - origin.x) / state.zoom, y: origin.position.y + (moveEvent.clientY - origin.y) / state.zoom }
      if (frame === 0) frame = window.requestAnimationFrame(apply)
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
      const aliases = placeCard(card, cardId, position)
      rememberCardPosition(cardId, position, aliases)
      card.classList.remove('is-dragging')
      markDraggedConnectors(cardId, false)
      state.dragging = false
      deferCanvasRefresh(120)
      // No full render: only the dragged card's inline position and its
      // connectors changed; rebuilding the whole canvas on drop is the jank.
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  })

  // Dragging must not be the ONLY way to place a card (WCAG 2.2.6/2.2.7 apply to
  // any author-controlled drag). The handle is a real focusable button, so arrow
  // keys nudge it: 8px a step, 1px with Shift for fine alignment.
  handle.addEventListener('keydown', event => {
    const cardId = event.currentTarget.dataset.dragCard
    const card = event.currentTarget.closest('.thread-card')
    if (cardId === undefined || !(card instanceof HTMLElement)) return
    const step = event.shiftKey ? 1 : 8
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
    if (delta === undefined) return
    event.preventDefault()
    const from = cardPosition(card, cardId)
    const aliases = placeCard(card, cardId, { x: from.x + delta[0], y: from.y + delta[1] })
    rememberCardPosition(cardId, { x: from.x + delta[0], y: from.y + delta[1] }, aliases)
  })
}

function installDragging() {
  for (const handle of document.querySelectorAll('[data-drag-card]')) bindDragHandle(handle)
}

function canvasViewport(target) {
  return target instanceof Element ? target.closest('.canvas-viewport') : null
}

function zoomCanvas(viewport, nextZoom, clientX, clientY) {
  const zoom = Math.min(4, Math.max(.6, Math.round(nextZoom * 100) / 100))
  if (zoom === state.zoom) return
  const bounds = viewport.getBoundingClientRect()
  const localX = clientX - bounds.left
  const localY = clientY - bounds.top
  const worldX = (localX - state.canvasCamera.x) / state.zoom
  const worldY = (localY - state.canvasCamera.y) / state.zoom
  state.zoom = zoom
  state.canvasCamera = { x: localX - worldX * zoom, y: localY - worldY * zoom }
  const content = viewport.querySelector('.canvas-content')
  if (content instanceof HTMLElement) {
    // Drop the composited layer before zooming: a cached will-change raster
    // would be upscaled instead of re-rasterized, which was the original
    // zoom-blur bug. will-change re-applies via .is-panning on the next pan.
    content.style.willChange = 'auto'
    applyCanvasTransform()
    syncCanvasViewport()
    window.requestAnimationFrame(() => { content.style.willChange = '' })
  } else {
    applyCanvasTransform()
    syncCanvasViewport()
  }
  const label = document.querySelector('.canvas-controls span')
  if (label !== null) label.textContent = `${Math.round(state.zoom * 100)}%`
}

function zoomCanvasAtCenter(delta) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const bounds = viewport.getBoundingClientRect()
  zoomCanvas(viewport, state.zoom + delta, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
}

function focusActiveCard() {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const cards = state.canvasCards
  if (cards === undefined || cards.length === 0) return
  // Drafts win over the active conversation's latest turn; fall back to the
  // first card. Cards may be unmounted (outside the viewport), so the focus
  // target comes from the data model, never from DOM queries.
  const draft = state.draft === null ? undefined
    : state.draft.kind === 'new' ? { position: { x: 86, y: 82 } } : draftPlacement(cards)
  const activeCards = state.activeId === null || state.activeId === undefined ? [] : cards.filter(card => card.hostThreadId === state.activeId)
  const card = draft ?? activeCards.at(-1) ?? cards[0]
  const { x: left, y: top } = card.position
  const bounds = viewport.getBoundingClientRect()
  state.canvasCamera = {
    x: bounds.width / 2 - (left + CARD_WIDTH / 2) * state.zoom,
    y: bounds.height / 2 - (top + CARD_HEIGHT / 2) * state.zoom,
  }
  applyCanvasTransform()
  syncCanvasViewport()
}

let selectionFollowup = null
let selectionFollowupFrame = 0

function hideSelectionFollowup() {
  if (selectionFollowupFrame !== 0) {
    window.cancelAnimationFrame(selectionFollowupFrame)
    selectionFollowupFrame = 0
  }
  selectionFollowup = null
  const button = app.querySelector('.selection-followup')
  if (button instanceof HTMLButtonElement) button.hidden = true
}

function selectionFollowupTarget(range) {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  if (!(start instanceof Element) || !(end instanceof Element)) return null
  const answer = start.closest('.thread-answer')
  if (answer instanceof HTMLElement && answer.contains(end)) {
    const card = answer.closest('.thread-card[data-thread]:not(.draft-card)')
    if (card instanceof HTMLElement && card.dataset.thread !== undefined) return { threadId: card.dataset.thread }
  }
  const messageBody = start.closest('.message-assistant .message-body')
  const thread = currentThread()
  if (messageBody instanceof HTMLElement && messageBody.contains(end) && thread !== null) return { threadId: thread.id }
  return null
}

function updateSelectionFollowup() {
  selectionFollowupFrame = 0
  const button = app.querySelector('.selection-followup')
  const selection = window.getSelection()
  if (!(button instanceof HTMLButtonElement) || state.draft !== null || selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return hideSelectionFollowup()
  const text = selection.toString().trim()
  const range = selection.getRangeAt(0)
  const target = text === '' || text.length > 4000 ? null : selectionFollowupTarget(range)
  const rect = range.getBoundingClientRect()
  if (target === null || rect.width === 0 || rect.height === 0) return hideSelectionFollowup()
  selectionFollowup = { ...target, text }
  button.dataset.thread = target.threadId
  button.style.left = `${Math.min(window.innerWidth - 12, Math.max(76, rect.right))}px`
  button.style.top = `${Math.min(window.innerHeight - 38, Math.max(8, rect.bottom + 8))}px`
  button.hidden = false
}

function queueSelectionFollowup() {
  if (selectionFollowupFrame !== 0) return
  selectionFollowupFrame = window.requestAnimationFrame(updateSelectionFollowup)
}

app.addEventListener('pointerdown', event => {
  const viewport = canvasViewport(event.target)
  if (!(viewport instanceof HTMLElement) || event.target instanceof Element && event.target.closest('.thread-card, button, textarea, select')) return
  event.preventDefault()
  const origin = { x: event.clientX, y: event.clientY, camera: { ...state.canvasCamera } }
  let pendingCamera = null
  let frame = 0
  state.canvasGesture = true
  viewport.classList.add('is-panning')
  viewport.setPointerCapture(event.pointerId)
  const apply = () => {
    frame = 0
    if (pendingCamera === null) return
    state.canvasCamera = pendingCamera
    pendingCamera = null
    applyCanvasTransform()
    syncCanvasViewport()
  }
  const move = moveEvent => {
    pendingCamera = {
      x: origin.camera.x + moveEvent.clientX - origin.x,
      y: origin.camera.y + moveEvent.clientY - origin.y,
    }
    if (frame === 0) frame = window.requestAnimationFrame(apply)
  }
  const stop = () => {
    viewport.classList.remove('is-panning')
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
    apply()
    state.canvasGesture = false
    deferCanvasRefresh(120)
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
})

app.addEventListener('wheel', event => {
  const viewport = canvasViewport(event.target)
  if (!(viewport instanceof HTMLElement)) return
  const card = event.target instanceof Element ? event.target.closest('.thread-card') : null
  if (card instanceof HTMLElement) {
    // Over a card the wheel scrolls that card's own answer with the browser's
    // native wheel (OS-smooth, never a page jump per notch); the answer's
    // overscroll-behavior: contain stops the scroll chaining into the canvas.
    const answer = card.querySelector('.thread-answer')
    if (answer instanceof HTMLElement && answer.scrollHeight > answer.clientHeight) {
      deferCanvasRefresh()
      return
    }
    // A card with no scrollable answer swallows the wheel instead of zooming.
    event.preventDefault()
    deferCanvasRefresh()
    return
  }
  event.preventDefault()
  zoomCanvas(viewport, state.zoom + (event.deltaY < 0 ? .05 : -.05), event.clientX, event.clientY)
}, { passive: false })

// Track pointer-down so the card click handler can tell a plain click from a
// text-selection or drag gesture; acting on the latter would re-render and
// wipe the user's selection.
let pointerDownPosition = null
app.addEventListener('pointerdown', event => { pointerDownPosition = { x: event.clientX, y: event.clientY } })
app.addEventListener('pointerdown', event => {
  const button = event.target instanceof Element ? event.target.closest('.selection-followup') : null
  if (button instanceof HTMLButtonElement) {
    event.preventDefault()
    return
  }
  hideSelectionFollowup()
  // Clicking off the text has to drop the highlight too, and the browser will
  // not do it for us: the canvas pan gesture calls preventDefault() on
  // pointerdown (it must — otherwise a pan drag starts a selection), and that
  // same default is what clears the selection. On the secondary button the
  // browser never clears it at all. Without this, a selection made in a card
  // stayed lit forever and 「追问」 kept coming back on pointerup.
  // Inside message text a pointer-down is the start of a *new* selection, so it
  // is left alone — that is also what keeps right-click → copy working. Form
  // fields are left alone too: a textarea keeps its own selection model, and it
  // is not ours to clear.
  const text = event.target instanceof Element ? event.target.closest('.thread-answer, .message-body, input, textarea, select') : null
  const selection = window.getSelection()
  if (text === null && selection !== null && selection.isCollapsed === false) selection.removeAllRanges()
})
app.addEventListener('pointerup', queueSelectionFollowup)
app.addEventListener('scroll', hideSelectionFollowup, true)
document.addEventListener('selectionchange', queueSelectionFollowup)

app.addEventListener('click', async event => {
  const button = event.target instanceof Element ? event.target.closest('[data-action]') : null
  if (!(button instanceof HTMLElement)) {
    const card = event.target instanceof Element ? event.target.closest('.thread-card[data-thread]:not(.draft-card)') : null
    if (!(card instanceof HTMLElement) || event.target instanceof Element && event.target.closest('.node-handle, textarea, select, form')) return
    // A double-click selects a word and a drag selects a range; neither is a
    // select-click, so leave the selection intact instead of re-rendering.
    if (event.detail > 1) return
    if (pointerDownPosition !== null
      && Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y) > 4) return
    const thread = state.workspace?.threads.find(item => item.id === card.dataset.thread)
    if (thread === undefined) return
    const cardId = card.dataset.cardId
    if (cardId === undefined) return
    state.activeId = thread.id
    state.selectedCardId = cardId
    state.error = ''
    // Clicking a card opens THIS app's detail view at that turn, not pi-web:
    // the map's whole point is reading the conversation here, and pi-web is
    // still one click away (「pi-web」 in the card footer / detail header).
    state.mode = 'thread'
    state.detailTargetCardId = cardId
    state.detailEntered = true
    render()
    return
  }
  const thread = state.workspace?.threads.find(item => item.id === button.dataset.thread)
  try {
    if (button.dataset.action === 'follow-selection') {
      const followup = selectionFollowup
      hideSelectionFollowup()
      if (followup !== null && thread !== undefined && thread.id === followup.threadId && state.draft === null) openContinue(thread, undefined, followup.text)
      return
    }
    if (button.dataset.action === 'insert-quick-phrase' && button.dataset.quickPhrase !== undefined) insertQuickPhrase(button.dataset.quickPhrase)
    if (button.dataset.action === 'pick-images') {
      // `querySelector` types its result as `Element`, which has no `click()`.
      const input = button.closest('form')?.querySelector('[data-image-input]')
      if (input instanceof HTMLInputElement) input.click()
    }
    if (button.dataset.action === 'remove-draft-image') removeDraftImage(Number(button.dataset.imageIndex))
    if (button.dataset.action === 'open-quick-phrase-editor') { state.quickPhraseEditorOpen = true; render() }
    if (button.dataset.action === 'close-quick-phrase-editor') { state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'add-quick-phrase') {
      const editor = button.closest('.draft-quick-phrase-add')
      const input = editor?.querySelector('input')
      if (input instanceof HTMLInputElement && addQuickPhrase(input.value)) {
        render()
        window.setTimeout(() => htmlElement('.draft-quick-phrase-add input')?.focus(), 0)
      }
    }
    if (button.dataset.action === 'remove-quick-phrase') {
      const index = Number(button.dataset.quickPhraseIndex)
      if (Number.isInteger(index) && index >= 0 && index < state.quickPhrases.length) {
        state.quickPhrases.splice(index, 1)
        persistQuickPhrases()
        render()
      }
    }
    if (button.dataset.action === 'toggle-sidebar') { state.sidebarCollapsed = !state.sidebarCollapsed; render() }
    if (button.dataset.action === 'create-session') openNewSession()
    if (button.dataset.action === 'open-current' && state.currentSession !== null) openSessionInHost(state.currentSession.id)
    if (button.dataset.action === 'toggle-visibility' && thread !== undefined) await setThreadVisibility(thread, isThreadVisible(thread))
    if (button.dataset.action === 'select-thread' && thread !== undefined) {
      state.mapCardSessionSwitches.clear()
      state.activeId = thread.id
      state.selectedCardId = null
      state.error = ''
      // A thread whose cards are off the canvas (7 天没活动，或被收起) has nothing
      // to pan to, so its row opens the transcript instead of looking dead.
      if (state.mode === 'canvas' && !isThreadVisible(thread)) state.mode = 'thread'
      if (state.workspace !== null) revealConversationThread(conversationCards(canvasThreads()), thread.id)
      // The sidebar is an index, so a row keeps the user's current view: on the
      // map it selects and pans to that thread's card, in the transcript it
      // switches to that conversation (and lands on its latest turn). Jumping
      // to the detail view from the map would make the index the only way back
      // into a view the user never asked to leave.
      if (state.mode === 'thread') {
        state.detailTargetCardId = null
        state.detailEntered = true
        render()
      } else {
        render()
        window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
      }
    }
    if (button.dataset.action === 'show-thread' && thread !== undefined) { state.activeId = thread.id; state.mode = 'thread'; state.detailTargetCardId = button.dataset.card ?? null; state.detailEntered = true; render() }
    if (button.dataset.action === 'show-canvas') { state.mode = 'canvas'; render() }
    if (button.dataset.action === 'toggle-card-children' && button.dataset.card !== undefined) {
      const cardId = button.dataset.card
      const collapsing = !state.collapsedCardIds.has(cardId)
      if (collapsing && state.workspace !== null) {
        const allCards = conversationCards(canvasThreads())
        const nextCollapsed = new Set(state.collapsedCardIds).add(cardId)
        const visibleCards = conversationGraphView(allCards, nextCollapsed).cards
        const visibleIds = new Set(visibleCards.map(card => card.id))
        const draftParentId = draftPlacement(allCards)?.parent.id
        if (draftParentId !== undefined && !visibleIds.has(draftParentId)) return setError('请先完成或取消正在编辑的追问或分支')
        if (state.activeId !== null && !visibleCards.some(card => card.hostThreadId === state.activeId)) return setError('当前会话位于这个后续分支中，请先切换会话')
      }
      collapsing ? state.collapsedCardIds.add(cardId) : state.collapsedCardIds.delete(cardId)
      persistCollapsedCards()
      render()
      window.setTimeout(() => htmlElement(`[data-action="toggle-card-children"][data-card="${selectorValue(cardId)}"]`)?.focus(), 0)
    }
    if (button.dataset.action === 'open-continue' && thread !== undefined) openContinue(thread, button.dataset.card)
    if (button.dataset.action === 'open-btw' && thread !== undefined) openBtw(thread, button.dataset.card, button.dataset.seq)
    if (button.dataset.action === 'toggle-draft-tool' && button.dataset.tool !== undefined) {
      const draft = state.draft
      if (draft !== null && draft.kind === 'btw') {
        draft.tools = draft.tools.includes(button.dataset.tool) ? draft.tools.filter(name => name !== button.dataset.tool) : [...draft.tools, button.dataset.tool]
        render()
      }
    }
    if (button.dataset.action === 'open-branch' && thread !== undefined) {
      // pi entry ids are 8-hex-digit strings (`927f88e9`), never numbers: a
      // `Number.isInteger()` gate rejected every one of them and answered with
      // 「请等待这张卡片的最终回答」 even on turns that were long finished.
      const requestedSeq = typeof button.dataset.seq === 'string' && button.dataset.seq !== '' ? button.dataset.seq : undefined
      if (button.dataset.card !== undefined && requestedSeq === undefined) return setError('这张卡片还没有可用的回答，暂时无法创建分支')
      const fallbackSeq = latestMessage(thread, 'assistant')?.sourceEntryId
      openBranch(thread, requestedSeq ?? (typeof fallbackSeq === 'string' && fallbackSeq !== '' ? fallbackSeq : undefined), button.dataset.card)
    }
    if (button.dataset.action === 'cancel-draft') { releaseDraftImages(state.draft); state.draft = null; state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'toggle-message' && button.dataset.message !== undefined) { state.expandedMessageIds.has(button.dataset.message) ? state.expandedMessageIds.delete(button.dataset.message) : state.expandedMessageIds.add(button.dataset.message); renderPreservingDetailScroll() }
    if (button.dataset.action === 'open-host' && thread?.sessionId !== null) openSessionInHost(thread.sessionId)
    if (button.dataset.action === 'archive-thread' && thread !== undefined) await archiveThread(thread)
    if (button.dataset.action === 'rename-thread' && thread !== undefined) await renameThread(thread)
    if (button.dataset.action === 'host-archive' && thread !== undefined) await archiveInHost(thread, true)
    if (button.dataset.action === 'zoom-in') zoomCanvasAtCenter(.1)
    if (button.dataset.action === 'zoom-out') zoomCanvasAtCenter(-.1)
    if (button.dataset.action === 'focus-active') focusActiveCard()
    if (button.dataset.action === 'dismiss-error') { state.error = ''; render() }
    if (button.dataset.action === 'layout' && state.workspace !== null) {
      resetCardPositions()
      resetCanvasCamera()
      render()
    }
  } catch (error) { setError(error) }
})

app.addEventListener('change', event => {
  const quickPhrase = event.target instanceof Element ? event.target.closest('[data-quick-phrase-index]') : null
  if (quickPhrase instanceof HTMLInputElement) {
    updateQuickPhrase(Number(quickPhrase.dataset.quickPhraseIndex), quickPhrase.value)
    return
  }
  const imageInput = event.target instanceof Element ? event.target.closest('[data-image-input]') : null
  if (imageInput instanceof HTMLInputElement) {
    const files = [...(imageInput.files ?? [])]
    // Clearing the value lets the same file be picked again, and keeps a stale
    // FileList from being re-read when the draft re-renders.
    imageInput.value = ''
    void attachImages(files).catch(setError)
    return
  }
  const select = event.target instanceof Element ? event.target.closest('[data-action="select-workspace"]') : null
  if (!(select instanceof HTMLSelectElement)) return
  const choice = workspaceChoices().find(item => item.id === select.value)
  if (choice !== undefined) void openWorkspace(choice.id).catch(setError)
})
// Paste is delegated on the app, not bound per element: the canvas rebuilds its
// whole DOM on every render (the projection polls each second), so a listener
// attached to a textarea would be gone the moment the user pasted into it.
app.addEventListener('paste', event => {
  const textarea = event.target instanceof Element ? event.target.closest('[data-draft] textarea') : null
  if (!(textarea instanceof HTMLTextAreaElement) || event.clipboardData === null) return
  const files = [...event.clipboardData.items]
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter(file => file !== null)
  if (files.length === 0) return
  // The image replaces the default paste: a clipboard screenshot also carries a
  // synthetic file name as text, which would otherwise land in the box.
  event.preventDefault()
  void attachImages(files).catch(setError)
})
app.addEventListener('input', event => { const input = event.target; if (input instanceof HTMLTextAreaElement && input.closest('[data-draft]') && state.draft !== null) state.draft.text = input.value })
app.addEventListener('submit', event => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  if (form.matches('[data-draft]')) { event.preventDefault(); void submitDraft(); return }
  const thread = state.workspace?.threads.find(item => item.id === form.dataset.compose)
  const input = form.querySelector('textarea')
  if (thread === undefined || !(input instanceof HTMLTextAreaElement) || input.value.trim() === '') return
  event.preventDefault()
  const text = input.value.trim()
  input.value = ''
  void sendMessage(thread, text).catch(setError)
})

// The canvas runs inside the host's page as an iframe (both hosts do this: the
// pi-web proxy injects the switch bar, and the DSH client plugin mounts the
// same bar). Three host signals arrive over postMessage from that parent: which
// session the host is showing, how much chrome the canvas should bring, and live
// streaming replies.
window.addEventListener('message', event => {
  if (event.origin !== window.location.origin || event.data?.source !== 'synapse-host') return
  const data = event.data
  if (data.type === 'synapse:theme') {
    document.documentElement.dataset.theme = data.dark === true ? 'dark' : 'light'
    applyHostTokens(data.tokens)
    return
  }
  // How much chrome the canvas should bring itself. A host that already shows
  // its own sidebar and header (DSH) asks for `embedded`: the canvas drops its
  // sidebar, its topbar and its view tabs, so the map reads as a view of the host
  // rather than an app inside it. pi-web sends nothing, which leaves the canvas
  // as it was.
  if (data.type === 'synapse:chrome') {
    const embedded = data.embedded === true
    if (embedded !== state.embedded) {
      state.embedded = embedded
      if (embedded) document.documentElement.dataset.embedded = ''
      else delete document.documentElement.dataset.embedded
      // The chrome change moves the map's own frame of reference: without this
      // the camera keeps the old insets and the cards land outside the viewport.
      // `canvasNeedsCenter` is the canvas's own "center on the focused card once
      // the DOM is mounted" pass, which also covers the first load.
      state.canvasViewInitialized = false
      state.canvasNeedsCenter = true
      resetCanvasCamera()
      if (canReplaceView()) render()
    }
    return
  }
  if (data.type === 'synapse:current-session') {
    const previousId = state.currentSession?.id
    state.currentSession = data.session ?? null
    const thread = currentHostThread()
    if (thread !== undefined) {
      state.activeId = thread.id
      if (state.workspace !== null) revealConversationThread(conversationCards(canvasThreads()), thread.id)
    }
    if (previousId !== state.currentSession?.id && canReplaceView()) render()
    return
  }
  if (data.type === 'synapse:live-reply' && typeof data.sessionId === 'string') {
    const thread = state.workspace?.threads.find(item => item.sessionId === data.sessionId)
    if (thread === undefined) return
    if (data.running === true) {
      state.liveReplies.set(data.sessionId, { running: true, text: typeof data.text === 'string' ? data.text : '' })
      if (state.mode === 'canvas') scheduleLiveCardUpdate(data.sessionId)
      else if (canReplaceView()) scheduleLiveRender()
    } else {
      state.liveReplies.delete(data.sessionId)
      // Unmark immediately, whatever render decides to do (see markCardStreaming)
      if (state.mode === 'canvas') markCardStreaming(thread.id, false)
      if (canReplaceView() || state.pendingReplies.has(data.sessionId)) renderPreservingDetailScroll()
    }
  }
})

/**
 * The host's own design values, pushed over the bridge as `--host-*`.
 *
 * The canvas runs in an IFRAME: `getComputedStyle(frame).getPropertyValue('--dsw-…')`
 * inside the frame returns the empty string, because custom properties do not
 * cross a document boundary. So the host half reads its own resolved tokens and
 * sends them, and the canvas maps its own variables onto them (see the
 * `embedded` block in styles.css).
 *
 * Unknown keys are ignored rather than trusted: the host half is the only
 * sender, but a typo there must not inject an arbitrary property.
 */
const HOST_TOKEN_VARS = {
  bg: '--host-bg',
  surface: '--host-surface',
  hover: '--host-hover',
  line: '--host-line',
  ink: '--host-ink',
  ink2: '--host-ink2',
  ink3: '--host-ink3',
  font: '--host-font',
  radiusSm: '--host-radius-sm',
}

function applyHostTokens(tokens) {
  if (tokens === null || typeof tokens !== 'object') return
  for (const [key, name] of Object.entries(HOST_TOKEN_VARS)) {
    const value = tokens[key]
    if (typeof value !== 'string' || value === '') continue
    document.documentElement.style.setProperty(name, value)
  }
}

post('synapse:map-ready')
// The host declares what it can do, how it names itself, and how it wants its
// writes delivered; the canvas hides actions it cannot perform rather than
// showing buttons that would fail.
api('/synapse/api/status').then(status => {
  try {
    if (status?.capabilities !== undefined) state.capabilities = { ...state.capabilities, ...status.capabilities }
    if (typeof status?.adapter === 'string') state.hostLabels = hostLabels(status.adapter)
    useWriteTransport(status?.writeTransport)
    // The tool vocabulary a /btw is expressed in belongs to the host: names it
    // may be given, and the set a new one starts from.
    if (Array.isArray(status?.defaultBtwTools) && status.defaultBtwTools.length > 0) state.btwDefaultTools = status.defaultBtwTools.filter(name => typeof name === 'string' && name !== '')
    const options = Array.isArray(status?.pinnableTools) && status.pinnableTools.length > 0 ? status.pinnableTools
      : Array.isArray(status?.tools) ? status.tools
      : []
    state.btwToolOptions = btwChipNames(options.filter(name => typeof name === 'string'), state.btwDefaultTools)
  } catch (error) {
    setError(error)
  }
  render()
}).catch(() => {})
refreshSummaries().catch(setError)
let polling = false
let liveRenderTimer = 0
let liveCardFrame = 0
let liveCardSessionId = null
function scheduleLiveCardUpdate(sessionId) {
  // Coalesce streaming chunks to one DOM patch per animation frame.
  liveCardSessionId = sessionId
  if (liveCardFrame !== 0) return
  liveCardFrame = window.requestAnimationFrame(() => {
    liveCardFrame = 0
    if (liveCardSessionId === null) return
    const id = liveCardSessionId
    liveCardSessionId = null
    applyLiveReplyToCard(id)
  })
}
/**
 * Mark (or unmark) the live card of a thread as answering.
 *
 * The border is applied by a DOM patch while a reply streams, so it must also be
 * REMOVED by a DOM patch: unmarking it only in render() left the card breathing
 * forever when a render happened to be skipped (composer focused, gesture in
 * flight, refresh deferred) — the state was clean and the class was not.
 */
function markCardStreaming(threadId, streaming) {
  const cards = app.querySelectorAll(`.thread-card[data-thread="${CSS.escape(threadId)}"]`)
  const live = cards[cards.length - 1]
  for (const card of cards) card.classList.toggle('is-streaming', card === live && streaming === true)
}

function applyLiveReplyToCard(sessionId) {
  if (state.mode !== 'canvas') return
  // Never patch cards mid-gesture: the reflow would compete with the drag or
  // pan frame; the next live-reply chunk re-applies after the gesture ends.
  if (state.dragging || state.canvasGesture) return
  const thread = state.workspace?.threads.find(item => item.sessionId === sessionId)
  if (thread === undefined) return
  const live = state.liveReplies.get(sessionId)
  if (live?.running !== true) return
  const cards = app.querySelectorAll(`.thread-card[data-thread="${CSS.escape(thread.id)}"]`)
  const card = cards[cards.length - 1]
  if (!(card instanceof HTMLElement)) return
  const answer = card.querySelector('.thread-answer')
  if (!(answer instanceof HTMLElement)) return
  // This path bypasses render() (it patches one card's answer only), so the
  // streaming halo has to be applied here too.
  markCardStreaming(thread.id, true)
  const text = live.text
  answer.innerHTML = text.trim() === ''
    ? '<p class="thread-answer-pending">正在回复</p>'
    : `${renderMarkdown(text)}<p class="thread-answer-pending">正在回复</p>`
}
function scheduleLiveRender() {
  if (liveRenderTimer !== 0 || !canReplaceView()) return
  liveRenderTimer = window.setTimeout(() => {
    liveRenderTimer = 0
    if (canReplaceView()) renderPreservingDetailScroll()
  }, 120)
}
async function pollProjection() {
  if (polling || document.hidden || !canReplaceView()) return
  polling = true
  try {
    await refreshProjection()
  } finally { polling = false }
}
window.setInterval(() => { void pollProjection() }, 1_000)
