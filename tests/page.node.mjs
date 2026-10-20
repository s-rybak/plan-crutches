// Checks the pure modules of the review page with node:test, no browser:
//   node --test tests/page.node.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import { STRINGS, t } from '../web/i18n.js'
import { escapeHtml, renderInline, renderMarkdown } from '../web/markdown.js'
import { highlight, languageOf } from '../web/highlight.js'
import { allDirKeys, buildTree, pathsUnder, renderTree } from '../web/tree.js'
import { deletionOfFile, findStubRegions, foldRanges, renderDiff, renderSource, stubbedSymbols, weaveDiff } from '../web/codeview.js'

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

test('tree: OK boxes per file and folder, delta chips and ghost rows for dropped files', async () => {
  const { okUnder } = await import('../web/tree.js')
  const roots = buildTree(
    [
      { path: 'src/b.ts', status: 'modified' },
      { path: 'src/auth/a.ts', status: 'new' },
    ],
    [{ path: 'src/auth/old.ts', status: 'modified' }],
  )
  const auth = roots[0].children[0]
  assert.deepEqual(pathsUnder(auth), ['src/auth/a.ts'], 'a ghost is not a planned file')
  assert.deepEqual(okUnder(roots[0], { 'src/auth/a.ts': { version: 1, at: 't' } }), { marked: 1, total: 2 })
  const options = { collapsed: new Set(), selected: null, lang: 'en', commentCounts: new Map() }
  const plain = renderTree(roots, { ...options, ok: { 'src/auth/a.ts': { version: 1, at: 't' } } })
  assert.match(plain, /class="okbox on" data-action="ok-toggle" data-path="src\/auth\/a.ts" data-ok="off"/)
  assert.match(plain, /class="okbox part" data-action="ok-toggle" data-path="src\/" data-ok="on"/)
  assert.match(plain, /class="okbox on" data-action="ok-toggle" data-path="src\/auth\/" data-ok="off"/)
  assert.match(plain, /class="row file modified" data-key="file:src\/b.ts"[^>]*><span class="caret"><\/span><button class="okbox" data-action="ok-toggle" data-path="src\/b.ts" data-ok="on"/)
  assert.match(plain, /class="row file modified ghost" data-key="file:src\/auth\/old.ts"[^>]*data-ghost="1"/)
  assert.doesNotMatch(plain, /data-action="comment-node" data-path="src\/auth\/old.ts"/, 'a ghost row takes no comment')
  assert.doesNotMatch(plain, /data-action="ok-toggle" data-path="src\/auth\/old.ts"/, 'a ghost row takes no OK')
  const deltas = { since: 1, byPath: new Map([['src/b.ts', 'changed'], ['src/auth/a.ts', 'added']]), folders: new Map([['src', 'changed'], ['src/auth', 'changed']]) }
  const marked = renderTree(roots, { ...options, deltas })
  assert.match(marked, /<span class="chip delta changed"[^>]*>~ changed<\/span>/)
  assert.match(marked, /<span class="chip delta added"[^>]*>\+ added<\/span>/)
  assert.match(marked, /<span class="chip delta removed"[^>]*>− removed<\/span>/)
  const readonly = renderTree(roots, { ...options, readonly: true })
  assert.doesNotMatch(readonly, /data-action="ok-toggle"/)
  assert.doesNotMatch(readonly, /data-action="comment-node"/)
})

test('compare: files and symbols added, changed, dropped or the same between two versions', async () => {
  const { fileDeltas, symbolDeltas, folderDelta, sameFile } = await import('../web/compare.js')
  const sym = (name, extra = {}) => ({ name, kind: 'function', signature: `function ${name}() {`, description: 'd', ...extra })
  const before = {
    files: [
      { path: 'a.ts', status: 'modified', description: 'A', symbols: [sym('f'), sym('g')] },
      { path: 'b.ts', status: 'new', description: 'B', symbols: [] },
      { path: 'gone.ts', status: 'deleted', description: '', symbols: [] },
    ],
  }
  const after = {
    files: [
      { path: 'a.ts', status: 'modified', description: 'A', symbols: [sym('f', { change: 'modified' }), sym('h')] },
      { path: 'b.ts', status: 'new', description: 'B', symbols: [] },
      { path: 'c.ts', status: 'new', description: 'C', symbols: [] },
    ],
  }
  const files = fileDeltas(after, before)
  assert.deepEqual([...files.byPath.entries()], [['a.ts', 'changed'], ['b.ts', 'same'], ['c.ts', 'added']])
  assert.deepEqual(files.removed.map(file => file.path), ['gone.ts'])
  assert.equal(sameFile(before.files[1], after.files[1]), true)
  assert.deepEqual(fileDeltas(after, null), { byPath: new Map(), removed: [] })
  const symbols = symbolDeltas(after.files[0], before.files[0])
  assert.deepEqual([...symbols.byName.entries()], [['f', 'changed'], ['h', 'added']])
  assert.deepEqual(symbols.removed.map(symbol => symbol.name), ['g'])
  assert.equal(symbols.previous.get('f').change, undefined)
  assert.deepEqual([...symbolDeltas(after.files[2], undefined).byName.entries()], [])
  assert.equal(folderDelta(['b.ts'], files.byPath, []), 'same')
  assert.equal(folderDelta(['b.ts'], files.byPath, ['gone.ts']), 'changed')
  assert.equal(folderDelta(['a.ts', 'b.ts'], files.byPath, []), 'changed')
})

