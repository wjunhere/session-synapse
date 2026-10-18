#!/usr/bin/env node
/**
 * Read a DSH session log: a concatenated-frame Zstandard JSONL container.
 *
 * Why this exists at all: DSH appends one Zstandard frame per durable batch, so
 * `zlib.zstdDecompressSync` on the whole file decodes ONLY the first frame
 * (measured: a 766 KB session yielded the header line and nothing else). Node
 * exposes no frame-counting decoder, so the boundaries are located by walking
 * the frame structure — the same algorithm DSH's own persistence reader uses.
 *
 * The running plugin does NOT need this: inside the harness, sessions are read
 * through `ctx.sessionQuery`. This is the offline reader — for debugging a log,
 * exporting one, or extracting a test fixture.
 *
 * Usage:
 *   node scripts/dsh-session-events.mjs <session.v4.jsonl.zstd>            # summary
 *   node scripts/dsh-session-events.mjs <file> --types                    # event type counts
 *   node scripts/dsh-session-events.mjs <file> --dump <type> [--limit N]   # raw events of a type
 *   node scripts/dsh-session-events.mjs <file> --json                     # every event, as JSON lines
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * A truncated final frame (the normal state of a log being appended to) is
 * reported through `tornStart` instead of throwing.
 *
 * @param {Buffer} buffer complete bytes currently present in the file
 * @returns {{ frames: {start: number, end: number}[], tornStart?: number }}
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`不是 DSH 会话日志：字节 ${offset} 处不是 Zstandard 帧头`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`帧头保留位被置位（字节 ${offset - 1}）`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`帧内出现保留块类型（字节 ${offset - 3}）`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode every complete frame into text.
 *
 * @param {Buffer} buffer the whole file
 * @returns {{ text: string, frames: number, torn: boolean }}
 */
export function decodeSessionText(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  const parts = []
  for (const frame of frames) parts.push(zstdFrame(buffer.subarray(frame.start, frame.end)))
  return { text: parts.join(''), frames: frames.length, torn: tornStart !== undefined }
}

/** Decompress one structurally complete frame. */
function zstdFrame(frame) {
  try {
    return zstdDecompressSync(frame).toString('utf8')
  } catch (error) {
    throw new Error(`解压第 ${frame.length} 字节的 zstd 帧失败: ${error?.message ?? error}`)
  }
}

/**
 * Read a session log file into its events, in order.
 *
 * A trailing partial line is expected while a session streams, so an
 * unparsable last line is skipped rather than treated as corruption.
 *
 * @param {string} file path to `session.v*.jsonl.zstd`
 * @returns {object[]} parsed events (the `session` header is the first one)
 */
export function readDshSessionEvents(file) {
  const { text } = decodeSessionText(readFileSync(file))
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // A partially written trailing line.
    }
  }
  return events
}

/** Event type → count, for a quick look at what a log contains. */
export function eventTypeCounts(events) {
  const counts = new Map()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  return counts
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, ...rest] = process.argv.slice(2)
  if (file === undefined) {
    process.stderr.write('用法: node scripts/dsh-session-events.mjs <session.v4.jsonl.zstd> [--types|--json|--dump <type> [--limit N]]\n')
    process.exit(1)
  }
  const events = readDshSessionEvents(file)
  const header = events[0]
  process.stdout.write(`事件数 ${events.length}\nheader ${JSON.stringify(header)}\n`)
  if (rest.includes('--json')) {
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`)
  } else if (rest.includes('--dump')) {
    const type = rest[rest.indexOf('--dump') + 1]
    const limitIndex = rest.indexOf('--limit')
    const limit = limitIndex === -1 ? 3 : Number(rest[limitIndex + 1])
    for (const event of events.filter(item => item.type === type).slice(0, limit)) {
      process.stdout.write(`${JSON.stringify(event, null, 1)}\n`)
    }
  } else {
    for (const [type, count] of [...eventTypeCounts(events)].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`${String(count).padStart(5)}  ${type}\n`)
    }
  }
}
