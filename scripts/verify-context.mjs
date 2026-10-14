/**
 * Cross-validate the canvas's context figure against pi's own algorithm.
 *
 * pi computes context usage in `getContextUsage()`:
 *   - anchor on the newest assistant usage (`calculateContextTokens`)
 *   - discount it when a compaction/context_edit follows
 *   - otherwise add character-based estimates for what came after
 *   - divide by `model.contextWindow`
 *
 * The canvas reaches the same figure through a different route (the projection
 * rather than the raw entries). This script runs BOTH on every real session and
 * reports any disagreement, so a projection regression cannot silently skew the
 * ring. It reads only; nothing is written.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseSessionLines, splitSession, projectPiSession, activeBranch } from '../src/project/pi.js'
import { contextUsage, effectiveModel, usageTotal } from '../src/project/context-usage.js'
import { createModelRegistry } from '../src/models/registry.js'

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
const sessionsDir = join(agentDir, 'sessions')
const registry = createModelRegistry(agentDir)

const CHARS_PER_TOKEN = 4
/** pi's flat per-image charge (`ESTIMATED_IMAGE_CHARS` in pi's `estimateTokens`). */
const IMAGE_CHARS = 4800
/** Only these roles carry images as far as pi's estimator is concerned. */
const IMAGE_CHARGED_ROLES = new Set(['user', 'custom', 'toolResult'])

/** pi's estimate for one raw pi message. */
function rawMessageTokens(entry) {
  const message = entry?.message
  if (message === null || typeof message !== 'object') return 0
  const blocks = Array.isArray(message.content) ? message.content : []
  let chars = 0
  for (const block of blocks) {
    if (typeof block?.text === 'string') chars += block.text.length
    else if (typeof block?.thinking === 'string') chars += block.thinking.length
    else if (block?.type === 'toolCall') chars += String(block.name ?? '').length + JSON.stringify(block.arguments ?? {}).length
    else if (typeof block?.content === 'string') chars += block.content.length
    // pi charges a FLAT 4800 chars per image instead of looking at the payload.
    // Leaving this out made the oracle blind to exactly what the canvas does
    // right: measured on real data, two sessions reported a «disagreement» that
    // was entirely the image charge (1 image after the anchor → Δ=1202 tokens;
    // 17 images in a fallback session → Δ=20416).
    else if (block?.type === 'image' && IMAGE_CHARGED_ROLES.has(message.role)) chars += IMAGE_CHARS
  }
  if (typeof message.content === 'string') chars += message.content.length
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** pi's `estimateContextTokens`, on raw entries. */
function piEstimate(rawEntries) {
  let anchorIndex = -1
  let usageTokens = 0
  for (let i = rawEntries.length - 1; i >= 0; i--) {
    const entry = rawEntries[i]
    if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue
    const total = usageTotal(entry.message.usage)
    if (total <= 0) continue
    anchorIndex = i
    usageTokens = total
    break
  }
  if (anchorIndex !== -1) {
    for (let i = anchorIndex + 1; i < rawEntries.length; i++) {
      const type = rawEntries[i]?.type
      // pi invalidates on BOTH: a compaction rewrites the context and a
      // context_edit removes a block from it.
      if (type === 'compaction' || type === 'context_edit') { anchorIndex = -1; break }
    }
  }
  if (anchorIndex === -1) {
    // Compaction-aware, matching pi: the history before the last compaction has
    // been replaced by its summary, so it is no longer in the context.
    let start = 0
    for (let i = rawEntries.length - 1; i >= 0; i--) {
      if (rawEntries[i]?.type === 'compaction') { start = i; break }
    }
    let tokens = 0
    for (let i = start; i < rawEntries.length; i++) {
      const e = rawEntries[i]
      if (e?.type === 'compaction') tokens += Math.ceil(String(e.summary ?? '').length / 4)
      else if (e?.type === 'message') tokens += rawMessageTokens(e)
    }
    return { tokens, anchored: false }
  }  let tokens = usageTokens
  for (let i = anchorIndex + 1; i < rawEntries.length; i++) {
    if (rawEntries[i]?.type === 'message') tokens += rawMessageTokens(rawEntries[i])
  }
  return { tokens, anchored: true }
}

const dirs = (await readdir(sessionsDir, { withFileTypes: true })).filter(d => d.isDirectory())
let checked = 0, compared = 0, missingWindow = 0
const diffs = []
// The projection trims message text and pi counts the raw bytes, so a handful
// of tokens of drift is expected and harmless: the ring shows one decimal place
// of a percentage whose denominator is hundreds of thousands of tokens.
const TOLERANCE_TOKENS = 64
// The fallback path (anchor invalidated by a compaction or context edit) uses a
// simpler basis than pi's compaction-aware projection. Measured worst case on
// real data: 0.25pp. Allow that, plus headroom, rather than pretend it is exact.
const FALLBACK_TOLERANCE_PP = 0.5

for (const dir of dirs) {
  const files = (await readdir(join(sessionsDir, dir.name), { withFileTypes: true })).filter(f => f.isFile() && f.name.endsWith('.jsonl'))
  for (const file of files) {
    const text = await readFile(join(sessionsDir, dir.name, file.name), 'utf8')
    const { header, entries: raw } = splitSession(parseSessionLines(text))
    const projected = projectPiSession(header, raw)
    const model = effectiveModel(raw, header)
    if (model === null) continue
    const window = await registry.contextWindow(model.provider, model.id)
    if (window === null) { missingWindow++; continue }

    const mine = contextUsage({ entries: projected.entries, contextWindow: window })
    // pi measures the ACTIVE BRANCH (`sessionManager.getBranch()`), not every
    // entry in the file. Comparing against the whole file would count turns the
    // user abandoned with /tree, which is not what the model saw.
    // Both invalidating kinds must be honoured, or this check would share any
    // blind spot the implementation has and silently pass.
    const theirs = piEstimate(activeBranch(raw))
    checked++

    // Compare whenever both sides produced a figure. Gating on `theirs.anchored`
    // would skip exactly the cases where one side invalidated the anchor and the
    // other did not — i.e. the only disagreements worth catching.
    if (mine !== null) {
      compared++
      // Two bases, two tolerances. The ANCHORED path is exact (pi's own usage
      // plus a character estimate) and must agree to rounding. The FALLBACK
      // path — used only when a compaction/context edit invalidated the anchor
      // — sums the branch instead of pi's compaction-aware projection, so it is
      // allowed a percentage-point tolerance rather than a token one.
      const delta = Math.abs(mine.tokens - theirs.tokens)
      const percentDelta = delta / window * 100
      const limit = mine.estimated === true ? FALLBACK_TOLERANCE_PP : TOLERANCE_TOKENS
      const over = mine.estimated === true ? percentDelta : delta
      if (over > limit) {
        diffs.push({ file: `${dir.name}/${file.name}`, mine: mine.tokens, theirs: theirs.tokens, delta: mine.tokens - theirs.tokens, percentDelta })
      }
    }
  }
}

console.log(`sessions with a window   ${checked}`)
console.log(`compared                 ${compared}`)
console.log(`skipped (unknown window) ${missingWindow}`)
console.log(`out of tolerance         ${diffs.length}  (±${TOLERANCE_TOKENS} tokens anchored / ±${FALLBACK_TOLERANCE_PP}pp fallback)`)
if (diffs.length > 0) console.log('')
for (const item of diffs.slice(0, 20)) console.log(`  ${item.file}  mine=${item.mine} pi=${item.theirs} Δ=${item.delta} (${item.percentDelta?.toFixed(3)}pp)`)
process.exitCode = diffs.length === 0 ? 0 : 1
