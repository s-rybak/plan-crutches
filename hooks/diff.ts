// The diffs the page draws for a planned file: a new symbol adds its stub at
// its anchor, a modified symbol replaces the code it has today with the stub,
// a deleted symbol removes that code. Pure, and free of imports other than
// types, so scripts/demo-state.mjs can load it under plain node.
import type { PlanFile, PlanSymbol, SymbolChange } from '../types'

const CONTEXT = 2
const MAX_DELETED_LINES = 200

/** The line-comment opener for a file, by its extension. */
export function commentPrefix(path: string): string {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'pl', 'r', 'dockerfile', 'makefile', 'env'].includes(ext)) return '#'
  if (['sql', 'lua', 'hs'].includes(ext)) return '--'
  if (['html', 'htm', 'xml', 'vue', 'svelte', 'md'].includes(ext)) return '<!--'
  if (['lisp', 'clj', 'el'].includes(ext)) return ';;'
  return '//'
}

function commentLine(path: string, text: string): string {
  const prefix = commentPrefix(path)
  if (prefix === '<!--') return `<!-- ${text} -->`
  return `${prefix} ${text}`
}

/** What the plan does to a symbol; a symbol without the field is new. */
export const changeOf = (symbol: Pick<PlanSymbol, 'change'>): SymbolChange => symbol.change ?? 'new'

/** The lines a symbol adds to its file: a comment, the signature, a todo. */
export function stubLines(file: PlanFile, symbol: PlanSymbol): string[] {
  const lines: string[] = []
  if (symbol.description) {
    for (const part of symbol.description.split('\n')) lines.push(commentLine(file.path, part.trim()))
  }
  for (const part of symbol.signature.split('\n')) lines.push(part)
  const last = symbol.signature.trimEnd()
  if (last.endsWith('{')) {
    lines.push('  ' + commentLine(file.path, 'implementation: expand in Plan Crutches'))
    lines.push('}')
  } else if (last.endsWith(':')) {
    lines.push('    ' + commentLine(file.path, 'implementation: expand in Plan Crutches'))
  } else {
    lines.push(commentLine(file.path, 'implementation: expand in Plan Crutches'))
  }
  return lines
}

/** A new file's preview: every symbol's stub, blank lines between. */
export function newFileStub(file: PlanFile): string {
  const blocks: string[] = []
  if (file.description) blocks.push(commentLine(file.path, file.description))
  for (const symbol of file.symbols) blocks.push(stubLines(file, symbol).join('\n'))
  return blocks.join('\n\n')
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function identifierIn(anchor: string, keyword: 'after' | 'before'): string | null {
  const match = anchor.match(new RegExp(`\\b${keyword}\\b\\s+([A-Za-z_$][\\w$.]*)`, 'i'))
  return match?.[1] ?? null
}

/** The end (exclusive) of the indented block that starts at `start`, by indentation alone. */
function blockEnd(lines: readonly string[], start: number): number {
  const indent = indentOf(lines[start] ?? '')
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    if (indentOf(line) > indent) continue
    const trimmed = line.trim()
    if (trimmed.startsWith('}') || trimmed.startsWith(')') || trimmed.startsWith(']') || /^end\b/.test(trimmed)) return i + 1
    return i
  }
  return lines.length
}

