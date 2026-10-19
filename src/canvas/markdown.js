/**
 * The markdown subset the canvas renders.
 *
 * Hand-rolled on purpose: the canvas ships no dependencies for its own code (the
 * two vendored libraries — mermaid, temml — are only *blocks*, see
 * `rich-blocks.js`). Everything is escaped before any tag is inserted, so a
 * reply cannot inject markup: the only HTML in the output is what this file
 * builds.
 *
 * What it covers, measured against the sessions on this machine (4505 messages,
 * 1.1 MB of prose) — the percentage is how many messages use the construct:
 *
 *   inline code 42% · bold 30% · headings 6.7% · tables 6.1% · lists 10% ·
 *   code fences 4.8% · italics 5.7% · blockquote 0.9% · hr 1.0% ·
 *   autolinks 1.0% · nested lists 0.9% · task lists 0.2% · links 0.2% ·
 *   mermaid 0.3% · LaTeX 0.3% · images 0.02%
 *
 * Deliberately NOT supported (with the reason, so the gap is a decision rather
 * than an oversight):
 *   - raw HTML: escaped. The host sanitizes it; a canvas that inserted it would
 *     have to sanitize too, and the messages that contain it are almost all code.
 *   - syntax highlighting: would mean shipping a highlighter (300 KB–1 MB) for
 *     the 2% of messages with a language tag.
 *   - footnotes / definition lists / setext headings: no occurrences here.
 */
import { escapeHtml } from './format.js'

/**
 * Placeholder for already-built HTML.
 *
 * Markup is built in the right order (code first, then links, then emphasis) and
 * parked in `tokens` while the remaining plain text is processed, so `**` inside
 * a code span or a URL stays literal. `\u0001`/`\u0002` cannot appear in the
 * escaped text — they are control characters, and the text is HTML-escaped
 * anyway.
 */
const TOKEN_PATTERN = /\u0001(\d+)\u0002/g

/** URLs that may become a link. Anything else (javascript:, data:, …) is text. */
const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i
/** Images the canvas can actually fetch. A local path would 404 inside the iframe. */
const SAFE_IMAGE = /^(?:https?:\/\/|data:image\/)/i

const imageHtml = (alt, source) => SAFE_IMAGE.test(source)
  ? `<img class="md-image" src="${source}" alt="${alt}" loading="lazy">`
  : `<span class="md-image-path" title="${source}">${alt === '' ? source : alt}</span>`

const linkHtml = (label, href) => SAFE_LINK.test(href)
  ? `<a class="md-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
  : label

/** `$…$` and `\(…\)`: inline math. `$$`/`\[` are block level, see `markdownBlock`. */
const INLINE_MATH = [
  /\\\(([\s\S]+?)\\\)/g,
  // The `$` form follows the usual convention: no space after the opening
  // delimiter, no space before the closing one, no digit right after it. That is
  // what keeps `$PATH` and `$5.00` from turning into formulas.
  /(^|[^\w$\\])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g,
]

function inlineMathHtml(source) {
  return `<span class="md-math">${escapeHtml(source.trim())}</span>`
}

export function inlineMarkdown(text) {
  const tokens = []
  const keep = html => `\u0001${tokens.push(html) - 1}\u0002`
  let out = escapeHtml(String(text))
  // Code spans first: nothing inside them is markup.
  out = out.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code class="md-code">${code}</code>`))
  // Inline math next, before links: a formula may contain brackets or asterisks.
  out = out.replace(INLINE_MATH[0], (_, source) => keep(inlineMathHtml(source)))
  out = out.replace(INLINE_MATH[1], (_, lead, source) => `${lead}${keep(inlineMathHtml(source))}`)
  // Images before links (`![` would otherwise be read as a link with a `!`).
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, source) => keep(imageHtml(alt, source)))
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => keep(linkHtml(label, href)))
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()\u0001\u0002]+)/g, (_, lead, url) => `${lead}${keep(linkHtml(url, url))}`)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  return out.replace(TOKEN_PATTERN, (_, index) => tokens[Number(index)])
}

export const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())

export const isTableDelimiter = line => {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell))
}

