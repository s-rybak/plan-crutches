import type { FileStatus, PlanFile, PlanModel, PlanSymbol, PlanTask, SymbolChange, SymbolKind } from '../types'

export type ParseResult =
  | { ok: true; plan: PlanModel; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] }

const BLOCK_OPEN = /^[ \t]*```+[ \t]*(?:json[ \t]+)?plan-crutches[^\n]*$/

type BlockRange = { open: number; close: number }

/** The lines of the last closed plan-crutches block: its fence lines, or null. */
function findBlockRange(lines: readonly string[]): BlockRange | null {
  let found: BlockRange | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!BLOCK_OPEN.test(line)) continue
    const fence = (line.match(/```+/) ?? ['```'])[0]
    for (let j = i + 1; j < lines.length; j++) {
      const inner = lines[j] ?? ''
      if (inner.trim().startsWith(fence) && inner.trim().replace(/`/g, '').trim() === '') {
        found = { open: i, close: j }
        i = j
        break
      }
    }
  }
  return found
}

/**
 * Finds the last fenced block whose info string names plan-crutches and
 * returns its inner text, or null when the markdown holds none.
 */
export function findBlock(markdown: string): string | null {
  const lines = markdown.split('\n')
  const range = findBlockRange(lines)
  return range ? lines.slice(range.open + 1, range.close).join('\n') : null
}

/** Removes every plan-crutches block from the markdown. */
export function stripBlocks(markdown: string): string {
  const lines = markdown.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!BLOCK_OPEN.test(line)) {
      kept.push(line)
      continue
    }
    const fence = (line.match(/```+/) ?? ['```'])[0]
    let j = i + 1
    for (; j < lines.length; j++) {
      const inner = lines[j] ?? ''
      if (inner.trim().startsWith(fence) && inner.trim().replace(/`/g, '').trim() === '') break
    }
    i = j
  }
  return kept.join('\n').trim()
}

export function titleFromMarkdown(markdown: string): string {
  const heading = markdown.split('\n').find(line => /^#\s+\S/.test(line))
  if (heading) return heading.replace(/^#\s+/, '').trim()
  const first = markdown.split('\n').find(line => line.trim() !== '')
  return (first ?? 'Plan').trim().slice(0, 80)
}

function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const cleaned = text.replace(/,\s*([}\]])/g, '$1').replace(/^﻿/, '')
    return JSON.parse(cleaned)
  }
}

const STATUSES: readonly FileStatus[] = ['new', 'modified', 'deleted']
const KINDS: readonly SymbolKind[] = ['function', 'method', 'class', 'type', 'const', 'other']

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function normalizeStatus(value: unknown, warnings: string[], path: string): FileStatus {
  const text = asString(value).toLowerCase().trim()
  if ((STATUSES as readonly string[]).includes(text)) return text as FileStatus
  if (text === 'added' || text === 'create' || text === 'created') return 'new'
  if (text === 'changed' || text === 'edit' || text === 'edited' || text === 'update' || text === 'updated') return 'modified'
  if (text === 'removed' || text === 'delete') return 'deleted'
  warnings.push(`${path}: unknown status "${text}", treated as modified`)
  return 'modified'
}

function normalizeKind(value: unknown): SymbolKind {
  const text = asString(value).toLowerCase().trim()
  if ((KINDS as readonly string[]).includes(text)) return text as SymbolKind
  if (text === 'fn' || text === 'func') return 'function'
  if (text === 'interface' || text === 'enum' || text === 'struct') return 'type'
  if (text === 'variable' || text === 'var' || text === 'let') return 'const'
  return 'other'
}

/**
 * What the plan does to a symbol, from its `change` field (or the older
 * spellings `status`, `op`, `action`), else from the anchor's wording. A
 * symbol of a new file is always new.
 */
export function normalizeChange(record: Record<string, unknown>, fileStatus: FileStatus): SymbolChange {
  if (fileStatus === 'new') return 'new'
  const raw = [record.change, record.status, record.op, record.operation, record.action].map(value => asString(value).toLowerCase().trim()).find(Boolean) ?? ''
  if (['modified', 'modify', 'changed', 'change', 'update', 'updated', 'edit', 'edited', 'replace', 'replaced', 'rewrite', 'rewritten', 'rename', 'renamed', 'move', 'moved'].includes(raw)) return 'modified'
  if (['deleted', 'delete', 'removed', 'remove', 'drop', 'dropped'].includes(raw)) return 'deleted'
  if (['new', 'added', 'add', 'create', 'created'].includes(raw)) return 'new'
  const anchor = asString(record.anchor).toLowerCase()
  if (/\b(replace|replaces|replacing|modif\w*|rewrite|rewrites|change|changes|update|updates)\b/.test(anchor)) return 'modified'
  if (/\b(delete|deletes|remove|removes|drop|drops)\b/.test(anchor)) return 'deleted'
  return 'new'
}

/** The identifier a signature declares: the one before its `(`, else after a keyword. */
export function nameFromSignature(signature: string): string {
  const first = signature.split('\n')[0] ?? ''
  const call = first.match(/([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/)
  if (call?.[1] && !['function', 'def', 'fn', 'func', 'async', 'export', 'public', 'private', 'static', 'if', 'return'].includes(call[1])) return call[1]
  const declared = first.match(/\b(?:type|interface|class|const|let|var|def|fn|func|struct|enum|trait|module|val)\s+([A-Za-z_$][\w$]*)/)
  if (declared?.[1]) return declared[1]
  const tokens = first.replace(/[^A-Za-z0-9_$]+/g, ' ').trim().split(' ').filter(Boolean)
  return tokens[tokens.length - 1] ?? ''
}

function normalizeSymbol(raw: unknown, warnings: string[], path: string, fileStatus: FileStatus): PlanSymbol | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const signature = asString(record.signature).trim()
  const name = asString(record.name).trim() || nameFromSignature(signature)
  if (!name && !signature) {
    warnings.push(`${path}: a symbol without name and signature was dropped`)
    return null
  }
  const symbol: PlanSymbol = {
    name: name || signature,
    kind: normalizeKind(record.kind),
    signature: signature || name,
    description: asString(record.description).trim(),
  }
  const anchor = asString(record.anchor).trim()
  if (anchor) symbol.anchor = anchor
  const change = normalizeChange(record, fileStatus)
  if (change !== 'new') symbol.change = change
  return symbol
}

export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function normalizeFile(raw: unknown, warnings: string[]): PlanFile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const path = normalizePath(asString(record.path))
  if (!path) {
    warnings.push('a file without a path was dropped')
    return null
  }
  const status = normalizeStatus(record.status, warnings, path)
  const symbolsRaw = Array.isArray(record.symbols) ? record.symbols : []
  const symbols: PlanSymbol[] = []
  for (const item of symbolsRaw) {
    const symbol = normalizeSymbol(item, warnings, path, status)
    if (symbol) symbols.push(symbol)
  }
  return {
    path,
    status,
    description: asString(record.description).trim(),
    symbols,
  }
}

function normalizeTask(raw: unknown): PlanTask | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const text = asString(record.text).trim()
  if (!text) return null
  const sourceText = asString(record.source).toLowerCase()
  const task: PlanTask = { source: sourceText === 'jira' ? 'jira' : 'user', text }
  const key = asString(record.key).trim()
  const title = asString(record.title).trim()
  if (key) task.key = key
  if (title) task.title = title
  return task
}

/** Turns the raw JSON of a plan-crutches block into a PlanModel, or null. */
export function normalizePlan(raw: unknown, warnings: string[], markdownTitle: string): PlanModel | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const filesRaw = Array.isArray(record.files) ? record.files : []
  const files: PlanFile[] = []
  const seen = new Set<string>()
  for (const item of filesRaw) {
    const file = normalizeFile(item, warnings)
    if (!file) continue
    if (seen.has(file.path)) {
      warnings.push(`${file.path}: listed twice, the second entry was dropped`)
      continue
    }
    seen.add(file.path)
    files.push(file)
  }
  if (!Array.isArray(record.files)) warnings.push('the block has no files list')
  const task = normalizeTask(record.task) ?? { source: 'none', text: '' }
  return {
    title: asString(record.title).trim() || markdownTitle,
    summary: asString(record.summary).trim(),
    task,
    files,
  }
}

/** Parses a plan file: its plan-crutches block when it has one. */
export function parsePlan(markdown: string): ParseResult {
  const warnings: string[] = []
  const block = findBlock(markdown)
  if (block === null) return { ok: false, reason: 'no plan-crutches block', warnings }
  let raw: unknown
  try {
    raw = parseJsonLenient(block)
  } catch (error) {
    return { ok: false, reason: `the plan-crutches block is not valid JSON: ${String(error)}`, warnings }
  }
  const plan = normalizePlan(raw, warnings, titleFromMarkdown(markdown))
  if (!plan) return { ok: false, reason: 'the plan-crutches block is not an object', warnings }
  if (!plan.summary) plan.summary = stripBlocks(markdown)
  return { ok: true, plan, warnings }
}

/** A plan with no structure: the markdown stands as the summary. */
export function planFromMarkdown(markdown: string): PlanModel {
  return {
    title: titleFromMarkdown(markdown),
    summary: stripBlocks(markdown) || markdown.trim(),
    task: { source: 'none', text: '' },
    files: [],
  }
}

/**
 * The plan file with the summary the user edited put in: into the block's
 * `summary` field when the block carries one, else in place of the
 * markdown above the block, else as the whole file.
 */
export function applySummary(markdown: string, summary: string): string {
  const text = summary.replace(/\r\n?/g, '\n').trimEnd()
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const range = findBlockRange(lines)
  if (!range) return `${text}\n`
  let raw: unknown = null
  try {
    raw = parseJsonLenient(lines.slice(range.open + 1, range.close).join('\n'))
  } catch {
    raw = null
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    if (typeof record.summary === 'string' && record.summary.trim()) {
      const json = JSON.stringify({ ...record, summary: text }, null, 2).split('\n')
      return [...lines.slice(0, range.open + 1), ...json, ...lines.slice(range.close)].join('\n')
    }
  }
  return [text, '', ...lines.slice(range.open)].join('\n')
}

/** Pulls the first JSON object out of a model reply that may wrap it in a fence. */
export function extractJson(reply: string): unknown {
  const fenced = reply.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  const candidate = fenced?.[1] ?? reply
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in the reply')
  return parseJsonLenient(candidate.slice(start, end + 1))
}
