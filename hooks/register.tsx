import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, PluginOptions, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type {
  Canvas,
  CommentTarget,
  FileCache,
  GeneratedBody,
  Lang,
  ParsedFrom,
  PlanFile,
  PlanModel,
  PlanSymbol,
  QaItem,
  Review,
  ReviewComment,
  TaskCapture,
  UiState,
  WebNotice,
  WebSnapshot,
  WebState,
} from '../types'
import { DEMO_PLAN } from './demo-plan'
import { codeFromReply } from './diff'
import { extractJson, normalizePlan, parsePlan, planFromMarkdown, titleFromMarkdown } from './plan-parser'
import { renderPane, withoutKeys } from './pane'
import type { PaneActions, PaneModel } from './pane'
import type { SelectableProps } from './select'
import {
  BODY_SYSTEM,
  EXTRACTION_SYSTEM,
  PICK_FILES_SYSTEM,
  PLAN_BLOCK_INSTRUCTIONS,
  PLAN_BLOCK_REMINDER,
  approvePrompt,
  askMorePrompt,
  askPrompt,
  bodyPrompt,
  denyMessage,
  extractionPrompt,
  importCandidates,
  parseFileList,
  pickFilesPrompt,
  relativeImports,
  revisionPrompt,
} from './prompts'
import type { RelatedFile } from './prompts'
import { t } from './i18n'
import { recordFileName, renderRecord } from './record'
import { PANE_ID, bodyKey, newId } from './state'
import { buildSnapshot, openCommands, pageUrl, parseAction, parseServerLine, parseTarget, splitLines } from './web'
import type { WebAction } from './web'

type OpenIn = 'auto' | 'system' | 'none'
type Options = {
  language: Lang
  model: string
  bodyModel: string
  plansDir: string
  summaryLimit: number
  port: number
  openIn: OpenIn
  nodePath: string
}

const planAtom = atom<'plan-crutches', 'plan'>(
  { plugin: 'plan-crutches', key: 'plan' } as const,
  null as PlanModel | null,
)

const reviewAtom = atom<'plan-crutches', 'review'>(
  { plugin: 'plan-crutches', key: 'review' } as const,
  {
    status: 'idle',
    version: 0,
    parsedFrom: 'none',
    warnings: [],
    history: [],
    previousPaths: [],
  } as Review,
)

const commentsAtom = atom<'plan-crutches', 'comments'>(
  { plugin: 'plan-crutches', key: 'comments' } as const,
  [] as ReviewComment[],
)

const uiAtom = atom<'plan-crutches', 'ui'>(
  { plugin: 'plan-crutches', key: 'ui' } as const,
  {
    lang: 'en',
    tab: 'changes',
    view: 'tree',
    collapsed: [],
    showFullSummary: false,
    showTask: true,
    expanded: [],
  } as UiState,
)

const taskAtom = atom<'plan-crutches', 'task'>(
  { plugin: 'plan-crutches', key: 'task' } as const,
  {} as TaskCapture,
)

const lastPromptAtom = atom<'plan-crutches', 'lastPrompt'>(
  { plugin: 'plan-crutches', key: 'lastPrompt' } as const,
  '',
)

const bodiesAtom = atom<'plan-crutches', 'bodies'>(
  { plugin: 'plan-crutches', key: 'bodies' } as const,
  {} as Record<string, GeneratedBody>,
)

const qaAtom = atom<'plan-crutches', 'qa'>(
  { plugin: 'plan-crutches', key: 'qa' } as const,
  [] as QaItem[],
)

const canvasAtom = atom<'plan-crutches', 'canvas'>(
  { plugin: 'plan-crutches', key: 'canvas' } as const,
  { nodes: [], edges: [], strokes: [] } as Canvas,
)

const filesAtom = atom<'plan-crutches', 'files'>(
  { plugin: 'plan-crutches', key: 'files' } as const,
  {} as FileCache,
)

const webAtom = atom<'plan-crutches', 'web'>(
  { plugin: 'plan-crutches', key: 'web' } as const,
  {} as WebState,
)

const PANE_TITLE = 'Plan Review'
const SERVER_START_MS = 8000
const SERVER_IDLE_MS = 600_000

function readOptions(raw: PluginOptions): Options {
  const language = raw.language === 'uk' ? 'uk' : 'en'
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : 'sonnet'
  const bodyModel = typeof raw.bodyModel === 'string' && raw.bodyModel.trim() ? raw.bodyModel.trim() : 'opus'
  const plansDir =
    typeof raw.plansDir === 'string' && raw.plansDir.trim() ? raw.plansDir.trim().replace(/^\/+|\/+$/g, '') : 'docs/plans'
  const summaryLimit = typeof raw.summaryLimit === 'number' && raw.summaryLimit > 200 ? Math.floor(raw.summaryLimit) : 9000
  const port = typeof raw.port === 'number' && raw.port >= 0 && raw.port <= 65535 ? Math.floor(raw.port) : 4817
  const openIn: OpenIn = raw.openIn === 'system' || raw.openIn === 'none' ? raw.openIn : 'auto'
  const nodePath = typeof raw.nodePath === 'string' ? raw.nodePath.trim() : ''
  return { language, model, bodyModel, plansDir, summaryLimit, port, openIn, nodePath }
}