function lastImportEnd(lines: readonly string[]): number {
  let end = 0
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (/^(import\b|from\b.*\bimport\b|require\(|using\b|#include\b|package\b)/.test(trimmed)) end = i + 1
    else if (trimmed !== '' && end > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('#')) break
  }
  return end
}

/** Where a symbol's lines go in the old file, from its anchor text. */
export function insertionIndex(lines: readonly string[], symbol: PlanSymbol): number {
  const anchor = (symbol.anchor ?? '').trim()
  if (!anchor) return lines.length
  const lower = anchor.toLowerCase()
  if (/\b(top|start|beginning)\b/.test(lower)) return lastImportEnd(lines)
  if (/\b(end|bottom)\b/.test(lower)) return lines.length
  const after = identifierIn(anchor, 'after')
  const before = identifierIn(anchor, 'before')
  const target = after ?? before
  if (!target) return lines.length
  const index = lines.findIndex(line => line.includes(target))
  if (index < 0) return lines.length
  return after ? blockEnd(lines, index) : index
}

// ---- finding the code a symbol has today -----------------------------------

const MODIFIERS =
  '(?:(?:export|default|public|private|protected|internal|static|async|override|readonly|abstract|final|virtual|get|set|synchronized|pub(?:\\([^)]*\\))?|unsafe|suspend|inline|operator|open|declare|extern|constexpr)\\s+)*'
const KEYWORDS = '(?:function\\*?|class|interface|enum|struct|trait|type|const|let|var|val|def|fn|func(?:\\s*\\([^)]*\\))?|fun|module|record|protocol|impl|macro|object|data\\s+class|sealed\\s+class)'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * How surely a line declares the symbol `name`: 3 for a keyword form
 * (`function name`, `def name`, `class name`, `const name`), 2 for a method
 * or property form that opens a body or an assignment, 1 for a bare
 * `name(` at the start of the line, 0 when the line does not declare it.
 */
export function declarationScore(line: string, name: string): number {
  const text = line.trim()
  if (!text || /^(\/\/|#(?!\[)|\*|\/\*|\*\/)/.test(text)) return 0
  const escaped = escapeRegExp(name)
  if (new RegExp(`(^|\\s)${KEYWORDS}\\s+(?:<[^>]*>\\s*)?${escaped}\\b`).test(text)) return 3
  const member = new RegExp(`^${MODIFIERS}\\*?\\s*${escaped}\\s*(?:<[^>]*>)?\\s*(\\(|=|:)`).exec(text)
  if (member) {
    if (/[{:]\s*$|=>\s*\{?\s*$|=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(text) || member[1] === '=') return 2
    if (member[1] === ':' && !/^[A-Za-z_$][\w$]*\s*:\s*(string|number|boolean|any|unknown|void|[A-Z])/.test(text)) return 2
    return member[1] === '(' && /\)\s*(?::\s*[^;]+)?$/.test(text) && !text.endsWith(';') ? 1 : 0
  }
  if (new RegExp(`^${MODIFIERS}[\\w<>\\[\\],.?*&:]+\\s+\\*?${escaped}\\s*\\(`).test(text) && !/^(return|new|await|yield|throw|case|else|typeof|delete)\b/.test(text)) return 2
  return 0
}

/**
 * The text of a line with its string literals emptied and its line comment
 * cut (by the file's comment opener), so braces inside them do not count.
 */
function stripLiterals(line: string, prefix: string): string {
  let out = ''
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? ''
    if (quote) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (prefix !== '<!--' && line.startsWith(prefix, i)) break
    out += ch
  }
  return out
}

function nextNonBlank(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i++) if ((lines[i] ?? '').trim() !== '') return i
  return -1
}

/**
 * The end (exclusive) of the symbol declared at `start`: the close of its
 * brace block, the end of its indented block (Python, Ruby), or the end of
 * its statement when it has no body.
 */
function symbolEnd(lines: readonly string[], start: number, prefix: string): number {
  let depth = 0
  let braces = 0
  let sawBrace = false
  const baseIndent = indentOf(lines[start] ?? '')
  for (let i = start; i < lines.length; i++) {
    const text = stripLiterals(lines[i] ?? '', prefix)
    for (const ch of text) {
      if (ch === '(' || ch === '[') depth += 1
      else if (ch === ')' || ch === ']') depth -= 1
      else if (ch === '{') {
        braces += 1
        sawBrace = true
      } else if (ch === '}') braces -= 1
    }
    if (depth > 0 || braces > 0) continue
    if (sawBrace) return i + 1
    const trimmed = text.trim()
    if (trimmed.endsWith(':')) return blockEnd(lines, start)
    if (/([,=+\-*/|&?.([{]|=>|\b(?:and|or|not|then|do))$/.test(trimmed)) continue
    const next = nextNonBlank(lines, i + 1)
    if (next !== -1 && indentOf(lines[next] ?? '') > baseIndent && !/^[)}\]]/.test((lines[next] ?? '').trim())) return blockEnd(lines, start)
    return i + 1
  }
  return lines.length
}

/** The first line of the comment, doc block or decorators attached right above a declaration. */
function attachedAbove(lines: readonly string[], start: number): number {
  let index = start
  while (index > 0) {
    const previous = (lines[index - 1] ?? '').trim()
    if (previous === '') break
    if (/^(\/\/|#|\*|\/\*|@|\[|'''|""")/.test(previous) || /\*\/$/.test(previous)) index -= 1
    else break
  }
  return index
}

export type LineRange = { start: number; end: number }

/**
 * The lines a symbol occupies in the file today, with its attached comment
 * or decorators: the surest declaration of its name, the outermost when
 * several tie. Null when no line declares it.
 */
export function symbolRange(lines: readonly string[], name: string, path = ''): LineRange | null {
  const needle = name.split('.').pop() || name
  let best: { index: number; score: number; indent: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const score = declarationScore(lines[i] ?? '', needle)
    if (!score) continue
    const indent = indentOf(lines[i] ?? '')
    if (!best || score > best.score || (score === best.score && indent < best.indent)) best = { index: i, score, indent }
  }
  if (!best) return null
  let end = symbolEnd(lines, best.index, commentPrefix(path))
  while (end > best.index + 1 && (lines[end - 1] ?? '').trim() === '') end -= 1
  return { start: attachedAbove(lines, best.index), end }
}

/** The code a symbol has today, or null when the file does not declare it. */
export function currentSymbolText(fileText: string, name: string, path = ''): string | null {
  const lines = splitFile(fileText)
  const range = symbolRange(lines, name, path)
  return range ? lines.slice(range.start, range.end).join('\n') : null
}

// ---- the unified diff ------------------------------------------------------

/** One change of the old file: the lines `[start, end)` go, `lines` come in their place. */
export type Edit = { start: number; end: number; lines: string[] }

function splitFile(fileText: string): string[] {
  const lines = fileText.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The edits sorted by place, overlapping removals merged into one. */
export function normalizeEdits(edits: readonly Edit[]): Edit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Edit[] = []
  for (const edit of sorted) {
    const last = out[out.length - 1]
    if (last && edit.start < last.end) {
      last.end = Math.max(last.end, edit.end)
      last.lines = [...last.lines, ...edit.lines]
    } else {
      out.push({ start: edit.start, end: edit.end, lines: [...edit.lines] })
    }
  }
  return out
}

/**
 * What every planned symbol does to the old file: a new symbol inserts its
 * stub at its anchor, a modified one replaces its current code with the
 * stub, a deleted one removes its current code. A symbol the file does not
 * hold is inserted (modified) or noted (deleted).
 */
export function symbolEdits(old: readonly string[], file: PlanFile): Edit[] {
  const edits: Edit[] = []
  for (const symbol of file.symbols) {
    const change = changeOf(symbol)
    const range = change === 'new' ? null : symbolRange(old, symbol.name, file.path)
    if (change === 'deleted') {
      if (range) edits.push({ start: range.start, end: range.end, lines: [] })
      else edits.push({ start: old.length, end: old.length, lines: [commentLine(file.path, `delete ${symbol.name}: not found in the current file`)] })
      continue
    }
    if (range) {
      edits.push({ start: range.start, end: range.end, lines: stubLines(file, symbol) })
      continue
    }
    const at = insertionIndex(old, symbol)
    edits.push({ start: at, end: at, lines: stubLines(file, symbol) })
  }
  if (edits.length === 0) edits.push({ start: old.length, end: old.length, lines: [commentLine(file.path, file.description || 'modified')] })
  return normalizeEdits(edits)
}

/** A unified diff of the edits against the old lines, `context` lines around each. */
export function unifiedDiff(old: readonly string[], edits: readonly Edit[], context = CONTEXT): string {
  if (edits.length === 0) return ''
  type Hunk = { start: number; end: number; edits: Edit[] }
  const hunks: Hunk[] = []
  for (const edit of edits) {
    const start = Math.max(0, edit.start - context)
    const end = Math.min(old.length, edit.end + context)
    const last = hunks[hunks.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
      last.edits.push(edit)
    } else {
      hunks.push({ start, end, edits: [edit] })
    }
  }
  const out: string[] = []
  let offset = 0
  for (const hunk of hunks) {
    const body: string[] = []
    let cursor = hunk.start
    let removed = 0
    let added = 0
    for (const edit of hunk.edits) {
      for (; cursor < edit.start; cursor++) body.push(` ${old[cursor] ?? ''}`)
      for (; cursor < edit.end; cursor++) {
        body.push(`-${old[cursor] ?? ''}`)
        removed += 1
      }
      for (const line of edit.lines) {
        body.push(`+${line}`)
        added += 1
      }
    }
    for (; cursor < hunk.end; cursor++) body.push(` ${old[cursor] ?? ''}`)
    const oldCount = hunk.end - hunk.start
    const newCount = oldCount - removed + added
    const oldStart = oldCount === 0 ? hunk.start : hunk.start + 1
    const newStart = (newCount === 0 ? hunk.start : hunk.start + 1) + offset
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    out.push(...body)
    offset += added - removed
  }
  return out.join('\n')
}

/**
 * The unified diff of a modified file: new symbols added at their anchors,
 * modified symbols replaced by their stubs, deleted symbols removed. What
 * the page draws for a modified file, with the current code as `-` lines.
 */
export function stubDiff(fileText: string, file: PlanFile): string {
  const old = splitFile(fileText)
  return unifiedDiff(old, symbolEdits(old, file))
}

/** A unified diff that removes the whole file, cut to a readable length. */
export function deletedDiff(fileText: string): string {
  const old = splitFile(fileText)
  const shown = old.slice(0, MAX_DELETED_LINES)
  const out = [`@@ -1,${shown.length} +0,0 @@`, ...shown.map(line => `-${line}`)]
  if (old.length > shown.length) out.push(`-... ${old.length - shown.length} more lines`)
  return out.join('\n')
}

/** The code inside the first fenced block of a model reply, else the reply. */
export function codeFromReply(reply: string): string {
  const fenced = reply.match(/```[^\n]*\n([\s\S]*?)\n```/)
  return (fenced?.[1] ?? reply).trim()
}
