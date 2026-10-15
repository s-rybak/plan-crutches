import { describe, expect, test } from 'claude-code/testing'

import { DEMO_PLAN } from '../hooks/demo-plan'
import {
  callersPrompt,
  declarationOf,
  diagramPrompt,
  diagramText,
  enclosingSymbol,
  groupCandidates,
  isDeclarationOf,
  isImportLine,
  normalizeGraph,
  parseCallersReply,
  parseDiagramReply,
  parseGrepOutput,
} from '../hooks/diagram'
import { parsePlan } from '../hooks/plan-parser'

function demoPlan() {
  const parsed = parsePlan(DEMO_PLAN)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.plan
}

describe('diagram prompts', () => {
  test('the graph prompt carries the plan, the file texts and the JSON shape', async () => {
    const plan = demoPlan()
    const withTools = diagramPrompt(plan, { 'src/auth/user.ts': 'export function getCurrentUser() {}', 'src/legacy/tokens.ts': null }, { tools: true })
    expect(withTools).toContain('All planned files and symbols:')
    expect(withTools).toContain('Current content of the planned files that exist in the project:')
    expect(withTools).toContain('src/auth/user.ts:\n```\nexport function getCurrentUser() {}\n```')
    expect(withTools).not.toContain('src/legacy/tokens.ts:\n```')
    expect(withTools).toContain('read the project files to confirm')
    expect(withTools).toContain('"edges"')
    const without = diagramPrompt(plan, {}, { tools: false })
    expect(without).not.toContain('Current content of')
    expect(without).toContain('the file texts given above')
  })

  test('the callers prompt names the symbol, its signature and the search candidates', async () => {
    const plan = demoPlan()
    const prompt = callersPrompt(
      plan,
      { path: 'src/auth/session.ts', symbol: 'refreshSession' },
      [{ path: 'src/auth/user.ts', line: 12, text: '  const next = await refreshSession(id)', enclosing: 'getCurrentUser', kind: 'function' }],
      20,
    )
    expect(prompt).toContain('calls or uses the symbol `refreshSession` of src/auth/session.ts')
    expect(prompt).toContain('export async function refreshSession(userId: string): Promise<Session> {')
    expect(prompt).toContain('src/auth/user.ts:12: const next = await refreshSession(id)    [in getCurrentUser]')
    expect(prompt).toContain('At most 20 entries')
    expect(callersPrompt(plan, { path: 'x.ts', symbol: 'nope' }, [])).toContain('found nothing')
  })
})

