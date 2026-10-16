import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEMO_PLAN } from '../hooks/demo-plan'
import { bodiesFile, projectDir, reviewFile, versionFile } from '../hooks/paths'
import {
  STORED_SHAPE,
  STORE_INDEX_KEY,
  buildStored,
  indexWith,
  parseBodiesText,
  parseIndex,
  parseStored,
  parseStoredText,
  serializeBodies,
  serializeStored,
  storeKey,
  thawStored,
} from '../hooks/persist'
import type { StoredInput } from '../hooks/persist'
import { parsePlan } from '../hooks/plan-parser'
import { parseSavedVersion } from '../hooks/versions'
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
const CWD = '/work/app'
const SESSION = 'session-a'
const PLAN_FILE = `${CWD}/plans/demo-plan.md`
/** Where the mod keeps this project's review files. */
const DIR = projectDir(HOME, CWD)
const REVIEW_FILE = reviewFile(DIR)
const BODIES_FILE = bodiesFile(DIR)

function demoPlan() {
  const parsed = parsePlan(DEMO_PLAN)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.plan
}

function input(overrides: Partial<StoredInput> = {}): StoredInput {
  return {
    cwd: CWD,
    sessionId: SESSION,
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
      recordPath: `${DIR}/x.md`,
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
    ok: { 'src/auth/user.ts': { version: 2, at: '2026-10-15T10:00:00.000Z' } },
    versions: [
      { version: 1, receivedAt: '2026-10-15T09:00:00.000Z', title: 'T', fileCount: 4, source: 'received', path: versionFile(DIR, 1) },
      { version: 2, receivedAt: '2026-10-15T10:00:00.000Z', title: 'T', fileCount: 5, source: 'received', path: versionFile(DIR, 2) },
    ],
    explanations: {
      e1: { status: 'done', text: 'Because.', target: { path: 'src/auth/session.ts' }, createdInVersion: 2 },
      e2: { status: 'asking', target: {}, createdInVersion: 2 },
    },
    token: 'tok',
    ...overrides,
  }
}

/**
 * The world beneath the mod for these tests, registered before the test's
 * first `$` call: a store in memory the test reads and seeds, a fixed folder
 * and session id, a file system that holds the plan file and keeps what the
 * mod writes (the review files among it), and answers for the calls the
 * session start and the plan mode hooks make. Nothing touches the disk.
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

/** Puts a record and its bodies where the mod reads them, as an earlier process left them. */
function seed(written: Record<string, string>, data: Record<string, unknown>, record: ReturnType<typeof buildStored>, bodies: Record<string, unknown> = {}): void {
  written[REVIEW_FILE] = serializeStored(record)
  written[BODIES_FILE] = JSON.stringify(bodies)
  data[STORE_INDEX_KEY] = [{ cwd: record.cwd, savedAt: record.savedAt, title: record.plan.title, version: record.review.version, dir: DIR }]
}

const storedNow = (written: Record<string, string>) => parseStoredText(written[REVIEW_FILE] ?? '')

