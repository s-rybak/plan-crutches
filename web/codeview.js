// Code blocks: a source listing and a unified diff, each line numbered and
// carrying data-line so a mouse selection maps back to line numbers. With
// `inline`, a planned symbol's stub gets a Show implementation button and the
// generated code takes the stub's place in the block: for a modified symbol
// the lines of its current code stay above it as `-` lines, so the block
// reads like a git diff.
import { escapeHtml } from './markdown.js'
import { highlight } from './highlight.js'
import { t } from './i18n.js'

const MAX_LINES = 3000
const PLACEHOLDER = 'implementation: expand in Plan Crutches'

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
      `<div class="${classes.join(' ')}" data-line="${number}"><span class="ln">${number}</span><span class="src">${marked[index] ?? ''}</span>${region ? actionsFor(inline, region.symbol) : ''}</div>`,
    )
  }
  return `<div class="code source${commented.size ? ' marked' : ''}">${rows.join('')}${note ? `<div class="cap">${escapeHtml(note)}</div>` : ''}</div>`
}

export function renderDiff(diff, { path = '', commented = new Set(), inline = null, headers = true } = {}) {
  const { lines, note } = cap(splitLines(diff))
  const texts = lines.map(raw => (raw[0] === '+' ? raw.slice(1) : null))
  const regions = inline ? findStubRegions(texts, inline.symbols) : new Map()
  let oldLine = 0
  let newLine = 0
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
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
      `<div class="${classes.join(' ')}" data-line="${line}" data-side="${kind === 'del' ? 'old' : 'new'}"><span class="ln old">${oldText}</span><span class="ln">${newText}</span><span class="sign">${sign === ' ' ? '' : sign}</span><span class="src">${highlight(body, path)}</span>${region ? actionsFor(inline, region.symbol) : ''}</div>`,
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
