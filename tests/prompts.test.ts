import { describe, expect, test } from 'claude-code/testing'

import type { QaItem } from '../types'
import { DEMO_PLAN } from '../hooks/demo-plan'
import { parsePlan } from '../hooks/plan-parser'
import { approvePrompt, askMorePrompt, askPrompt, bodyPrompt, explainPrompt, importCandidates, parseFileList, pickFilesPrompt, planSurface, relativeImports, revisionPrompt, threadText, userWords } from '../hooks/prompts'
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
    expect(rest.indexOf('Modify this existing symbol')).toBeGreaterThan(rest.indexOf('Current content of src/auth/user.ts'))
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

  test('a modified symbol asks for its whole new implementation next to its code today; the surface names the change', async () => {
    const plan = demoPlan()
    const file = plan.files.find(one => one.path === 'src/auth/user.ts')!
    const symbol = file.symbols.find(one => one.name === 'getCurrentUser')!
    expect(symbol.change).toBe('modified')
    const blocks = bodyPrompt({ plan, file, symbol, fileText: 'x', bodies: {}, related: [], currentCode: 'export async function getCurrentUser() { return old }' })
    expect(blocks[0]!.text).toContain('[function, modified] getCurrentUser')
    expect(blocks[0]!.text).toContain('[function, deleted] displayNameOf')
    expect(blocks[1]!.text).toContain('Modify this existing symbol')
    expect(blocks[1]!.text).toContain('Its code today, which your implementation replaces:')
    expect(blocks[1]!.text).toContain('return old')
    expect(blocks[1]!.text).toContain('- export function displayNameOf(user: User): string { (deleted)')
  })

  test('the explanation prompt names the place, the planned symbol, the file text and the language', async () => {
    const plan = demoPlan()
    const prompt = explainPrompt(plan, { path: 'src/auth/user.ts', symbol: 'getCurrentUser', lines: [3, 5], selection: 'readSession()' }, undefined, 'export function x() {}', 'uk', 'Чому саме кеш?')
    expect(prompt).toContain('Answer in the language the user writes in')
    expect(prompt).toContain('quoted here: "Чому саме кеш?"')
    expect(prompt).toContain('Only when there are none, answer in Ukrainian.')
    expect(prompt).toContain('What, Where and Why')
    expect(prompt).toContain('The place to explain: src/auth/user.ts, symbol getCurrentUser, lines 3-5.')
    expect(prompt).toContain('Planned symbol getCurrentUser [function, modified]:')
    expect(prompt).toContain('Current content of src/auth/user.ts:\n```\nexport function x() {}')
    expect(prompt).toContain('readSession()')
    expect(prompt).toContain('All planned files and symbols:')
    const whole = explainPrompt(plan, {}, 'src/auth/session.ts')
    expect(whole).toContain('Only when there are none, answer in English.')
    expect(whole).not.toContain('quoted here')
    expect(whole).toContain('The place to explain: src/auth/session.ts.')
    expect(whole).not.toContain('Current content of')
  })

  test('the user words for the answer language come from the latest questions, comments and the typed task', async () => {
    const plan = demoPlan()
    expect(userWords(plan)).toBe('')
    const comments = [{ id: '1', target: {}, text: 'Залиш  менше\nфайлів.', createdInVersion: 1 }]
    const qa: QaItem[] = [{ ...THREAD, followups: [{ id: 'f1', question: 'А транзакція?', status: 'done', answer: 'Так.' }] }]
    expect(userWords(plan, comments, qa)).toBe('А транзакція? / Why a cache? / Залиш менше файлів.')
    const typed = { ...plan, task: { source: 'user' as const, text: 'Зроби відправку листа' } }
    expect(userWords(typed, [], [])).toBe('Зроби відправку листа')
    expect(userWords(typed, comments, qa)).toBe('А транзакція? / Why a cache? / Залиш менше файлів.')
    expect(userWords(plan, [{ id: '2', target: {}, text: 'x'.repeat(500), createdInVersion: 1 }]).length).toBeLessThanOrEqual(301)
  })

  test('the revision and approval prompts carry the OK marks and the summary edit', async () => {
    const plan = demoPlan()
    const comments = [{ id: '1', target: {}, text: 'Keep it smaller.', createdInVersion: 2 }]
    const revision = revisionPrompt(plan, comments, 2, { okPaths: ['src/legacy/tokens.ts'], summaryEdited: true })
    expect(revision).toContain('The user edited the plan text (the summary) directly in the plan file.')
    expect(revision).toContain('Files the user marked as reviewed OK')
    expect(revision).toContain('- src/legacy/tokens.ts')
    expect(revisionPrompt(plan, comments, 2)).not.toContain('reviewed OK')
    expect(approvePrompt(2)).toContain('Call ExitPlanMode now')
    expect(approvePrompt(2, { summaryEdited: true })).toContain('Read the plan file again')
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
