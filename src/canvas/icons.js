/**
 * The canvas icon set.
 *
 * Kept as constants so the capability-gated buttons stay readable in the
 * template. One geometry rule holds the set together: a 16px box, a single
 * stroke weight, round joins, no fills except where a shape is genuinely solid.
 * Icons are glyphs of a technical drawing, not illustration.
 */
export const ICON = (body, { className = '' } = {}) => `<svg aria-hidden="true"${className === '' ? '' : ` class="${className}"`} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5">${body}</svg>`

/** Path data for icons reused inside inline SVG that carries its own attributes. */
export const ICON_PATHS = {
  close: 'm4.5 4.5 7 7m0-7-7 7',
  plus: 'M8 3.5v9M3.5 8h9',
  minus: 'M3.5 8h9',
  vertical: 'M8 3.5v9',
  arrowUp: 'M8 12.5v-9M4.5 7 8 3.5 11.5 7',
  chevronRight: 'm6 3.5 4.5 4.5L6 12.5',
  search: 'M7.25 12a4.75 4.75 0 1 1 0-9.5 4.75 4.75 0 0 1 0 9.5Zm3.4-1.35L13.5 13.5',
  branch: 'M4.5 6.5v3a2.5 2.5 0 0 0 2.5 2.5h5',
  external: 'M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9',
  arch: 'M2.5 5h11M5.5 7v5.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V7',
  speaker: 'M3 3.5h10v6.25H7.2L4 12.5V9.75H3Z',
  speakerAdd: 'M6.2 6.2h3.6M8 4.6v3.2',
  grid: 'M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5h-4.5zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5h-4.5z',
  target: 'M8 4.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4ZM8 1.5v2.6M8 11.9v2.6M1.5 8h2.6M11.9 8h2.6',
  zoomIn: 'M6.75 11.5a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5Zm3.4-1.35L13.5 13.5M6.75 4.9v3.7M4.9 6.75h3.7',
  zoomOut: 'M6.75 11.5a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5Zm3.4-1.35L13.5 13.5M4.9 6.75h3.7',
}

export const closeIcon = (attributes = '') => `<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" ${attributes}><path d="${ICON_PATHS.close}"/></svg>`
export const RENAME_ICON = ICON('<path d="M10.5 2.5 13.5 5.5 6.5 12.5 3 13l.5-3.5z"/><path d="M9 4l3 3"/>')
export const HOST_ARCHIVE_ICON = ICON('<rect x="2.5" y="3" width="11" height="3.25" rx="1"/><path d="M4 6.75v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6"/><path d="M6.5 9h3"/>')
