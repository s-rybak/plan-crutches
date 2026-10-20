// Code blocks: a source listing and a unified diff, each line numbered and
// carrying data-line so a mouse selection maps back to line numbers. With
// `inline`, a planned symbol's stub gets a Show implementation button and the
// generated code takes the stub's place in the block: for a modified symbol
// the lines of its current code stay above it as `-` lines, so the block
// reads like a git diff. With `fold`, the unchanged stretches of a diff hide
// behind one row each, the way a code host folds a file down to its changes.
import { escapeHtml } from './markdown.js'
import { highlight } from './highlight.js'
import { t } from './i18n.js'

const MAX_LINES = 3000
const PLACEHOLDER = 'implementation: expand in Plan Crutches'
/** Unchanged lines kept on each side of a change when the rest is folded. */
export const FOLD_CONTEXT = 3
/** A stretch shorter than this stays open: a fold row would save nothing. */
const MIN_FOLD = 3

function cap(lines) {
  if (lines.length <= MAX_LINES) return { lines, note: '' }
  return { lines: lines.slice(0, MAX_LINES), note: `… ${lines.length - MAX_LINES} more lines not shown` }
}

export function splitLines(text) {
  const all = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  if (all.length > 1 && all[all.length - 1] === '') all.pop()
  return all
}

/**
 * Finds each symbol's stub in `texts` (the code of every line, already
 * stripped of a diff sign; null where a line cannot hold a stub) and returns
 * a map from the stub's first line index to { symbol, end } (end exclusive).
 */
export function findStubRegions(texts, symbols) {
  const regions = new Map()
  const taken = new Set()
  for (const symbol of symbols || []) {
    const signature = symbol.signature.split('\n').map(part => part.trim()).filter(Boolean)
    if (!signature.length) continue
    for (let index = 0; index < texts.length; index += 1) {
      if (taken.has(index) || texts[index] === null) continue
      if (texts[index].trim() !== signature[0]) continue
      let matched = true
      for (let offset = 1; offset < signature.length; offset += 1) {
        const text = texts[index + offset]
        if (text === null || text === undefined || text.trim() !== signature[offset]) {
          matched = false
          break
        }
      }
      if (!matched) continue
      let end = index + signature.length
      const placeholder = texts[end]
      if (placeholder !== null && placeholder !== undefined && placeholder.includes(PLACEHOLDER)) {
        end += 1
        if (symbol.signature.trimEnd().endsWith('{') && texts[end] !== null && texts[end] !== undefined && texts[end].trim() === '}') end += 1
      }
      for (let cursor = index; cursor < end; cursor += 1) taken.add(cursor)
      regions.set(index, { symbol, end })
      break
    }
  }
  return regions
}

/**
 * The `-` lines right above a symbol's stub in a unified diff: the code the
 * symbol has today when the plan modifies it. Empty when the diff holds none.
 */
