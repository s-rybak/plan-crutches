// Runs the page server alone with the demo plan, for a look at the page without
// the mod:  node scripts/demo-server.mjs   then open http://127.0.0.1:4818/?t=demo
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const stateFile = path.join(os.tmpdir(), `plan-crutches-demo-${process.pid}.json`)
const state = execFileSync(process.execPath, [path.join(here, 'demo-state.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
fs.writeFileSync(stateFile, state)

process.env.PLAN_CRUTCHES_DEMO = stateFile
process.env.PLAN_CRUTCHES_PORT = process.env.PLAN_CRUTCHES_PORT || '4818'
process.env.PLAN_CRUTCHES_TOKEN = process.env.PLAN_CRUTCHES_TOKEN || 'demo'
process.env.PLAN_CRUTCHES_PROJECT = path.join(here, '..', 'fixtures', 'demo-src')
process.on('exit', () => {
  try {
    fs.unlinkSync(stateFile)
  } catch {
    // already gone
  }
})
await import('../server/index.mjs')
