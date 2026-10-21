/**
 * Card-to-card calls: everything about 「呼叫其他会话」 that is not the DOM.
 *
 * A call takes one card's turn (its question and the answer it already has) and
 * sends it, as a plain intercom message, into another RUNNING session. Two
 * halves of the canvas meet here:
 *
 *   - who may speak: `dsh-intercom` only accepts a `from` that is a session
 *     agent inside the SAME dsh process (`roster.senders`). The canvas cannot
 *     speak as "the user" or as itself, so the picker resolves an identity —
 *     ideally the session the card belongs to — and says so out loud before
 *     sending (`resolveSender`).
 *   - who may listen: only rows whose id carries the `session-` prefix are
 *     canvas sessions. `roster.sessions` also lists Agent Teams teammates and
 *     subagents (bare uuids), which have no card anywhere — offering them would
 *     be offering a target the receiver cannot see on this map.
 *
 * Pure functions only: no `state`, no DOM, no fetch. That is what lets the
 * selection rules and the message body be unit-tested (`test/intercom.test.js`)
 * instead of only observed in a browser.
 */

/** How much of the card's question / answer goes into the outgoing message. */
export const CALL_EXCERPT_LIMIT = 300

/** How much of the optional note goes into the outgoing message. */
export const CALL_NOTE_LIMIT = 500

/** A canvas session id. Teammate/subagent rows are bare uuids and fail this. */
const SESSION_ID = /^session-[0-9a-f-]+$/i

export function isSessionRow(id) {
  return typeof id === 'string' && SESSION_ID.test(id)
}

/**
 * What a roster row is called on screen.
 *
 * `name` is the intercom alias, which is what the two ends of a conversation
 * actually recognise; an unnamed session falls back to its own id, minus the
 * `session-` prefix, cut to the 8 characters `dsh-intercom` itself shows.
 */
export function senderLabel(row) {
  const name = typeof row?.name === 'string' ? row.name.trim() : ''
  if (name !== '') return name
  const id = typeof row?.id === 'string' ? row.id : ''
  return id.replace(/^session-/i, '').slice(0, 8)
}

/**
 * A cwd reduced to something two sources can agree on.
 *
 * The roster reports a Windows path with backslashes (`B:\work\…`)
 * while a workspace carries the same directory with forward slashes — and on
 * Windows the case is not significant either. This is only used to sort "same
 * working directory" first, so a comparison that is merely generous is right
 * here; it never decides whether a target is legal.
 */
function normalizeCwd(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : ''
}

/**
 * The sessions this card may be sent TO.
 *
 * `selfId` is the session the call goes out as: `dsh-intercom` rejects
 * `from === to`, so the speaker is never also a target. Rows that are not
 * canvas sessions are dropped (see the header) — a picker full of teammate
 * agents would be a list of cards that do not exist.
 *
 * Order matters to the reader: same-working-directory sessions first, then the
 * roster's own order (`sort` is stable), so the likeliest target is the top row
 * without the list being reshuffled between renders.
 *
 * @param {{ sessions?: Array<{id?: string, name?: string|null, cwd?: string, status?: string}> }|null|undefined} roster
 * @param {{ selfId?: string|null, cwd?: string|null }} [options]
 */
export function rosterTargets(roster, { selfId, cwd } = {}) {
  const rows = Array.isArray(roster?.sessions) ? roster.sessions : []
  const own = normalizeCwd(cwd)
  const targets = []
  for (const row of rows) {
    if (!isSessionRow(row?.id) || row.id === selfId) continue
    targets.push({
      id: row.id,
      label: senderLabel(row),
      cwd: typeof row.cwd === 'string' ? row.cwd : '',
      status: typeof row.status === 'string' ? row.status : '',
      sameCwd: own !== '' && normalizeCwd(row.cwd) === own,
    })
  }
  return targets.sort((left, right) => Number(right.sameCwd) - Number(left.sameCwd))
}

