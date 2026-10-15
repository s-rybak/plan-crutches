import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEMO_PLAN } from '../hooks/demo-plan'
import { newestPlanFile, openArgument, resolvePlanPath } from '../hooks/open-plan'
import type { FolderEntry } from '../hooks/open-plan'
import { STORE_INDEX_KEY, parseIndex, parseStored, storeKey } from '../hooks/persist'

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
const FIXTURE = 'fixtures/demo-plan.md'
const FIXTURE_PATH = `${CWD}/${FIXTURE}`
const PLANS_DIR = `${HOME}/.claude/plans`
const OTHER_PATH = `${PLANS_DIR}/other-plan.md`
const NEWEST_PATH = `${PLANS_DIR}/newest-plan.md`
const LOCKED_PATH = `${CWD}/locked.md`

/** The plans folder as the engine lists it: the newest plan last changed, beside an older plan, a folder and a text file. */
const PLANS: FolderEntry[] = [
  { name: 'other-plan.md', kind: 'file', mtimeMs: 1_000 },
  { name: 'newest-plan.md', kind: 'file', mtimeMs: 2_000 },
  { name: 'notes.txt', kind: 'file', mtimeMs: 3_000 },
  { name: 'drafts', kind: 'dir', mtimeMs: 4_000 },
]

const OTHER_PLAN = `# Rename the greeting

Rename \`greet\` to \`hello\` and keep the export.

\`\`\`plan-crutches
{
  "title": "Rename the greeting",
  "summary": "Rename greet to hello.",
  "files": [
    {
      "path": "src/greet.ts",
      "status": "modified",
      "description": "Rename the function.",
      "symbols": [
        { "name": "hello", "kind": "function", "signature": "export function hello(name: string): string {", "description": "The renamed greeting." }
      ]
    }
  ]
}
\`\`\`
`

const NEWEST_PLAN = `# Add a logout button

Add a logout button to the header.

\`\`\`plan-crutches
{
  "title": "Add a logout button",
  "summary": "A button in the header ends the session.",
  "files": [
    {
      "path": "src/header.ts",
      "status": "modified",
      "description": "Add the button.",
      "symbols": [
        { "name": "logoutButton", "kind": "function", "signature": "export function logoutButton(): HTMLButtonElement {", "description": "The button that ends the session." }
      ]
    }
  ]
}
\`\`\`
`

/**
 * The world beneath the mod, registered before the test's first `$` call: a
 * store in memory, a fixed folder and session id, a file system that holds
 * the fixture plan (at its path under the project folder), two plans under
 * the home folder's plans folder (listed as `plans`), one file that exists
 * but cannot be read, and answers for the calls the command makes. Nothing
 * touches the disk.
 */
