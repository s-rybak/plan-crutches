import { describe, expect, test } from 'claude-code/testing'

import { DEMO_PLAN } from '../hooks/demo-plan'
import { currentSymbolText, declarationScore, insertionIndex, newFileStub, stubDiff, symbolRange, unifiedDiff } from '../hooks/diff'
import { applySummary, findBlock, normalizeChange, parsePlan, planFromMarkdown, stripBlocks } from '../hooks/plan-parser'
import { revisionPrompt } from '../hooks/prompts'
import { renderRecord } from '../hooks/record'
import { allDirKeys, buildTree, visibleRows } from '../hooks/tree'

describe('plan parser', () => {
  test('reads the plan-crutches block of the demo plan', async () => {
    const parsed = parsePlan(DEMO_PLAN)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.plan.title).toBe('Session refresh for the auth module')
    expect(parsed.plan.files.length).toBe(5)
    expect(parsed.plan.task.source).toBe('jira')
    expect(parsed.plan.task.key).toBe('AUTH-42')
    const session = parsed.plan.files.find(file => file.path === 'src/auth/session.ts')
    expect(session?.status).toBe('new')
    expect(session?.symbols.map(symbol => symbol.name)).toEqual(['Session', 'refreshSession', 'isExpiringSoon'])
  })

  test('tolerates trailing commas and odd statuses, and warns', async () => {
    const markdown = [
      '# Title',
      '',
      'Body.',
      '',
      '```plan-crutches',
      '{ "files": [ { "path": "./a/b.ts", "status": "added", "symbols": [ { "signature": "function go(): void {" }, ] }, ] }',
      '```',
    ].join('\n')
    const parsed = parsePlan(markdown)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.plan.title).toBe('Title')
    expect(parsed.plan.summary).toBe('# Title\n\nBody.')
    expect(parsed.plan.files[0]?.path).toBe('a/b.ts')
    expect(parsed.plan.files[0]?.status).toBe('new')
    expect(parsed.plan.files[0]?.symbols[0]?.name).toBe('go')
  })

  test('reads what the plan does to each symbol: new by default, modified or deleted when said or implied', async () => {
    const parsed = parsePlan(DEMO_PLAN)
    if (!parsed.ok) throw new Error(parsed.reason)
    const user = parsed.plan.files.find(file => file.path === 'src/auth/user.ts')
    expect(user?.symbols.map(symbol => [symbol.name, symbol.change])).toEqual([
      ['getCurrentUser', 'modified'],
      ['displayNameOf', 'deleted'],
    ])
    const session = parsed.plan.files.find(file => file.path === 'src/auth/session.ts')
    expect(session?.symbols.every(symbol => symbol.change === undefined)).toBe(true)
    expect(normalizeChange({ change: 'Modified' }, 'modified')).toBe('modified')
    expect(normalizeChange({ status: 'removed' }, 'modified')).toBe('deleted')
    expect(normalizeChange({ op: 'add' }, 'modified')).toBe('new')
    expect(normalizeChange({ anchor: 'replaces loadUser' }, 'modified')).toBe('modified')
    expect(normalizeChange({ anchor: 'remove it' }, 'modified')).toBe('deleted')
    expect(normalizeChange({ anchor: 'after loadUser' }, 'modified')).toBe('new')
    expect(normalizeChange({ change: 'deleted' }, 'new')).toBe('new')
  })

  test('puts an edited summary into the block, or above it, or in place of the whole file', async () => {
    const edited = applySummary(DEMO_PLAN, 'A new summary.\n\nWith two lines.')
    const parsed = parsePlan(edited)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.plan.summary).toBe('A new summary.\n\nWith two lines.')
    expect(parsed.plan.files.length).toBe(5)
    expect(parsed.plan.task.key).toBe('AUTH-42')
    expect(edited.startsWith('# Session refresh for the auth module')).toBe(true)
    const noSummary = ['# T', '', 'Old prose.', '', '```plan-crutches', '{ "files": [] }', '```'].join('\n')
    const above = applySummary(noSummary, '# T\n\nNew prose.')
    expect(above).toBe(['# T', '', 'New prose.', '', '```plan-crutches', '{ "files": [] }', '```'].join('\n'))
    const aboveParsed = parsePlan(above)
    expect(aboveParsed.ok && aboveParsed.plan.summary).toBe('# T\n\nNew prose.')
    expect(applySummary('Just prose.', 'Other prose.')).toBe('Other prose.\n')
  })

  test('reports a plan without a block and falls back to markdown', async () => {
    const markdown = '# Only prose\n\nNothing structured here.'
    expect(findBlock(markdown)).toBe(null)
    const parsed = parsePlan(markdown)
    expect(parsed.ok).toBe(false)
    const plan = planFromMarkdown(markdown)
    expect(plan.title).toBe('Only prose')
    expect(plan.files).toEqual([])
    expect(stripBlocks(DEMO_PLAN).includes('plan-crutches')).toBe(false)
  })
})

