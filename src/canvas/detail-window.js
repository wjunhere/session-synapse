/**
 * Which slice of a transcript the detail view renders.
 *
 * The canvas renders the tail of a conversation, like the host's own page does
 * (pi-web renders the last 50 and loads older pages on demand). Rendering all
 * 923 messages of a long session blocked the main thread for most of a second
 * on every write — a visible freeze on every poll that found a change.
 *
 * Two rules, and both are load-bearing:
 *   - the default window is the NEWEST `visibleCount` messages, because a
 *     transcript that opens at the top makes a long conversation look like it
 *     never got answered;
 *   - an explicit anchor (clicking a card, which names one turn) WIDENS the
 *     window back to that turn. Dropping the anchor onto the tail instead is how
 *     the click's promise — 「落在那一轮」 — would silently break.
 *
 * Pure on purpose: the arithmetic is what a regression would break, and it is
 * easier to test as a table than through the DOM.
 */
export const DETAIL_PAGE_SIZE = 50

/**
 * @param {{ total: number, visibleCount: number, anchorIndex?: number | null }} input
 * @returns {{ start: number, count: number, hasEarlier: boolean }}
 */
export function detailWindow({ total, visibleCount, anchorIndex = null }) {
  const clampedTotal = Math.max(Math.floor(total), 0)
  const wanted = Math.max(Math.floor(visibleCount), 0)
  const tail = Math.max(0, clampedTotal - wanted)
  // An anchor beyond the end (a stale card id) must not shrink the window below
  // the tail: the anchor widens, it never narrows.
  const start = anchorIndex === null || anchorIndex < 0 ? tail : Math.min(tail, Math.floor(anchorIndex))
  return { start, count: clampedTotal - start, hasEarlier: start > 0 }
}
