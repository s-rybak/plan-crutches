import { describe, expect, test } from 'claude-code/testing'

import { WEB_PROTOCOL, buildSnapshot, fileEntries, parseAction, parseServerLine, splitLines } from '../hooks/web'
import { parsePlan } from '../hooks/plan-parser'
import { DEMO_PLAN } from '../hooks/demo-plan'

const EMPTY_REVIEW = { status: 'reviewing' as const, version: 1, parsedFrom: 'block' as const, warnings: [], history: [], previousPaths: [] }

describe('web bridge helpers', () => {
  test('parses the actions the page sends and refuses junk', async () => {
    expect(parseAction({ type: 'comment', text: '  Split it. ', target: { path: 'a.ts', lines: [4, 2], selection: 'x' } })).toEqual({
      type: 'comment',
      text: 'Split it.',
      target: { path: 'a.ts', selection: 'x', lines: [2, 4] },
    })
    expect(parseAction({ type: 'comment', text: '   ' })).toBe(null)
    expect(parseAction({ type: 'generateBody', path: 'a.ts', symbol: 'f' })).toEqual({ type: 'generateBody', path: 'a.ts', symbol: 'f' })
    expect(parseAction({ type: 'ask', question: 'Why?', focus: 'a.ts' })).toEqual({ type: 'ask', question: 'Why?', focus: 'a.ts' })
    expect(parseAction({ type: 'ask', id: 'q1', question: 'Why?', target: { path: 'a.ts', symbol: 'f', selection: 'x', lines: [3, 1] } })).toEqual({
      type: 'ask',
      id: 'q1',
      question: 'Why?',
      target: { path: 'a.ts', symbol: 'f', selection: 'x', lines: [1, 3] },
    })
    expect(parseAction({ type: 'ask', id: 'bad id!', question: 'Why?', target: {} })).toEqual({ type: 'ask', question: 'Why?' })
    expect(parseAction({ type: 'askMore', id: 'q1', question: '  And then? ' })).toEqual({ type: 'askMore', id: 'q1', question: 'And then?' })
    expect(parseAction({ type: 'askMore', id: 'q1', question: ' ' })).toBe(null)
    expect(parseAction({ type: 'askMore', question: 'x' })).toBe(null)
    expect(parseAction({ type: 'setLang', lang: 'fr' })).toEqual({ type: 'setLang', lang: 'en' })
    expect(parseAction({ type: 'diagramSvg', svg: 'nope' })).toBe(null)
    expect(parseAction({ type: 'diagramSvg', svg: ' <svg/>' })).toEqual({ type: 'diagramSvg', svg: ' <svg/>' })
    expect(parseAction({ type: 'generateDiagram' })).toEqual({ type: 'generateDiagram' })
    expect(parseAction({ type: 'callers', path: 'a.ts', symbol: 'f' })).toEqual({ type: 'callers', path: 'a.ts', symbol: 'f' })
    expect(parseAction({ type: 'callers', path: 'a.ts' })).toBe(null)
    expect(parseAction({ type: 'explode' })).toBe(null)
    expect(parseAction('submit')).toBe(null)
  })

  test('parses the OK marks, the explanation, the summary edit and the version actions', async () => {
    expect(parseAction({ type: 'setOk', paths: ['a.ts', 'src/', 'a.ts', 3], ok: true })).toEqual({ type: 'setOk', paths: ['a.ts', 'src/'], ok: true })
    expect(parseAction({ type: 'setOk', path: 'a.ts', ok: false })).toEqual({ type: 'setOk', paths: ['a.ts'], ok: false })
    expect(parseAction({ type: 'setOk', paths: [] })).toBe(null)
    expect(parseAction({ type: 'explain', id: 'x1', target: { path: 'a.ts', lines: [2, 1] }, focus: 'a.ts' })).toEqual({ type: 'explain', id: 'x1', target: { path: 'a.ts', lines: [1, 2] }, focus: 'a.ts' })
    expect(parseAction({ type: 'explain', id: 'x1' })).toEqual({ type: 'explain', id: 'x1', target: {} })
    expect(parseAction({ type: 'explain', id: 'bad id!', target: {} })).toBe(null)
    expect(parseAction({ type: 'editSummary', text: 'New text\r\n\r\n' })).toEqual({ type: 'editSummary', text: 'New text' })
    expect(parseAction({ type: 'editSummary', text: '' })).toEqual({ type: 'editSummary', text: '' })
    expect(parseAction({ type: 'editSummary' })).toBe(null)
    expect(parseAction({ type: 'viewVersion', version: 2 })).toEqual({ type: 'viewVersion', version: 2 })
    expect(parseAction({ type: 'viewVersion', version: null })).toEqual({ type: 'viewVersion', version: null })
    expect(parseAction({ type: 'viewVersion' })).toEqual({ type: 'viewVersion', version: null })
    expect(parseAction({ type: 'viewVersion', version: 0 })).toBe(null)
    expect(parseAction({ type: 'viewVersion', version: 1.5 })).toBe(null)
    expect(parseAction({ type: 'compareWith', version: 1 })).toEqual({ type: 'compareWith', version: 1 })
    expect(parseAction({ type: 'compareWith', version: null })).toEqual({ type: 'compareWith', version: null })
    expect(parseAction({ type: 'restoreVersion', version: 1 })).toEqual({ type: 'restoreVersion', version: 1 })
    expect(parseAction({ type: 'restoreVersion', version: null })).toBe(null)
    expect(parseAction({ type: 'restoreVersion' })).toBe(null)
  })

  test('splits the server stream into lines and reads its messages', async () => {
    const first = splitLines('', '{"type":"listening","port":4817,"token":"abc","url":"http://127.0.0.1:4817"}\n{"type":"act')
    expect(first.lines.length).toBe(1)
    expect(first.rest).toBe('{"type":"act')
    const second = splitLines(first.rest, 'ion","action":{"type":"submit"}}\n')
    expect(second.lines.length).toBe(1)
    expect(second.rest).toBe('')
    expect(parseServerLine(first.lines[0]!)).toEqual({ type: 'listening', host: '127.0.0.1', port: 4817, token: 'abc', url: 'http://127.0.0.1:4817' })
    expect(parseServerLine(second.lines[0]!)).toEqual({ type: 'action', action: { type: 'submit' } })
    expect(parseServerLine('plain text')).toEqual({ type: 'log', text: 'plain text' })
    expect(parseServerLine('{"type":"listening"}')).toBe(null)
  })

  test('builds file entries and a snapshot from the demo plan, with the versions, the OK marks and the viewed version', async () => {
    const parsed = parsePlan(DEMO_PLAN)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const userText = 'export type User = { id: string }\n\nexport async function getCurrentUser(): Promise<User | null> {\n  return null\n}\n\nexport function displayNameOf(user: User): string {\n  return user.id\n}\n'
    const entries = fileEntries(parsed.plan, { 'src/auth/user.ts': userText, 'src/api/routes.ts': null })
    expect(entries['src/auth/session.ts']?.view?.format).toBe('source')
    expect(entries['src/auth/user.ts']?.view?.format).toBe('diff')
    const diff = entries['src/auth/user.ts']?.view?.text ?? ''
    expect(diff).toContain('@@')
    expect(diff).toContain('-export async function getCurrentUser(): Promise<User | null> {')
    expect(diff).toContain('+export async function getCurrentUser(): Promise<User | null> {')
    expect(diff).toContain('-export function displayNameOf(user: User): string {')
    expect(diff).not.toContain('+export function displayNameOf')
    expect(entries['src/api/routes.ts']?.missing).toBe(true)
    expect(entries['src/legacy/tokens.ts']?.loaded).toBe(false)
    const earlier = { ...parsed.plan, files: parsed.plan.files.slice(0, 2) }
    const snapshot = buildSnapshot({
      plan: parsed.plan,
      review: EMPTY_REVIEW,
      comments: [],
      bodies: {},
      qa: [],
      diagram: { status: 'idle', callers: {} },
      files: {},
      ok: { 'src/auth/user.ts': { version: 1, at: '2026-10-16T00:00:00.000Z' } },
      explanations: { e1: { status: 'done', text: 'Because.', target: {}, createdInVersion: 1 } },
      versions: [{ version: 1, receivedAt: '2026-10-16T00:00:00.000Z', title: 'T', fileCount: 5, source: 'received', path: '/v1.json' }],
      compare: { version: 1, plan: earlier },
      viewing: { version: 1, plan: earlier },
      lang: 'uk',
      summaryLimit: 9000,
      cwd: '/tmp/project',
      nowMs: 0,
    })
    expect(snapshot.lang).toBe('uk')
    expect(snapshot.diagram.status).toBe('idle')
    expect(snapshot.generatedAt).toBe('1970-01-01T00:00:00.000Z')
    expect(snapshot.protocol).toBe(WEB_PROTOCOL)
    expect(WEB_PROTOCOL).toBe(4)
    expect(Object.keys(snapshot.files).length).toBe(parsed.plan.files.length)
    expect(Object.keys(snapshot.ok)).toEqual(['src/auth/user.ts'])
    expect(Object.keys(snapshot.explanations)).toEqual(['e1'])
    expect(snapshot.versions.length).toBe(1)
    expect(snapshot.compare?.version).toBe(1)
    expect(snapshot.viewing?.version).toBe(1)
    expect(Object.keys(snapshot.viewing?.files ?? {}).length).toBe(2)
    const bare = buildSnapshot({ plan: null, review: EMPTY_REVIEW, comments: [], bodies: {}, qa: [], diagram: { status: 'idle', callers: {} }, files: {}, lang: 'en', summaryLimit: 9000, cwd: '/x', nowMs: 0 })
    expect(bare.ok).toEqual({})
    expect(bare.versions).toEqual([])
    expect(bare.compare).toBeUndefined()
    expect(bare.viewing).toBeUndefined()
  })
})
