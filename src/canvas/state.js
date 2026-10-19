/**
 * The canvas state, and the handful of helpers that write it back to storage.
 *
 * One mutable object rather than a store with subscribers: the canvas re-renders
 * the whole view from it, and module-level `let` bindings for each field would
 * mean every module importing every other one. Modules that need the state
 * import THIS object and read the fields they care about.
 *
 * The layout maps and sets (card positions, collapsed cards, branch anchors,
 * quick phrases) are restored from local storage at load and persisted on every
 * change — the canvas is a place, and where you put things should survive a
 * reload.
 */
import {
  loadBranchAnchors, loadCardPositions, loadCollapsedCards, loadQuickPhrases,
  clearCardPositions, persistBranchAnchors,
  persistCardPositions as saveCardPositions, persistCollapsedCards as saveCollapsedCards, persistQuickPhrases as saveQuickPhrases,
} from './storage.js'
import { hostLabels } from './host-labels.js'

export const state = {
  summaries: [], workspace: null, activeId: null, selectedCardId: null, mode: 'canvas', zoom: 1, currentSession: null, sidebarCollapsed: false,
  // Set by the host over the bridge (`synapse:chrome`): the host provides its own
  // sidebar and header, so the canvas brings none. See styles.css `embedded`.
  embedded: false,
  capabilities: { sendMessage: false, forkSession: false, openSession: false, archiveSession: false, renameSession: false, btw: false, setTools: false },
  // Host wording (button labels, empty-state hints). Neutral until
  // /synapse/api/status names the adapter — see host-labels.js.
  hostLabels: hostLabels(undefined),
  // The tool vocabulary a /btw side question is expressed in: the names a new
  // one starts with, and the names it may be given at all. Both come from
  // `/synapse/api/status`, because the vocabulary is the HOST's — pi-web's
  // read/grep/find/ls are not DSH's read/grep/glob/web_fetch/… The fallback is
  // pi-web's own read-only preset, so a draft is never tool-less while the
  // status call is still in flight.
  btwDefaultTools: ['read', 'grep', 'find', 'ls'],
  btwToolOptions: ['read', 'grep', 'find', 'ls'],
  hostWorkspaces: [], selectedHostWorkspaceId: null,
  pendingReplies: new Map(), pendingRpc: new Map(), liveReplies: new Map(),
  draft: null, error: '', workspaceLoad: 0, branchAnchors: new Map(loadBranchAnchors()), cardPositions: new Map(loadCardPositions()), collapsedCardIds: new Set(loadCollapsedCards()), quickPhrases: loadQuickPhrases(), quickPhraseEditorOpen: false,
  dragging: false, canvasGesture: false, canvasRefreshAfter: 0, canvasViewInitialized: false, canvasCamera: { x: 0, y: 0 }, mapCardSessionSwitches: new Set(),
  expandedMessageIds: new Set(),
  canvasCards: undefined, canvasCardsById: undefined, canvasGraph: undefined, mountedCardIds: new Set(), canvasNeedsCenter: false,
  detailScrollByThread: new Map(), detailThreadId: null, detailTargetCardId: null, detailEntered: false,
}

export function rememberBranchAnchor(sessionId, cardId) {
  state.branchAnchors.set(sessionId, cardId)
  persistBranchAnchors(state.branchAnchors)
}

export function rememberCardPosition(cardId, position, aliases = []) {
  state.cardPositions.set(cardId, { x: Math.round(position.x), y: Math.round(position.y) })
  for (const alias of aliases) state.cardPositions.set(alias, { x: Math.round(position.x), y: Math.round(position.y) })
  saveCardPositions(state.cardPositions)
}

export function persistCardPositions() { saveCardPositions(state.cardPositions) }
export function persistCollapsedCards() { saveCollapsedCards(state.collapsedCardIds) }
export function persistQuickPhrases() { saveQuickPhrases(state.quickPhrases) }

export function resetCardPositions() {
  state.cardPositions.clear()
  clearCardPositions()
}

export function resetCanvasCamera() {
  state.canvasViewInitialized = false
  state.canvasCamera = { x: 0, y: 0 }
}
