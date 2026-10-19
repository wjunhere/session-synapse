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
const SETTINGS_KEY = 'pi-synapse:settings:v1'
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

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * What the settings panel may change, and the range each value is clamped to.
 *
 * The clamps live next to the persistence, not in the panel: a hand-edited
 * localStorage entry (or a future second caller) must not be able to produce a
 * canvas with 4px cards or a 0-day window that reads as "nothing is ever stale".
 * The ranges are tuples because that is what `clamp` destructures.
 */
export const CARD_SCALE_RANGE = /** @type {[number, number]} */ ([0.8, 1.4])
export const CARD_FONT_SCALE_RANGE = /** @type {[number, number]} */ ([0.9, 1.3])
/**
 * World-space distance between two cards, in pixels.
 *
 * A setting rather than a constant, and deliberately NOT scaled with the card:
 * a bigger card needs the same breathing room, not proportionally more, and the
 * gap is what the user actually aims at when they say the map is too tight.
 */
export const CARD_GAP_RANGE = /** @type {[number, number]} */ ([8, 120])
/** Days of activity a card needs to stay on the canvas; `0` means no window. */
export const RECENT_DAYS_CHOICES = [1, 3, 7, 14, 30, 0]
export const DEFAULT_SETTINGS = { cardScale: 1, cardFontScale: 1, cardGap: 42, recentDays: 7 }

/** One number inside its range, or the default when it is not a number at all. */
function clamp(value, [min, max], fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * A complete settings value set: every field present and inside its range.
 *
 * Exported because the panel hands its own edits through the same door as the
 * stored ones — one place decides what a legal value is.
 */
export function normalizeSettings(value) {
  const raw = value !== null && typeof value === 'object' ? value : {}
  return {
    cardScale: clamp(raw.cardScale, CARD_SCALE_RANGE, DEFAULT_SETTINGS.cardScale),
    cardFontScale: clamp(raw.cardFontScale, CARD_FONT_SCALE_RANGE, DEFAULT_SETTINGS.cardFontScale),
    cardGap: Math.round(clamp(raw.cardGap, CARD_GAP_RANGE, DEFAULT_SETTINGS.cardGap)),
    recentDays: RECENT_DAYS_CHOICES.includes(raw.recentDays) ? raw.recentDays : DEFAULT_SETTINGS.recentDays,
  }
}

/** The saved settings, or the defaults (a missing or broken key is not an error). */
export function loadSettings() {
  return normalizeSettings(readJson(SETTINGS_KEY, DEFAULT_SETTINGS))
}

export function persistSettings(settings) { writeJson(SETTINGS_KEY, normalizeSettings(settings)) }

/** Drop every saved card position, including the formats that are no longer read. */
export function clearCardPositions() {
  try {
    localStorage.removeItem(CARD_POSITIONS_KEY)
    for (const key of DEAD_CARD_POSITION_KEYS) localStorage.removeItem(key)
  } catch { /* Private browsing may disable local storage. */ }
}
