import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEMO_PLAN } from '../hooks/demo-plan'
import { STORED_SHAPE, STORE_INDEX_KEY, buildStored, indexWith, parseIndex, parseStored, storeKey, thawStored } from '../hooks/persist'
import type { StoredInput } from '../hooks/persist'
import { parsePlan } from '../hooks/plan-parser'
import type { StoredIndexEntry } from '../types'

const PANE = {
  component: 'Pane' as const,
  requestId: 'plan-review',
  props: {
    title: 'Plan Review',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
}

const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
const HOME = '/tmp/plan-crutches-test-home'

function demoPlan() {
  const parsed = parsePlan(DEMO_PLAN)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.plan
}

function input(overrides: Partial<StoredInput> = {}): StoredInput {
  return {
    cwd: '/work/app',
    sessionId: 'session-a',
    savedAt: '2026-10-15T10:00:00.000Z',
    plan: demoPlan(),
    review: {
      status: 'reviewing',
      version: 2,
      parsedFrom: 'block',
      warnings: [],
      history: ['v1 received', 'v2 received'],
      previousPaths: [],
      planFilePath: '/home/me/.claude/plans/x.md',
      recordPath: '/work/app/docs/plans/x.md',
    },
    comments: [{ id: 'c1', target: { path: 'src/auth/session.ts' }, text: 'Keep it smaller.', createdInVersion: 2 }],
    qa: [
      { id: 'q1', question: 'Why?', status: 'asking' },
      { id: 'q2', question: 'How?', status: 'done', answer: 'So.', followups: [{ id: 'f1', question: 'And?', status: 'asking' }] },
    ],
    diagram: {
      status: 'ready',
      graph: { files: [], edges: [] },
      version: 2,
      callers: { 'a#b': { status: 'loading', callers: [], more: 0 }, 'c#d': { status: 'ready', callers: [], more: 0 } },
    },
    task: { userPrompt: 'Do it' },
    ui: {
      lang: 'uk',
      tab: 'changes',
      view: 'file',
      collapsed: ['src'],
      selected: 'src/auth/session.ts',
      commenting: 'x',
      showFullSummary: false,
      showTask: true,
      expanded: [],
      pendingSelection: 'sel',
    },
    bodies: { 'a#b': { status: 'ready', code: 'x' }, 'c#d': { status: 'loading' } },
    token: 'tok',
    ...overrides,
  }
}

const CWD = '/work/app'
const SESSION = 'session-a'
const PLAN_FILE = `${CWD}/plans/demo-plan.md`

/**
 * The world beneath the mod for these tests, registered before the test's
 * first `$` call: a store in memory the test reads and seeds, a fixed folder
 * and session id, a file system that holds the plan file and keeps what the
 * mod writes, and answers for the calls the session start and the plan mode
 * hooks make. Nothing touches the disk.
 */
function beneath(on: On, sessionId = SESSION): { data: Record<string, unknown>; written: Record<string, string> } {
  mock.clock(on)
  mock.env(on, { HOME })
  const data: Record<string, unknown> = {}
  const written: Record<string, string> = {}
  on('store.get', async (_$, e) => ({ value: data[e.key] }))
  on('store.set', async (_$, e) => {
    data[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    delete data[e.key]
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: Object.keys(data) }))
  on('session.cwd', async () => ({ value: CWD }))
  on('session.id', async () => ({ value: sessionId }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: { command: 'plan-review' } }))
  on('agent.register', async () => ({ value: { agent: 'plan-crutches:diagram' } }))
  on('fs.exists', async (_$, e) => ({ value: e.path === PLAN_FILE || e.path in written }))
  on('fs.read', async (_$, e) => ({ value: e.path === PLAN_FILE ? DEMO_PLAN : (written[e.path] ?? '') }))
  on('fs.write', async (_$, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('prompt.attachment', async (_$, e) => ({ text: e.text }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  return { data, written }
}

const exitPlanMode = ($: Engine) => ($.tool.call as unknown as (input: { tool: string }) => Promise<unknown>)({ tool: 'ExitPlanMode' })

describe('stored review helpers', () => {
  test('builds a record with the token and the ready bodies, and drops the bodies when the record would be large', async () => {
    const stored = buildStored(input())
    expect(stored.shape).toBe(STORED_SHAPE)
    expect(stored.token).toBe('tok')
    expect(Object.keys(stored.bodies ?? {})).toEqual(['a#b'])
    const big = buildStored(input({ bodies: { 'a#b': { status: 'ready', code: 'x'.repeat(1024 * 1024 + 1) } } }))
    expect(big.bodies).toBeUndefined()
    expect(big.comments).toHaveLength(1)
    const none = buildStored(input({ bodies: {}, token: undefined }))
    expect(none.bodies).toBeUndefined()
    expect(none.token).toBeUndefined()
  })

  test('reads a record back through JSON and refuses what it did not write', async () => {
    const stored = buildStored(input())
    const back = parseStored(JSON.parse(JSON.stringify(stored)))
    expect(back).toEqual(stored)
    expect(parseStored(null)).toBe(null)
    expect(parseStored('review')).toBe(null)
    expect(parseStored({ ...stored, shape: STORED_SHAPE + 1 })).toBe(null)
    expect(parseStored({ ...stored, plan: { title: 'x' } })).toBe(null)
    expect(parseStored({ ...stored, review: { status: 'reviewing' } })).toBe(null)
    expect(parseStored({ ...stored, comments: 'none' })).toBe(null)
  })

  test('settles what was still loading when the process died', async () => {
    const thawed = thawStored(buildStored(input()))
    expect(thawed.plan.title).toBe(demoPlan().title)
    expect(thawed.review.version).toBe(2)
    expect(thawed.comments.map(one => one.text)).toEqual(['Keep it smaller.'])
    expect(thawed.qa[0]).toEqual({ id: 'q1', question: 'Why?', status: 'failed', answer: 'interrupted by a restart of Claude Code' })
    expect(thawed.qa[1]?.status).toBe('done')
    expect(thawed.qa[1]?.followups?.[0]?.status).toBe('failed')
    expect(Object.keys(thawed.diagram.callers)).toEqual(['c#d'])
    expect(thawed.diagram.status).toBe('ready')
    expect(Object.keys(thawed.bodies)).toEqual(['a#b'])
    expect(thawed.ui.lang).toBe('uk')
    expect(thawed.ui.selected).toBe('src/auth/session.ts')
    expect(thawed.ui.commenting).toBeUndefined()
    expect(thawed.ui.pendingSelection).toBeUndefined()
    const loading = thawStored(buildStored(input({ diagram: { status: 'loading', callers: {} } })))
    expect(loading.diagram).toEqual({ status: 'idle', callers: {} })
  })

  test('keeps the index newest first and names the folders it cuts off', async () => {
    const entries: StoredIndexEntry[] = [
      { cwd: '/b', savedAt: '2026-10-02T00:00:00.000Z', title: 'B', version: 1 },
      { cwd: '/a', savedAt: '2026-10-01T00:00:00.000Z', title: 'A', version: 1 },
    ]
    const added = indexWith(entries, { cwd: '/c', savedAt: '2026-10-03T00:00:00.000Z', title: 'C', version: 1 }, 2)
    expect(added.entries.map(one => one.cwd)).toEqual(['/c', '/b'])
    expect(added.dropped).toEqual(['/a'])
    const replaced = indexWith(entries, { cwd: '/a', savedAt: '2026-10-04T00:00:00.000Z', title: 'A', version: 2 }, 8)
    expect(replaced.entries.map(one => one.cwd)).toEqual(['/a', '/b'])
    expect(replaced.dropped).toEqual([])
    expect(parseIndex(JSON.parse(JSON.stringify(replaced.entries)))).toEqual(replaced.entries)
    expect(parseIndex([{ cwd: '' }, 'x', { cwd: '/d', savedAt: 't' }])).toEqual([{ cwd: '/d', savedAt: 't', title: '', version: 0 }])
  })
})

describe('the review between processes', () => {
  test('a live review is written to the store as it changes, and dropped by a reset', async ($, on) => {
    const { data: seen, written } = beneath(on)
    const [cwd, sessionId, planFilePath] = [CWD, SESSION, PLAN_FILE]
    await $.prompt.attachment({ type: 'plan_mode', origin: { kind: 'engine' }, text: 'Plan mode is on.', detail: { reminder: 'full', planFilePath, hasPlan: true } })
    await exitPlanMode($)
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await ui.find({ text: /Session refresh for the auth module/ })).toBeDefined()
    await ui.press({ key: 'plan-comment' })
    await ui.input({ key: 'input:plan', text: 'Keep it smaller.' })
    expect(await ui.find({ text: /Keep it smaller\./ })).toBeDefined()
    await ui.unmount()
    const stored = parseStored(seen[storeKey(cwd)])
    expect(stored).not.toBe(null)
    expect(stored?.sessionId).toBe(sessionId)
    expect(stored?.review.status).toBe('reviewing')
    expect(stored?.review.version).toBe(1)
    expect(stored?.review.planFilePath).toBe(planFilePath)
    expect(stored?.comments.map(one => one.text)).toEqual(['Keep it smaller.'])
    expect(parseIndex(seen[STORE_INDEX_KEY]).map(one => one.cwd)).toEqual([cwd])
    expect(Object.keys(written).some(path => path.startsWith(`${cwd}/docs/plans/`))).toBe(true)
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(seen[storeKey(cwd)]).toBeUndefined()
    expect(parseIndex(seen[STORE_INDEX_KEY])).toEqual([])
    const none = await $.command.run({ command: 'plan-review', args: 'restore', ...RUN })
    expect(none.text ?? '').toContain('No stored review')
  })

  test('the same session resumed takes its stored review up at session start', async ($, on) => {
    const { data: seen, written } = beneath(on)
    const [cwd, sessionId] = [CWD, SESSION]
    const record = buildStored(input({ cwd, sessionId, review: { ...input().review, planFilePath: PLAN_FILE, recordPath: `${cwd}/docs/plans/x.md` } }))
    seen[storeKey(cwd)] = record
    seen[STORE_INDEX_KEY] = [{ cwd, savedAt: record.savedAt, title: record.plan.title, version: 2 }]
    await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await ui.find({ text: /Session refresh for the auth module/ })).toBeDefined()
    expect(await ui.find({ text: /Keep it smaller\./ })).toBeDefined()
    await ui.unmount()
    const again = parseStored(seen[storeKey(cwd)])
    expect(again?.review.history.some(line => line.startsWith('restored after a restart'))).toBe(true)
    expect(again?.token).toBe('tok')
    expect(written[`${cwd}/docs/plans/x.md`] ?? '').toContain('restored after a restart')
    const live = await $.command.run({ command: 'plan-review', args: 'restore', ...RUN })
    expect(live.text ?? '').toContain('already under review')
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(seen[storeKey(cwd)]).toBeUndefined()
  })

  test('another session is only told, and restores on command', async ($, on) => {
    const { data: seen } = beneath(on, 'session-b')
    const cwd = CWD
    const record = buildStored(input({ cwd, sessionId: SESSION, review: { ...input().review, planFilePath: PLAN_FILE, recordPath: '' } }))
    seen[storeKey(cwd)] = record
    await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
    const before = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await before.find({ text: /No plan under review/ })).toBeDefined()
    await before.unmount()
    expect(parseStored(seen[storeKey(cwd)])?.sessionId).toBe(SESSION)
    const ran = await $.command.run({ command: 'plan-review', args: 'restore', ...RUN })
    expect(ran.text ?? '').toContain('plan v2 restored')
    const after = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await after.find({ text: /Session refresh for the auth module/ })).toBeDefined()
    expect(await after.find({ text: /Keep it smaller\./ })).toBeDefined()
    await after.unmount()
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(seen[storeKey(cwd)]).toBeUndefined()
  })

  test('a stored review whose plan file is gone is reported, not restored', async ($, on) => {
    const { data: seen } = beneath(on, 'session-b')
    const cwd = CWD
    const record = buildStored(input({ cwd, sessionId: SESSION, review: { ...input().review, planFilePath: `${cwd}/plans/no-such-plan.md`, recordPath: '' } }))
    seen[storeKey(cwd)] = record
    const ran = await $.command.run({ command: 'plan-review', args: 'restore', ...RUN })
    expect(ran.text ?? '').toContain('plan file is gone')
    expect(seen[storeKey(cwd)]).toBeDefined()
    const demo = await $.command.run({ command: 'plan-review', args: 'demo', ...RUN })
    expect(demo.text ?? '').toContain('demo plan opened')
    expect(seen[storeKey(cwd)]).toBeUndefined()
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
  })
})