function beneath(on: On, plans: readonly FolderEntry[] = PLANS): { data: Record<string, unknown>; written: Record<string, string> } {
  mock.clock(on)
  mock.env(on, { HOME })
  const data: Record<string, unknown> = {}
  const written: Record<string, string> = {}
  const files: Record<string, string> = { [FIXTURE_PATH]: DEMO_PLAN, [OTHER_PATH]: OTHER_PLAN, [NEWEST_PATH]: NEWEST_PLAN }
  const listed = plans.map(entry => ({ ...entry, size: 0, isLink: false }))
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
  on('session.id', async () => ({ value: SESSION }))
  on('command.register', async () => ({ value: { command: 'plan-review' } }))
  on('agent.register', async () => ({ value: { agent: 'plan-crutches:diagram' } }))
  on('fs.exists', async (_$, e) => ({ value: e.path in files || e.path === LOCKED_PATH || e.path in written || (e.path === PLANS_DIR && plans.length > 0) }))
  on('fs.list', async (_$, e) => (e.path === PLANS_DIR && plans.length > 0 ? { value: listed } : { deny: `ENOENT: no such directory ${e.path}` }))
  on('fs.read', async (_$, e) => {
    if (e.path === LOCKED_PATH) return { deny: 'EACCES: permission denied' }
    return { value: files[e.path] ?? written[e.path] ?? '' }
  })
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

describe('open command helpers', () => {
  test('reads the open form of the arguments and keeps the path as typed', async () => {
    expect(openArgument('open fixtures/Demo-Plan.md')).toEqual({ isOpen: true, path: 'fixtures/Demo-Plan.md' })
    expect(openArgument('  OPEN   "/a b/plan.md"  ')).toEqual({ isOpen: true, path: '/a b/plan.md' })
    expect(openArgument("open '~/.claude/plans/x.md'")).toEqual({ isOpen: true, path: '~/.claude/plans/x.md' })
    expect(openArgument('open')).toEqual({ isOpen: true, path: '' })
    expect(openArgument('opener')).toEqual({ isOpen: false, path: '' })
    expect(openArgument('demo')).toEqual({ isOpen: false, path: '' })
    expect(openArgument('')).toEqual({ isOpen: false, path: '' })
  })

  test('puts a typed path under the project folder, the home folder or the root', async () => {
    expect(resolvePlanPath('plans/x.md', '/work/app', '/home/me')).toBe('/work/app/plans/x.md')
    expect(resolvePlanPath('./a/../plans/x.md', '/work/app/', '/home/me')).toBe('/work/app/plans/x.md')
    expect(resolvePlanPath('~/.claude/plans/x.md', '/work/app', '/home/me/')).toBe('/home/me/.claude/plans/x.md')
    expect(resolvePlanPath('/abs/x.md', '/work/app', '/home/me')).toBe('/abs/x.md')
    expect(resolvePlanPath('/abs//y/./x.md', '/work/app', '/home/me')).toBe('/abs/y/x.md')
    expect(resolvePlanPath('Plans/X.md', '/work/app', '/home/me')).toBe('/work/app/Plans/X.md')
  })

  test('picks the newest plan file of a folder and skips folders and other files', async () => {
    expect(newestPlanFile('/home/me/.claude/plans/', PLANS)).toBe('/home/me/.claude/plans/newest-plan.md')
    expect(newestPlanFile('/p', [{ name: 'a.md', kind: 'file', mtimeMs: 5 }, { name: 'b.md', kind: 'file', mtimeMs: 5 }])).toBe('/p/a.md')
    expect(newestPlanFile('/p', [{ name: 'drafts', kind: 'dir', mtimeMs: 9 }, { name: 'notes.txt', kind: 'file', mtimeMs: 9 }])).toBeUndefined()
    expect(newestPlanFile('/p', [])).toBeUndefined()
  })
})

describe('a plan opened from a file', () => {
  test('opens the fixture as a real review: the pane shows it, the store and the record hold it', async ($, on) => {
    const { data: seen, written } = beneath(on)
    const ran = await $.command.run({ command: 'plan-review', args: `open ${FIXTURE}`, ...RUN })
    expect(ran.text ?? '').toContain(`plan v1 opened from ${FIXTURE_PATH}`)
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await ui.find({ text: /Session refresh for the auth module/ })).toBeDefined()
    expect(await ui.find({ key: 'row:file:src/auth/session.ts' })).toBeDefined()
    await ui.press({ key: 'plan-comment' })
    await ui.input({ key: 'input:plan', text: 'Keep it smaller.' })
    expect(await ui.find({ text: /Keep it smaller\./ })).toBeDefined()
    await ui.unmount()
    const stored = parseStored(seen[storeKey(CWD)])
    expect(stored).not.toBe(null)
    expect(stored?.sessionId).toBe(SESSION)
    expect(stored?.review.status).toBe('reviewing')
    expect(stored?.review.version).toBe(1)
    expect(stored?.review.isDemo).toBeUndefined()
    expect(stored?.review.planFilePath).toBe(FIXTURE_PATH)
    expect(stored?.plan.title).toBe('Session refresh for the auth module')
    expect(stored?.comments.map(one => one.text)).toEqual(['Keep it smaller.'])
    expect(parseIndex(seen[STORE_INDEX_KEY]).map(one => one.cwd)).toEqual([CWD])
    const recordPath = Object.keys(written).find(path => path.startsWith(`${CWD}/docs/plans/`))
    expect(recordPath).toBeDefined()
    expect(written[recordPath ?? ''] ?? '').toContain(`Plan file: ${FIXTURE_PATH}`)
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(seen[storeKey(CWD)]).toBeUndefined()
  })

  test('the same file again is the next version and keeps the comments; another file starts over', async ($, on) => {
    const { data: seen } = beneath(on)
    await $.command.run({ command: 'plan-review', args: `open ${FIXTURE}`, ...RUN })
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    await ui.press({ key: 'plan-comment' })
    await ui.input({ key: 'input:plan', text: 'Keep it smaller.' })
    await ui.unmount()
    const again = await $.command.run({ command: 'plan-review', args: `open ./${FIXTURE}`, ...RUN })
    expect(again.text ?? '').toContain(`plan v2 opened from ${FIXTURE_PATH}`)
    let stored = parseStored(seen[storeKey(CWD)])
    expect(stored?.review.version).toBe(2)
    expect(stored?.review.history.map(line => line.slice(0, 11))).toEqual(['v1 received', 'v2 received'])
    expect(stored?.comments.map(one => one.text)).toEqual(['Keep it smaller.'])
    const other = await $.command.run({ command: 'plan-review', args: 'open ~/.claude/plans/other-plan.md', ...RUN })
    expect(other.text ?? '').toContain(`plan v1 opened from ${OTHER_PATH}`)
    stored = parseStored(seen[storeKey(CWD)])
    expect(stored?.review.version).toBe(1)
    expect(stored?.review.planFilePath).toBe(OTHER_PATH)
    expect(stored?.plan.title).toBe('Rename the greeting')
    expect(stored?.comments).toEqual([])
    const pane = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    expect(await pane.find({ text: /Rename the greeting/ })).toBeDefined()
    expect(await pane.find({ key: 'row:file:src/greet.ts' })).toBeDefined()
    await pane.unmount()
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(seen[storeKey(CWD)]).toBeUndefined()
  })

  test('refuses a missing, unreadable or unnamed file and keeps the live review', async ($, on) => {
    const { data: seen } = beneath(on)
    await $.command.run({ command: 'plan-review', args: `open ${FIXTURE}`, ...RUN })
    const missing = await $.command.run({ command: 'plan-review', args: 'open plans/no-such-plan.md', ...RUN })
    expect(missing.text ?? '').toContain(`no file at ${CWD}/plans/no-such-plan.md`)
    const cased = await $.command.run({ command: 'plan-review', args: 'open Fixtures/Demo-Plan.md', ...RUN })
    expect(cased.text ?? '').toContain(`no file at ${CWD}/Fixtures/Demo-Plan.md`)
    const locked = await $.command.run({ command: 'plan-review', args: 'open locked.md', ...RUN })
    expect(locked.text ?? '').toContain(`could not read ${LOCKED_PATH}`)
    const stored = parseStored(seen[storeKey(CWD)])
    expect(stored?.review.version).toBe(1)
    expect(stored?.review.planFilePath).toBe(FIXTURE_PATH)
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(seen[storeKey(CWD)]).toBeUndefined()
  })
})

