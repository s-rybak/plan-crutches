// Takes the screenshots of the landing page (docs/assets/*.webp) from the demo
// plan:  node scripts/landing-shots.mjs [light|dark|both]
// It starts the demo server on its own port, drives the page in the installed
// Google Chrome (headless, through the DevTools protocol) and writes one WebP
// file per shot and theme. It needs cwebp on the PATH; CHROME can name another
// Chrome or Chromium binary. The Ask and Explain answers are sample texts below,
// because the demo server answers with placeholders instead of calling the model.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '..')
const assets = path.join(project, 'docs', 'assets')
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.LANDING_SHOTS_PORT || 4821)
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'demo'
const themes = process.argv[2] === 'light' ? ['light'] : process.argv[2] === 'dark' ? ['dark'] : ['light', 'dark']

const TEXTS = {
  commentTokens: 'Keep the exports for one release and mark them deprecated: the mobile client still imports loadTokens.',
  commentMargin: 'Read the margin from the auth config instead of a default parameter.',
  commentRefresh: 'When the refresh fails, clear the session and return null, so the caller can redirect to the login page with the message.',
  question: 'What happens when two components call this at the same time while the token is expiring?',
  answer:
    'Both calls reach `refreshSession` for the same user. The plan keeps a cache of refresh promises in `src/auth/session.ts`: the first call stores its promise, the second call gets the same promise and waits on it. One request goes to `POST /auth/refresh`, both callers get the same new session, and the refresh token is used once.\n\n' +
    'The cache lives in one process. Two server instances still refresh on their own, which is why the summary names Redis as a later step.',
  followup: 'And if that one refresh fails?',
  followupAnswer:
    'The shared promise rejects for both callers, and `refreshSession` drops it from the cache so the next call tries again. `getCurrentUser` turns the rejection into `null`, and the page sends the user to the login screen with the message from the acceptance criteria.\n\n' +
    'The plan does not say where the message text comes from. That is worth a comment.',
  explanation:
    '**What.** The new signature of `getCurrentUser`. The return type stays `Promise<User | null>`, so every caller compiles as before. The body changes: before `loadUser`, it calls `isExpiringSoon(session, Date.now())` and awaits `refreshSession(session.userId)` when the token is about to expire.\n\n' +
    '**Where.** `src/auth/user.ts`, line 16 today, between `loadUser` and `displayNameOf`. It is called from `handleMe` in `src/api/handlers.ts` and from the `Header`, `Profile` and `ProfileMenu` components under `src/ui/`. The session comes from `readSession` in `./storage`.\n\n' +
    '**Why.** Today the function trusts a session that can expire a moment later, which is the logout after 15 minutes from AUTH-42. One refresh here covers every caller, so no component needs to know about tokens.',
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function have(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---------- the demo server ----------

async function startDemoServer() {
  const child = spawn(process.execPath, [path.join(here, 'demo-server.mjs')], {
    env: { ...process.env, PLAN_CRUTCHES_PORT: String(PORT), PLAN_CRUTCHES_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  child.stdout.on('data', () => {})
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/ping?t=${TOKEN}`)
      if (res.ok) return child
    } catch {
      // not up yet
    }
    await sleep(100)
  }
  child.kill()
  throw new Error(`the demo server did not answer on port ${PORT}`)
}

const api = async (route, init = {}) => {
  const res = await fetch(`${BASE}${route}${route.includes('?') ? '&' : '?'}t=${TOKEN}`, {
    ...init,
    headers: { 'x-plan-crutches-token': TOKEN, 'content-type': 'application/json', ...(init.headers || {}) },
  })
  if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`)
  return res.json()
}

/** Edits the live state in place, as the mod would push it. */
const pushState = async mutate => {
  const state = await api('/api/state')
  mutate(state)
  await api('/api/state', { method: 'POST', body: JSON.stringify(state) })
  await sleep(500)
}

// ---------- Chrome over the DevTools protocol ----------

async function launchChrome({ port, profile }) {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME to the binary`)
  const proc = spawn(
    CHROME,
    ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu', '--force-device-scale-factor=2', '--window-size=1440,900', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )
  let version
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      break
    } catch {
      await sleep(100)
    }
  }
  if (!version) {
    proc.kill()
    throw new Error('Chrome did not start')
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    } else if (message.method) {
      for (const listener of listeners) listener(message)
    }
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  const waitEvent = (method, sessionId, timeout = 20000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener)
        reject(new Error(`timeout waiting for ${method}`))
      }, timeout)
      const listener = message => {
        if (message.method === method && (!sessionId || message.sessionId === sessionId)) {
          clearTimeout(timer)
          listeners.delete(listener)
          resolve(message.params)
        }
      }
      listeners.add(listener)
    })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => send(method, params, sessionId)
  await call('Page.enable')
  await call('Runtime.enable')
  return {
    call,
    async viewport(width, height, dark) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
      await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
    },
    async goto(url) {
      const loaded = waitEvent('Page.loadEventFired', sessionId)
      await call('Page.navigate', { url })
      await loaded
    },
    async eval(expression) {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails))
      return result.result.value
    },
    /** Saves a PNG of the viewport, or of `clip` ({x, y, width, height} in CSS pixels of the page). */
    async shot(file, clip, pad = 0) {
      const params = { format: 'png', fromSurface: true, captureBeyondViewport: false }
      if (clip) params.clip = { x: Math.max(0, clip.x - pad), y: Math.max(0, clip.y - pad), width: clip.width + pad * 2, height: clip.height + pad * 2, scale: 1 }
      const result = await call('Page.captureScreenshot', params)
      fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
    },
    async close() {
      try {
        ws.close()
      } catch {
        // already closed
      }
      const exited = new Promise(resolve => {
        proc.once('exit', resolve)
        setTimeout(resolve, 3000).unref()
      })
      proc.kill()
      await exited
    },
  }
}

// ---------- the shots ----------

async function takeShots(theme, outDir, pristine) {
  const dark = theme === 'dark'
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-crutches-shots-'))
  const page = await launchChrome({ port: dark ? 9334 : 9333, profile })
  const file = name => path.join(outDir, `${name}.png`)
  const MAIN_DIFF = "[...document.querySelectorAll('.detail-card .code.diff')].pop()"
  const WIDE = [1280, 840]
  const TALL = [1280, 2800]

  const click = async (selector, wait = 400) => {
    const ok = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)
    if (!ok) throw new Error(`no element ${selector}`)
    await sleep(wait)
  }
  /** A mouse press and release at the element's center, for the diagram's pointer handlers. */
  const tap = async (selector, wait = 400) => {
    const rect = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    if (!rect) throw new Error(`no element ${selector}`)
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  const exists = selector => page.eval(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  const scrollTop = () => page.eval('window.scrollTo(0, 0)').then(() => sleep(250))
  const scrollUnderBar = async selector => {
    await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const bar = document.querySelector('.topbar'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - bar.offsetHeight - 12) })()`)
    await sleep(450)
  }
  /** Page-coordinate rect of a selector, or of an expression that returns an element. */
  const pageRect = async (selector, expression = false) => {
    const rect = await page.eval(`(() => { const el = ${expression ? selector : `document.querySelector(${JSON.stringify(selector)})`}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height } })()`)
    if (!rect) throw new Error(`no rect for ${selector}`)
    return rect
  }
  const union = (a, b) => {
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
  }
  const selectDiffLines = async (from, to) => {
    const ok = await page.eval(`(() => {
      const code = ${MAIN_DIFF}
      if (!code) return 'no code'
      const lines = [...code.querySelectorAll('.line.add')].filter(line => Number(line.dataset.line) >= ${from} && Number(line.dataset.line) <= ${to})
      if (lines.length < 1) return 'no lines'
      const first = lines[0].querySelector('.src')
      const last = lines[lines.length - 1].querySelector('.src')
      const range = document.createRange()
      range.setStart(first.firstChild || first, 0)
      range.setEndAfter(last.lastChild || last)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      last.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
      return 'ok'
    })()`)
    if (ok !== 'ok') throw new Error(`selectDiffLines: ${ok}`)
    await sleep(400)
    if (!(await exists('#popup:not([hidden])'))) throw new Error('the popup did not open')
  }
  const typeInPopup = async (text, send = false) => {
    await page.eval(`(() => { const ta = document.querySelector('#popup textarea'); ta.value = ${JSON.stringify(text)}; ta.focus(); ta.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await sleep(150)
    if (send) {
      await page.eval(`document.querySelector('#popup textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
      await sleep(500)
    }
  }
  const popupTab = mode => click(`#popup .ptab[data-mode="${mode}"]`, 500)
  const closePopup = async () => {
    await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(200)
  }
  const shotClip = async (name, clip, pad = 0) => {
    await page.shot(file(name), clip, pad)
    console.log(`  ${theme} ${name}`)
  }
  const shotView = async name => {
    await page.shot(file(name))
    console.log(`  ${theme} ${name}`)
  }
  const popupShot = async name => shotClip(name, union(await pageRect(MAIN_DIFF, true), await pageRect('#popup')), 12)

  try {
    await api('/api/state', { method: 'POST', body: pristine })
    await page.viewport(...WIDE, dark)
    await page.goto(`${BASE}/?t=${TOKEN}`)
    await sleep(1500)
    await page.eval(`localStorage.setItem('plan-crutches-highlight', '0')`)

    // approve: every file OK, nothing pending
    await click('[data-action="ok-toggle"][data-path="docs/"]')
    await click('[data-action="ok-toggle"][data-path="src/"]')
    await scrollTop()
    await shotClip('approve', await pageRect('header.top'))
    await click('[data-action="ok-toggle"][data-path="src/auth/"]')
    await click('[data-action="ok-toggle"][data-path="src/legacy/"]')

    // a file comment from the tree and a symbol comment from the file view
    await click('[data-action="comment-node"][data-path="src/legacy/tokens.ts"]')
    await typeInPopup(TEXTS.commentTokens, true)
    await click('.row[data-path="src/auth/session.ts"]', 600)
    await click('[data-action="comment-symbol"][data-symbol="isExpiringSoon"]')
    await typeInPopup(TEXTS.commentMargin, true)

    // the selection popup on the diff of user.ts: comment draft, ask, explain, then the comment is saved
    await page.viewport(...TALL, dark)
    await sleep(300)
    await click('.row[data-path="src/auth/user.ts"]', 600)
    await scrollTop()
    await selectDiffLines(16, 17)
    await typeInPopup(TEXTS.commentRefresh)
    await popupShot('popup-comment')
    await popupTab('ask')
    await typeInPopup(TEXTS.question, true)
    await sleep(1200)
    await pushState(state => {
      const item = state.qa.find(one => one.question === TEXTS.question)
      if (item) Object.assign(item, { status: 'done', answer: TEXTS.answer })
    })
    await sleep(300)
    await popupTab('explain')
    await sleep(1400)
    await pushState(state => {
      for (const one of Object.values(state.explanations || {})) Object.assign(one, { status: 'done', text: TEXTS.explanation })
    })
    await sleep(300)
    await popupShot('popup-explain')
    await popupTab('comment')
    await typeInPopup(TEXTS.commentRefresh, true)
    await sleep(400)
    if (await exists('#popup:not([hidden])')) await closePopup()

    // the file view: the diff section
    await scrollTop()
    {
      const card = await pageRect('.detail-card')
      const titles = await page.eval(`[...document.querySelectorAll('.detail-card .section-title')].map(el => ({ text: el.textContent.trim(), section: el.dataset.section || '', y: el.getBoundingClientRect().top + window.scrollY }))`)
      const sig = titles.find(one => one.section === 'changes')
      const comments = titles.find(one => /^Comments/i.test(one.text))
      const bottom = comments ? comments.y - 10 : card.y + card.height
      if (sig) await shotClip('diff', { x: card.x, y: sig.y - 6, width: card.width, height: bottom - (sig.y - 6) })
    }
    await shotClip('tree', await pageRect('.tree-panel'))

    // hero: the split under the floating header
    await page.viewport(...WIDE, dark)
    await sleep(300)
    await scrollUnderBar('.split')
    await shotView('hero')

    // summary editor
    await page.viewport(...TALL, dark)
    await sleep(300)
    await scrollTop()
    await click('[data-action="edit-summary"]', 500)
    await shotClip('summary-edit', await pageRect('.card.summary'))
    await click('[data-action="cancel-summary"]')

    // highlight changes against v1
    await click('[data-action="toggle-highlight"]', 600)
    await scrollTop()
    await page.viewport(...WIDE, dark)
    await sleep(300)
    await scrollUnderBar('.card.summary')
    await shotView('highlight')
    await click('[data-action="toggle-highlight"]', 400)

    // the Ask tab with the thread and a follow-up
    await page.viewport(...TALL, dark)
    await sleep(300)
    await click('.tab[data-tab="ask"]', 500)
    await click('[data-action="qa-reply-open"]', 300)
    await page.eval(`(() => { const ta = document.querySelector('textarea[data-reply]'); ta.value = ${JSON.stringify(TEXTS.followup)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
    await sleep(1300)
    await pushState(state => {
      for (const one of state.qa) for (const turn of one.followups || []) if (turn.question === TEXTS.followup) Object.assign(turn, { status: 'done', answer: TEXTS.followupAnswer })
    })
    await sleep(300)
    await scrollTop()
    {
      const main = await pageRect('main')
      await shotClip('ask', { ...main, y: main.y + 8, height: main.height - 8 })
    }

    // the diagram, at the normal viewport (the board is 72vh tall), with the callers of getCurrentUser
    await page.viewport(...WIDE, dark)
    await sleep(300)
    await click('.tab[data-tab="diagram"]', 500)
    await click('[data-d3="generate"]', 1800)
    await click('[data-d3="fit"]', 500)
    await tap('.d3-block .d3-row[data-symbol="getCurrentUser"]', 1600)
    await click('[data-d3="fit"]', 600)
    await scrollTop()
    await shotClip('diagram', await pageRect('.diagram-card'))

    // the Comments tab: states, versions, history
    await page.viewport(...TALL, dark)
    await sleep(300)
    await click('.tab[data-tab="comments"]', 500)
    await scrollTop()
    await shotClip('versions', await pageRect('main > section.card'))
  } finally {
    await page.close()
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      // Chrome may still hold a file of its profile; the folder sits under the temp dir
    }
  }
}

// ---------- main ----------

if (!have('cwebp')) {
  console.error('cwebp is not on the PATH (brew install webp); the landing page uses WebP files')
  process.exit(1)
}
const pristine = execFileSync(process.execPath, [path.join(here, 'demo-state.mjs')], { cwd: project, encoding: 'utf8' })
const demo = await startDemoServer()
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-crutches-landing-'))
try {
  fs.mkdirSync(assets, { recursive: true })
  for (const theme of themes) {
    const outDir = path.join(work, theme)
    fs.mkdirSync(outDir, { recursive: true })
    console.log(`${theme} theme`)
    await takeShots(theme, outDir, pristine)
    for (const name of fs.readdirSync(outDir)) {
      const base = path.basename(name, '.png')
      execFileSync('cwebp', ['-quiet', '-q', '82', '-m', '6', '-metadata', 'none', path.join(outDir, name), '-o', path.join(assets, `${base}-${theme}.webp`)])
    }
    if (theme === 'light' && have('sips')) {
      execFileSync('sips', ['--resampleWidth', '1280', path.join(outDir, 'hero.png'), '--out', path.join(assets, 'og.png')], { stdio: 'ignore' })
    }
  }
  console.log(`written to ${assets}`)
} finally {
  demo.kill()
  fs.rmSync(work, { recursive: true, force: true })
}