const EMPTY_REVIEW: Review = { status: 'idle', version: 0, parsedFrom: 'none', warnings: [], history: [], previousPaths: [] }

function freshUi(previous: UiState): UiState {
  return { lang: previous.lang, tab: 'changes', view: 'tree', collapsed: [], showFullSummary: false, showTask: true, expanded: [] }
}

let options: Options = { language: 'en', model: 'sonnet', bodyModel: 'opus', plansDir: 'docs/plans', summaryLimit: 9000, port: 4817, openIn: 'auto', nodePath: '' }

// ---- the review page server -------------------------------------------------

type ServerHandle = { url: string; port: number; token: string; stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> }

let server: ServerHandle | undefined
let serverStarting: Promise<ServerHandle | undefined> | undefined
let heartbeat: Timer | undefined
let notice: WebNotice | undefined
let noticeCounter = 0
let pushing = false
let pushAgain = false

function setNotice(text: string): void {
  noticeCounter += 1
  notice = { id: noticeCounter, text }
}

function makeToken(): string {
  return `${newId()}${newId()}${newId()}${newId()}`
}

async function findNode($: EngineInterface): Promise<string> {
  if (options.nodePath) return options.nodePath
  const home = (await $.env.get('HOME')) ?? ''
  const candidates = ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node', `${home}/.volta/bin/node`, '/usr/bin/node']
  const nvmDir = `${home}/.nvm/versions/node`
  try {
    if (home && (await $.fs.exists(nvmDir))) {
      const versions = (await $.fs.list(nvmDir)).filter(entry => entry.kind === 'dir').map(entry => entry.name).sort().reverse()
      for (const version of versions) candidates.push(`${nvmDir}/${version}/bin/node`)
    }
  } catch {
    // no nvm
  }
  for (const candidate of candidates) {
    try {
      const ran = await $.process.run([candidate, '--version'], { timeoutMs: 8000 })
      if (ran.exitCode === 0 && /^v(1[89]|[2-9]\d)\./.test(ran.stdout.trim())) return candidate
    } catch {
      // try the next one
    }
  }
  throw new Error('node 18 or newer was not found; set the nodePath option of plan-crutches')
}

async function noteServerError($: EngineInterface, error: string): Promise<void> {
  $.ui.log(`plan-crutches: review page server: ${error}`, { to: 'debug' })
  await update($, webAtom, web => ({ ...(web.token ? { token: web.token } : {}), error }))
}

async function serverGone($: EngineInterface): Promise<void> {
  server = undefined
  if (heartbeat) {
    heartbeat.cancel()
    heartbeat = undefined
  }
  await update($, webAtom, web => (web.token ? { token: web.token } : {}))
}

async function startServer($: EngineInterface): Promise<ServerHandle | undefined> {
  const stored = await read($, webAtom)
  const token = stored.token ?? makeToken()
  if (!stored.token) await update($, webAtom, web => ({ ...web, token }))
  let node: string
  try {
    node = await findNode($)
  } catch (error) {
    await noteServerError($, String(error))
    return undefined
  }
  const root = $.plugin.root
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    cwd = ''
  }
  let stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  try {
    stream = $.process.spawn({
      argv: [node, `${root}/server/index.mjs`],
      cwd: root,
      env: {
        PLAN_CRUTCHES_PORT: String(options.port),
        PLAN_CRUTCHES_TOKEN: token,
        PLAN_CRUTCHES_PROJECT: cwd || root,
        PLAN_CRUTCHES_WEB: `${root}/web`,
        PLAN_CRUTCHES_IDLE_MS: String(SERVER_IDLE_MS),
      },
    })
  } catch (error) {
    await noteServerError($, String(error))
    return undefined
  }
  let settle: (handle: ServerHandle | undefined) => void = () => {}
  const ready = new Promise<ServerHandle | undefined>(resolve => {
    settle = resolve
  })
  let handle: ServerHandle | undefined
  let fatal = ''
  void (async () => {
    let rest = ''
    try {
      for await (const chunk of stream) {
        if (chunk.stream === 'stderr') {
          $.ui.log(`plan-crutches server: ${chunk.text.trim()}`, { to: 'debug' })
          continue
        }
        const split = splitLines(rest, chunk.text)
        rest = split.rest
        for (const line of split.lines) {
          const message = parseServerLine(line)
          if (!message) continue
          if (message.type === 'listening') {
            handle = { url: message.url, port: message.port, token: message.token, stream }
            settle(handle)
          } else if (message.type === 'action') {
            const action = parseAction(message.action)
            if (action) {
              void handleAction($, action).catch(error => $.ui.log(`plan-crutches: page action ${action.type} failed: ${String(error)}`, { to: 'debug' }))
            } else {
              $.ui.log('plan-crutches: ignored a malformed page action', { to: 'debug' })
            }
          } else if (message.type === 'fatal') {
            fatal = message.text
            $.ui.log(`plan-crutches server: ${message.text}`, { to: 'debug' })
          } else {
            $.ui.log(`plan-crutches server: ${message.text}`, { to: 'debug' })
          }
        }
      }
    } catch (error) {
      $.ui.log(`plan-crutches server stream ended: ${String(error)}`, { to: 'debug' })
    } finally {
      settle(undefined)
      if (handle && server === handle) await serverGone($)
    }
  })()
  const started = await Promise.race([ready, $.clock.sleep(SERVER_START_MS).then(() => undefined)])
  if (!started) {
    await noteServerError($, fatal || `the page server did not report a port within ${SERVER_START_MS / 1000} s`)
    try {
      await stream.return({ code: null, signal: null })
    } catch {
      // already gone
    }
    return undefined
  }
  server = started
  await update($, webAtom, web => ({ ...(web.token ? { token: web.token } : {}), url: started.url, port: started.port }))
  if (heartbeat) heartbeat.cancel()
  heartbeat = $.clock.every(60_000, () => {
    void pingServer($)
  })
  void pushState($)
  return started
}

