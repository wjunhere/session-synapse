import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CARD_SCALE_RANGE, CARD_FONT_SCALE_RANGE, CARD_GAP_RANGE, DEFAULT_SETTINGS, RECENT_DAYS_CHOICES, normalizeSettings } from '../src/canvas/storage.js'

/**
 * The settings value set is the one thing in the panel that is not a pure UI
 * concern: it is persisted, it is read back by a later boot, and every field is
 * consumed by layout math (the card size also decides where connectors and btw
 * widgets are drawn). So the range checks are tested here rather than by dragging
 * a slider in a browser.
 *
 * `normalizeSettings` is pure — no localStorage — which is why these cases can
 * run without a DOM.
 */

test('a missing or broken value falls back to the defaults', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings('nonsense'), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS)
})

test('a stored value is honoured when it is legal', () => {
  assert.deepEqual(normalizeSettings({ cardScale: 1.2, cardFontScale: 1.1, cardGap: 64, recentDays: 14 }), { cardScale: 1.2, cardFontScale: 1.1, cardGap: 64, recentDays: 14 })
})

test('a number outside its range is clamped, not rejected', () => {
  // The panel's slider cannot produce these, but a hand-edited localStorage
  // entry can — and a 400% card would be a canvas nobody can use.
  assert.equal(normalizeSettings({ cardScale: 4 }).cardScale, CARD_SCALE_RANGE[1])
  assert.equal(normalizeSettings({ cardScale: 0.1 }).cardScale, CARD_SCALE_RANGE[0])
  assert.equal(normalizeSettings({ cardFontScale: 9 }).cardFontScale, CARD_FONT_SCALE_RANGE[1])
  assert.equal(normalizeSettings({ cardFontScale: 0 }).cardFontScale, CARD_FONT_SCALE_RANGE[0])
  // A non-number is not a small number: it is missing.
  assert.equal(normalizeSettings({ cardScale: '1.2' }).cardScale, DEFAULT_SETTINGS.cardScale)
  assert.equal(normalizeSettings({ cardFontScale: Number.NaN }).cardFontScale, DEFAULT_SETTINGS.cardFontScale)
  assert.equal(normalizeSettings({ cardGap: 4_000 }).cardGap, CARD_GAP_RANGE[1])
  assert.equal(normalizeSettings({ cardGap: -20 }).cardGap, CARD_GAP_RANGE[0])
  assert.equal(normalizeSettings({ cardGap: 'wide' }).cardGap, DEFAULT_SETTINGS.cardGap)
  // The gap is a pixel count the layout rounds anyway; a fractional one from a
  // hand-edited entry must not reach the world coordinates.
  assert.equal(normalizeSettings({ cardGap: 41.7 }).cardGap, 42)
})

test('the recent-activity window is one of the offered choices', () => {
  for (const days of RECENT_DAYS_CHOICES) assert.equal(normalizeSettings({ recentDays: days }).recentDays, days)
  // `0` means "no window" and is a real choice, so it must survive as 0.
  assert.equal(normalizeSettings({ recentDays: 0 }).recentDays, 0)
  // Anything else is not a window we can render a sentence for.
  assert.equal(normalizeSettings({ recentDays: 2 }).recentDays, DEFAULT_SETTINGS.recentDays)
  assert.equal(normalizeSettings({ recentDays: '7' }).recentDays, DEFAULT_SETTINGS.recentDays)
  assert.equal(normalizeSettings({ recentDays: null }).recentDays, DEFAULT_SETTINGS.recentDays)
})

test('unknown keys never reach the stored value', () => {
  // The panel posts one `data-setting` name per control; a typo there must not
  // grow the settings object (the sliders are keyed by those names).
  const settings = normalizeSettings({ cardScale: 1, whatever: 'x' })
  assert.deepEqual(Object.keys(settings).sort(), ['cardFontScale', 'cardGap', 'cardScale', 'recentDays'])
})