describe('tree', () => {
  test('groups files by folder, folders first, with folder status', async () => {
    const parsed = parsePlan(DEMO_PLAN)
    if (!parsed.ok) throw new Error('demo plan did not parse')
    const roots = buildTree(parsed.plan.files)
    expect(roots.map(node => node.name)).toEqual(['docs', 'src'])
    const src = roots[1]
    expect(src?.children.map(node => node.name)).toEqual(['api', 'auth', 'legacy'])
    const legacy = src?.children.find(node => node.name === 'legacy')
    expect(legacy?.status).toBe('deleted')
    const docs = roots[0]
    expect(docs?.status).toBe('new')
    expect(allDirKeys(roots)).toEqual(['dir:docs', 'dir:src', 'dir:src/api', 'dir:src/auth', 'dir:src/legacy'])
    const rows = visibleRows(roots, new Set(['dir:src']))
    expect(rows.map(node => node.path)).toEqual(['docs', 'docs/auth.md', 'src'])
  })
})

describe('stub diff', () => {
  const file = {
    path: 'src/auth/user.ts',
    status: 'modified' as const,
    description: 'Refresh before returning the user.',
    symbols: [
      {
        name: 'getCurrentUser',
        kind: 'function' as const,
        signature: 'export async function getCurrentUser(): Promise<User | null> {',
        description: 'Returns the current user.',
        anchor: 'after loadUser',
      },
    ],
  }
  const source = ['import { db } from "./db"', '', 'export function loadUser(id: string) {', '  return db.get(id)', '}', '', 'export const other = 1'].join('\n')

  test('places a symbol after the anchored block', async () => {
    expect(insertionIndex(source.split('\n'), file.symbols[0]!)).toBe(5)
    const diff = stubDiff(source, file)
    expect(diff.startsWith('@@ -4,4 +4,8 @@')).toBe(true)
    expect(diff).toContain('+export async function getCurrentUser(): Promise<User | null> {')
    expect(diff).toContain('+// Returns the current user.')
    expect(diff).toContain(' export const other = 1')
  })

  test('previews a new file from its signatures', async () => {
    const preview = newFileStub({ ...file, status: 'new', path: 'src/new.py' })
    expect(preview).toContain('# Refresh before returning the user.')
    expect(preview).toContain('export async function getCurrentUser')
  })

  const existing = [
    "import { db } from './db'",
    '',
    '/** Loads one user. */',
    'export async function loadUser(id: string): Promise<User | null> {',
    '  const row = await db.get(id)',
    '  if (!row) return null',
    '  return row as User',
    '}',
    '',
    'export const KEY = `k-${1}`',
    '',
    'export class Store {',
    '  private items = new Map<string, User>()',
    '',
    '  get(id: string): User | undefined {',
    '    return this.items.get(id)',
    '  }',
    '',
    '  clear(): void {',
    '    this.items.clear()',
    '  }',
    '}',
  ]

  test('finds the code a symbol has today: keyword forms, methods, one-line consts, Python blocks', async () => {
    expect(symbolRange(existing, 'loadUser', 'a.ts')).toEqual({ start: 2, end: 8 })
    expect(symbolRange(existing, 'KEY', 'a.ts')).toEqual({ start: 9, end: 10 })
    expect(symbolRange(existing, 'Store', 'a.ts')).toEqual({ start: 11, end: 22 })
    expect(symbolRange(existing, 'Store.clear', 'a.ts')).toEqual({ start: 18, end: 21 })
    expect(symbolRange(existing, 'get', 'a.ts')).toEqual({ start: 14, end: 17 })
    expect(symbolRange(existing, 'nothing', 'a.ts')).toBe(null)
    expect(declarationScore('  return loadUser(id)', 'loadUser')).toBe(0)
    expect(declarationScore('export function loadUser() {', 'loadUser')).toBe(3)
    expect(declarationScore('  loadUser(): void {', 'loadUser')).toBe(2)
    const python = ['import os', '', '@cache', 'def load(path):', '    with open(path) as f:', '        return f.read()', '', 'def other():', '    pass']
    expect(symbolRange(python, 'load', 'x.py')).toEqual({ start: 2, end: 6 })
    expect(currentSymbolText(python.join('\n'), 'other', 'x.py')).toBe('def other():\n    pass')
    expect(currentSymbolText(existing.join('\n'), 'KEY', 'a.ts')).toBe('export const KEY = `k-${1}`')
  })

  test('a modified symbol replaces its code and a deleted one removes it, as - and + lines', async () => {
    const changed = {
      path: 'src/store.ts',
      status: 'modified' as const,
      description: 'Rework the loader, drop the key.',
      symbols: [
        { name: 'loadUser', kind: 'function' as const, change: 'modified' as const, signature: 'export async function loadUser(id: string, fresh = false): Promise<User | null> {', description: 'Loads a user, bypassing the cache when fresh.' },
        { name: 'KEY', kind: 'const' as const, change: 'deleted' as const, signature: 'export const KEY', description: 'No longer used.' },
        { name: 'gone', kind: 'function' as const, change: 'deleted' as const, signature: 'function gone()', description: 'Not in the file.' },
        { name: 'added', kind: 'function' as const, signature: 'export function added(): void {', description: 'New.', anchor: 'end of file' },
      ],
    }
    const diff = stubDiff(existing.join('\n'), changed)
    const lines = diff.split('\n')
    expect(lines[0]).toBe('@@ -1,12 +1,9 @@')
    expect(lines.filter(line => line.startsWith('@@')).length).toBe(2)
    expect(diff).toContain('-/** Loads one user. */\n-export async function loadUser(id: string): Promise<User | null> {\n-  const row = await db.get(id)\n-  if (!row) return null\n-  return row as User\n-}\n')
    expect(diff).toContain('+// Loads a user, bypassing the cache when fresh.\n+export async function loadUser(id: string, fresh = false): Promise<User | null> {\n+  // implementation: expand in Plan Crutches\n+}')
    expect(diff).toContain('-export const KEY = `k-${1}`')
    expect(diff).not.toContain('+export const KEY')
    expect(diff).toContain('+// delete gone: not found in the current file')
    expect(diff).toContain('+export function added(): void {')
    expect(diff.indexOf('-export const KEY')).toBeGreaterThan(diff.indexOf('+export async function loadUser'))
    const only = unifiedDiff(['a', 'b', 'c', 'd', 'e', 'f'], [{ start: 1, end: 2, lines: ['B'] }, { start: 5, end: 6, lines: [] }], 1)
    expect(only).toBe(['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -5,2 +5,1 @@', ' e', '-f'].join('\n'))
  })
})