async function ensureServer($: EngineInterface): Promise<ServerHandle | undefined> {
  if (server) return server
  if (!serverStarting) {
    serverStarting = startServer($).finally(() => {
      serverStarting = undefined
    })
  }
  return serverStarting
}

async function stopServer($: EngineInterface): Promise<void> {
  const current = server
  await serverGone($)
  if (!current) return
  try {
    await current.stream.return({ code: null, signal: null })
  } catch {
    // already gone
  }
}

async function pingServer($: EngineInterface): Promise<boolean> {
  const current = server
  if (!current) return false
  try {
    const response = await $.http.fetch(`${current.url}/api/ping`, { headers: { 'x-plan-crutches-token': current.token } })
    if (response.ok) return true
  } catch {
    // fall through
  }
  if (server === current) await serverGone($)
  return false
}

async function buildWebSnapshot($: EngineInterface): Promise<WebSnapshot> {
  const [plan, review, comments, ui, bodies, qa, canvas, files] = await Promise.all([
    read($, planAtom),
    read($, reviewAtom),
    read($, commentsAtom),
    read($, uiAtom),
    read($, bodiesAtom),
    read($, qaAtom),
    read($, canvasAtom),
    read($, filesAtom),
  ])
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    cwd = ''
  }
  return buildSnapshot({
    plan,
    review,
    comments,
    bodies,
    qa,
    canvas,
    files,
    lang: ui.lang,
    summaryLimit: options.summaryLimit,
    cwd,
    ...(notice ? { notice } : {}),
    nowMs: await $.clock.now(),
  })
}

