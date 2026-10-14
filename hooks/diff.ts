import type { PlanFile, PlanSymbol } from '../types'

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

type Insertion = { at: number; lines: string[] }

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function identifierIn(anchor: string, keyword: 'after' | 'before'): string | null {
  const match = anchor.match(new RegExp(`\\b${keyword}\\b\\s+([A-Za-z_$][\\w$.]*)`, 'i'))
  return match?.[1] ?? null
}

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

/**
 * A unified diff that adds every symbol's stub to the file at its anchor:
 * what Code format="diff" draws for a modified file.
 */
export function stubDiff(fileText: string, file: PlanFile): string {
  const old = fileText.replace(/\r\n/g, '\n').split('\n')
  if (old.length > 0 && old[old.length - 1] === '') old.pop()
  const insertions: Insertion[] = file.symbols
    .map(symbol => ({ at: insertionIndex(old, symbol), lines: stubLines(file, symbol) }))
    .sort((a, b) => a.at - b.at)
  if (insertions.length === 0) {
    const note = commentLine(file.path, file.description || 'modified')
    insertions.push({ at: old.length, lines: [note] })
  }

  type Hunk = { start: number; end: number; items: Insertion[] }
  const hunks: Hunk[] = []
  for (const item of insertions) {
    const start = Math.max(0, item.at - CONTEXT)
    const end = Math.min(old.length, item.at + CONTEXT)
    const last = hunks[hunks.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
      last.items.push(item)
    } else {
      hunks.push({ start, end, items: [item] })
    }
  }

  const out: string[] = []
  let offset = 0
  for (const hunk of hunks) {
    const added = hunk.items.reduce((sum, item) => sum + item.lines.length, 0)
    const oldCount = hunk.end - hunk.start
    const oldStart = oldCount === 0 ? hunk.start : hunk.start + 1
    const newStart = oldStart + offset
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${oldCount + added} @@`)
    for (let i = hunk.start; i <= hunk.end; i++) {
      for (const item of hunk.items) {
        if (item.at === i) for (const line of item.lines) out.push(`+${line}`)
      }
      if (i < hunk.end) out.push(` ${old[i] ?? ''}`)
    }
    offset += added
  }
  return out.join('\n')
}

/** A unified diff that removes the whole file, cut to a readable length. */
export function deletedDiff(fileText: string): string {
  const old = fileText.replace(/\r\n/g, '\n').split('\n')
  if (old.length > 0 && old[old.length - 1] === '') old.pop()
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
