#!/usr/bin/env node
// Plan Crutches review server. The mod starts it with $.process.spawn and
// talks to it two ways: it POSTs the whole review state to /api/state, and it
// reads this process's stdout, where every browser action is one JSON line.
// The page gets the state over Server-Sent Events and posts actions back.
// No dependencies: node:http and node:fs only.

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const env = process.env
const HOST = env.PLAN_CRUTCHES_HOST || '127.0.0.1'
const WANTED_PORT = Number(env.PLAN_CRUTCHES_PORT || 0) || 0
const WEB_DIR = path.resolve(env.PLAN_CRUTCHES_WEB || path.join(here, '..', 'web'))
const PROJECT_DIR = path.resolve(env.PLAN_CRUTCHES_PROJECT || process.cwd())
const TOKEN = env.PLAN_CRUTCHES_TOKEN || crypto.randomBytes(16).toString('hex')
const IDLE_MS = Number(env.PLAN_CRUTCHES_IDLE_MS || 0) || 0
const DEMO_STATE = env.PLAN_CRUTCHES_DEMO || ''
const MAX_BODY = 64 * 1024 * 1024

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const EMPTY_STATE = {
  plan: null,
  review: { status: 'idle', version: 0, parsedFrom: 'none', warnings: [], history: [], previousPaths: [] },
  comments: [],
  bodies: {},
  qa: [],
  canvas: { nodes: [], edges: [], strokes: [] },
  files: {},
  lang: 'en',
  summaryLimit: 9000,
  cwd: PROJECT_DIR,
  generatedAt: new Date().toISOString(),
}

let state = EMPTY_STATE
let lastContact = Date.now()
const clients = new Set()
let noticeCounter = 0

function emit(message) {
  try {
    process.stdout.write(JSON.stringify(message) + '\n')
  } catch {
    process.exit(0)
  }
}

process.stdout.on('error', () => process.exit(0))

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

function tokenOf(req, url) {
  return req.headers['x-plan-crutches-token'] || url.searchParams.get('t') || ''
}

