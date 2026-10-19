import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DETAIL_PAGE_SIZE, detailWindow } from '../src/canvas/detail-window.js'

test('a short transcript is rendered whole, with nothing to load', () => {
  assert.deepEqual(detailWindow({ total: 3, visibleCount: DETAIL_PAGE_SIZE }), { start: 0, count: 3, hasEarlier: false })
  assert.deepEqual(detailWindow({ total: 0, visibleCount: DETAIL_PAGE_SIZE }), { start: 0, count: 0, hasEarlier: false })
})

test('a long transcript starts at its tail, never at the top', () => {
  // 923 messages: the point of the window is that the newest ones are on screen
  // when the view opens, because the answer is what the reader came for.
  const tail = detailWindow({ total: 923, visibleCount: DETAIL_PAGE_SIZE })
  assert.deepEqual(tail, { start: 873, count: 50, hasEarlier: true })
})

test('an anchor older than the window widens it back to that turn', () => {
  // Clicking a card names one turn; landing on the tail instead is the promise
  // this arithmetic exists to keep.
  const anchored = detailWindow({ total: 923, visibleCount: DETAIL_PAGE_SIZE, anchorIndex: 4 })
  assert.deepEqual(anchored, { start: 4, count: 919, hasEarlier: true })
})

test('an anchor never narrows the window', () => {
  // A stale card id (or one whose turn was folded away) must not hide messages
  // the tail window would have shown.
  const stale = detailWindow({ total: 923, visibleCount: DETAIL_PAGE_SIZE, anchorIndex: 900 })
  assert.equal(stale.start, 873)
  const beyond = detailWindow({ total: 923, visibleCount: DETAIL_PAGE_SIZE, anchorIndex: 5000 })
  assert.equal(beyond.start, 873)
  const negative = detailWindow({ total: 10, visibleCount: 4, anchorIndex: -1 })
  assert.equal(negative.start, 6)
})

test('a window at least as large as the transcript has nothing earlier', () => {
  const all = detailWindow({ total: 12, visibleCount: 50 })
  assert.deepEqual(all, { start: 0, count: 12, hasEarlier: false })
  const exactly = detailWindow({ total: 50, visibleCount: 50 })
  assert.deepEqual(exactly, { start: 0, count: 50, hasEarlier: false })
})

test('nonsense counts clamp instead of producing a negative window', () => {
  // `visibleCount` comes from the canvas's own counter, so a negative value can
  // only be a bug — but it must not turn into a negative slice, which would
  // silently drop messages off the END of the transcript.
  const negative = detailWindow({ total: 5, visibleCount: -3 })
  assert.deepEqual(negative, { start: 5, count: 0, hasEarlier: true })
  assert.deepEqual(detailWindow({ total: -1, visibleCount: 10 }), { start: 0, count: 0, hasEarlier: false })
  assert.deepEqual(detailWindow({ total: 7, visibleCount: 2.7 }), { start: 5, count: 2, hasEarlier: true })
})
