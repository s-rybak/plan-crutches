import type { FileStatus, PlanFile, PlanModel, PlanSymbol, PlanTask, SymbolKind } from '../types'

export type ParseResult =
  | { ok: true; plan: PlanModel; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] }

const BLOCK_OPEN = /^[ \t]*```+[ \t]*(?:json[ \t]+)?plan-crutches[^\n]*$/

/**
 * Finds the last fenced block whose info string names plan-crutches and
 * returns its inner text, or null when the markdown holds none.
 */
export function findBlock(markdown: string): string | null {
  const lines = markdown.split('\n')
  let found: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!BLOCK_OPEN.test(line)) continue
    const fence = (line.match(/```+/) ?? ['```'])[0]
    const body: string[] = []
    let closed = false
    for (let j = i + 1; j < lines.length; j++) {
      const inner = lines[j] ?? ''
      if (inner.trim().startsWith(fence) && inner.trim().replace(/`/g, '').trim() === '') {
        closed = true
        i = j
        break
      }
      body.push(inner)
    }
    if (closed) found = body.join('\n')
  }
  return found
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

function normalizeSymbol(raw: unknown, warnings: string[], path: string): PlanSymbol | null {
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
  const symbolsRaw = Array.isArray(record.symbols) ? record.symbols : []
  const symbols: PlanSymbol[] = []
  for (const item of symbolsRaw) {
    const symbol = normalizeSymbol(item, warnings, path)
    if (symbol) symbols.push(symbol)
  }
  return {
    path,
    status: normalizeStatus(record.status, warnings, path),
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

/** Pulls the first JSON object out of a model reply that may wrap it in a fence. */
export function extractJson(reply: string): unknown {
  const fenced = reply.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  const candidate = fenced?.[1] ?? reply
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in the reply')
  return parseJsonLenient(candidate.slice(start, end + 1))
}