describe('prompts and record', () => {
  test('builds the revision prompt grouped by file and folder', async () => {
    const parsed = parsePlan(DEMO_PLAN)
    if (!parsed.ok) throw new Error('demo plan did not parse')
    const comments = [
      { id: '1', target: {}, text: 'Keep it smaller.', createdInVersion: 1 },
      { id: '2', target: { path: 'src/auth/' }, text: 'Rename the folder to sessions.', createdInVersion: 1 },
      { id: '3', target: { path: 'src/auth/session.ts', symbol: 'refreshSession' }, text: 'Return a Result type.', createdInVersion: 1 },
    ]
    const prompt = revisionPrompt(parsed.plan, comments, 1)
    expect(prompt).toContain('plan version 1')
    expect(prompt).toContain('Comments on the whole plan:\n- Keep it smaller.')
    expect(prompt).toContain('- src/auth/ (folder)')
    expect(prompt).toContain('[symbol refreshSession] Return a Result type.')
    const diagram = {
      status: 'ready' as const,
      version: 1,
      callers: {},
      graph: {
        files: [{ path: 'src/auth/session.ts', status: 'new' as const, symbols: [{ name: 'refreshSession', kind: 'function' as const }] }],
        edges: [{ from: { path: 'src/auth/user.ts', symbol: 'getCurrentUser' }, to: { path: 'src/auth/session.ts', symbol: 'refreshSession' }, kind: 'call' as const }],
      },
    }
    const record = renderRecord({
      plan: parsed.plan,
      review: { status: 'reviewing', version: 1, parsedFrom: 'block', warnings: [], history: ['v1 received'], previousPaths: [] },
      comments,
      diagram,
      nowMs: 0,
    })
    expect(record).toContain('## Diagram')
    expect(record).toContain('- src/auth/user.ts#getCurrentUser -> src/auth/session.ts#refreshSession')
    expect(record).toContain('# Session refresh for the auth module')
    expect(record).toContain('## Task')
    expect(record).toContain('AUTH-42')
    expect(record).toContain('- [deleted] src/legacy/tokens.ts')
    expect(record).toContain('### Version 1')
  })
})