describe('a plan found without a path', () => {
  test('with nothing under review, opens the newest plan file of the plans folder', async ($, on) => {
    const { data: seen } = beneath(on)
    const ran = await $.command.run({ command: 'plan-review', args: 'open', ...RUN })
    expect(ran.text ?? '').toContain(`plan v1 opened from ${NEWEST_PATH}, the newest file under ~/.claude/plans`)
    const stored = parseStored(seen[storeKey(CWD)])
    expect(stored?.review.planFilePath).toBe(NEWEST_PATH)
    expect(stored?.plan.title).toBe('Add a logout button')
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(seen[storeKey(CWD)]).toBeUndefined()
  })

  test('opens the plan file plan mode named, not the newest one', async ($, on) => {
    const { data: seen } = beneath(on)
    await $.prompt.attachment({ type: 'plan_mode', origin: { kind: 'engine' }, text: 'Plan mode is on.', detail: { reminder: 'full', planFilePath: OTHER_PATH, hasPlan: true } })
    const ran = await $.command.run({ command: 'plan-review', args: 'OPEN', ...RUN })
    expect(ran.text ?? '').toContain(`plan v1 opened from ${OTHER_PATH}, the plan file of this session`)
    const stored = parseStored(seen[storeKey(CWD)])
    expect(stored?.review.planFilePath).toBe(OTHER_PATH)
    expect(stored?.plan.title).toBe('Rename the greeting')
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(seen[storeKey(CWD)]).toBeUndefined()
  })

  test('the file of the live review comes first and keeps the comments; the file plan mode names becomes the next version', async ($, on) => {
    const { data: seen } = beneath(on)
    await $.command.run({ command: 'plan-review', args: `open ${FIXTURE}`, ...RUN })
    const ui = await $.ui.mount({ plugin: 'plan-crutches', surface: 'desktop', ...PANE })
    await ui.press({ key: 'plan-comment' })
    await ui.input({ key: 'input:plan', text: 'Keep it smaller.' })
    await ui.unmount()
    const again = await $.command.run({ command: 'plan-review', args: 'open', ...RUN })
    expect(again.text ?? '').toContain(`plan v2 opened from ${FIXTURE_PATH}, the plan file of this session`)
    let stored = parseStored(seen[storeKey(CWD)])
    expect(stored?.review.version).toBe(2)
    expect(stored?.comments.map(one => one.text)).toEqual(['Keep it smaller.'])
    // Plan mode names another file: as with ExitPlanMode, it is the next version of the live review.
    await $.prompt.attachment({ type: 'plan_mode', origin: { kind: 'engine' }, text: 'Plan mode is on.', detail: { reminder: 'sparse', planFilePath: OTHER_PATH, hasPlan: true } })
    const other = await $.command.run({ command: 'plan-review', args: 'open', ...RUN })
    expect(other.text ?? '').toContain(`plan v3 opened from ${OTHER_PATH}, the plan file of this session`)
    stored = parseStored(seen[storeKey(CWD)])
    expect(stored?.review.version).toBe(3)
    expect(stored?.plan.title).toBe('Rename the greeting')
    expect(stored?.comments.map(one => one.text)).toEqual(['Keep it smaller.'])
    await $.command.run({ command: 'plan-review', args: 'reset', ...RUN })
    expect(seen[storeKey(CWD)]).toBeUndefined()
  })

  test('says so when there is no plan to find', async ($, on) => {
    const { data: seen } = beneath(on, [])
    const none = await $.command.run({ command: 'plan-review', args: 'open', ...RUN })
    expect(none.text ?? '').toContain('no plan found')
    expect(none.text ?? '').toContain('/plan-review open <path>')
    expect(seen[storeKey(CWD)]).toBeUndefined()
  })
})