export function oldLinesBefore(diffText, symbol) {
  const lines = splitLines(diffText)
  const texts = lines.map(raw => (raw[0] === '+' ? raw.slice(1) : null))
  const regions = findStubRegions(texts, [symbol])
  const start = [...regions.keys()][0]
  if (start === undefined) return []
  let index = start - 1
  // The stub's own comment lines (the symbol's description) sit between the old code and the signature.
  while (index >= 0 && lines[index][0] === '+' && /^\s*(\/\/|#|--|<!--|;;|\*)/.test(lines[index].slice(1))) index -= 1
  const old = []
  for (; index >= 0 && lines[index][0] === '-'; index -= 1) old.unshift(lines[index].slice(1))
  return old
}

function actionsFor(inline, symbol) {
  const { path, bodies, expanded, lang } = inline
  const key = `${path}#${symbol.name}`
  const body = bodies[key]
  const data = `data-path="${escapeHtml(path)}" data-symbol="${escapeHtml(symbol.name)}"`
  let inner
  if (expanded.has(key)) {
    if (!body || body.status === 'loading') inner = `<span class="spinner"></span><span>${t(lang, 'generating')}</span><button class="btn small ghost" data-action="inline-collapse" ${data}>${t(lang, 'hideImpl')}</button>`
    else if (body.status === 'failed') inner = `<span class="error">${t(lang, 'generationFailed')}</span><button class="btn small" data-action="inline-regen" ${data}>${t(lang, 'retry')}</button><button class="btn small ghost" data-action="inline-collapse" ${data}>${t(lang, 'hideImpl')}</button>`
    else inner = `<button class="btn small ghost" data-action="inline-collapse" ${data}>${t(lang, 'hideImpl')}</button><button class="btn small ghost" data-action="inline-regen" ${data}>${t(lang, 'regenerate')}</button>`
  } else {
    inner = `<button class="btn small" data-action="inline-expand" ${data}>${t(lang, 'showImpl')}</button>`
  }
  return `<span class="line-actions">${inner}</span>`
}

function readyBody(inline, symbol) {
  const key = `${inline.path}#${symbol.name}`
  const body = inline.bodies[key]
  return inline.expanded.has(key) && body && body.status === 'ready' ? body.code || '' : null
}

function renderBodyBlock(inline, symbol, code, { diff }) {
  const lines = splitLines(code)
  const marked = highlight(lines.join('\n'), inline.path).split('\n')
  const commented = inline.commentedFor ? inline.commentedFor(symbol.name) : new Set()
  const rows = lines.map((_, index) => {
    const number = index + 1
    const classes = ['line', 'gen']
    if (diff) classes.push('add')
    if (commented.has(number)) classes.push('commented')
    const numbers = diff ? `<span class="ln old"></span><span class="ln">${number}</span><span class="sign">+</span>` : `<span class="ln">${number}</span>`
    return `<div class="${classes.join(' ')}" data-line="${number}"><span class="ln-gen"></span>${numbers}<span class="src">${marked[index] ?? ''}</span>${index === 0 ? actionsFor(inline, symbol) : ''}</div>`
  })
  return `<div class="inline-body" data-selectable data-scope="code" data-path="${escapeHtml(inline.path)}" data-symbol="${escapeHtml(symbol.name)}">${rows.join('')}</div>`
}

export function renderSource(code, { path = '', startLine = 1, commented = new Set(), inline = null } = {}) {
  const { lines, note } = cap(splitLines(code))
  const marked = highlight(lines.join('\n'), path).split('\n')
  const regions = inline ? findStubRegions(lines, inline.symbols) : new Map()
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const region = regions.get(index)
    if (region) {
      const body = readyBody(inline, region.symbol)
      if (body !== null) {
        rows.push(renderBodyBlock(inline, region.symbol, body, { diff: false }))
        index = region.end - 1
        continue
      }
    }
    const number = startLine + index
    const classes = ['line']
    if (commented.has(number)) classes.push('commented')
    rows.push(
      `<div class="${classes.join(' ')}" data-line="${number}"${stubAttr(region)}><span class="ln">${number}</span><span class="src">${marked[index] ?? ''}</span>${region ? actionsFor(inline, region.symbol) : ''}</div>`,
    )
  }
  return `<div class="code source${commented.size ? ' marked' : ''}">${rows.join('')}${note ? `<div class="cap">${escapeHtml(note)}</div>` : ''}</div>`
}

/** The row that carries a stub's first line names its symbol, so the page can scroll to it. */
function stubAttr(region) {
  return region ? ` data-stub="${escapeHtml(region.symbol.name)}"` : ''
}

/** The names of the symbols whose stub a file view holds: the generated body of each has a place in it. */
export function stubbedSymbols(view, symbols) {
  if (!view || typeof view.text !== 'string') return new Set()
  const lines = splitLines(view.text)
  const texts = view.format === 'diff' ? lines.map(raw => (raw[0] === '+' ? raw.slice(1) : null)) : lines
  return new Set([...findStubRegions(texts, symbols).values()].map(region => region.symbol.name))
}

/**
 * The stretches of a diff that a folded view hides, as [start, end) line
 * indexes. `foldable[i]` says the line can hide (an unchanged line nobody
 * commented on), `anchor[i]` says it must stay and keeps `context` lines on
 * each side of it (a changed or commented line). A stretch that starts in
 * `unfolded` stays open, and so does one shorter than `minHidden` lines.
 */
export function foldRanges(foldable, anchor, { context = FOLD_CONTEXT, minHidden = MIN_FOLD, unfolded = new Set() } = {}) {
  const count = foldable.length
  const anchorBefore = new Array(count + 1).fill(false)
  for (let index = 0; index < count; index += 1) anchorBefore[index + 1] = anchorBefore[index] || Boolean(anchor[index])
  const anchorAfter = new Array(count + 1).fill(false)
  for (let index = count - 1; index >= 0; index -= 1) anchorAfter[index] = anchorAfter[index + 1] || Boolean(anchor[index])
  const ranges = []
  let index = 0
  while (index < count) {
    if (!foldable[index]) {
      index += 1
      continue
    }
    let end = index
    while (end < count && foldable[end]) end += 1
    const start = index + (anchorBefore[index] ? context : 0)
    const stop = end - (anchorAfter[end] ? context : 0)
    if (stop - start >= minHidden && !unfolded.has(start)) ranges.push({ start, end: stop })
    index = end
  }
  return ranges
}

/** The folds of a diff's lines, keyed by their first hidden index; a commented unchanged line never hides. */
function foldsOf(lines, commented, fold) {
  const foldable = []
  const anchor = []
  let newLine = 0
  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) newLine = Number(match[2])
      foldable.push(false)
      anchor.push(false)
      continue
    }
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      foldable.push(false)
      anchor.push(false)
      continue
    }
    if (raw[0] === '+') {
      foldable.push(false)
      anchor.push(true)
      newLine += 1
    } else if (raw[0] === '-') {
      foldable.push(false)
      anchor.push(true)
    } else {
      const kept = commented.has(newLine)
      foldable.push(!kept)
      anchor.push(kept)
      newLine += 1
    }
  }
  const folds = new Map()
  for (const range of foldRanges(foldable, anchor, fold)) folds.set(range.start, range)
  return folds
}