/** Sends the whole state to the page server; coalesces calls that overlap. */
async function pushState($: EngineInterface): Promise<void> {
  const current = server
  if (!current) return
  if (pushing) {
    pushAgain = true
    return
  }
  pushing = true
  try {
    do {
      pushAgain = false
      const snapshot = await buildWebSnapshot($)
      const response = await $.http.fetch(`${current.url}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-plan-crutches-token': current.token },
        body: JSON.stringify(snapshot),
      })
      if (!response.ok) $.ui.log(`plan-crutches: the page server answered ${response.status} to a state push`, { to: 'debug' })
    } while (pushAgain)
  } catch (error) {
    $.ui.log(`plan-crutches: state push failed: ${String(error)}`, { to: 'debug' })
    if (server === current) await serverGone($)
  } finally {
    pushing = false
  }
}

function changed($: EngineInterface): void {
  void pushState($)
}

async function openWeb($: EngineInterface, open: boolean): Promise<string | undefined> {
  const handle = await ensureServer($)
  if (!handle) {
    const web = await read($, webAtom)
    $.ui.toast(`Plan Crutches: the review page did not start${web.error ? `: ${web.error}` : ''}`)
    return undefined
  }
  const url = pageUrl(handle.url, handle.token)
  if (!open || options.openIn === 'none') return url
  if (options.openIn === 'auto') {
    try {
      const result = await $.mcp.call('Claude_Browser', 'navigate', { url })
      if (!result.isError) return url
      $.ui.log(`plan-crutches: the browser pane refused the page: ${JSON.stringify(result.content).slice(0, 300)}`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`plan-crutches: no browser pane for the page: ${String(error)}`, { to: 'debug' })
    }
  }
  for (const argv of openCommands(url)) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 15000 })
      if (ran.exitCode === 0) return url
    } catch {
      // try the next opener
    }
  }
  $.ui.toast(`Plan Crutches: open ${url}`)
  return url
}

// ---- the review -------------------------------------------------------------

async function resetAll($: EngineInterface): Promise<void> {
  await update($, planAtom, () => null)
  await update($, reviewAtom, () => EMPTY_REVIEW)
  await update($, commentsAtom, () => [])
  await update($, canvasAtom, () => ({ nodes: [], edges: [], strokes: [] }))
  await update($, qaAtom, () => [])
  await update($, bodiesAtom, () => ({}))
  await update($, filesAtom, () => ({}))
  await update($, taskAtom, () => ({}))
  await update($, uiAtom, freshUi)
  notice = undefined
  changed($)
}

async function isoNow($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

async function findLatestPlanFile($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  if (!home) return undefined
  const dir = `${home}/.claude/plans`
  if (!(await $.fs.exists(dir))) return undefined
  const entries = await $.fs.list(dir)
  const newest = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest ? `${dir}/${newest.name}` : undefined
}

function applyTask(plan: PlanModel, task: TaskCapture): void {
  if (task.jira?.text) {
    plan.task = {
      source: 'jira',
      text: task.jira.text,
      ...(task.jira.key ?? plan.task.key ? { key: task.jira.key ?? plan.task.key } : {}),
      ...(plan.task.title ? { title: plan.task.title } : {}),
    }
    return
  }
  if (plan.task.text) return
  if (task.userPrompt) plan.task = { source: 'user', text: task.userPrompt }
}

async function writeRecord($: EngineInterface): Promise<void> {
  const [plan, review, comments, canvas, qa] = await Promise.all([
    read($, planAtom),
    read($, reviewAtom),
    read($, commentsAtom),
    read($, canvasAtom),
    read($, qaAtom),
  ])
  if (!plan || review.isDemo || !review.recordPath) return
  try {
    const text = renderRecord({ plan, review, comments, canvas, qa, nowMs: await $.clock.now() })
    await $.fs.write(review.recordPath, text)
  } catch (error) {
    $.ui.log(`plan-crutches: could not write ${review.recordPath}: ${String(error)}`, { to: 'debug' })
  }
}

async function buildPlan(
  $: EngineInterface,
  markdown: string,
): Promise<{ plan: PlanModel; parsedFrom: ParsedFrom; warnings: string[] }> {
  const parsed = parsePlan(markdown)
  if (parsed.ok) return { plan: parsed.plan, parsedFrom: 'block', warnings: parsed.warnings }
  const warnings = [`${parsed.reason}; structure extracted by ${options.model}`, ...parsed.warnings]
  try {
    const reply = await $.model.complete({
      model: options.model,
      system: EXTRACTION_SYSTEM,
      prompt: extractionPrompt(markdown),
      maxTokens: 8000,
      timeoutMs: 180_000,
    })
    if (reply.isAnswered) {
      const plan = normalizePlan(extractJson(reply.text), warnings, titleFromMarkdown(markdown))
      if (plan) {
        if (!plan.summary) plan.summary = planFromMarkdown(markdown).summary
        return { plan, parsedFrom: 'model', warnings }
      }
      warnings.push('the model reply was not a plan object')
    } else {
      warnings.push(`model extraction failed: ${reply.reason}`)
    }
  } catch (error) {
    warnings.push(`model extraction failed: ${String(error)}`)
  }
  return { plan: planFromMarkdown(markdown), parsedFrom: 'markdown', warnings }
}

async function openPane($: EngineInterface, focus: boolean): Promise<void> {
  try {
    const opened = await $.ui.open(focus ? { id: PANE_ID, title: PANE_TITLE, focus: true } : { id: PANE_ID, title: PANE_TITLE })
    if (!opened.isPlaced) $.ui.log(`plan-crutches: the pane waits undrawn: ${opened.reason}`, { to: 'debug' })
  } catch (error) {
    $.ui.log(`plan-crutches: could not open the pane: ${String(error)}`, { to: 'debug' })
  }
}

async function receivePlan($: EngineInterface, markdown: string, planFilePath: string | undefined, isDemo: boolean): Promise<number> {
  const review = await read($, reviewAtom)
  const previous = await read($, planAtom)
  const isRevision = !isDemo && (review.status === 'revising' || review.status === 'reviewing') && previous !== null
  const built = await buildPlan($, markdown)
  const plan = built.plan
  if (!isDemo) applyTask(plan, await read($, taskAtom))
  const version = isRevision ? review.version + 1 : 1
  const now = await isoNow($)

  if (isRevision) {
    await update($, commentsAtom, list =>
      list.map(one => (one.sentInVersion !== undefined && one.resolvedInVersion === undefined ? { ...one, resolvedInVersion: version } : one)),
    )
  } else {
    await update($, commentsAtom, () => [])
    await update($, canvasAtom, () => ({ nodes: [], edges: [], strokes: [] }))
    await update($, qaAtom, () => [])
  }
  await update($, planAtom, () => plan)
  await update($, bodiesAtom, () => ({}))
  await update($, filesAtom, () => ({}))
  await update($, uiAtom, ui => ({ ...freshUi(ui), collapsed: isRevision ? ui.collapsed : [] }))

  let recordPath: string | undefined
  if (!isDemo) {
    recordPath = isRevision && review.recordPath ? review.recordPath : `${await $.session.cwd()}/${options.plansDir}/${recordFileName(await $.clock.now(), plan)}`
  }
  await update($, reviewAtom, current => ({
    status: 'reviewing' as const,
    version,
    parsedFrom: built.parsedFrom,
    warnings: built.warnings,
    previousPaths: previous?.files.map(file => file.path) ?? [],
    history: [...(isRevision ? current.history : []), `v${version} received ${now}`],
    ...(planFilePath ? { planFilePath } : {}),
    ...(recordPath ? { recordPath } : {}),
    ...(isRevision && current.canvasSvgPath ? { canvasSvgPath: current.canvasSvgPath } : {}),
    ...(isRevision && current.canvasSentInVersion !== undefined ? { canvasSentInVersion: current.canvasSentInVersion } : {}),
    ...(isDemo ? { isDemo: true } : {}),
  }))
  await writeRecord($)
  changed($)
  return version
}

async function submit($: EngineInterface): Promise<void> {
  const [plan, review, comments, canvas] = await Promise.all([
    read($, planAtom),
    read($, reviewAtom),
    read($, commentsAtom),
    read($, canvasAtom),
  ])
  if (!plan || review.status !== 'reviewing') return
  const pending = comments.filter(one => one.sentInVersion === undefined && one.resolvedInVersion === undefined)
  const canvasIsNew =
    canvas.nodes.length + canvas.edges.length + canvas.strokes.length > 0 && (review.canvasSentInVersion ?? 0) < review.version
  const now = await isoNow($)
  if (review.isDemo) {
    const text =
      pending.length || canvasIsNew
        ? `Demo: ${pending.length} comments would go to Claude as a revision request.`
        : 'Demo: the plan would be approved.'
    $.ui.toast(text)
    setNotice(text)
    changed($)
    return
  }
  if (pending.length === 0 && !canvasIsNew) {
    await update($, reviewAtom, current => ({ ...current, status: 'approved' as const, history: [...current.history, `v${review.version} approved ${now}`] }))
    try {
      await $.prompt.submit({ text: approvePrompt(review.version), asUser: true })
    } catch (error) {
      await update($, reviewAtom, current => ({ ...current, status: 'reviewing' as const }))
      $.ui.toast(`Plan Crutches: could not submit: ${String(error)}`)
      setNotice(`Could not submit: ${String(error)}`)
      changed($)
      return
    }
    await writeRecord($)
    changed($)
    return
  }
  const sentIds = new Set(pending.map(one => one.id))
  await update($, commentsAtom, list => list.map(one => (sentIds.has(one.id) ? { ...one, sentInVersion: review.version } : one)))
  await update($, reviewAtom, current => ({
    ...current,
    status: 'revising' as const,
    canvasSentInVersion: canvasIsNew ? review.version : current.canvasSentInVersion ?? 0,
    history: [...current.history, `v${review.version} sent back with ${pending.length} comments ${now}`],
  }))
  try {
    await $.prompt.submit({ text: revisionPrompt(plan, pending, canvas, review.version, review.canvasSvgPath), asUser: true })
  } catch (error) {
    await update($, commentsAtom, list => list.map(one => (sentIds.has(one.id) ? { id: one.id, target: one.target, text: one.text, createdInVersion: one.createdInVersion } : one)))
    await update($, reviewAtom, current => ({ ...current, status: 'reviewing' as const }))
    $.ui.toast(`Plan Crutches: could not submit: ${String(error)}`)
    setNotice(`Could not submit: ${String(error)}`)
    changed($)
    return
  }
  await writeRecord($)
  changed($)
}

async function loadFile($: EngineInterface, path: string): Promise<void> {
  const files = await read($, filesAtom)
  if (files[path] !== undefined) return
  let content: string | null = null
  try {
    const base = await projectBase($)
    const full = `${base}/${path}`
    if (await $.fs.exists(full)) content = await $.fs.read(full)
  } catch {
    content = null
  }
  await update($, filesAtom, current => ({ ...current, [path]: content }))
  changed($)
}

/** The project folder the plan's paths are relative to (the demo has its own). */
async function projectBase($: EngineInterface): Promise<string> {
  const review = await read($, reviewAtom)
  return review.isDemo ? `${$.plugin.root}/fixtures/demo-src` : await $.session.cwd()
}

/** Reads one project file for a prompt; null when it is missing or unreadable. */
async function readProjectFile($: EngineInterface, base: string, path: string): Promise<string | null> {
  if (path.includes('..')) return null
  try {
    const full = `${base}/${path}`
    if (!(await $.fs.exists(full))) return null
    return await $.fs.read(full)
  } catch {
    return null
  }
}

const MAX_LISTED_FILES = 4000
const SKIP_LISTED = /(^|\/)(node_modules|dist|build|vendor|\.git|coverage|target|__pycache__)(\/|$)|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|lock|map|min\.js)$/i

/** The project's tracked files from git, else nothing; the model picks from this list. */
async function listProjectFiles($: EngineInterface, base: string): Promise<string[]> {
  try {
    const ran = await $.process.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd: base, timeoutMs: 20_000 })
    if (ran.exitCode !== 0) return []
    return ran.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !SKIP_LISTED.test(line))
      .slice(0, MAX_LISTED_FILES)
  } catch {
    return []
  }
}

/**
 * The real code the implementation needs: the other planned files as they are
 * on disk, what the current file imports, and the files a cheap model picks
 * from the project's file list.
 */
async function gatherRelatedFiles($: EngineInterface, plan: PlanModel, file: PlanFile, symbol: PlanSymbol, fileText: string | null): Promise<RelatedFile[]> {
  const base = await projectBase($)
  const related: RelatedFile[] = []
  const seen = new Set<string>([file.path])
  const add = async (path: string, why: string): Promise<void> => {
    if (seen.has(path) || related.length >= 24) return
    seen.add(path)
    const text = await readProjectFile($, base, path)
    if (text !== null && text.trim()) related.push({ path, text, why })
  }
  for (const other of plan.files) {
    if (other.path !== file.path && other.status !== 'new') await add(other.path, `planned ${other.status}`)
  }
  const sources = [fileText ?? '', symbol.signature, ...file.symbols.map(one => one.signature)]
  for (const spec of relativeImports(sources.join('\n'))) {
    for (const candidate of importCandidates(file.path, spec)) {
      if (seen.has(candidate)) break
      if (await $.fs.exists(`${base}/${candidate}`).catch(() => false)) {
        await add(candidate, `imported by ${file.path}`)
        break
      }
    }
  }
  const listed = await listProjectFiles($, base)
  if (listed.length === 0) return related
  try {
    const picked = await $.model.complete({
      model: options.model,
      system: PICK_FILES_SYSTEM,
      prompt: pickFilesPrompt(plan, file, symbol, fileText, listed, [...seen]),
      maxTokens: 400,
      effort: 'low',
      timeoutMs: 60_000,
    })
    if (picked.isAnswered) {
      for (const path of parseFileList(picked.text, new Set(listed))) await add(path, 'chosen as context')
    } else {
      $.ui.log(`plan-crutches: file pick for ${symbol.name} failed: ${picked.reason}`, { to: 'debug' })
    }
  } catch (error) {
    $.ui.log(`plan-crutches: file pick for ${symbol.name} failed: ${String(error)}`, { to: 'debug' })
  }
  return related
}

async function generateBody($: EngineInterface, file: PlanFile, symbol: PlanSymbol): Promise<void> {
  const key = bodyKey(file.path, symbol.name)
  const plan = await read($, planAtom)
  if (!plan) return
  await update($, bodiesAtom, current => ({ ...current, [key]: { status: 'loading' as const } }))
  changed($)
  let fileText: string | null = null
  if (file.status === 'modified') {
    await loadFile($, file.path)
    fileText = (await read($, filesAtom))[file.path] ?? null
  }
  const related = await gatherRelatedFiles($, plan, file, symbol, fileText)
  const bodies = await read($, bodiesAtom)
  const reply = await $.model.complete({
    model: options.bodyModel || options.model,
    system: BODY_SYSTEM,
    prompt: bodyPrompt({ plan, file, symbol, fileText, bodies, related }),
    maxTokens: 6000,
    timeoutMs: 300_000,
  })
  if (reply.isAnswered) {
    await update($, bodiesAtom, current => ({ ...current, [key]: { status: 'ready' as const, code: codeFromReply(reply.text) } }))
  } else {
    const detail = reply.reason === 'api-error' ? `${reply.reason} ${reply.status}` : reply.reason
    await update($, bodiesAtom, current => ({ ...current, [key]: { status: 'failed' as const, error: detail } }))
  }
  changed($)
}

/** One answer from the session's fork, else from the plan text alone. */
async function answerQuestion($: EngineInterface, plan: PlanModel, prompt: string): Promise<{ answer?: string; failure?: string }> {
  const forked = await $.model.fork({ prompt })
  if (forked.isAnswered) return { answer: forked.text }
  if (forked.reason !== 'nothing-to-fork') return { failure: forked.reason }
  const direct = await $.model.complete({
    model: options.model,
    system: 'You answer questions about an implementation plan from the plan text alone. Be brief; answer in the language of the question.',
    prompt: `Plan "${plan.title}":\n${plan.summary.slice(0, 8000)}\n\nFiles:\n${plan.files
      .map(file => `- [${file.status}] ${file.path}: ${file.description}`)
      .join('\n')}\n\n${prompt}`,
    maxTokens: 1500,
    timeoutMs: 90_000,
  })
  return direct.isAnswered ? { answer: direct.text } : { failure: direct.reason }
}

async function ask($: EngineInterface, question: string, focus?: string, target?: CommentTarget, wantedId?: string): Promise<void> {
  const plan = await read($, planAtom)
  if (!plan) return
  const review = await read($, reviewAtom)
  const taken = new Set((await read($, qaAtom)).map(item => item.id))
  // The page may name the thread's id, so its popup can follow the thread it opened.
  const id = wantedId && !taken.has(wantedId) ? wantedId : newId()
  await update($, qaAtom, list => [
    ...list,
    {
      id,
      question,
      status: 'asking' as const,
      createdInVersion: review.version,
      ...(focus ? { focus } : {}),
      ...(target ? { target } : {}),
    },
  ])
  changed($)
  const { answer, failure } = await answerQuestion($, plan, askPrompt(plan, question, focus, target))
  await update($, qaAtom, list =>
    list.map(item =>
      item.id === id
        ? answer !== undefined
          ? { ...item, status: 'done' as const, answer }
          : { ...item, status: 'failed' as const, answer: failure ?? 'unknown' }
        : item,
    ),
  )
  await writeRecord($)
  changed($)
}

async function askMore($: EngineInterface, id: string, question: string): Promise<void> {
  const plan = await read($, planAtom)
  const item = (await read($, qaAtom)).find(one => one.id === id)
  if (!plan || !item) return
  const followupId = newId()
  await update($, qaAtom, list =>
    list.map(one => (one.id === id ? { ...one, followups: [...(one.followups ?? []), { id: followupId, question, status: 'asking' as const }] } : one)),
  )
  changed($)
  const { answer, failure } = await answerQuestion($, plan, askMorePrompt(plan, item, question))
  await update($, qaAtom, list =>
    list.map(one =>
      one.id === id
        ? {
            ...one,
            followups: (one.followups ?? []).map(turn =>
              turn.id === followupId
                ? answer !== undefined
                  ? { ...turn, status: 'done' as const, answer }
                  : { ...turn, status: 'failed' as const, answer: failure ?? 'unknown' }
                : turn,
            ),
          }
        : one,
    ),
  )
  await writeRecord($)
  changed($)
}

async function readModel($: EngineInterface): Promise<PaneModel> {
  const [plan, review, comments, ui, bodies, qa, files] = await Promise.all([
    read($, planAtom),
    read($, reviewAtom),
    read($, commentsAtom),
    read($, uiAtom),
    read($, bodiesAtom),
    read($, qaAtom),
    read($, filesAtom),
  ])
  return {
    plan,
    review,
    comments,
    ui,
    bodies,
    qa,
    files,
    summaryLimit: options.summaryLimit,
    ...(server ? { webUrl: pageUrl(server.url, server.token) } : {}),
  }
}

async function addComment($: EngineInterface, target: CommentTarget, text: string): Promise<void> {
  if (text) {
    const review = await read($, reviewAtom)
    await update($, commentsAtom, list => [...list, { id: newId(), target, text, createdInVersion: review.version }])
  }
  await update($, uiAtom, state => withoutKeys(state, ['commenting', 'pendingSelection']))
  if (text) await writeRecord($)
  changed($)
}

async function deleteComment($: EngineInterface, id: string): Promise<void> {
  await update($, commentsAtom, list => list.filter(one => one.id !== id))
  await writeRecord($)
  changed($)
}

async function setCanvas($: EngineInterface, canvas: Canvas): Promise<void> {
  await update($, canvasAtom, () => canvas)
  await writeRecord($)
  changed($)
}

async function saveCanvasSvg($: EngineInterface, svg: string): Promise<void> {
  const review = await read($, reviewAtom)
  if (review.isDemo || !review.recordPath) {
    setNotice('Demo: the SVG is kept with the review only while a real plan has a record file.')
    changed($)
    return
  }
  const svgPath = `${review.recordPath.replace(/\.md$/, '')}.svg`
  try {
    await $.fs.write(svgPath, svg)
    await update($, reviewAtom, current => ({ ...current, canvasSvgPath: svgPath }))
    setNotice(`SVG saved: ${svgPath}`)
    await writeRecord($)
  } catch (error) {
    setNotice(`Could not save the SVG: ${String(error)}`)
  }
  changed($)
}

async function commentOnSelection($: EngineInterface, path: string): Promise<void> {
  const selected = await $.ui.selection()
  const text = selected?.text.trim() ?? ''
  if (!text) {
    const ui = await read($, uiAtom)
    $.ui.toast(t(ui.lang, 'nothingSelected'))
    return
  }
  await update($, uiAtom, state => ({ ...state, commenting: `sel:${path}`, pendingSelection: text.slice(0, 2000) }))
}

async function handleAction($: EngineInterface, action: WebAction): Promise<void> {
  switch (action.type) {
    case 'comment':
      return addComment($, action.target, action.text)
    case 'deleteComment':
      return deleteComment($, action.id)
    case 'submit':
      return submit($)
    case 'loadFile':
      return loadFile($, action.path)
    case 'generateBody': {
      const plan = await read($, planAtom)
      const file = plan?.files.find(one => one.path === action.path)
      const symbol = file?.symbols.find(one => one.name === action.symbol)
      if (file && symbol) return generateBody($, file, symbol)
      return
    }
    case 'ask':
      return ask($, action.question, action.focus, action.target, action.id)
    case 'askMore':
      return askMore($, action.id, action.question)
    case 'canvas':
      return setCanvas($, action.canvas)
    case 'canvasSvg':
      return saveCanvasSvg($, action.svg)
    case 'setLang':
      await update($, uiAtom, ui => ({ ...ui, lang: action.lang }))
      changed($)
      return
    case 'ping':
      return
  }
}

export const register: Register = (on, rawOptions) => {
  options = readOptions(rawOptions)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plan-review',
      description: 'Plan Crutches: open the plan review page (demo | url | close | stop | reset)',
      argumentHint: '[demo|url|close|stop|reset]',
    })
    const review = await read($, reviewAtom)
    if (review.status === 'idle') await update($, uiAtom, ui => ({ ...ui, lang: options.language }))
    if (review.status === 'reviewing' || review.status === 'revising') {
      void openPane($, false)
      void ensureServer($)
    }
    return next(e)
  })

  on('command.run', { command: 'plan-review' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE_ID })
      return { text: 'Plan Review pane closed. The page keeps running; /plan-review stop ends it.' }
    }
    if (arg === 'stop') {
      await stopServer($)
      return { text: 'Plan Crutches page server stopped.' }
    }
    if (arg === 'reset') {
      await resetAll($)
      await $.ui.close({ id: PANE_ID })
      return { text: 'Plan Crutches state cleared.' }
    }
    if (arg === 'url') {
      const url = await openWeb($, false)
      return { text: url ? `Plan Crutches review page: ${url}` : 'The review page is not running; see the debug log.' }
    }
    if (arg === 'demo') {
      await resetAll($)
      const version = await receivePlan($, DEMO_PLAN, undefined, true)
      const url = await openWeb($, true)
      await openPane($, true)
      return { text: `Plan Crutches demo plan opened (version ${version}).${url ? ` Page: ${url}` : ''}` }
    }
    const url = await openWeb($, true)
    await openPane($, true)
    return { text: url ? `Plan Review page: ${url}` : 'Plan Review pane opened; the page did not start (see the debug log).' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin' && e.text.trim()) await update($, lastPromptAtom, () => e.text.slice(0, 20000))
    return next(e)
  })

  on('tool.call', { tool: /jira_get_issue|getJiraIssue|jira_issue_get/i }, async ($, e, next) => {
    const ran = await next(e)
    if (!('deny' in ran) && !ran.isError && typeof ran.text === 'string' && ran.text.trim()) {
      const input = e as unknown as Record<string, unknown>
      const fromInput = [input.issue_key, input.issueIdOrKey, input.issueKey, input.key].find(value => typeof value === 'string') as string | undefined
      const key = fromInput ?? ran.text.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0]
      await update($, taskAtom, task => ({ ...task, jira: { text: ran.text!.slice(0, 20000), ...(key ? { key } : {}) } }))
    }
    return ran
  })

  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    if (!e.agentId) {
      const review = await read($, reviewAtom)
      if (review.status === 'approved') await resetAll($)
    }
    return next(e)
  })

  on('prompt.attachment', { type: 'plan_mode' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    let review = await read($, reviewAtom)
    if (review.status === 'approved') {
      await resetAll($)
      review = await read($, reviewAtom)
    }
    const planFilePath = e.detail?.planFilePath
    if (planFilePath && planFilePath !== review.planFilePath) await update($, reviewAtom, current => ({ ...current, planFilePath }))
    const task = await read($, taskAtom)
    if (!task.userPrompt) {
      const last = await read($, lastPromptAtom)
      if (last) await update($, taskAtom, current => ({ ...current, userPrompt: last }))
    }
    const extra = e.detail?.reminder === 'sparse' ? PLAN_BLOCK_REMINDER : PLAN_BLOCK_INSTRUCTIONS
    return next({ ...e, text: `${e.text}\n\n${extra}` })
  })

  on('prompt.attachment', { type: 'plan_mode_exit' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const review = await read($, reviewAtom)
    if (review.status === 'reviewing' || review.status === 'revising') {
      const now = await isoNow($)
      await update($, reviewAtom, current => ({ ...current, status: 'idle' as const, history: [...current.history, `plan mode left ${now}`] }))
      await writeRecord($)
      changed($)
    }
    return next(e)
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const review = await read($, reviewAtom)
    if (review.status === 'approved') {
      const ran = await next(e)
      const now = await isoNow($)
      if ('deny' in ran || ran.isError) {
        await update($, reviewAtom, current => ({ ...current, status: 'reviewing' as const, history: [...current.history, `approval not confirmed ${now}`] }))
      } else {
        await update($, reviewAtom, current => ({ ...current, history: [...current.history, `plan mode exited for implementation ${now}`] }))
      }
      await writeRecord($)
      changed($)
      return ran
    }
    const planFilePath = review.planFilePath ?? (await findLatestPlanFile($))
    if (!planFilePath || !(await $.fs.exists(planFilePath))) {
      $.ui.log('plan-crutches: no plan file to review; ExitPlanMode passes through', { to: 'debug' })
      return next(e)
    }
    const markdown = await $.fs.read(planFilePath)
    const version = await receivePlan($, markdown, planFilePath, false)
    const url = await openWeb($, version === 1)
    await openPane($, true)
    $.ui.toast(`Plan Crutches: plan v${version} is ready for review${url ? ` at ${url}` : ''}.`)
    return { deny: denyMessage(version) }
  }).catch(($, e, next) => next(e))

  on('ui.message', async ($, e, next) => {
    const data = e.data as { type?: unknown; target?: unknown; text?: unknown } | null
    if (data && data.type === 'comment' && typeof data.text === 'string' && data.target && typeof data.target === 'object') {
      await addComment($, parseTarget(data.target), data.text.trim())
    }
    return next(e)
  })

  on('ui.fault', async ($, e, next) => {
    $.ui.log(`plan-crutches: Client fault (${e.phase}): ${e.reason}; falling back to plain code blocks`, { to: 'debug' })
    await update($, uiAtom, ui => ({ ...ui, clientBroken: true }))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text>Plan Crutches draws on the desktop and terminal surfaces.</Text>
        </Box>
      )
    }
    const el = $.ui.resolve(e)
    const model = await readModel($)
    let selectable: PaneActions['selectable']
    if ((e.surface === 'desktop' || e.surface === 'terminal') && !model.ui.clientBroken) {
      const { Client } = $.ui.resolve(e)
      selectable = (args: { key: string; props: SelectableProps }) => <Client key={args.key} module="./select.tsx" props={args.props} />
    }
    const actions: PaneActions = {
      ...(selectable ? { selectable } : {}),
      setUi: async change => {
        await update($, uiAtom, change)
        changed($)
      },
      addComment: (target, text) => addComment($, target, text),
      deleteComment: id => deleteComment($, id),
      submit: () => submit($),
      loadFile: path => loadFile($, path),
      generateBody: (file, symbol) => generateBody($, file, symbol),
      ask: (question, focus) => ask($, question, focus),
      commentOnSelection: path => commentOnSelection($, path),
      openWeb: () => openWeb($, true),
    }
    return renderPane(el, model, actions)
  })
}
