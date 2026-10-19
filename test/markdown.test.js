import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inlineMarkdown, renderMarkdown } from '../src/canvas/markdown.js'

// The constructs that actually occur in the sessions on this machine, in the
// order they appear in the audit (see the header of src/canvas/markdown.js).

test('inline code, bold, italic and strikethrough', () => {
  assert.equal(inlineMarkdown('`git push` 之后 **完成**'), '<code class="md-code">git push</code> 之后 <strong>完成</strong>')
  assert.equal(inlineMarkdown('*斜* 和 ~~删~~'), '<em>斜</em> 和 <s>删</s>')
})

test('markup inside a code span stays literal', () => {
  // The reason tokens exist: a command like `git log --grep='**'` must not come
  // out half-bolded.
  assert.equal(inlineMarkdown('`**not bold**`'), '<code class="md-code">**not bold**</code>')
  assert.equal(inlineMarkdown('`[x](javascript:alert(1))`'), '<code class="md-code">[x](javascript:alert(1))</code>')
})

test('a reply cannot inject markup', () => {
  const rendered = inlineMarkdown('<img src=x onerror=alert(1)>')
  assert.ok(!rendered.includes('<img'), rendered)
  assert.ok(rendered.includes('&lt;img'), rendered)
})

test('links are opened in a new tab, and only for schemes that are safe', () => {
  assert.equal(inlineMarkdown('[PR #4](https://github.com/x/y/pull/4)'),
    '<a class="md-link" href="https://github.com/x/y/pull/4" target="_blank" rel="noopener noreferrer">PR #4</a>')
  // A relative URL would navigate the IFRAME (the canvas is a document, not a
  // tab), so it stays text.
  assert.equal(inlineMarkdown('[看这里](/synapse/api/status)'), '看这里')
  assert.equal(inlineMarkdown('[写信](mailto:a@b.c)'),
    '<a class="md-link" href="mailto:a@b.c" target="_blank" rel="noopener noreferrer">写信</a>')
  // A hostile scheme loses its href entirely — only the label survives. (The
  // stray `)` is the URL's own closing paren, which the pattern does not take;
  // rendering the href would be the bug, not the punctuation.)
  const hostile = inlineMarkdown('[点我](javascript:alert(1))')
  assert.ok(!hostile.includes('href'), hostile)
  assert.ok(hostile.startsWith('点我'), hostile)
})

test('a bare URL becomes a link, a URL inside one does not become two', () => {
  assert.equal(inlineMarkdown('见 https://example.com/a'),
    '见 <a class="md-link" href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>')
  assert.equal(inlineMarkdown('[x](https://example.com)').match(/md-link/g)?.length, 1)
})

test('images only for sources the canvas can fetch', () => {
  assert.equal(inlineMarkdown('![图](https://x/y.png)'), '<img class="md-image" src="https://x/y.png" alt="图" loading="lazy">')
  // A local path would 404 inside the iframe, so it is shown as a path instead.
  assert.equal(inlineMarkdown('![图](B:/shots/a.png)'), '<span class="md-image-path" title="B:/shots/a.png">图</span>')
})

test('inline math needs the delimiters a formula needs, so $PATH stays a variable', () => {
  assert.equal(inlineMarkdown('公式 $a^2+b^2$ 结束'), '公式 <span class="md-math">a^2+b^2</span> 结束')
  assert.equal(inlineMarkdown('公式 \\(x_1\\) 结束'), '公式 <span class="md-math">x_1</span> 结束')
  // Money and shell variables are the two things a naive `$…$` rule eats.
  assert.equal(inlineMarkdown('价格 $5 到 $9'), '价格 $5 到 $9')
  assert.equal(inlineMarkdown('用 $PATH 和 $HOME'), '用 $PATH 和 $HOME')
})

test('block level: headings, hr, blockquote, tables, fences', () => {
  assert.equal(renderMarkdown('#### 四级标题'), '<h4>四级标题</h4>')
  assert.equal(renderMarkdown('---'), '<hr>')
  assert.equal(renderMarkdown('> 引用一句'), '<blockquote><p>引用一句</p></blockquote>')
  assert.equal(renderMarkdown('```js\nconst a = 1\n```'),
    '<pre class="md-block" data-lang="js"><span class="md-code-lang">js</span><code>const a = 1</code></pre>')
  assert.equal(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'),
    '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
})

test('a mermaid fence keeps its source as text for the render pass', () => {
  const rendered = renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```')
  assert.equal(rendered, '<div class="md-mermaid">graph TD\n  A--&gt;B</div>')
})

test('display math is its own block, on one line or several', () => {
  assert.equal(renderMarkdown('$$\n\\int_0^1 x dx\n$$'), '<div class="md-math-block">\\int_0^1 x dx</div>')
  assert.equal(renderMarkdown('$$a+b$$'), '<div class="md-math-block">a+b</div>')
  assert.equal(renderMarkdown('\\[a+b\\]'), '<div class="md-math-block">a+b</div>')
})

test('lists nest by indentation, and task items get a checkbox', () => {
  assert.equal(renderMarkdown('- 一\n- 二'),
    '<ul><li>一</li><li>二</li></ul>')
  assert.equal(renderMarkdown('1. 一\n2. 二'),
    '<ol><li>一</li><li>二</li></ol>')
  assert.equal(renderMarkdown('- 一\n  - 一之一\n- 二'),
    '<ul><li>一<ul><li>一之一</li></ul></li><li>二</li></ul>')
  assert.equal(renderMarkdown('- [x] 做完\n- [ ] 没做'),
    '<ul><li><input class="md-task" type="checkbox" disabled checked>做完</li><li><input class="md-task" type="checkbox" disabled>没做</li></ul>')
})

test('a list item can continue on the next line, and a blank line does not end it', () => {
  assert.equal(renderMarkdown('- 第一行\n  第二行'), '<ul><li>第一行<br>第二行</li></ul>')
  assert.equal(renderMarkdown('- 一\n\n- 二'), '<ul><li>一</li><li>二</li></ul>')
})

test('a change of marker kind starts a new list', () => {
  // Measured in the browser: a task list written right after an ordered list came
  // out as items 3 and 4 of the ordered list.
  assert.equal(renderMarkdown('1. 一\n- [x] 二'),
    '<ol><li>一</li></ol><ul><li><input class="md-task" type="checkbox" disabled checked>二</li></ul>')
})

test('a paragraph line that starts with a list marker is still a list', () => {
  // The old parser needed a marker-only line to make progress; the paragraph
  // branch must never swallow a list.
  assert.equal(renderMarkdown('正文\n- 项目'), '<p>正文</p><ul><li>项目</li></ul>')
})

test('a PowerShell diagnostic line does not hang the parser', () => {
  // Measured in a real session: `+ ` alone (a marker with no text) is neither a
  // list item nor paragraph content under the rules above.
  const rendered = renderMarkdown('+ \n+ CategoryInfo: 找不到')
  assert.ok(rendered.includes('CategoryInfo'), rendered)
})
