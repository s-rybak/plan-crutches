// Checks the page server end to end with node:test:  node --test tests/server.node.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(here, '..', 'server', 'index.mjs')

function startServer(env = {}) {
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, PLAN_CRUTCHES_PORT: '0', PLAN_CRUTCHES_TOKEN: 'testtoken', PLAN_CRUTCHES_PROJECT: path.join(here, '..'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = []
  const waiters = []
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk.toString()
    const parts = buffer.split('\n')
    buffer = parts.pop()
    for (const line of parts) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      lines.push(message)
      for (const waiter of waiters.splice(0)) waiter(message)
    }
  })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  const next = () => new Promise(resolve => {
    waiters.push(resolve)
  })
  return { child, lines, next }
}

test('serves the page, syncs state and relays actions', async () => {
  const server = startServer()
  try {
    const listening = await server.next()
    assert.equal(listening.type, 'listening')
    const base = listening.url
    const headers = { 'content-type': 'application/json', 'x-plan-crutches-token': 'testtoken' }

    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Plan Review/)

    const unauthorized = await fetch(`${base}/api/state`)
    assert.equal(unauthorized.status, 401)

    const events = await fetch(`${base}/api/events?t=testtoken`)
    assert.equal(events.status, 200)
    const reader = events.body.getReader()
    const decoder = new TextDecoder()
    const readEvent = async () => {
      let text = ''
      while (!text.includes('\n\n')) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
        if (text.startsWith('retry:')) text = text.slice(text.indexOf('\n\n') + 2)
      }
      return JSON.parse(text.split('data: ')[1].split('\n')[0])
    }
    const initial = await readEvent()
    assert.equal(initial.plan, null)

    const pushed = await fetch(`${base}/api/state`, { method: 'POST', headers, body: JSON.stringify({ plan: { title: 'T', summary: '', task: { source: 'none', text: '' }, files: [] }, review: { status: 'reviewing', version: 1, parsedFrom: 'block', warnings: [], history: [], previousPaths: [] }, comments: [], lang: 'uk' }) })
    assert.equal(pushed.status, 200)
    const updated = await readEvent()
    assert.equal(updated.plan.title, 'T')
    assert.equal(updated.lang, 'uk')

    const state = await (await fetch(`${base}/api/state`, { headers })).json()
    assert.equal(state.plan.title, 'T')

    const actionPromise = server.next()
    const accepted = await fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify({ type: 'comment', target: {}, text: 'hi' }) })
    assert.equal(accepted.status, 202)
    const relayed = await actionPromise
    assert.deepEqual(relayed, { type: 'action', action: { type: 'comment', target: {}, text: 'hi' } })

    const outside = await fetch(`${base}/project/../server/index.mjs?t=testtoken`)
    assert.ok(outside.status === 403 || outside.status === 404)
    const inside = await fetch(`${base}/project/README.md?t=testtoken`)
    assert.equal(inside.status, 200)
    const traversal = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)
    assert.ok(traversal.status === 403 || traversal.status === 404)

    // fetch() refuses to set Host, so a raw request plays the rebinding site.
    const withHost = host => new Promise((resolve, reject) => {
      const request = http.request(`${base}/api/state?t=testtoken`, { headers: { host } }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on('error', reject)
      request.end()
    })
    assert.equal(await withHost('evil.example:80'), 403)
    assert.equal(await withHost(`localhost:${listening.port}`), 200)
    assert.equal(await withHost(`[::1]:${listening.port}`), 200)
    reader.cancel()
  } finally {
    server.child.kill('SIGTERM')
  }
})

test('falls back to a free port when the wanted one is taken', async () => {
  const first = startServer()
  try {
    const listening = await first.next()
    const second = startServer({ PLAN_CRUTCHES_PORT: String(listening.port) })
    try {
      let message = await second.next()
      while (message.type === 'log') message = await second.next()
      assert.equal(message.type, 'listening')
      assert.notEqual(message.port, listening.port)
    } finally {
      second.child.kill('SIGTERM')
    }
  } finally {
    first.child.kill('SIGTERM')
  }
})

test('demo mode answers the comment actions itself: add, edit a pending one only, delete', async () => {
  const demoFile = path.join(os.tmpdir(), `plan-crutches-demo-test-${process.pid}.json`)
  fs.writeFileSync(
    demoFile,
    JSON.stringify({
      review: { status: 'reviewing', version: 2, parsedFrom: 'block', warnings: [], history: [], previousPaths: [] },
      comments: [{ id: 'sent', target: {}, text: 'Old', createdInVersion: 1, sentInVersion: 1 }],
    }),
  )
  const server = startServer({ PLAN_CRUTCHES_DEMO: demoFile })
  try {
    let listening = await server.next()
    while (listening.type === 'log') listening = await server.next()
    const base = listening.url
    const headers = { 'content-type': 'application/json', 'x-plan-crutches-token': 'testtoken' }
    const post = action => fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify(action) })
    const comments = async () => (await (await fetch(`${base}/api/state`, { headers })).json()).comments

    assert.equal((await post({ type: 'comment', target: { path: 'a.ts' }, text: 'First' })).status, 202)
    let list = await comments()
    assert.deepEqual(list.map(one => one.text), ['Old', 'First'])
    const id = list[1].id
    await post({ type: 'editComment', id, text: ' Second ' })
    await post({ type: 'editComment', id: 'sent', text: 'Changed' })
    await post({ type: 'editComment', id, text: '   ' })
    list = await comments()
    assert.deepEqual(list.map(one => one.text), ['Old', 'Second'], 'the pending comment takes the trimmed text; the sent one and an empty text change nothing')
    assert.equal(list[1].createdInVersion, 2)
    await post({ type: 'deleteComment', id })
    assert.deepEqual((await comments()).map(one => one.id), ['sent'])
  } finally {
    server.child.kill('SIGTERM')
    fs.rmSync(demoFile, { force: true })
  }
})
