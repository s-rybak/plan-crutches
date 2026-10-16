// Checks the pure modules of the review page with node:test, no browser:
//   node --test tests/page.node.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import { STRINGS, t } from '../web/i18n.js'
import { escapeHtml, renderInline, renderMarkdown } from '../web/markdown.js'
import { highlight, languageOf } from '../web/highlight.js'
import { allDirKeys, buildTree, pathsUnder, renderTree } from '../web/tree.js'
import { findStubRegions, renderDiff, renderSource } from '../web/codeview.js'

test('i18n: both languages carry the same keys and params are filled in', () => {
  const en = Object.keys(STRINGS.en).sort()
  const uk = Object.keys(STRINGS.uk).sort()
  assert.deepEqual(uk, en)
  assert.equal(t('en', 'submitWith', { n: 3 }), 'Submit 3 comments')
  assert.equal(t('uk', 'submitWith', { n: 3 }), 'Надіслати 3 коментарів')
  assert.equal(t('fr', 'submit'), STRINGS.en.submit)
  assert.equal(t('en', 'no-such-key'), 'no-such-key')
})

test('markdown: escapes html, blocks script urls, keeps structure', () => {
  assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;')
  const html = renderMarkdown('# Title\n\nA <script>alert(1)</script> line with `code` and **bold**.\n\n- one\n- two\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n> quoted')
  assert.match(html, /<h1>Title<\/h1>/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /<code>code<\/code>/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<ul><li>one<\/li><li>two<ul><li>nested<\/li><\/ul><\/li><\/ul>/)
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
  assert.match(html, /<pre><code class="language-ts">const x = 1<\/code><\/pre>/)
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/)
  assert.match(renderInline('[x](javascript:alert(1))'), /href="#"/)
  assert.match(renderInline('![d](docs/a.png)', { imageUrl: src => `/project/${src}?t=1` }), /src="\/project\/docs\/a.png\?t=1"/)
  assert.match(renderInline('![d](https://x.test/a.png)', { imageUrl: () => 'nope' }), /src="https:\/\/x.test\/a.png"/)
  assert.match(renderInline('[site](https://x.test)'), /<a href="https:\/\/x.test" target="_blank" rel="noopener">site<\/a>/)
})

