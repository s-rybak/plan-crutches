import { describe, expect, test } from 'claude-code/testing'

import type { QaItem } from '../types'
import { DEMO_PLAN } from '../hooks/demo-plan'
import { parsePlan } from '../hooks/plan-parser'
import { askMorePrompt, askPrompt, bodyPrompt, importCandidates, parseFileList, pickFilesPrompt, planSurface, relativeImports, threadText } from '../hooks/prompts'
import { renderRecord } from '../hooks/record'

function demoPlan() {
  const parsed = parsePlan(DEMO_PLAN)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.plan
}

const THREAD: QaItem = {
  id: 'q1',
  question: 'Why a cache?',
  answer: 'So parallel callers share one request.',
  status: 'done',
  target: { path: 'src/auth/session.ts', symbol: 'refreshSession', selection: 'const cache = new Map()', lines: [4, 4] },
  followups: [
    { id: 'f1', question: 'Per process only?', answer: 'Yes, Redis comes later.', status: 'done' },
    { id: 'f2', question: 'And TTL?', status: 'asking' },
  ],
}

describe('prompts', () => {
  test('the body prompt opens with the cached plan surface and carries generated code and project files', async () => {
    const plan = demoPlan()
    const file = plan.files.find(one => one.path === 'src/auth/user.ts')!
    const symbol = file.symbols[0]!
    const blocks = bodyPrompt({
      plan,
      file,
      symbol,
      fileText: 'import { readSession } from "./storage"\nexport async function getCurrentUser() {}\n',
      bodies: {
        'src/auth/session.ts#refreshSession': { status: 'ready', code: 'export async function refreshSession(userId: string): Promise<Session> { return go(userId) }' },
        'src/auth/session.ts#isExpiringSoon': { status: 'loading' },
        'src/auth/user.ts#getCurrentUser': { status: 'ready', code: 'old body of the symbol itself' },
      },
      related: [{ path: 'src/auth/storage.ts', text: 'export function readSession() {}', why: 'imported by src/auth/user.ts' }],
    })
    expect(blocks.length).toBe(2)
    expect(blocks[0]!.cache).toBe(true)
    expect(blocks[0]!.text).toContain('All planned files and symbols:')
    expect(blocks[0]!.text).toContain('export function isExpiringSoon(session: Session, now: number, marginMs = 60_000): boolean {')
    expect(blocks[0]!.text).toContain('src/legacy/tokens.ts (deleted)')
    const rest = blocks[1]!.text
    expect(rest).toContain('// src/auth/session.ts · refreshSession')
    expect(rest).not.toContain('old body of the symbol itself')
    expect(rest).not.toContain('isExpiringSoon(session: Session, now: number, marginMs = 60_000): boolean {\n')
    expect(rest).toContain('src/auth/storage.ts (imported by src/auth/user.ts)')
    expect(rest).toContain('Current content of src/auth/user.ts')
    expect(rest.indexOf('Implement this symbol')).toBeGreaterThan(rest.indexOf('Current content of src/auth/user.ts'))
    expect(planSurface(plan, 200).length).toBeLessThan(260)
  })

  test('file picking: the prompt lists the project and the reply is read as paths from that list', async () => {
    const plan = demoPlan()
    const file = plan.files[0]!
    const prompt = pickFilesPrompt(plan, file, file.symbols[1]!, null, ['src/a.ts', 'src/b.ts'], ['src/c.ts'])
    expect(prompt).toContain('Project files (2):\nsrc/a.ts\nsrc/b.ts')
    expect(prompt).toContain('Already provided, do not list again:\n- src/c.ts')
    const known = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(parseFileList('Sure: ["src/a.ts", "./src/b.ts", "src/a.ts", "nope.ts", 3]', known)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(parseFileList('no list here', known)).toEqual([])
    expect(parseFileList('[1,', known)).toEqual([])
    expect(parseFileList('["src/a.ts","src/b.ts","src/c.ts"]', known, 2)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('imports: relative specifiers are found and resolved to candidate paths', async () => {
    const text = "import { a } from './a'\nimport b from '../lib/b.js'\nconst c = require('./c')\nimport('./d')\nimport x from 'react'\nfrom .models import User\nfrom ..core.db import conn"
    expect(relativeImports(text).sort()).toEqual(['../lib/b.js', '..core.db', './a', './c', './d', '.models'].sort())
    expect(importCandidates('src/auth/user.ts', './storage')).toContain('src/auth/storage.ts')
    expect(importCandidates('src/auth/user.ts', '../api/client')).toContain('src/api/client.ts')
    expect(importCandidates('src/auth/user.ts', '../api/client')).toContain('src/api/client/index.ts')
    expect(importCandidates('src/auth/user.ts', '../lib/b.js')[0]).toBe('src/lib/b.js')
    expect(importCandidates('app/auth/views.py', '.models')).toEqual(['app/auth/models.py', 'app/auth/models/__init__.py'])
    expect(importCandidates('app/auth/views.py', '..core.db')).toEqual(['app/core/db.py', 'app/core/db/__init__.py'])
  })

  test('questions: the selection goes into the prompt, the follow-up carries the thread, the thread reads as a comment', async () => {
    const plan = demoPlan()
    const first = askPrompt(plan, 'Why a cache?', 'src/auth/session.ts', THREAD.target)
    expect(first).toContain('The user selected this text in src/auth/session.ts, symbol refreshSession, lines 4:')
    expect(first).toContain('const cache = new Map()')
    expect(first).not.toContain('The user is looking at')
    // The fork may run over a transcript without the plan, so the prompt carries it.
    expect(first).toContain('All planned files and symbols:')
    expect(first).toContain('- src/auth/session.ts (')
    expect(askPrompt(plan, 'Why?', 'src/auth/session.ts')).toContain('The user is looking at src/auth/session.ts')
    const more = askMorePrompt(plan, THREAD, 'What about eviction?')
    expect(more).toContain('User: Why a cache?\n\nAssistant: So parallel callers share one request.')
    expect(more).toContain('User: Per process only?\n\nAssistant: Yes, Redis comes later.')
    expect(more).not.toContain('And TTL?')
    expect(more).toContain('All planned files and symbols:')
    expect(more.endsWith('User: What about eviction?')).toBe(true)
    expect(threadText(THREAD)).toBe('Q: Why a cache?\nA: So parallel callers share one request.\nQ: Per process only?\nA: Yes, Redis comes later.')
  })

  test('the record lists answered questions with their context', async () => {
    const plan = demoPlan()
    const record = renderRecord({
      plan,
      review: { status: 'reviewing', version: 1, parsedFrom: 'block', warnings: [], history: [], previousPaths: [] },
      comments: [],
      qa: [THREAD, { id: 'q2', question: 'Pending?', status: 'asking' }],
      nowMs: 0,
    })
    expect(record).toContain('## Questions')
    expect(record).toContain('### Why a cache? (src/auth/session.ts, symbol refreshSession, lines 4)')
    expect(record).toContain('> const cache = new Map()')
    expect(record).toContain('Q: Per process only?')
    expect(record).not.toContain('Pending?')
  })
})
