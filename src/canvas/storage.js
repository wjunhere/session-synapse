/**
 * Local-storage persistence for the canvas layout.
 *
 * Deliberately dumb: read a key, validate what came back, write a key. What
 * each value MEANS lives with the state that owns it (`state.js`), so a storage
 * bug can never change layout semantics and a layout change never has to touch
 * parsing.
 *
 * Private browsing can disable local storage entirely, so every access is
 * guarded — a canvas that cannot remember card positions is still usable.
 */

export const DEFAULT_QUICK_PHRASES = ['展开说明', '举例', '通俗易懂', '对比解释']
export const MAX_QUICK_PHRASES = 12
export const MAX_QUICK_PHRASE_LENGTH = 16

const CARD_POSITIONS_KEY = 'pi-synapse:card-positions:v3'
const COLLAPSED_CARDS_KEY = 'pi-synapse:collapsed-cards:v1'
const QUICK_PHRASES_KEY = 'pi-synapse:quick-phrases:v1'
const BRANCH_ANCHORS_KEY = 'pi-synapse:branch-anchors'
// Formats that were never persisted; dropped on load so they cannot come back.
const DEAD_CARD_POSITION_KEYS = ['pi-synapse:card-positions', 'pi-synapse:card-positions:v2']

/** Read and parse a key, returning `fallback` for a missing key or any failure. */
function readJson(key, fallback) {
  try {
    const stored = localStorage.getItem(key)
    if (stored === null) return fallback
    return JSON.parse(stored)
  } catch {
    return fallback
  }
}

/** Write a key as JSON. A failure is not an error the user needs to see. */
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* Private browsing may disable local storage. */ }
}

export function normalizeQuickPhrases(value) {
  if (!Array.isArray(value)) return []
  const phrases = []
  for (const item of value) {
    const phrase = typeof item === 'string' ? item.trim().slice(0, MAX_QUICK_PHRASE_LENGTH) : ''
    if (phrase !== '' && !phrases.includes(phrase)) phrases.push(phrase)
    if (phrases.length === MAX_QUICK_PHRASES) break
  }
  return phrases
}

/** `[[sessionId, cardId], …]` pairs, which is how the state holds them too. */
export function loadBranchAnchors() {
  const value = readJson(BRANCH_ANCHORS_KEY, [])
  return Array.isArray(value) ? value.filter(item => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') : []
}

export function loadCardPositions() {
  try {
    for (const key of DEAD_CARD_POSITION_KEYS) localStorage.removeItem(key)
  } catch { /* Private browsing may disable local storage. */ }
  const value = readJson(CARD_POSITIONS_KEY, [])
  return Array.isArray(value) ? value.filter(item => Array.isArray(item) && typeof item[0] === 'string' && item[1] !== null && Number.isFinite(item[1].x) && Number.isFinite(item[1].y)) : []
}

export function loadCollapsedCards() {
  const value = readJson(COLLAPSED_CARDS_KEY, [])
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

/**
 * The saved quick phrases, or the defaults.
 *
 * A stored-but-empty list is honoured (`[]`), because clearing the chips is a
 * deliberate act; only a MISSING key falls back to the defaults.
 */
export function loadQuickPhrases() {
  try {
    const stored = localStorage.getItem(QUICK_PHRASES_KEY)
    return stored === null ? DEFAULT_QUICK_PHRASES : normalizeQuickPhrases(JSON.parse(stored))
  } catch {
    return DEFAULT_QUICK_PHRASES
  }
}

export function persistCardPositions(entries) { writeJson(CARD_POSITIONS_KEY, [...entries]) }
export function persistCollapsedCards(ids) { writeJson(COLLAPSED_CARDS_KEY, [...ids]) }
export function persistQuickPhrases(phrases) { writeJson(QUICK_PHRASES_KEY, phrases) }
export function persistBranchAnchors(entries) { writeJson(BRANCH_ANCHORS_KEY, [...entries]) }

/** Drop every saved card position, including the formats that are no longer read. */
export function clearCardPositions() {
  try {
    localStorage.removeItem(CARD_POSITIONS_KEY)
    for (const key of DEAD_CARD_POSITION_KEYS) localStorage.removeItem(key)
  } catch { /* Private browsing may disable local storage. */ }
}