test('textdiff: words that changed get marks, unchanged lines stay plain, html is escaped', async () => {
  const { diffSequences, tokenize, renderTextDiff, textsDiffer, countChanges } = await import('../web/textdiff.js')
  assert.deepEqual(
    diffSequences(['a', 'b', 'c'], ['a', 'x', 'c']).map(op => `${op.type}:${op.value}`),
    ['eq:a', 'del:b', 'ins:x', 'eq:c'],
  )
  assert.deepEqual(tokenize('Add a cache, now!'), ['Add', ' ', 'a', ' ', 'cache', ',', ' ', 'now', '!'])
  const html = renderTextDiff('Keep users signed in.\nThe cache is per process.\nOld line.', 'Keep users signed in.\nThe cache is per <b>process</b> and per user.\nNew line.')
  assert.match(html, /^<div class="textdiff">Keep users signed in\.\n/)
  assert.match(html, /<ins>&lt;b&gt;<\/ins>/)
  assert.match(html, /<ins>&lt;\/b&gt; and per user<\/ins>/)
  assert.match(html, /<del>Old<\/del><ins>New<\/ins> line\./)
  assert.doesNotMatch(html, /<b>/)
  assert.equal(textsDiffer('a\r\nb', 'a\nb'), false)
  assert.equal(textsDiffer('a', 'b'), true)
  assert.deepEqual(countChanges('one two three', 'one three four'), { added: 1, removed: 1 })
  const big = Array.from({ length: 3000 }, (_, index) => `w${index}`).join(' ')
  assert.match(renderTextDiff(big, `${big} tail`), /<ins>/)
})

