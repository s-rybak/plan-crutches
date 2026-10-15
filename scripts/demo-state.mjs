// Builds a review snapshot from the demo plan so the page can be tried without
// the mod:  node scripts/demo-state.mjs > /tmp/state.json
//           PLAN_CRUTCHES_DEMO=/tmp/state.json node server/index.mjs
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

const state = {
  plan,
  review: { status: 'reviewing', version: 1, parsedFrom: 'block', warnings: parsed.warnings, history: ['v1 received (demo)'], previousPaths: [], isDemo: true },
  comments: [],
  bodies: {},
  qa: [],
  diagram: { status: 'idle', callers: {} },
  files,
  lang: process.env.PLAN_CRUTCHES_LANG || 'en',
  summaryLimit: 9000,
  cwd: path.resolve(here, '..'),
  generatedAt: new Date().toISOString(),
  protocol: WEB_PROTOCOL,
}
process.stdout.write(JSON.stringify(state, null, 2))
