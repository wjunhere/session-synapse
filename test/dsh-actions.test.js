import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BTW_DEFAULT_TOOLS, btwToolPin, createDshAdapter, forkBoundary, promptContent } from '../src/adapters/dsh.js'
import { writeTransport } from '../src/adapters/contract.js'

/**
 * The canvas holds images as base64 with no data-URL prefix
 * (`src/canvas/images.js`); DSH names the field `mediaType`. Both directions of
 * that mapping are pure, so they are checked here rather than through a live
 * harness — and the live behaviour (does the model actually receive the image)
 * is verified against a running harness, not here.
 */

test('a message becomes the harness prompt content parts, attachments first', () => {
  const parts = promptContent('看看这个', [{ data: 'AAAA', mimeType: 'image/png' }])
  assert.deepEqual(parts, [
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'text', text: '看看这个' },
  ])
})

test('an image with no words is still a complete message', () => {
  assert.deepEqual(promptContent('', [{ data: 'AAAA', mimeType: 'image/jpeg' }]), [
    { type: 'image', mediaType: 'image/jpeg', data: 'AAAA' },
  ])
})

test('whitespace is not a message', () => {
  assert.throws(() => promptContent('   ', []), /消息不能为空/)
})

test('a media type the harness does not admit is refused here, by name', () => {
  // `ImageMediaType` is a closed union in @deepseek-ai/dsh-attachment; the host
  // would reject this deep inside attachment admission, so the refusal names the
  // offending type instead.
  assert.throws(() => promptContent('x', [{ data: 'AAAA', mimeType: 'image/svg+xml' }]), /image\/svg\+xml/)
  assert.throws(() => promptContent('x', [{ data: '', mimeType: 'image/png' }]), /图片数据为空/)
})

test('a canvas entry id reverses into the host event seq', () => {
  // Projection ids are the event seq zero-padded to 8 digits (dshEntryId), so
  // they are DECIMAL — unlike pi's 8-hex-digit entry ids, which look the same
  // shape and mean something else entirely.
  assert.equal(forkBoundary('00000042'), 42)
  assert.equal(forkBoundary('00000000'), 0)
  assert.equal(forkBoundary('2457831657'), 2457831657)
})

test('a branch position that is not a seq is refused', () => {
  // A pi entry id is hex; reading it as a seq would fork at the wrong event, so
  // the mismatch has to be loud.
  assert.throws(() => forkBoundary('927f88e9'), /分支位置/)
  assert.throws(() => forkBoundary(''), /分支位置/)
  assert.throws(() => forkBoundary(' 12'), /分支位置/)
  assert.throws(() => forkBoundary(42), /分支位置/)
})

test('a /btw loadout has to name at least one tool', () => {
  // `tools.restrict({ allow: [] })` is accepted by the harness and restricts
  // NOTHING, so an empty loadout would be the opposite of what it says. The
  // refusal happens here rather than in the harness, which has no opinion.
  assert.deepEqual(btwToolPin(['read', 'grep']), ['read', 'grep'])
  // A name given twice is one tool, in the caller's order.
  assert.deepEqual(btwToolPin(['grep', 'read', 'grep']), ['grep', 'read'])
  assert.throws(() => btwToolPin([]), /至少要给一个工具/)
  assert.throws(() => btwToolPin(undefined), /至少要给一个工具/)
  assert.throws(() => btwToolPin('read'), /至少要给一个工具/)
  assert.throws(() => btwToolPin(['read', '  ']), /工具名/)
  assert.throws(() => btwToolPin(['read', 7]), /工具名/)
})

test('the DSH default loadout names tools the harness actually has', () => {
  // pi's read-only preset is read/grep/find/ls; DSH has no `find` or `ls` and
  // does have the two browsing tools, so the two vocabularies stay apart.
  assert.deepEqual(BTW_DEFAULT_TOOLS, ['read', 'grep', 'glob', 'web_fetch', 'web_search'])
})

test('the DSH canvas writes through our routes, not the host api', () => {
  const adapter = createDshAdapter({ on: () => () => {} })
  assert.equal(writeTransport(adapter), 'synapse')
  // The write methods exist because this process CAN perform them.
  for (const method of ['sendMessage', 'createSession', 'forkSession', 'renameSession', 'archiveSession', 'btw', 'btwTools']) {
    assert.equal(typeof adapter[method], 'function', `adapter 缺少 ${method}()`)
  }
  // `btw` is on: DSH can pin one agent scope and put the child in its read-only
  // permission preset. `setTools` stays off — there is no per-session loadout
  // to set, and the capability table must not claim otherwise.
  const caps = adapter.capabilities()
  assert.equal(caps.btw, true)
  assert.equal(caps.setTools, false)
  assert.equal(caps.sendMessage, true)
  assert.equal(caps.createSession, true)
})

test('an adapter that says nothing writes through the host api', () => {
  // pi-web: the canvas shares its origin, and pi-web rejects any request whose
  // Origin is not its own Host, so only the page can perform the write.
  assert.equal(writeTransport({ id: 'pi', capabilities: () => ({}) }), 'host')
})

test('an unknown transport is refused rather than guessed', () => {
  assert.throws(() => writeTransport({ id: 'x', writeTransport: () => 'ftp' }), /未知的传输方式/)
})