describe('stored review helpers', () => {
  test('builds a record with the token, the OK marks, the versions and the finished explanations; the bodies have a file of their own', async () => {
    const stored = buildStored(input())
    expect(stored.shape).toBe(STORED_SHAPE)
    expect(stored.token).toBe('tok')
    expect(stored.bodies).toBeUndefined()
    expect(Object.keys(stored.ok)).toEqual(['src/auth/user.ts'])
    expect(stored.versions.map(one => one.version)).toEqual([1, 2])
    expect(Object.keys(stored.explanations ?? {})).toEqual(['e1'])
    const none = buildStored(input({ token: undefined, explanations: {} }))
    expect(none.token).toBeUndefined()
    expect(none.explanations).toBeUndefined()
    const bodies = serializeBodies({ 'a#b': { status: 'ready', code: 'x' }, 'c#d': { status: 'loading' }, 'e#f': { status: 'ready', code: 'y'.repeat(100) } }, 80)
    expect(Object.keys(parseBodiesText(bodies))).toEqual(['a#b'])
    expect(parseBodiesText('not json')).toEqual({})
    expect(parseBodiesText(serializeBodies({}))).toEqual({})
  })

  test('a record too large for one read drops its explanations, then its questions, and keeps the comments', async () => {
    const whole = serializeStored(buildStored(input()))
    expect(JSON.parse(whole).explanations).toBeDefined()
    const smaller = JSON.parse(serializeStored(buildStored(input()), whole.length - 1))
    expect(smaller.explanations).toBeUndefined()
    expect(smaller.qa.length).toBe(2)
    const tiny = JSON.parse(serializeStored(buildStored(input()), 100))
    expect(tiny.qa).toEqual([])
    expect(tiny.diagram.status).toBe('idle')
    expect(tiny.comments.map((one: { text: string }) => one.text)).toEqual(['Keep it smaller.'])
  })

  test('reads a record back through JSON and refuses what it did not write', async () => {
    const stored = buildStored(input())
    const back = parseStored(JSON.parse(JSON.stringify(stored)))
    expect(back).toEqual(stored)
    expect(parseStoredText(serializeStored(stored))).toEqual(stored)
    expect(parseStoredText('{}')).toBe(null)
    expect(parseStoredText('nope')).toBe(null)
    expect(parseStored(null)).toBe(null)
    expect(parseStored('review')).toBe(null)
    expect(parseStored({ ...stored, shape: STORED_SHAPE + 1 })).toBe(null)
    expect(parseStored({ ...stored, plan: { title: 'x' } })).toBe(null)
    expect(parseStored({ ...stored, review: { status: 'reviewing' } })).toBe(null)
    expect(parseStored({ ...stored, comments: 'none' })).toBe(null)
    expect(parseStored({ ...stored, ok: 'all' })).toBe(null)
    // A record without the newer fields still reads: they are empty.
    const { ok: _ok, versions: _versions, explanations: _explanations, ...older } = stored
    expect(parseStored(older)?.ok).toEqual({})
    expect(parseStored(older)?.versions).toEqual([])
  })

  test('settles what was still loading when the process died', async () => {
    const thawed = thawStored(buildStored(input()), { 'a#b': { status: 'ready', code: 'x' }, 'c#d': { status: 'loading' } })
    expect(thawed.plan.title).toBe(demoPlan().title)
    expect(thawed.review.version).toBe(2)
    expect(thawed.comments.map(one => one.text)).toEqual(['Keep it smaller.'])
    expect(thawed.qa[0]).toEqual({ id: 'q1', question: 'Why?', status: 'failed', answer: 'interrupted by a restart of Claude Code' })
    expect(thawed.qa[1]?.status).toBe('done')
    expect(thawed.qa[1]?.followups?.[0]?.status).toBe('failed')
    expect(Object.keys(thawed.diagram.callers)).toEqual(['c#d'])
    expect(thawed.diagram.status).toBe('ready')
    expect(Object.keys(thawed.bodies)).toEqual(['a#b'])
    expect(Object.keys(thawed.ok)).toEqual(['src/auth/user.ts'])
    expect(thawed.versions.length).toBe(2)
    expect(Object.keys(thawed.explanations)).toEqual(['e1'])
    expect(thawed.ui.lang).toBe('uk')
    expect(thawed.ui.selected).toBe('src/auth/session.ts')
    expect(thawed.ui.commenting).toBeUndefined()
    expect(thawed.ui.pendingSelection).toBeUndefined()
    const loading = thawStored(buildStored(input({ diagram: { status: 'loading', callers: {} } })))
    expect(loading.diagram).toEqual({ status: 'idle', callers: {} })
    expect(loading.bodies).toEqual({})
  })

  test('keeps the index newest first and names the folders it cuts off', async () => {
    const entries: StoredIndexEntry[] = [
      { cwd: '/b', savedAt: '2026-10-02T00:00:00.000Z', title: 'B', version: 1, dir: '/h/b' },
      { cwd: '/a', savedAt: '2026-10-01T00:00:00.000Z', title: 'A', version: 1 },
    ]
    const added = indexWith(entries, { cwd: '/c', savedAt: '2026-10-03T00:00:00.000Z', title: 'C', version: 1 }, 2)
    expect(added.entries.map(one => one.cwd)).toEqual(['/c', '/b'])
    expect(added.dropped.map(one => one.cwd)).toEqual(['/a'])
    const replaced = indexWith(entries, { cwd: '/a', savedAt: '2026-10-04T00:00:00.000Z', title: 'A', version: 2 }, 8)
    expect(replaced.entries.map(one => one.cwd)).toEqual(['/a', '/b'])
    expect(replaced.dropped).toEqual([])
    expect(parseIndex(JSON.parse(JSON.stringify(replaced.entries)))).toEqual(replaced.entries)
    expect(parseIndex([{ cwd: '' }, 'x', { cwd: '/d', savedAt: 't' }])).toEqual([{ cwd: '/d', savedAt: 't', title: '', version: 0 }])
  })
})