function authorized(req, url) {
  const given = tokenOf(req, url)
  if (given.length !== TOKEN.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function broadcast() {
  const data = `event: state\ndata: ${JSON.stringify(state)}\n\n`
  for (const res of clients) {
    try {
      res.write(data)
    } catch {
      clients.delete(res)
    }
  }
}

function setState(next) {
  state = { ...EMPTY_STATE, ...next, cwd: next.cwd || PROJECT_DIR }
  broadcast()
}

function insideDir(dir, target) {
  const relative = path.relative(dir, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function serveFile(res, dir, relativePath) {
  const target = path.resolve(dir, '.' + path.posix.normalize('/' + relativePath))
  if (!insideDir(dir, target)) return send(res, 403, 'forbidden')
  let stat
  try {
    stat = await fsp.stat(target)
  } catch {
    return send(res, 404, 'not found')
  }
  if (!stat.isFile()) return send(res, 404, 'not found')
  const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': stat.size })
  fs.createReadStream(target).pipe(res)
}

function openEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(`retry: 1500\n\n`)
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`)
  clients.add(res)
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      clearInterval(beat)
      clients.delete(res)
    }
  }, 25000)
  req.on('close', () => {
    clearInterval(beat)
    clients.delete(res)
  })
}

// Standalone mode: with PLAN_CRUTCHES_DEMO the server answers actions itself,
// so the page can be tried without the mod. The real mod never sets it.
function handleDemoAction(action) {
  const id = () => Math.random().toString(36).slice(2, 10)
  const now = () => new Date().toISOString()
  switch (action.type) {
    case 'comment':
      state.comments = [...state.comments, { id: id(), target: action.target || {}, text: action.text, createdInVersion: state.review.version }]
      break
    case 'deleteComment':
      state.comments = state.comments.filter(one => one.id !== action.id)
      break
    case 'setLang':
      state.lang = action.lang === 'uk' ? 'uk' : 'en'
      break
    case 'canvas':
      state.canvas = action.canvas
      break
    case 'canvasSvg':
      state.review = { ...state.review, canvasSvgPath: '(demo) diagram.svg' }
      break
    case 'generateBody': {
      const key = `${action.path}#${action.symbol}`
      state.bodies = { ...state.bodies, [key]: { status: 'loading' } }
      setTimeout(() => {
        state.bodies = {
          ...state.bodies,
          [key]: { status: 'ready', code: `// demo body for ${action.symbol}\nexport function ${action.symbol}() {\n  // generated by the model in the real flow\n  return null\n}` },
        }
        state.generatedAt = now()
        broadcast()
      }, 700)
      break
    }
    case 'ask': {
      const item = { id: id(), question: action.question, status: 'asking', ...(action.focus ? { focus: action.focus } : {}) }
      state.qa = [...state.qa, item]
      setTimeout(() => {
        state.qa = state.qa.map(one => (one.id === item.id ? { ...one, status: 'done', answer: `**Demo answer.** In the real flow Claude answers from the plan and the session.\n\nYou asked: _${action.question}_` } : one))
        state.generatedAt = now()
        broadcast()
      }, 700)
      break
    }
    case 'submit': {
      const pending = state.comments.filter(one => one.sentInVersion === undefined && one.resolvedInVersion === undefined)
      noticeCounter += 1
      state.notice = { id: noticeCounter, text: pending.length ? `Demo: ${pending.length} comments would go to Claude as a revision request.` : 'Demo: the plan would be approved.' }
      break
    }
    default:
      break
  }
  state.generatedAt = now()
  broadcast()
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)

  if (pathname.startsWith('/api/')) {
    if (!authorized(req, url)) return send(res, 401, { error: 'bad token' })
    if (pathname === '/api/ping') {
      lastContact = Date.now()
      return send(res, 200, { ok: true, clients: clients.size })
    }
    if (pathname === '/api/state' && req.method === 'GET') return send(res, 200, state)
    if (pathname === '/api/state' && req.method === 'POST') {
      lastContact = Date.now()
      try {
        const body = JSON.parse(await readBody(req))
        if (!body || typeof body !== 'object') return send(res, 400, { error: 'state must be an object' })
        setState(body)
        return send(res, 200, { ok: true, clients: clients.size })
      } catch (error) {
        return send(res, 400, { error: String(error) })
      }
    }
    if (pathname === '/api/events') return openEvents(req, res)
    if (pathname === '/api/action' && req.method === 'POST') {
      try {
        const action = JSON.parse(await readBody(req))
        if (!action || typeof action.type !== 'string') return send(res, 400, { error: 'action.type is required' })
        if (DEMO_STATE) handleDemoAction(action)
        emit({ type: 'action', action })
        return send(res, 202, { accepted: true })
      } catch (error) {
        return send(res, 400, { error: String(error) })
      }
    }
    return send(res, 404, { error: 'no such route' })
  }

  if (pathname.startsWith('/project/')) {
    if (!authorized(req, url)) return send(res, 401, 'bad token')
    return serveFile(res, PROJECT_DIR, pathname.slice('/project/'.length))
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed')
  const file = pathname === '/' ? 'index.html' : pathname.slice(1)
  return serveFile(res, WEB_DIR, file)
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    emit({ type: 'log', text: `request failed: ${String(error)}` })
    try {
      send(res, 500, 'internal error')
    } catch {
      // the response is gone
    }
  })
})

server.keepAliveTimeout = 65000

function listen(port) {
  server.once('error', error => {
    if (error && error.code === 'EADDRINUSE' && port !== 0) {
      emit({ type: 'log', text: `port ${port} is taken; using a free one` })
      listen(0)
      return
    }
    emit({ type: 'fatal', text: String(error) })
    process.exit(1)
  })
  server.listen(port, HOST, () => {
    const address = server.address()
    const actual = typeof address === 'object' && address ? address.port : port
    emit({ type: 'listening', host: HOST, port: actual, token: TOKEN, url: `http://${HOST}:${actual}` })
  })
}

if (DEMO_STATE) {
  try {
    setState(JSON.parse(fs.readFileSync(DEMO_STATE, 'utf8')))
  } catch (error) {
    emit({ type: 'log', text: `demo state not loaded: ${String(error)}` })
  }
}

if (IDLE_MS > 0) {
  setInterval(() => {
    if (Date.now() - lastContact > IDLE_MS) {
      emit({ type: 'log', text: 'no contact from the mod; exiting' })
      process.exit(0)
    }
  }, Math.min(IDLE_MS, 30000)).unref()
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    for (const res of clients) res.end()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500).unref()
  })
}

listen(WANTED_PORT)