describe('diagram answers', () => {
  test('the graph keeps every planned file and symbol, takes exports for a deleted file and drops unknown edges', async () => {
    const plan = demoPlan()
    const graph = normalizeGraph(
      {
        files: [
          { path: './src/auth/session.ts', symbols: [{ name: 'refreshSession', kind: 'function' }, { name: 'invented', kind: 'function' }] },
          { path: 'src/legacy/tokens.ts', symbols: [{ name: 'saveTokens', kind: 'function' }, { name: 'loadTokens', kind: 'function' }, { name: 'loadTokens' }] },
        ],
        edges: [
          { from: { path: 'src/auth/user.ts', symbol: 'getCurrentUser' }, to: { path: 'src/auth/session.ts', symbol: 'refreshSession' }, kind: 'call' },
          { from: { path: 'src/auth/user.ts', symbol: 'getCurrentUser' }, to: { path: 'src/auth/session.ts', symbol: 'refreshSession' }, kind: 'call' },
          { from: { path: 'src/auth/session.ts', symbol: 'refreshSession' }, to: { path: 'src/auth/session.ts', symbol: 'Session' }, kind: 'use' },
          { from: { path: 'src/auth/session.ts', symbol: 'invented' }, to: { path: 'src/auth/session.ts', symbol: 'Session' }, kind: 'use' },
          { from: { path: 'src/api/routes.ts', symbol: 'refreshRoute' }, to: { path: 'src/other.ts', symbol: 'x' } },
        ],
      },
      plan,
    )
    expect(graph.files.map(file => file.path)).toEqual(plan.files.map(file => file.path))
    const session = graph.files.find(file => file.path === 'src/auth/session.ts')
    expect(session?.symbols.map(symbol => symbol.name)).toEqual(['Session', 'refreshSession', 'isExpiringSoon'])
    const legacy = graph.files.find(file => file.path === 'src/legacy/tokens.ts')
    expect(legacy?.status).toBe('deleted')
    expect(legacy?.symbols.map(symbol => symbol.name)).toEqual(['saveTokens', 'loadTokens'])
    expect(legacy?.symbols[1]?.kind).toBe('function')
    expect(graph.edges.length).toBe(2)
    expect(graph.edges[1]?.kind).toBe('use')
    expect(parseDiagramReply('Here you go:\n```json\n{"files":[],"edges":[]}\n```', plan)?.files.length).toBe(plan.files.length)
    expect(parseDiagramReply('no json at all', plan)).toBe(null)
  })

  test('the callers answer is capped at the limit and counts the rest', async () => {
    const reply = JSON.stringify({
      callers: [
        { path: './a.ts', symbol: 'one', kind: 'function', line: 3 },
        { path: 'a.ts', symbol: 'one', line: 9 },
        { path: 'b.ts', symbol: 'Two.run', kind: 'method', line: 2.7 },
        { path: 'c.ts', symbol: '', kind: 'weird' },
        { path: '', symbol: 'dropped' },
      ],
      total: 12,
    })
    const parsed = parseCallersReply(reply, 2)
    expect(parsed?.callers).toEqual([
      { path: 'a.ts', symbol: 'one', kind: 'function', line: 3 },
      { path: 'b.ts', symbol: 'Two.run', kind: 'method', line: 2 },
    ])
    expect(parsed?.more).toBe(10)
    const whole = parseCallersReply(reply)
    expect(whole?.callers.length).toBe(3)
    expect(whole?.callers[2]).toEqual({ path: 'c.ts', symbol: '(module)', kind: 'other' })
    expect(parseCallersReply('{"total": 3}')).toBe(null)
    const prefixed = parseCallersReply('{"callers":[{"path":"/repo/app/src/a.ts","symbol":"f"},{"path":"app/src/b.ts","symbol":"g"},{"path":"src/c.ts","symbol":"h"}],"total":3}', 20, ['/repo/app/', 'app/'])
    expect(prefixed?.callers.map(one => one.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(callersPrompt(demoPlan(), { path: 'x.ts', symbol: 'f' }, [], 20, '/repo/app')).toContain('relative to the project folder /repo/app')
    expect(parseCallersReply('{"callers": [{"path":"a.ts","symbol":"f"}], "total": 0}')?.more).toBe(0)
  })

  test('the record text lists files and calls', async () => {
    expect(diagramText(undefined)).toBe('')
    const text = diagramText({
      files: [
        { path: 'a.ts', status: 'modified', symbols: [{ name: 'f', kind: 'function' }, { name: 'K', kind: 'const' }] },
        { path: 'gone.ts', status: 'deleted', symbols: [] },
      ],
      edges: [{ from: { path: 'a.ts', symbol: 'f' }, to: { path: 'a.ts', symbol: 'K' }, kind: 'use' }],
    })
    expect(text).toBe('Files:\n- [modified] a.ts: f, K\n- [deleted] gone.ts\nCalls:\n- a.ts#f -> a.ts#K (uses)')
  })
})

describe('callers text search', () => {
  test('reads grep output and skips generated folders', async () => {
    const hits = parseGrepOutput(['src/a.ts:12:  refreshSession(id)', 'node_modules/x/y.js:1:refreshSession', './src/b.py:7:refreshSession()', 'garbage line', 'dist/out.js:3:x'].join('\n'))
    expect(hits).toEqual([
      { path: 'src/a.ts', line: 12, text: '  refreshSession(id)' },
      { path: 'src/b.py', line: 7, text: 'refreshSession()' },
    ])
    expect(parseGrepOutput('a:1:x\nb:2:y\nc:3:z', 2).length).toBe(2)
  })

  test('names the symbol a line declares in the usual languages', async () => {
    expect(declarationOf('export async function getCurrentUser(): Promise<User | null> {')).toEqual({ name: 'getCurrentUser', kind: 'function' })
    expect(declarationOf('const refreshRoute = route.post("/auth/refresh", handleRefresh)')).toEqual({ name: 'refreshRoute', kind: 'const' })
    expect(declarationOf('export const go = async (x: number) => {')).toEqual({ name: 'go', kind: 'function' })
    expect(declarationOf('export class SessionStore {')).toEqual({ name: 'SessionStore', kind: 'class' })
    expect(declarationOf('export type Session = {')).toEqual({ name: 'Session', kind: 'type' })
    expect(declarationOf('  private async load(id: string): Promise<User> {')).toEqual({ name: 'load', kind: 'method' })
    expect(declarationOf('  static of(x) {')).toEqual({ name: 'of', kind: 'method' })
    expect(declarationOf('  def refresh(self, user_id):')).toEqual({ name: 'refresh', kind: 'function' })
    expect(declarationOf('func (s *Store) Load(id string) error {')).toEqual({ name: 'Load', kind: 'method' })
    expect(declarationOf('pub fn load(id: &str) -> Result<User> {')).toEqual({ name: 'load', kind: 'function' })
    expect(declarationOf('    public function handle(Request $request) {')).toEqual({ name: 'handle', kind: 'method' })
    expect(declarationOf('    public User load(String id) throws IOException {')).toEqual({ name: 'load', kind: 'method' })
    expect(declarationOf('  if (session) {')).toBe(null)
    expect(declarationOf('  return loadUser(session.userId)')).toBe(null)
    expect(declarationOf('  await refreshSession(id)')).toBe(null)
    expect(declarationOf('// function commented(): void {')).toBe(null)
    expect(isDeclarationOf('export async function refreshSession(userId: string) {', 'refreshSession')).toBe(true)
    expect(isDeclarationOf('  const next = await refreshSession(userId)', 'refreshSession')).toBe(false)
    expect(isImportLine("import { loadTokens } from '../legacy/tokens'")).toBe(true)
    expect(isImportLine('from app.tokens import load_tokens')).toBe(true)
    expect(isImportLine("const { loadTokens } = require('./tokens')")).toBe(true)
    expect(isImportLine("export { loadTokens } from './tokens'")).toBe(false)
    expect(isImportLine('  const tokens = loadTokens()')).toBe(false)
    expect(isImportLine("const mod = await import('./tokens')")).toBe(false)
  })

  test('finds the enclosing function, method with its class, constant or module', async () => {
    const lines = [
      'import { refreshSession } from "./session"',
      '',
      'export const ROUTE = refreshSession.name',
      '',
      'export class Store {',
      '  private cache = new Map()',
      '',
      '  async load(id: string) {',
      '    if (this.cache.has(id)) {',
      '      return refreshSession(id)',
      '    }',
      '    return null',
      '  }',
      '}',
      '',
      'export async function getCurrentUser() {',
      '  const session = await refreshSession("me")',
      '  return session',
      '}',
      '',
      'refreshSession("top")',
    ]
    expect(enclosingSymbol(lines, 0)).toEqual({ name: '(module)', kind: 'other' })
    expect(enclosingSymbol(lines, 2)).toEqual({ name: 'ROUTE', kind: 'const' })
    expect(enclosingSymbol(lines, 9)).toEqual({ name: 'Store.load', kind: 'method' })
    expect(enclosingSymbol(lines, 16)).toEqual({ name: 'getCurrentUser', kind: 'function' })
    expect(enclosingSymbol(lines, 20)).toEqual({ name: '(module)', kind: 'other' })
    const python = ['class Auth:', '    def refresh(self):', '        return refresh_session()', '', 'def main():', '    refresh_session()']
    expect(enclosingSymbol(python, 2)).toEqual({ name: 'Auth.refresh', kind: 'method' })
    expect(enclosingSymbol(python, 5)).toEqual({ name: 'main', kind: 'function' })
  })

  test('groups hits into callers, one per enclosing symbol, capped', async () => {
    const grouped = groupCandidates(
      [
        { path: 'a.ts', line: 3, text: 'x', enclosing: 'f', kind: 'function' },
        { path: 'a.ts', line: 9, text: 'y', enclosing: 'f', kind: 'function' },
        { path: 'b.ts', line: 1, text: 'z', enclosing: '(module)', kind: 'other' },
        { path: 'c.ts', line: 4, text: 'w', enclosing: 'g', kind: 'function' },
      ],
      2,
    )
    expect(grouped.callers).toEqual([
      { path: 'a.ts', symbol: 'f', kind: 'function', line: 3 },
      { path: 'b.ts', symbol: '(module)', kind: 'other', line: 1 },
    ])
    expect(grouped.more).toBe(1)
  })
})
