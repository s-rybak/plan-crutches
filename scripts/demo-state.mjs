// Builds a review snapshot from the demo plan so the page can be tried without
// the mod:  node scripts/demo-state.mjs > /tmp/state.json
//           PLAN_CRUTCHES_DEMO=/tmp/state.json node server/index.mjs
// The snapshot is version 2 of the plan, with a made-up version 1 behind it,
// so the version list, the compare view and the restore can be tried too.
// Node strips the types of the imported .ts files itself (Node 22.6+ / 23.6+).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlan } from '../hooks/plan-parser.ts'
import { DEMO_PLAN } from '../hooks/demo-plan.ts'
import { deletedDiff, newFileStub, stubDiff } from '../hooks/diff.ts'
import { WEB_PROTOCOL } from '../hooks/state.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const demoSrc = path.join(here, '..', 'fixtures', 'demo-src')

const parsed = parsePlan(DEMO_PLAN)
if (!parsed.ok) {
  console.error('demo plan did not parse:', parsed.reason)
  process.exit(1)
}
const plan = parsed.plan
const files = {}
for (const file of plan.files) {
  if (file.status === 'new') {
    files[file.path] = { loaded: true, view: { format: 'source', text: newFileStub(file), startLine: 1 } }
    continue
  }
  const onDisk = path.join(demoSrc, file.path)
  if (!fs.existsSync(onDisk)) {
    files[file.path] = { loaded: true, content: null, missing: true }
    continue
  }
  const content = fs.readFileSync(onDisk, 'utf8')
  files[file.path] = { loaded: true, content, view: { format: 'diff', text: file.status === 'deleted' ? deletedDiff(content) : stubDiff(content, file) } }
}

/** Version 1 as it might have been: a shorter summary, one symbol and one file fewer, one file the next version dropped. */
function earlierVersion(current) {
  const earlier = JSON.parse(JSON.stringify(current))
  earlier.summary = earlier.summary.replace('within 60 seconds of expiry', 'within 30 seconds of expiry').replace(/\n\nRisks:[^\n]*$/, '')
  const session = earlier.files.find(file => file.path === 'src/auth/session.ts')
  session.symbols = session.symbols.filter(symbol => symbol.name !== 'isExpiringSoon')
  const user = earlier.files.find(file => file.path === 'src/auth/user.ts')
  user.description = 'Refresh the session before returning the current user.'
  const current_ = user.symbols.find(symbol => symbol.name === 'getCurrentUser')
  current_.description = 'Returns the current user after a refresh.'
  user.symbols = user.symbols.filter(symbol => symbol.name !== 'displayNameOf')
  earlier.files = earlier.files.filter(file => file.path !== 'docs/auth.md')
  earlier.files.push({
    path: 'src/auth/middleware.ts',
    status: 'modified',
    description: 'Guard the refresh route with the refresh cookie.',
    symbols: [{ name: 'requireRefreshCookie', kind: 'function', signature: 'export function requireRefreshCookie(request: Request): void {', description: 'Rejects a refresh without the cookie.', anchor: 'after requireSession' }],
  })
  return earlier
}

const first = earlierVersion(plan)
const receivedAt = index => new Date(Date.now() - (2 - index) * 3_600_000).toISOString()

const state = {
  plan,
  review: { status: 'reviewing', version: 2, parsedFrom: 'block', warnings: parsed.warnings, history: [`v1 received (demo) ${receivedAt(1)}`, `v1 sent back with 2 comments (demo)`, `v2 received (demo) ${receivedAt(2)}`], previousPaths: first.files.map(file => file.path), isDemo: true },
  comments: [
    { id: 'demo-c1', target: { path: 'src/auth/session.ts' }, text: 'Add a helper that says when the token is about to expire.', createdInVersion: 1, sentInVersion: 1, resolvedInVersion: 2 },
    { id: 'demo-c2', target: {}, text: 'The middleware change belongs to another task.', createdInVersion: 1, sentInVersion: 1, resolvedInVersion: 2 },
  ],
  bodies: {},
  qa: [],
  diagram: { status: 'idle', callers: {} },
  files,
  ok: {},
  explanations: {},
  versions: [
    { version: 1, receivedAt: receivedAt(1), title: first.title, fileCount: first.files.length, source: 'received', path: '' },
    { version: 2, receivedAt: receivedAt(2), title: plan.title, fileCount: plan.files.length, source: 'received', path: '' },
  ],
  compare: { version: 1, plan: first },
  // The server answers viewVersion, compareWith and restoreVersion from these in demo mode.
  demoPlans: { 1: first, 2: plan },
  lang: process.env.PLAN_CRUTCHES_LANG || 'en',
  summaryLimit: 9000,
  cwd: path.resolve(here, '..'),
  generatedAt: new Date().toISOString(),
  protocol: WEB_PROTOCOL,
}
process.stdout.write(JSON.stringify(state, null, 2))