test('highlight: comments follow the language, strings and keywords get classes', () => {
  assert.equal(languageOf('src/a/b.test.ts'), 'ts')
  assert.equal(languageOf('Dockerfile'), 'dockerfile')
  const ts = highlight('const s = "a" // note\n# not a comment', 'x.ts')
  assert.match(ts, /<span class="tok-kw">const<\/span>/)
  assert.match(ts, /<span class="tok-str">&quot;a&quot;<\/span>/)
  assert.match(ts, /<span class="tok-cm">\/\/ note<\/span>/)
  assert.doesNotMatch(ts, /tok-cm">#/)
  const py = highlight('def f(x): # note\n    return x // 2', 'x.py')
  assert.match(py, /<span class="tok-cm"># note<\/span>/)
  assert.doesNotMatch(py, /tok-cm">\/\//)
  assert.match(py, /<span class="tok-fn">f<\/span>/)
  const markup = highlight('<b>', 'x.html')
  assert.doesNotMatch(markup, /<b>/)
  assert.match(markup, /&lt;.*&gt;/)
})

test('tree: folders first, folder status from children, collapse hides rows', () => {
  const roots = buildTree([
    { path: 'src/b.ts', status: 'modified' },
    { path: 'src/auth/a.ts', status: 'new' },
    { path: 'src/auth/z.ts', status: 'new' },
    { path: 'README.md', status: 'deleted' },
  ])
  assert.deepEqual(roots.map(node => node.name), ['src', 'README.md'])
  const src = roots[0]
  assert.equal(src.status, 'mixed')
  assert.deepEqual(src.children.map(node => node.name), ['auth', 'b.ts'])
  assert.equal(src.children[0].status, 'new')
  assert.deepEqual(pathsUnder(src), ['src/auth/a.ts', 'src/auth/z.ts', 'src/b.ts'])
  assert.deepEqual(allDirKeys(roots), ['dir:src', 'dir:src/auth'])
  const options = { collapsed: new Set(), selected: 'src/b.ts', lang: 'en', commentCounts: new Map([['src/auth/', 2]]) }
  const open = renderTree(roots, options)
  assert.equal((open.match(/class="row /g) || []).length, 6)
  assert.match(open, /class="row file modified selected"/)
  assert.match(open, /<span class="chip count">2<\/span>/)
  assert.match(open, /data-action="comment-node" data-path="src\/auth" data-kind="dir"/)
  const closed = renderTree(roots, { ...options, collapsed: new Set(['dir:src']) })
  assert.equal((closed.match(/class="row /g) || []).length, 2)
})

test('codeview: stub regions match one-line and multi-line signatures', () => {
  const regions = findStubRegions(
    ['import x', '', 'export function a(): void {', '  // implementation: expand in Plan Crutches', '}', 'def b(', '    x,', '):', '    # implementation: expand in Plan Crutches', 'tail'],
    [
      { name: 'a', signature: 'export function a(): void {' },
      { name: 'b', signature: 'def b(\n    x,\n):' },
      { name: 'missing', signature: 'function nope()' },
    ],
  )
  assert.deepEqual([...regions.entries()].map(([start, region]) => [start, region.symbol.name, region.end]), [
    [2, 'a', 5],
    [5, 'b', 9],
  ])
  const noStub = findStubRegions(['export function a(): void {', '  return 1', '}'], [{ name: 'a', signature: 'export function a(): void {' }])
  assert.deepEqual([...noStub.entries()].map(([start, region]) => [start, region.end]), [[0, 1]])
})

test('codeview: source and diff lines carry numbers, and the inline body replaces the stub', () => {
  const source = renderSource('a\nb\nc', { path: 'x.ts', startLine: 10, commented: new Set([11]) })
  assert.match(source, /class="line" data-line="10"/)
  assert.match(source, /class="line commented" data-line="11"/)
  assert.match(source, /class="code source marked"/)

  const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -3,2 +3,5 @@', ' keep', '+export function f(): void {', '+  // implementation: expand in Plan Crutches', '+}', '-gone', ' end'].join('\n')
  const symbols = [{ name: 'f', signature: 'export function f(): void {' }]
  const inline = { path: 'x.ts', symbols, bodies: {}, expanded: new Set(), lang: 'en', commentedFor: () => new Set() }
  const collapsed = renderDiff(diff, { path: 'x.ts', inline })
  assert.match(collapsed, /class="line ctx" data-line="3"/)
  assert.match(collapsed, /class="line add" data-line="4"[^>]*>.*data-action="inline-expand" data-path="x.ts" data-symbol="f"/)
  assert.equal((collapsed.match(/inline-expand/g) || []).length, 1)
  assert.match(collapsed, /class="line del" data-line="4" data-side="old"/)
  assert.match(collapsed, /class="line ctx" data-line="7" data-side="new"/)

  const ready = { ...inline, bodies: { 'x.ts#f': { status: 'ready', code: 'export function f(): void {\n  go()\n}' } }, expanded: new Set(['x.ts#f']), commentedFor: () => new Set([2]) }
  const expanded = renderDiff(diff, { path: 'x.ts', inline: ready })
  assert.doesNotMatch(expanded, /expand in Plan Crutches/)
  assert.match(expanded, /<div class="inline-body" data-selectable data-scope="code" data-path="x.ts" data-symbol="f">/)
  assert.match(expanded, /class="line gen add commented" data-line="2"/)
  assert.equal((expanded.match(/class="line gen add/g) || []).length, 3)
  assert.match(expanded, /data-action="inline-collapse"/)
  assert.match(expanded, /class="line ctx" data-line="7" data-side="new"/)

  const loading = { ...inline, bodies: { 'x.ts#f': { status: 'loading' } }, expanded: new Set(['x.ts#f']) }
  assert.match(renderDiff(diff, { path: 'x.ts', inline: loading }), /class="spinner"/)
  const failed = { ...inline, bodies: { 'x.ts#f': { status: 'failed', error: 'x' } }, expanded: new Set(['x.ts#f']) }
  assert.match(renderDiff(diff, { path: 'x.ts', inline: failed }), /data-action="inline-regen"/)

  const preview = renderSource('export function f(): void {\n  // implementation: expand in Plan Crutches\n}\nconst k = 1', { path: 'x.ts', inline: ready })
  assert.match(preview, /class="line gen" data-line="1"/)
  assert.match(preview, /class="line" data-line="4"/)
})

test('diagram layout: callees sit right of callers, callers of an opened symbol join the planned blocks or a lane, others get a block', async () => {
  const { layoutScene, pathD, layerFiles, rowKey, BLOCK_W } = await import('../web/diagram-layout.js')
  const { readFileSync } = await import('node:fs')
  const demo = JSON.parse(readFileSync(new URL('../fixtures/demo-diagram.json', import.meta.url), 'utf8'))
  const layers = layerFiles(['a', 'b', 'c', 'd'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }])
  assert.deepEqual([...layers.entries()], [['a', 0], ['b', 1], ['c', 2], ['d', 0]])

  const plain = layoutScene(demo.graph, {}, new Set())
  const byPath = new Map(plain.blocks.map(block => [block.path, block]))
  assert.equal(plain.blocks.length, demo.graph.files.length)
  assert.ok(byPath.get('src/auth/user.ts').x < byPath.get('src/auth/session.ts').x, 'the caller file is left of the callee file')
  assert.equal(byPath.get('src/auth/session.ts').rows.map(row => row.name).join(','), 'Session,refreshSession,isExpiringSoon')
  assert.equal(byPath.get('docs/auth.md').rows.length, 0)
  assert.equal(plain.edges.length, demo.graph.edges.length)
  const inside = plain.edges.find(edge => edge.from === rowKey('src/auth/session.ts', 'refreshSession'))
  assert.equal(inside.mode, 'inside')
  assert.match(pathD(inside), /^M \d+(\.\d+)? \d+(\.\d+)? C /)
  const forward = plain.edges.find(edge => edge.to === rowKey('src/auth/session.ts', 'refreshSession') && edge.mode === 'forward')
  assert.equal(forward.x1, byPath.get('src/auth/user.ts').x + BLOCK_W)
  assert.equal(forward.x2, byPath.get('src/auth/session.ts').x)

  const key = rowKey('src/auth/user.ts', 'getCurrentUser')
  const routeKey = rowKey('src/api/routes.ts', 'refreshRoute')
  const callers = {
    [key]: { status: 'ready', ...demo.callers[key] },
    [routeKey]: { status: 'ready', ...demo.callers[routeKey] },
    [rowKey('src/auth/session.ts', 'Session')]: { status: 'loading', callers: [], more: 0 },
  }
  const opened = layoutScene(demo.graph, callers, new Set([key, routeKey, rowKey('src/auth/session.ts', 'Session')]))
  const paths = new Map(opened.blocks.map(block => [block.path || block.id, block]))
  assert.equal(opened.blocks.filter(block => !block.extra).length, demo.graph.files.length, 'the planned blocks are all still there')
  assert.ok(paths.get('src/ui/Header.tsx').extra)
  assert.equal(paths.get('src/ui/Header.tsx').status, 'unchanged')
  assert.ok(paths.get('src/ui/Header.tsx').x < paths.get('src/auth/user.ts').x, 'a caller block is left of the callee block')
  assert.equal(paths.get('src/ui/Profile.tsx').rows.map(row => row.name).join(','), 'Profile,ProfileMenu')
  const routes = paths.get('src/api/routes.ts')
  assert.deepEqual(routes.rows.map(row => [row.name, row.planned]), [['refreshRoute', true], ['routes', false]])
  assert.equal(opened.edges.find(edge => edge.from === rowKey('src/api/routes.ts', 'routes')).mode, 'inside')
  const others = paths.get(`others:${key}`)
  assert.equal(others.kind, 'others')
  assert.equal(others.count, 23)
  assert.equal(opened.edges.find(edge => edge.from === others.id).origin, 'others')
  assert.equal(opened.blocks.filter(block => block.id.startsWith('others:')).length, 1, 'a loading query adds nothing yet')
  assert.ok(opened.width > plain.width, 'the lane widens the scene')
})

test('diagram layout: a dragged block keeps its place, the board grows and the pivot stays; tall columns wrap', async () => {
  const { layoutScene, wrapColumn, rowKey, BLOCK_W, MARGIN, MAX_STACK, ROW_GAP } = await import('../web/diagram-layout.js')
  const { readFileSync } = await import('node:fs')
  const demo = JSON.parse(readFileSync(new URL('../fixtures/demo-diagram.json', import.meta.url), 'utf8'))
  const plain = layoutScene(demo.graph, {}, new Set())
  assert.deepEqual(plain.pivot, { x: plain.width / 2, y: plain.height / 2 })
  assert.ok(plain.blocks.every(block => !block.moved))

  const moved = new Map([
    ['file:docs/auth.md', { x: 1400, y: 900 }],
    ['file:src/auth/user.ts', { x: 1200, y: 60 }],
  ])
  const dragged = layoutScene(demo.graph, {}, new Set(), moved)
  const byPath = new Map(dragged.blocks.map(block => [block.path, block]))
  assert.deepEqual([byPath.get('docs/auth.md').x, byPath.get('docs/auth.md').y, byPath.get('docs/auth.md').moved], [1400, 900, true])
  assert.deepEqual(dragged.pivot, plain.pivot, 'the view keeps turning around the automatic layout')
  assert.equal(dragged.width, 1400 + BLOCK_W + MARGIN)
  assert.equal(dragged.height, 900 + byPath.get('docs/auth.md').h + MARGIN)
  assert.equal(byPath.get('src/auth/session.ts').x, new Map(plain.blocks.map(block => [block.path, block])).get('src/auth/session.ts').x, 'other blocks stay put')
  const edge = dragged.edges.find(one => one.from === rowKey('src/auth/user.ts', 'getCurrentUser') && one.to === rowKey('src/auth/session.ts', 'refreshSession'))
  assert.equal(edge.mode, 'backward', 'the edge follows the moved block')
  assert.equal(edge.x1, 1200)

  const tall = Array.from({ length: 5 }, (_, index) => ({ id: `b${index}`, h: 500 }))
  const stacks = wrapColumn(tall)
  assert.deepEqual(stacks.map(stack => stack.length), [2, 2, 1])
  assert.ok(2 * 500 + ROW_GAP <= MAX_STACK && 3 * 500 + 2 * ROW_GAP > MAX_STACK)
  const files = Array.from({ length: 12 }, (_, index) => ({ path: `src/f${index}.ts`, status: 'modified', symbols: Array.from({ length: 12 }, (_, at) => ({ name: `s${at}`, kind: 'function' })) }))
  const wide = layoutScene({ files, edges: [] }, {}, new Set())
  const xs = new Set(wide.blocks.map(block => block.x))
  assert.ok(xs.size > 1, 'a column of twelve tall blocks wraps into several stacks')
  assert.ok(wide.height <= MAX_STACK + 2 * MARGIN + 1)
  assert.equal(wide.blocks.length, 12, 'every block is drawn')
})