/**
 * `fold` is `{ unfolded, lang, context? }`: the diff's unchanged stretches
 * hide behind one row each, except those whose first index is in `unfolded`
 * (the user opened them). A folded diff is never cut at MAX_LINES: its
 * hidden lines cost no rows, and a cut could drop a change.
 */
export function renderDiff(diff, { path = '', commented = new Set(), inline = null, headers = true, fold = null } = {}) {
  const { lines, note } = fold ? { lines: splitLines(diff), note: '' } : cap(splitLines(diff))
  const texts = lines.map(raw => (raw[0] === '+' ? raw.slice(1) : null))
  const regions = inline ? findStubRegions(texts, inline.symbols) : new Map()
  const folds = fold ? foldsOf(lines, commented, fold) : new Map()
  let oldLine = 0
  let newLine = 0
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const hidden = folds.get(index)
    if (hidden) {
      // Only unchanged lines fold, so both sides of the numbering move on by the same count.
      const count = hidden.end - hidden.start
      rows.push(
        `<div class="line fold" data-action="unfold" data-path="${escapeHtml(path)}" data-fold="${hidden.start}" title="${escapeHtml(t(fold.lang, 'unfoldHint'))}">` +
          `<span class="ln old"></span><span class="ln"></span><span class="sign"></span><span class="src">${escapeHtml(t(fold.lang, 'foldedLines', { n: count }))}</span></div>`,
      )
      oldLine += count
      newLine += count
      index = hidden.end - 1
      continue
    }
    if (raw.startsWith('@@')) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      if (headers) rows.push(`<div class="line hunk"><span class="ln old"></span><span class="ln"></span><span class="sign"></span><span class="src">${escapeHtml(raw)}</span></div>`)
      continue
    }
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      rows.push(`<div class="line meta"><span class="ln old"></span><span class="ln"></span><span class="sign"></span><span class="src">${escapeHtml(raw)}</span></div>`)
      continue
    }
    const region = regions.get(index)
    if (region) {
      const body = readyBody(inline, region.symbol)
      if (body !== null) {
        rows.push(renderBodyBlock(inline, region.symbol, body, { diff: true }))
        newLine += region.end - index
        index = region.end - 1
        continue
      }
    }
    const sign = raw[0] === '+' || raw[0] === '-' || raw[0] === ' ' ? raw[0] : ' '
    const body = raw[0] === '+' || raw[0] === '-' || raw[0] === ' ' ? raw.slice(1) : raw
    let kind = 'ctx'
    let oldText = ''
    let newText = ''
    let line = 0
    if (sign === '+') {
      kind = 'add'
      newText = String(newLine)
      line = newLine
      newLine += 1
    } else if (sign === '-') {
      kind = 'del'
      oldText = String(oldLine)
      line = oldLine
      oldLine += 1
    } else {
      oldText = String(oldLine)
      newText = String(newLine)
      line = newLine
      oldLine += 1
      newLine += 1
    }
    const classes = ['line', kind]
    if (line && commented.has(line) && kind !== 'del') classes.push('commented')
    rows.push(
      `<div class="${classes.join(' ')}" data-line="${line}" data-side="${kind === 'del' ? 'old' : 'new'}"${stubAttr(region)}><span class="ln old">${oldText}</span><span class="ln">${newText}</span><span class="sign">${sign === ' ' ? '' : sign}</span><span class="src">${highlight(body, path)}</span>${region ? actionsFor(inline, region.symbol) : ''}</div>`,
    )
  }
  return `<div class="code diff${commented.size ? ' marked' : ''}">${rows.join('')}${note ? `<div class="cap">${escapeHtml(note)}</div>` : ''}</div>`
}