const HEADING = /^(#{1,6})\s+(.+)$/
const FENCE = /^\s*```\s*([\w-]*)\s*$/
const THEMATIC_BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const LIST_ITEM = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/
const TASK_MARK = /^\[([ xX])\]\s+/

/** One list item's marker, its indentation (in spaces) and its text. */
function listItemOf(line) {
  const match = LIST_ITEM.exec(line)
  if (match === null) return null
  const indent = match[1].replace(/\t/g, '    ').length
  const task = TASK_MARK.exec(match[3])
  return {
    indent,
    ordered: /^\d/.test(match[2]),
    text: task === null ? match[3] : match[3].slice(task[0].length),
    task: task === null ? null : task[1].toLowerCase() === 'x',
    continuations: [],
  }
}

/** How deep a continuation line has to be indented to belong to the item above. */
const continuationIndent = indent => indent + 2

/**
 * Render the list starting at `items[index]`, recursing into deeper items.
 *
 * Nesting is by indentation, which is what a reader sees; the marker kind
 * (`-` vs `1.`) decides `<ul>` or `<ol>` per level.
 */
function renderList(items, index, indent) {
  const ordered = items[index].ordered
  const entries = []
  let cursor = index
  while (cursor < items.length && items[cursor].indent >= indent) {
    const item = items[cursor]
    if (item.indent > indent) {
      // Deeper than the current level: it belongs inside the previous <li>.
      const child = renderList(items, cursor, item.indent)
      entries[entries.length - 1] = entries[entries.length - 1].replace(/<\/li>$/, `${child.html}</li>`)
      cursor = child.next
      continue
    }
    // A different marker kind at the same level is a DIFFERENT list: `1. a`
    // followed by `- b` must not turn the bullet into item 2 (measured: a task
    // list right after an ordered list came out numbered).
    if (item.ordered !== ordered) break
    const box = item.task === null ? '' : `<input class="md-task" type="checkbox" disabled${item.task ? ' checked' : ''}>`
    // Continuation lines are escaped by `inlineMarkdown` like any other text:
    // escaping them here as well would put `&lt;br&gt;` on the page.
    const rest = item.continuations.map(text => `<br>${inlineMarkdown(text)}`).join('')
    entries.push(`<li>${box}${inlineMarkdown(item.text)}${rest}</li>`)
    cursor += 1
  }
  return { html: `<${ordered ? 'ol' : 'ul'}>${entries.join('')}</${ordered ? 'ol' : 'ul'}>`, next: cursor }
}

export function markdownBlock(text) {
  const lines = text.split('\n')
  const output = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (line.trim() === '') { index++; continue }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      index++
      continue
    }
    if (THEMATIC_BREAK.test(line)) { output.push('<hr>'); index++; continue }

    // Display math: `$$…$$` and `\[…\]`, on one line or spread over several.
    // The opening line may already carry the whole formula (`$$a+b$$`).
    const dollar = /^\s*\$\$(.*)$/.exec(line)
    const bracket = /^\s*\\\[(.*)$/.exec(line)
    if (dollar !== null || bracket !== null) {
      const closer = dollar === null ? '\\]' : '$$'
      const collected = [(dollar ?? bracket)[1]]
      let cursor = index
      while (!collected[collected.length - 1].includes(closer) && cursor + 1 < lines.length) {
        cursor += 1
        collected.push(lines[cursor])
      }
      const joined = collected.join('\n')
      const end = joined.indexOf(closer)
      output.push(`<div class="md-math-block">${escapeHtml((end === -1 ? joined : joined.slice(0, end)).trim())}</div>`)
      index = cursor + 1
      continue
    }

    // Blockquote: consecutive `>` lines, rendered recursively.
    if (QUOTE.test(line)) {
      const quoted = []
      while (index < lines.length && QUOTE.test(lines[index])) { quoted.push(QUOTE.exec(lines[index])[1]); index++ }
      output.push(`<blockquote>${markdownBlock(quoted.join('\n'))}</blockquote>`)
      continue
    }

    // GFM table: a leading-pipe header row followed by a |-delimiter row,
    // then any number of leading-pipe body rows.
    if (/^\s*\|/.test(line) && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      const header = line
      const body = []
      index += 2
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        body.push(lines[index])
        index++
      }
      output.push(`<table><thead><tr>${tableCells(header).map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${tableCells(row).map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }

    // Lists: gather every marker line (and the continuation lines that belong to
    // an item) so nesting can be built in one pass.
    const firstItem = listItemOf(line)
    if (firstItem !== null) {
      const items = []
      while (index < lines.length) {
        const item = listItemOf(lines[index])
        if (item !== null) { items.push(item); index++; continue }
        // A blank line between two items is a "loose" list, not the end of it.
        if (lines[index].trim() === '' && index + 1 < lines.length && listItemOf(lines[index + 1]) !== null) { index++; continue }
        // An indented non-marker line continues the item above it.
        const indentation = /^[ \t]*/.exec(lines[index])[0].replace(/\t/g, '    ').length
        if (items.length > 0 && lines[index].trim() !== '' && indentation >= continuationIndent(items[items.length - 1].indent)) {
          items[items.length - 1].continuations.push(lines[index].trim())
          index++
          continue
        }
        break
      }
      // A run of list lines can hold more than one list: a change of marker kind
      // ends the list and starts another (see `renderList`).
      let cursor = 0
      while (cursor < items.length) {
        const list = renderList(items, cursor, items[cursor].indent)
        output.push(list.html)
        cursor = list.next
      }
      continue
    }

    const paragraph = []
    while (index < lines.length && lines[index].trim() !== '' && HEADING.exec(lines[index]) === null && listItemOf(lines[index]) === null && !QUOTE.test(lines[index]) && !THEMATIC_BREAK.test(lines[index])) paragraph.push(lines[index++])
    // A marker-only line such as PowerShell's "+ " diagnostic is neither a
    // list item nor paragraph content under the rules above. Consume it so
    // the parser always makes progress.
    if (paragraph.length === 0) paragraph.push(lines[index++])
    output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`)
  }
  return output.join('')
}

/**
 * One fenced code block.
 *
 * ```mermaid becomes a diagram container holding the SOURCE as text: the canvas
 * has no library loaded at this point (mermaid is 3.4 MB and only fetched when a
 * diagram actually exists), and keeping the source in the document is what lets
 * the render pass replace it, and lets a diagram that fails to parse fall back to
 * the code the user wrote.
 */
function codeBlock(part) {
  const info = /^([^\n]*)\n/.exec(part)
  const language = info === null ? '' : info[1].trim().toLowerCase()
  const body = info === null ? part : part.slice(info[0].length)
  if (language === 'mermaid') return `<div class="md-mermaid">${escapeHtml(body.trim())}</div>`
  const label = language === '' ? '' : `<span class="md-code-lang">${escapeHtml(language)}</span>`
  return `<pre class="md-block"${language === '' ? '' : ` data-lang="${escapeHtml(language)}"`}>${label}<code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`
}

// Markdown parsing is pure CPU and repeats for every card on every canvas
// rebuild; cache the rendered HTML by input text so stable answers are never
// re-parsed. Bounded: streaming partial texts churn keys, so evict oldest.
const markdownCache = new Map()
const MARKDOWN_CACHE_LIMIT = 5000
export function renderMarkdown(text) {
  const key = String(text)
  const cached = markdownCache.get(key)
  if (cached !== undefined) return cached
  const parts = key.split(/^\s*```/m)
  // Odd parts are inside a fence (the closing fence is a split point too, so the
  // alternation holds); a fence that was NOT at a line start stays inside its
  // part, which is why the tail after it is rendered as markdown here.
  const rendered = parts.map((part, index) => {
    if (index % 2 === 0) return markdownBlock(part)
    const end = part.indexOf('\n```')
    return end === -1 ? codeBlock(part) : `${codeBlock(part.slice(0, end))}${markdownBlock(part.slice(end + 4))}`
  }).join('')
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) markdownCache.delete(markdownCache.keys().next().value)
  markdownCache.set(key, rendered)
  return rendered
}
