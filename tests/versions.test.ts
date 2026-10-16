import { describe, expect, test } from 'claude-code/testing'

import { DEMO_PLAN } from '../hooks/demo-plan'
import { bodiesFile, projectDir, projectSlug, recordsDir, reviewFile, reviewsRoot, shortHash, versionFile } from '../hooks/paths'
import { parsePlan } from '../hooks/plan-parser'
import { buildSavedVersion, keepOkMarks, parseSavedVersion, pathsUnderFolder, sameFile, serializeVersion, versionEntry } from '../hooks/versions'

function demoPlan() {
  const parsed = parsePlan(DEMO_PLAN)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.plan
}

describe('review files', () => {
  test('every project gets its own folder under the shared root, by name and path hash', async () => {
    expect(reviewsRoot('/home/me/')).toBe('/home/me/.claude/plan-crutches')
    expect(shortHash('/work/app')).toBe(shortHash('/work/app'))
    expect(shortHash('/work/app')).not.toBe(shortHash('/work/app2'))
    expect(shortHash('x')).toMatch(/^[0-9a-f]{8}$/)
    expect(projectSlug('/work/My App/')).toBe(`my-app-${shortHash('/work/My App')}`)
    expect(projectDir('/home/me', '/work/app')).toBe(`/home/me/.claude/plan-crutches/app-${shortHash('/work/app')}`)
    const dir = projectDir('/home/me', '/work/app')
    expect(reviewFile(dir)).toBe(`${dir}/review.json`)
    expect(bodiesFile(dir)).toBe(`${dir}/bodies.json`)
    expect(versionFile(dir, 3)).toBe(`${dir}/versions/v3.json`)
  })

  test('the records folder follows the option: shared by default, inside the project for a relative path', async () => {
    const dir = projectDir('/home/me', '/work/app')
    expect(recordsDir('', '/work/app', '/home/me')).toBe(dir)
    expect(recordsDir('~/.claude/plan-crutches', '/work/app', '/home/me')).toBe(dir)
    expect(recordsDir('~/reviews/', '/work/app', '/home/me')).toBe(`/home/me/reviews/app-${shortHash('/work/app')}`)
    expect(recordsDir('/srv/reviews', '/work/app', '/home/me')).toBe(`/srv/reviews/app-${shortHash('/work/app')}`)
    expect(recordsDir('docs/plans', '/work/app', '/home/me')).toBe('/work/app/docs/plans')
    expect(recordsDir('docs/plans/', '/work/app/', '/home/me')).toBe('/work/app/docs/plans')
  })
})

describe('plan versions', () => {
  test('a saved version goes through its file and back, and its row names the essentials', async () => {
    const plan = demoPlan()
    const saved = buildSavedVersion({ version: 2, receivedAt: '2026-10-16T08:00:00.000Z', markdown: DEMO_PLAN, plan, parsedFrom: 'block', warnings: ['w'], source: 'restored', from: 1 })
    const back = parseSavedVersion(serializeVersion(saved))
    expect(back).toEqual(saved)
    expect(parseSavedVersion('{}')).toBe(null)
    expect(parseSavedVersion('nope')).toBe(null)
    expect(parseSavedVersion(JSON.stringify({ shape: 99, ...saved }))).toBe(null)
    const entry = versionEntry(saved, '/x/versions/v2.json')
    expect(entry).toEqual({ version: 2, receivedAt: saved.receivedAt, title: plan.title, fileCount: plan.files.length, source: 'restored', from: 1, path: '/x/versions/v2.json' })
    const plain = buildSavedVersion({ version: 1, receivedAt: 't', markdown: 'm', plan, parsedFrom: 'markdown', warnings: [], source: 'received' })
    expect(plain.from).toBeUndefined()
    expect(versionEntry(plain, '').from).toBeUndefined()
  })

  test('an OK mark survives a new version only while the file is planned the same way', async () => {
    const plan = demoPlan()
    const marks = {
      'src/auth/user.ts': { version: 1, at: 't' },
      'src/auth/session.ts': { version: 1, at: 't' },
      'docs/auth.md': { version: 1, at: 't' },
      'src/legacy/tokens.ts': { version: 1, at: 't' },
    }
    const next = JSON.parse(JSON.stringify(plan)) as typeof plan
    const user = next.files.find(file => file.path === 'src/auth/user.ts')!
    user.symbols[0]!.description = 'Something else.'
    const session = next.files.find(file => file.path === 'src/auth/session.ts')!
    session.symbols.push({ name: 'extra', kind: 'function', signature: 'export function extra(): void {', description: 'New.' })
    next.files = next.files.filter(file => file.path !== 'docs/auth.md')
    const kept = keepOkMarks(marks, plan, next)
    expect(Object.keys(kept)).toEqual(['src/legacy/tokens.ts'])
    expect(keepOkMarks(marks, null, next)).toEqual({})
    expect(sameFile(plan.files[0], plan.files[0])).toBe(true)
    expect(sameFile(plan.files[0], undefined)).toBe(false)
    expect(sameFile(plan.files[0], { ...plan.files[0]!, status: 'deleted' })).toBe(false)
  })

  test('a folder OK covers every planned file under it', async () => {
    const plan = demoPlan()
    expect(pathsUnderFolder(plan, 'src/auth/')).toEqual(['src/auth/session.ts', 'src/auth/user.ts'])
    expect(pathsUnderFolder(plan, 'src')).toEqual(['src/auth/session.ts', 'src/auth/user.ts', 'src/api/routes.ts', 'src/legacy/tokens.ts'])
    expect(pathsUnderFolder(plan, 'nothing/')).toEqual([])
  })
})
