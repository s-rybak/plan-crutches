import { describe, expect, test } from 'claude-code/testing'

import { DEMO_PLAN } from '../hooks/demo-plan'
import { insertionIndex, newFileStub, stubDiff } from '../hooks/diff'
import { findBlock, parsePlan, planFromMarkdown, stripBlocks } from '../hooks/plan-parser'
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