test('codeview: a modified symbol shows its old lines before the stub, and the replace and deletion views carry both signs', async () => {
  const { oldLinesBefore, renderReplaceDiff, renderDeletion } = await import('../web/codeview.js')
  const diff = ['@@ -1,6 +1,5 @@', ' import x', '-export function f(): void {', '-  return 1', '-}', '+// New f.', '+export function f(): void {', '+  // implementation: expand in Plan Crutches', '+}', ' tail'].join('\n')
  const symbol = { name: 'f', signature: 'export function f(): void {' }
  assert.deepEqual(oldLinesBefore(diff, symbol), ['export function f(): void {', '  return 1', '}'])
  assert.deepEqual(oldLinesBefore(diff, { name: 'g', signature: 'function g()' }), [])
  const replace = renderReplaceDiff(['function f() {', '  return 1', '}'], 'function f() {\n  return 2\n}', { path: 'x.ts', commented: new Set([2]) })
  assert.equal((replace.match(/class="line del"/g) || []).length, 3)
  assert.equal((replace.match(/class="line add/g) || []).length, 3)
  assert.match(replace, /class="line add commented" data-line="2" data-side="new"/)
  const deletion = renderDeletion('function g() {\n}', { path: 'x.ts' })
  assert.equal((deletion.match(/class="line del"/g) || []).length, 2)
  assert.doesNotMatch(deletion, /class="line add/)
  assert.doesNotMatch(deletion, /class="line hunk"/, 'a synthetic diff shows no hunk header')
  assert.doesNotMatch(replace, /class="line hunk"/)
  const inlineReady = { path: 'x.ts', symbols: [symbol], bodies: { 'x.ts#f': { status: 'ready', code: 'export function f(): void {\n  return 2\n}' } }, expanded: new Set(['x.ts#f']), lang: 'en', commentedFor: () => new Set() }
  const expanded = renderDiff(diff, { path: 'x.ts', inline: inlineReady })
  assert.ok(expanded.indexOf('class="line del"') < expanded.indexOf('class="inline-body"'), 'the old lines stay above the generated body')
  assert.equal((expanded.match(/class="line del"/g) || []).length, 3)
})

test('codeview: the Full file view weaves the hunks into the file, moves a shifted hunk and gives up on a changed file', () => {
  const file = 'import x\nexport function f(): void {\n  return 1\n}\ntail\nmore\nend'
  const diff = ['@@ -1,6 +1,5 @@', ' import x', '-export function f(): void {', '-  return 1', '-}', '+// New f.', '+export function f(): void {', '+  // implementation: expand in Plan Crutches', '+}', ' tail', ' more'].join('\n')
  const woven = weaveDiff(file, diff)
  assert.equal(woven, ['@@ -1,7 +1,8 @@', ' import x', '-export function f(): void {', '-  return 1', '-}', '+// New f.', '+export function f(): void {', '+  // implementation: expand in Plan Crutches', '+}', ' tail', ' more', ' end'].join('\n'))
  const html = renderDiff(woven, { path: 'x.ts', headers: false })
  assert.match(html, /class="line ctx" data-line="8" data-side="new"[^>]*><span class="ln old">7<\/span><span class="ln">8<\/span>/, 'every line of the file is there, numbered on both sides')
  assert.doesNotMatch(html, /class="line hunk"/)
  const symbol = { name: 'f', signature: 'export function f(): void {' }
  const inline = { path: 'x.ts', symbols: [symbol], bodies: {}, expanded: new Set(), lang: 'en', commentedFor: () => new Set() }
  assert.match(renderDiff(woven, { path: 'x.ts', headers: false, inline }), /data-action="inline-expand" data-path="x.ts" data-symbol="f"/, 'the stub keeps its Show implementation button')

  const shifted = 'first\nsecond\n' + file
  assert.equal(weaveDiff(shifted, diff), ['@@ -1,9 +1,10 @@', ' first', ' second', ' import x', '-export function f(): void {', '-  return 1', '-}', '+// New f.', '+export function f(): void {', '+  // implementation: expand in Plan Crutches', '+}', ' tail', ' more', ' end'].join('\n'))
  assert.equal(weaveDiff('something\nelse', diff), null)
  assert.equal(weaveDiff(file, ''), ['@@ -1,7 +1,7 @@', ...file.split('\n').map(line => ` ${line}`)].join('\n'))

  const two = ['@@ -1,3 +1,4 @@', ' import x', '+// head', ' export function f(): void {', '   return 1', '@@ -5,3 +6,3 @@', ' tail', '-more', '+less', ' end'].join('\n')
  assert.equal(weaveDiff(file, two), ['@@ -1,7 +1,8 @@', ' import x', '+// head', ' export function f(): void {', '   return 1', ' }', ' tail', '-more', '+less', ' end'].join('\n'))
  const insertOnly = ['@@ -4,0 +5,2 @@', '+a', '+b'].join('\n')
  assert.equal(weaveDiff(file, insertOnly), ['@@ -1,7 +1,9 @@', ' import x', ' export function f(): void {', '   return 1', ' }', '+a', '+b', ' tail', ' more', ' end'].join('\n'))
  assert.equal(deletionOfFile('a\nb\n'), '@@ -1,2 +0,0 @@\n-a\n-b')
})

test('codeview: foldRanges hides the unchanged stretches, keeps context around anchors and leaves short or opened stretches alone', () => {
  const foldable = index => Array.from({ length: 20 }, (_, at) => !index.includes(at))
  const anchor = index => Array.from({ length: 20 }, (_, at) => index.includes(at))
  assert.deepEqual(foldRanges(foldable([10]), anchor([10]), { context: 2 }), [
    { start: 0, end: 8 },
    { start: 13, end: 20 },
  ])
  assert.deepEqual(foldRanges(foldable([10]), anchor([10]), { context: 2, unfolded: new Set([0]) }), [{ start: 13, end: 20 }])
  assert.deepEqual(foldRanges(foldable([5, 11]), anchor([5, 11]), { context: 2 }), [
    { start: 0, end: 3 },
    { start: 14, end: 20 },
  ], 'the five lines between two changes keep two of context on each side and the one left over stays open; two lines above the first change are too few to fold')
  assert.deepEqual(foldRanges(foldable([4, 10]), anchor([4, 10]), { context: 2 }), [{ start: 13, end: 20 }], 'two lines above the first change are too few to fold')
  assert.deepEqual(foldRanges(foldable([]), anchor([]), { context: 2 }), [{ start: 0, end: 20 }], 'a diff without a change folds whole')
  const header = foldable([0, 10])
  assert.deepEqual(foldRanges(header, anchor([10]), { context: 2 }), [
    { start: 1, end: 8 },
    { start: 13, end: 20 },
  ], 'a line that neither hides nor anchors, such as a hunk header, only bounds a stretch')
})

test('codeview: the folded file view hides the unchanged stretches behind one row each, numbers the lines through them and opens a fold on demand', () => {
  const file = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')
  const diff = ['@@ -13,5 +13,6 @@', ' line 13', ' line 14', '-line 15', '+line 15a', '+line 15b', ' line 16', ' line 17'].join('\n')
  const woven = weaveDiff(file, diff)
  const foldsIn = html =>
    [...html.matchAll(/class="line fold" data-action="unfold" data-path="x.ts" data-fold="(\d+)" title="Click to show these lines"><span class="ln old"><\/span><span class="ln"><\/span><span class="sign"><\/span><span class="src">⋯ (\d+) unchanged lines<\/span><\/div>/g)].map(match => [Number(match[1]), Number(match[2])])
  const folded = renderDiff(woven, { path: 'x.ts', headers: false, fold: { unfolded: new Set(), lang: 'en' } })
  assert.deepEqual(foldsIn(folded), [
    [1, 11],
    [21, 12],
  ], 'lines 1-11 and 19-30 hide; three lines of context stay on each side of the change')
  assert.doesNotMatch(folded, /class="line ctx" data-line="1"/)
  assert.match(folded, /class="line ctx" data-line="12" data-side="new"[^>]*><span class="ln old">12<\/span><span class="ln">12<\/span>/, 'the numbering continues through a fold')
  assert.match(folded, /class="line del" data-line="15" data-side="old"/)
  assert.match(folded, /class="line add" data-line="16" data-side="new"/)
  assert.match(folded, /class="line ctx" data-line="19" data-side="new"[^>]*><span class="ln old">18<\/span><span class="ln">19<\/span>/, 'after the change the two sides differ by one')
  assert.doesNotMatch(folded, /class="line hunk"/)

  const opened = renderDiff(woven, { path: 'x.ts', headers: false, fold: { unfolded: new Set([1]), lang: 'en' } })
  assert.deepEqual(foldsIn(opened), [[21, 12]])
  assert.match(opened, /class="line ctx" data-line="1" data-side="new"/)

  const commented = renderDiff(woven, { path: 'x.ts', headers: false, commented: new Set([5]), fold: { unfolded: new Set(), lang: 'en' } })
  assert.deepEqual(foldsIn(commented), [
    [9, 3],
    [21, 12],
  ], 'a commented line never hides and keeps its context; the stretch above it is too short to fold')
  assert.match(commented, /class="line ctx commented" data-line="5" data-side="new"/)

  assert.deepEqual(foldsIn(renderDiff(weaveDiff(file, ''), { path: 'x.ts', headers: false, fold: { unfolded: new Set(), lang: 'en' } })), [[1, 30]])
  assert.match(renderDiff(woven, { path: 'x.ts', headers: false, fold: { unfolded: new Set(), lang: 'uk' } }), /⋯ рядків без змін: 11/)

  const big = Array.from({ length: 3100 }, (_, index) => `l${index + 1}`).join('\n')
  const tail = weaveDiff(big, ['@@ -3099,2 +3099,2 @@', ' l3099', '-l3100', '+l3100x'].join('\n'))
  assert.match(renderDiff(tail, { path: 'x.ts', headers: false }), /more lines not shown/, 'the plain view is cut')
  const bigFolded = renderDiff(tail, { path: 'x.ts', headers: false, fold: { unfolded: new Set(), lang: 'en' } })
  assert.doesNotMatch(bigFolded, /more lines not shown/)
  assert.match(bigFolded, /class="line add" data-line="3100"/, 'the folded view keeps a change past the cap')
})

test('codeview: a stub row names its symbol, and stubbedSymbols says which bodies have a place in the view', () => {
  const symbol = { name: 'f', signature: 'export function f(): void {' }
  const other = { name: 'g', signature: 'function g()' }
  const diff = ['@@ -1,2 +1,4 @@', ' import x', '+export function f(): void {', '+  // implementation: expand in Plan Crutches', '+}', ' tail'].join('\n')
  const inline = { path: 'x.ts', symbols: [symbol], bodies: {}, expanded: new Set(), lang: 'en', commentedFor: () => new Set() }
  assert.match(renderDiff(diff, { path: 'x.ts', inline }), /class="line add" data-line="2" data-side="new" data-stub="f"><span class="ln old">/)
  assert.equal((renderDiff(diff, { path: 'x.ts', inline }).match(/data-stub=/g) || []).length, 1)
  assert.match(renderSource('export function f(): void {\n  // implementation: expand in Plan Crutches\n}', { path: 'x.ts', inline }), /class="line" data-line="1" data-stub="f">/)
  assert.doesNotMatch(renderDiff(diff, { path: 'x.ts' }), /data-stub=/, 'without inline there is no stub to scroll to')
  assert.deepEqual([...stubbedSymbols({ format: 'diff', text: diff }, [symbol, other])], ['f'])
  assert.deepEqual([...stubbedSymbols({ format: 'source', text: 'function g()\n// implementation: expand in Plan Crutches', startLine: 1 }, [symbol, other])], ['g'])
  assert.deepEqual([...stubbedSymbols(undefined, [symbol])], [])
})