/**
 * A diff that replaces `oldLines` with `newCode`: what a modified symbol's
 * implementation looks like next to the code it replaces. The new lines are
 * numbered from 1, as the generated body is elsewhere, so comments on them
 * keep their line numbers.
 */
export function renderReplaceDiff(oldLines, newCode, { path = '', commented = new Set() } = {}) {
  const added = splitLines(newCode)
  const text = [`@@ -1,${oldLines.length} +1,${added.length} @@`, ...oldLines.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n')
  return renderDiff(text, { path, commented, headers: false })
}

/** A diff that removes `code` whole: what a deleted symbol looks like. */
export function renderDeletion(code, { path = '' } = {}) {
  const gone = splitLines(code)
  const text = [`@@ -1,${gone.length} +0,0 @@`, ...gone.map(line => `-${line}`)].join('\n')
  return renderDiff(text, { path, headers: false })
}

/**
 * The whole file with the diff's changes woven in: one unified diff whose
 * only hunk covers every line, so the page shows the file as it is with the
 * `-` and `+` lines of each change in their place. Each hunk of `diffText`
 * is placed where its header says and checked against the file; a hunk
 * whose old side does not match there is looked up by its old lines, and
 * when it is nowhere in the file the result is null (the file changed since
 * the diff was made, so the two cannot be shown as one).
 */
export function weaveDiff(fileText, diffText) {
  const file = splitLines(fileText)
  const hunks = parseHunks(diffText)
  if (!hunks) return null
  if (hunks.length === 0) return [`@@ -1,${file.length} +1,${file.length} @@`, ...file.map(line => ` ${line}`)].join('\n')
  const placed = []
  let cursor = 0
  for (const hunk of hunks) {
    let start = hunk.oldStart
    if (!matchesAt(file, hunk.oldLines, start) || start < cursor) {
      start = findOldLines(file, hunk.oldLines, cursor)
      if (start < 0) return null
    }
    placed.push({ start, end: start + hunk.oldLines.length, lines: hunk.lines })
    cursor = start + hunk.oldLines.length
  }
  const out = []
  let at = 0
  let added = 0
  let removed = 0
  for (const hunk of placed) {
    for (; at < hunk.start; at += 1) out.push(` ${file[at]}`)
    for (const line of hunk.lines) {
      out.push(line)
      if (line[0] === '+') added += 1
      else if (line[0] === '-') removed += 1
    }
    at = hunk.end
  }
  for (; at < file.length; at += 1) out.push(` ${file[at]}`)
  return [`@@ -1,${file.length} +1,${file.length - removed + added} @@`, ...out].join('\n')
}

/** The hunks of a unified diff: where each starts in the old file (0-based) and its lines; null when the text is no diff. */
function parseHunks(diffText) {
  const hunks = []
  let current = null
  for (const raw of splitLines(diffText)) {
    const header = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (header) {
      const oldCount = header[2] === undefined ? 1 : Number(header[2])
      // A hunk that only inserts says the line before the insertion; others say their first line, 1-based.
      current = { oldStart: oldCount === 0 ? Number(header[1]) : Number(header[1]) - 1, lines: [], oldLines: [] }
      hunks.push(current)
      continue
    }
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ')) continue
    if (!current) {
      if (raw.trim() === '') continue
      return null
    }
    const sign = raw[0] === '+' || raw[0] === '-' || raw[0] === ' ' ? raw[0] : ' '
    const line = sign === ' ' && raw[0] !== ' ' ? ` ${raw}` : raw
    current.lines.push(line)
    if (sign !== '+') current.oldLines.push(line.slice(1))
  }
  return hunks
}

function matchesAt(file, oldLines, start) {
  if (start < 0 || start + oldLines.length > file.length) return false
  for (let index = 0; index < oldLines.length; index += 1) if (file[start + index] !== oldLines[index]) return false
  return true
}

/** The first place at or after `from` where the file holds `oldLines`; -1 when it is nowhere. */
function findOldLines(file, oldLines, from) {
  if (oldLines.length === 0) return -1
  for (let start = from; start + oldLines.length <= file.length; start += 1) if (matchesAt(file, oldLines, start)) return start
  return -1
}

/** A deleted file as one diff that removes every line, for the Full file view. */
export function deletionOfFile(fileText) {
  const gone = splitLines(fileText)
  return [`@@ -1,${gone.length} +0,0 @@`, ...gone.map(line => `-${line}`)].join('\n')
}
