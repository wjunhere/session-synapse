/**
 * Text, time and token formatting, plus the two small read-only gauges the
 * cards show (the context ring and the lane colours).
 *
 * Everything here depends on nothing but its arguments — except `laneColor`,
 * whose palette indexes the workspace thread list, and `contextRing`, which
 * renders markup. Both are deliberately pure functions of their input so the
 * card template can call them without wiring.
 */

/** One `[图片]` marker per attached image, appended to the text for display. */
export const imageMarkers = count => (count > 0 ? Array.from({ length: count }, () => '[图片]').join('\n') : '')

/**
 * What a message shows once images are attached.
 *
 * The projection keeps the user's own words as `text` and the image COUNT
 * separately (a marker inside the text would break the optimistic-message match
 * that decides when a reply has landed), so display re-joins the two here.
 */
export const displayText = message => {
  const text = typeof message?.text === 'string' ? message.text.trim() : ''
  const markers = imageMarkers(message?.imageCount ?? 0)
  if (text === '') return markers
  return markers === '' ? text : `${text}\n${markers}`
}

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))

// One colour per thread, assigned by position in the workspace list so the
// sidebar index, the card dot and the connector lane agree without any
// per-thread bookkeeping. Values are CSS variables, not hex, so both themes
// resolve them; the palette is deliberately the same spot-pastel set used for
// status, which keeps colour meaningful instead of decorative.
export const LANE_COLORS = ['var(--ink-1)', 'var(--info)', 'var(--ok)', 'var(--violet)', 'var(--warn)', 'var(--danger)']
export const laneColor = index => LANE_COLORS[(index < 0 ? 0 : index) % LANE_COLORS.length]

export const formatTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Format a token count the way pi's own footer does, so both agree on `62k`. */
export function formatTokens(count) {
  const value = Math.max(0, Math.round(Number(count) || 0))
  if (value < 1_000) return String(value)
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * The context-window ring in a card's top-right corner.
 *
 * The arc length IS the used fraction, so the ring reads as a gauge at a
 * glance; the hover (or focus) tip carries the exact numbers. Colours follow
 * pi's own thresholds: warn above 70%, error above 90%.
 *
 * @param {{ percent?: number, tokens?: number, contextWindow?: number, estimated?: boolean }|null|undefined} usage
 */
export function contextRing(usage) {
  if (usage === null || usage === undefined || typeof usage.percent !== 'number') return ''
  const percent = Math.max(0, Math.min(100, usage.percent))
  const tokens = Number(usage.tokens) || 0
  const window = Number(usage.contextWindow) || 0
  if (window <= 0) return ''
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const arc = circumference * percent / 100
  const level = percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'ok'
  const label = `上下文占用 ${percent.toFixed(1)}%（${formatTokens(tokens)} / ${formatTokens(window)} token）${usage.estimated ? '，含估算' : ''}`
  return `<span class="context-ring context-ring-${level}" tabindex="0" role="img" aria-label="${escapeHtml(label)}" data-context-ring><svg viewBox="0 0 24 24" aria-hidden="true"><circle class="context-ring-track" cx="12" cy="12" r="${radius}"></circle><circle class="context-ring-arc" cx="12" cy="12" r="${radius}" stroke-dasharray="${arc.toFixed(2)} ${(circumference - arc).toFixed(2)}" stroke-dashoffset="0"></circle></svg><span class="context-ring-tip" role="tooltip"><b>${percent.toFixed(1)}%</b><span>${formatTokens(tokens)} / ${formatTokens(window)}${usage.estimated === true ? ' · 估算' : ''}</span></span></span>`
}