describe('the review between processes', () => {
  test('a live review is written to its file as it changes, with its version saved, and dropped by a reset', async ($, on) => {
    const { data: seen, written } = beneath(on)
    // A record from the time the store held it: the mod cleans it up.
    seen[storeKey(CWD)] = { shape: 1 }
    await $.prompt.attachment({ type: 'plan_mode', origin: { kind: 'engine' }, text: 'Plan mode is on.', detail: { reminder: 'full', planFilePath: PLAN_FILE, hasPlan: true } })
    await exitPlanMode($)
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await ui.find({ text: /Session refresh for the auth module/ })).toBeDefined()
    await ui.press({ key: 'plan-comment' })
    await ui.input({ key: 'input:plan', text: 'Keep it smaller.' })
    expect(await ui.find({ text: /Keep it smaller\./ })).toBeDefined()
    await ui.unmount()
    const stored = storedNow(written)
    expect(stored).not.toBe(null)
    expect(stored?.sessionId).toBe(SESSION)
    expect(stored?.review.status).toBe('reviewing')
    expect(stored?.review.version).toBe(1)
    expect(stored?.review.planFilePath).toBe(PLAN_FILE)
    expect(stored?.comments.map(one => one.text)).toEqual(['Keep it smaller.'])
    expect(stored?.versions.map(one => one.version)).toEqual([1])
    expect(stored?.versions[0]?.path).toBe(versionFile(DIR, 1))
    const saved = parseSavedVersion(written[versionFile(DIR, 1)] ?? '')
    expect(saved?.markdown).toBe(DEMO_PLAN)
    expect(saved?.plan.title).toBe('Session refresh for the auth module')
    expect(saved?.source).toBe('received')
    expect(written[BODIES_FILE]).toBe('{}')
    expect(parseIndex(seen[STORE_INDEX_KEY]).map(one => one.cwd)).toEqual([CWD])
    expect(parseIndex(seen[STORE_INDEX_KEY])[0]?.dir).toBe(DIR)
    expect(seen[storeKey(CWD)]).toBeUndefined()
    const record = Object.keys(written).find(path => path.startsWith(`${DIR}/`) && path.endsWith('.md'))
    expect(record).toBeDefined()
    expect(written[record ?? ''] ?? '').toContain('## Versions')
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(storedNow(written)).toBe(null)
    expect(parseIndex(seen[STORE_INDEX_KEY])).toEqual([])
    const none = await $.command.run({ command: 'plan-review', args: 'restore', ...RUN })
    expect(none.text ?? '').toContain('No stored review')
  })

  test('the same session resumed takes its stored review up at session start, bodies and OK marks included', async ($, on) => {
    const { data: seen, written } = beneath(on)
    const record = buildStored(input({ review: { ...input().review, planFilePath: PLAN_FILE, recordPath: `${DIR}/x.md` } }))
    seed(written, seen, record, { 'a#b': { status: 'ready', code: 'x' } })
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await ui.find({ text: /Session refresh for the auth module/ })).toBeDefined()
    expect(await ui.find({ text: /Keep it smaller\./ })).toBeDefined()
    await ui.unmount()
    const again = storedNow(written)
    expect(again?.review.history.some(line => line.startsWith('restored after a restart'))).toBe(true)
    expect(again?.token).toBe('tok')
    expect(Object.keys(again?.ok ?? {})).toEqual(['src/auth/user.ts'])
    expect(again?.versions.length).toBe(2)
    expect(Object.keys(parseBodiesText(written[BODIES_FILE] ?? ''))).toEqual(['a#b'])
    expect(written[`${DIR}/x.md`] ?? '').toContain('restored after a restart')
    const live = await $.command.run({ command: 'plan-review', args: 'restore', ...RUN })
    expect(live.text ?? '').toContain('already under review')
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(storedNow(written)).toBe(null)
  })

  test('another session is only told, and restores on command', async ($, on) => {
    const { data: seen, written } = beneath(on, 'session-b')
    const record = buildStored(input({ sessionId: SESSION, review: { ...input().review, planFilePath: PLAN_FILE, recordPath: '' } }))
    seed(written, seen, record)
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    const before = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await before.find({ text: /No plan under review/ })).toBeDefined()
    await before.unmount()
    expect(storedNow(written)?.sessionId).toBe(SESSION)
    const ran = await $.command.run({ command: 'plan-review', args: 'restore', ...RUN })
    expect(ran.text ?? '').toContain('plan v2 restored')
    const after = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await after.find({ text: /Session refresh for the auth module/ })).toBeDefined()
    expect(await after.find({ text: /Keep it smaller\./ })).toBeDefined()
    await after.unmount()
    expect(storedNow(written)?.sessionId).toBe('session-b')
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(storedNow(written)).toBe(null)
  })

  test('a stored review whose plan file is gone is reported, not restored', async ($, on) => {
    const { data: seen, written } = beneath(on, 'session-b')
    const record = buildStored(input({ sessionId: SESSION, review: { ...input().review, planFilePath: `${CWD}/plans/no-such-plan.md`, recordPath: '' } }))
    seed(written, seen, record)
    const ran = await $.command.run({ command: 'plan-review', args: 'restore', ...RUN })
    expect(ran.text ?? '').toContain('plan file is gone')
    expect(storedNow(written)).not.toBe(null)
    const demo = await $.command.run({ command: 'plan-review', args: 'demo', ...RUN })
    expect(demo.text ?? '').toContain('demo plan opened')
    expect(storedNow(written)).toBe(null)
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
  })
})