/**
 * Which session a call goes out AS, or null when the host cannot carry one.
 *
 * The card's own session is the honest speaker — the recipient sees "from the
 * session whose work this is". It is not always allowed: `senders` only holds
 * the agents of THIS dsh process, and a card may belong to a session hosted
 * elsewhere (or to a session that has gone quiet). Falling back to the session
 * the user is currently in keeps the call possible, but it IS a different
 * speaker, so the picker has to say so (`fallback: true`) rather than quietly
 * sending as someone else.
 *
 * @param {{ senders?: Array<{id?: string}> }|null|undefined} roster
 * @param {{ cardSessionId?: string|null, currentSessionId?: string|null }} [options]
 */
export function resolveSender(roster, { cardSessionId, currentSessionId } = {}) {
  const senders = Array.isArray(roster?.senders) ? roster.senders : []
  const hosted = id => typeof id === 'string' && id !== '' && senders.some(row => row?.id === id)
  if (hosted(cardSessionId)) return { id: cardSessionId, fallback: false }
  if (hosted(currentSessionId)) return { id: currentSessionId, fallback: true }
  return null
}

/**
 * One section of the message, cut to its limit with a visible ellipsis.
 *
 * `…` is added rather than counted, so a truncated excerpt is always `limit`
 * characters of content plus the marker: the reader can tell a cut-off card
 * from one that simply ended there.
 */
function clamp(value, limit) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * The message one card sends.
 *
 * Deterministic: the same card and note always produce the same text, which is
 * what makes the recipient's copy comparable with what the sender saw (and what
 * makes this testable without a host).
 *
 * `sessionId` is the session the CARD belongs to, not the identity the call is
 * sent as — that one is written by `dsh-intercom` into its own envelope, and the
 * picker states it to the user before sending. The title, the cwd, the question
 * and the answer all come from the card, so they must all describe the same
 * session.
 *
 * @param {{ title?: string, cwd?: string|null, question?: string, answer?: string|null, note?: string, sessionId?: string|null, seq?: string|null }} [input]
 */
export function callMessageBody({ title, cwd, question, answer, note, sessionId, seq } = {}) {
  const name = typeof title === 'string' && title.trim() !== '' ? title.trim() : '未命名会话'
  const place = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : '未知工作目录'
  const origin = typeof sessionId === 'string' && sessionId !== '' ? sessionId : '未知会话'
  const anchor = typeof seq === 'string' && seq !== '' ? ` · 卡片锚点 ${seq}` : ''
  const lines = [`【呼叫】来自会话「${name}」的一张卡片（工作目录：${place}）`, `来源：${origin}${anchor}`]
  const asked = clamp(question, CALL_EXCERPT_LIMIT)
  if (asked !== '') lines.push('', '问题：', asked)
  const answered = clamp(answer, CALL_EXCERPT_LIMIT)
  if (answered !== '') lines.push('', '已经给出的回答（摘录）：', answered)
  const noteText = clamp(note, CALL_NOTE_LIMIT)
  if (noteText !== '') lines.push('', '附言：', noteText)
  return lines.join('\n')
}

/**
 * A received call card's title: whose work this is.
 *
 * A call has no question of its own — its text is the composed message — so the
 * card is named after its sender instead. The sender's canvas title is the one
 * the reader can act on; when that session has no card here (a session from
 * another working directory, or one that has aged out), the id prefix is shown
 * so the card still names SOMETHING rather than claiming to be from nowhere.
 *
 * @param {string|null|undefined} from
 * @param {Array<{sessionId?: string|null, sessionTitle?: string|null, title?: string|null}>|null|undefined} threads
 */
export function callCardLabel(from, threads) {
  if (typeof from !== 'string' || from === '') return '来自未知会话'
  const thread = (Array.isArray(threads) ? threads : []).find(item => item?.sessionId === from)
  const named = typeof thread?.sessionTitle === 'string' && thread.sessionTitle !== '' ? thread.sessionTitle
    : typeof thread?.title === 'string' && thread.title !== '' ? thread.title
    : ''
  return named === '' ? `来自「${senderLabel({ id: from })}」` : `来自「${named}」`
}
