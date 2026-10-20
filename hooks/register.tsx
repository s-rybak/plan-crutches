import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, PluginOptions, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type {
  CallersQuery,
  CommentTarget,
  Diagram,
  DiagramRef,
  Explanation,
  FileCache,
  GeneratedBody,
  Lang,
  LoadedVersion,
  OkMark,
  ParsedFrom,
  PlanFile,
  PlanModel,
  PlanSymbol,
  PlanVersion,
  QaItem,
  Review,
  ReviewComment,
  SavedVersion,
  StoredReview,
  TaskCapture,
  UiState,
  VersionSource,
  WebNotice,
  WebSnapshot,
  WebState,
} from '../types'
import { DEMO_PLAN } from './demo-plan'
import {
  CALLERS_LIMIT,
  DIAGRAM_AGENT_DESCRIPTION,
  DIAGRAM_AGENT_NAME,
  DIAGRAM_AGENT_PROMPT,
  DIAGRAM_SYSTEM,
  callersPrompt,
  diagramPrompt,
  enclosingSymbol,
  groupCandidates,
  isDeclarationOf,
  isImportLine,
  isTestPath,
  loadingCallers,
  parseCallersReply,
  parseDiagramReply,
  parseGrepOutput,
} from './diagram'
import type { CallerCandidate } from './diagram'
import { codeFromReply, currentSymbolText } from './diff'
import { applySummary, extractJson, normalizePlan, parsePlan, planFromMarkdown, titleFromMarkdown } from './plan-parser'
import { renderPane, withoutKeys } from './pane'
import type { PaneActions, PaneModel } from './pane'
import { bodiesFile, projectDir, recordsDir, reviewFile, versionFile } from './paths'
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
  explainPrompt,
  userWords,
  extractionPrompt,
  importCandidates,
  parseFileList,
  pickFilesPrompt,
  relativeImports,
  revisionPrompt,
} from './prompts'
import type { RelatedFile } from './prompts'
import { t } from './i18n'
import { newestPlanFile, openArgument, planSourceNote, resolvePlanPath } from './open-plan'
import type { FoundPlan } from './open-plan'
import { recordFileName, renderRecord } from './record'
import {
  STORE_INDEX_KEY,
  STORE_KEEP,
  buildStored,
  indexWith,
  indexWithout,
  isRestorable,
  parseBodiesText,
  parseIndex,
  parseStoredText,
  serializeBodies,
  serializeStored,
  storeKey,
  thawStored,
} from './persist'
import { PANE_ID, bodyKey, newId } from './state'
import { buildSavedVersion, keepOkMarks, parseSavedVersion, pathsUnderFolder, serializeVersion, versionEntry } from './versions'
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

const diagramAtom = atom<'plan-crutches', 'diagram'>(
  { plugin: 'plan-crutches', key: 'diagram' } as const,
  { status: 'idle', callers: {} } as Diagram,
)

const filesAtom = atom<'plan-crutches', 'files'>(
  { plugin: 'plan-crutches', key: 'files' } as const,
  {} as FileCache,
)

const webAtom = atom<'plan-crutches', 'web'>(
  { plugin: 'plan-crutches', key: 'web' } as const,
  {} as WebState,
)

const okAtom = atom<'plan-crutches', 'ok'>(
  { plugin: 'plan-crutches', key: 'ok' } as const,
  {} as Record<string, OkMark>,
)

const explainAtom = atom<'plan-crutches', 'explanations'>(
  { plugin: 'plan-crutches', key: 'explanations' } as const,
  {} as Record<string, Explanation>,
)

const versionsAtom = atom<'plan-crutches', 'versions'>(
  { plugin: 'plan-crutches', key: 'versions' } as const,
  [] as PlanVersion[],
)

const compareAtom = atom<'plan-crutches', 'compare'>(
  { plugin: 'plan-crutches', key: 'compare' } as const,
  null as LoadedVersion | null,
)

const viewingAtom = atom<'plan-crutches', 'viewing'>(
  { plugin: 'plan-crutches', key: 'viewing' } as const,
  null as LoadedVersion | null,
)

const PANE_TITLE = 'Plan Review'
const SERVER_START_MS = 8000
const SERVER_IDLE_MS = 600_000
const DIAGRAM_AGENT_TYPE = `plan-crutches:${DIAGRAM_AGENT_NAME}`
const AGENT_WAIT_MS = 900_000
const EMPTY_DIAGRAM: Diagram = { status: 'idle', callers: {} }

function readOptions(raw: PluginOptions): Options {
  const language = raw.language === 'uk' ? 'uk' : 'en'
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : 'sonnet'
  const bodyModel = typeof raw.bodyModel === 'string' && raw.bodyModel.trim() ? raw.bodyModel.trim() : 'opus'
  // Empty, `~/...` or absolute: the shared folder with one subfolder per project. Anything else: a folder inside the project.
  const plansDir = typeof raw.plansDir === 'string' ? raw.plansDir.trim().replace(/\/+$/, '') : ''
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

let options: Options = { language: 'en', model: 'sonnet', bodyModel: 'opus', plansDir: '', summaryLimit: 9000, port: 4817, openIn: 'auto', nodePath: '' }

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

async function homeDir($: EngineInterface): Promise<string> {
  try {
    return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  } catch {
    return ''
  }
}

async function findNode($: EngineInterface): Promise<string> {
  if (options.nodePath) return options.nodePath
  const home = await homeDir($)
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
  const [plan, review, comments, ui, bodies, qa, diagram, files, ok, explanations, versions, compare, viewing] = await Promise.all([
    read($, planAtom),
    read($, reviewAtom),
    read($, commentsAtom),
    read($, uiAtom),
    read($, bodiesAtom),
    read($, qaAtom),
    read($, diagramAtom),
    read($, filesAtom),
    read($, okAtom),
    read($, explainAtom),
    read($, versionsAtom),
    read($, compareAtom),
    read($, viewingAtom),
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
    diagram,
    files,
    ok,
    explanations,
    versions,
    compare,
    viewing,
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
  syncStore($)
}

// ---- the review between processes ------------------------------------------
// The session state dies with the process. A live review is also written to a
// JSON file under the mod's folder in the Claude configuration directory, one
// subfolder per project (hooks/paths.ts): the same session resumed takes it up
// on its own, another session in the folder by /plan-review restore. The
// plugin store holds only the index of folders. The store work runs one job
// at a time, in the order it was asked.

let storeChain: Promise<void> = Promise.resolve()
let syncQueued = false

async function sessionCwd($: EngineInterface): Promise<string> {
  try {
    return await $.session.cwd()
  } catch {
    return ''
  }
}

async function currentSessionId($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

/** The folder of this project's review files, or empty when the home or the project folder is unknown. */
async function reviewDir($: EngineInterface): Promise<string> {
  const [home, cwd] = await Promise.all([homeDir($), sessionCwd($)])
  return home && cwd ? projectDir(home, cwd) : ''
}

/** Writes the review to its file after the running job; one write serves every call made meanwhile. */
function syncStore($: EngineInterface): void {
  if (syncQueued) return
  syncQueued = true
  storeChain = storeChain.then(() => syncJob($))
}

async function syncJob($: EngineInterface): Promise<void> {
  syncQueued = false
  try {
    await writeStore($)
  } catch (error) {
    $.ui.log(`plan-crutches: could not write the review file: ${String(error)}`, { to: 'debug' })
  }
}

async function writeStore($: EngineInterface): Promise<void> {
  const [plan, review, comments, qa, diagram, task, ui, bodies, web, ok, versions, explanations] = await Promise.all([
    read($, planAtom),
    read($, reviewAtom),
    read($, commentsAtom),
    read($, qaAtom),
    read($, diagramAtom),
    read($, taskAtom),
    read($, uiAtom),
    read($, bodiesAtom),
    read($, webAtom),
    read($, okAtom),
    read($, versionsAtom),
    read($, explainAtom),
  ])
  if (!plan || review.isDemo || !isRestorable(review)) return
  const cwd = await sessionCwd($)
  const dir = await reviewDir($)
  if (!cwd || !dir) return
  const savedAt = await isoNow($)
  const sessionId = await currentSessionId($)
  const stored = buildStored({ cwd, sessionId, savedAt, plan, review, comments, qa, diagram, task, ui, ok, versions, explanations, ...(web.token ? { token: web.token } : {}) })
  await $.fs.write(reviewFile(dir), serializeStored(stored))
  await $.fs.write(bodiesFile(dir), serializeBodies(bodies))
  const index = indexWith(parseIndex(await $.store.get(STORE_INDEX_KEY)), { cwd, savedAt, title: plan.title, version: review.version, dir }, STORE_KEEP)
  await $.store.set(STORE_INDEX_KEY, index.entries)
  // The record once lived in the store itself; that copy only takes room now.
  const legacy = storeKey(cwd)
  if ((await $.store.keys()).includes(legacy)) await $.store.delete(legacy)
}

/** Drops this folder's stored review after the running job: the review ended or was reset. */
function clearStore($: EngineInterface): Promise<void> {
  storeChain = storeChain.then(() => deleteStore($))
  return storeChain
}

async function deleteStore($: EngineInterface): Promise<void> {
  try {
    const cwd = await sessionCwd($)
    const dir = await reviewDir($)
    if (!cwd) return
    // The file system API has no delete: an empty record is no record.
    if (dir && (await $.fs.exists(reviewFile(dir)))) await $.fs.write(reviewFile(dir), '{}')
    const legacy = storeKey(cwd)
    if ((await $.store.keys()).includes(legacy)) await $.store.delete(legacy)
    const index = parseIndex(await $.store.get(STORE_INDEX_KEY))
    if (index.some(entry => entry.cwd === cwd)) await $.store.set(STORE_INDEX_KEY, indexWithout(index, cwd))
  } catch (error) {
    $.ui.log(`plan-crutches: could not drop the stored review: ${String(error)}`, { to: 'debug' })
  }
}

type StoredFound = { stored: StoredReview; bodies: Record<string, GeneratedBody> }

/** This folder's stored review, when its file holds one this code can read. */
async function readStored($: EngineInterface): Promise<StoredFound | null> {
  try {
    const dir = await reviewDir($)
    if (!dir) return null
    const file = reviewFile(dir)
    if (!(await $.fs.exists(file))) return null
    const stored = parseStoredText(await $.fs.read(file))
    if (!stored || !isRestorable(stored.review)) return null
    const bodiesPath = bodiesFile(dir)
    const bodies = (await $.fs.exists(bodiesPath)) ? parseBodiesText(await $.fs.read(bodiesPath)) : {}
    return { stored, bodies }
  } catch (error) {
    $.ui.log(`plan-crutches: could not read the stored review: ${String(error)}`, { to: 'debug' })
    return null
  }
}

/** Takes a stored review up in this process; `gone` when its plan file is no longer there. */
async function restoreReview($: EngineInterface, found: StoredFound): Promise<'restored' | 'gone'> {
  const { stored } = found
  const planFilePath = stored.review.planFilePath
  if (!planFilePath || !(await $.fs.exists(planFilePath))) return 'gone'
  const now = await isoNow($)
  const thawed = thawStored(stored, found.bodies)
  versionCache.clear()
  await update($, planAtom, () => thawed.plan)
  await update($, reviewAtom, () => ({ ...thawed.review, history: [...thawed.review.history, `restored after a restart ${now}`] }))
  await update($, commentsAtom, () => thawed.comments)
  await update($, qaAtom, () => thawed.qa)
  await update($, diagramAtom, () => thawed.diagram)
  await update($, taskAtom, () => thawed.task)
  await update($, uiAtom, () => thawed.ui)
  await update($, bodiesAtom, () => thawed.bodies)
  await update($, filesAtom, () => ({}))
  await update($, okAtom, () => thawed.ok)
  await update($, versionsAtom, () => thawed.versions)
  await update($, explainAtom, () => thawed.explanations)
  await update($, viewingAtom, () => null)
  const previous = thawed.review.version > 1 ? await loadVersion($, thawed.review.version - 1) : undefined
  await update($, compareAtom, () => (previous ? { version: previous.version, plan: previous.plan } : null))
  // The stored token lets the page the person left open reconnect; a server
  // already running keeps the token it was started with.
  const token = stored.token
  if (token && !server) await update($, webAtom, web => ({ ...web, token }))
  notice = undefined
  await writeRecord($)
  changed($)
  return 'restored'
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

// ---- plan versions ----------------------------------------------------------
// Every version of the plan is kept: its file as received and the plan read
// from it, one JSON file per version under the project's review folder. The
// page lists them, shows an earlier one, compares the current plan with one,
// and brings one back as the next version.

const versionCache = new Map<number, SavedVersion>()

/** Writes a version to its file (not for the demo) and returns the row the state keeps. */
async function saveVersion($: EngineInterface, saved: SavedVersion, isDemo: boolean): Promise<PlanVersion> {
  versionCache.set(saved.version, saved)
  let path = ''
  if (!isDemo) {
    const dir = await reviewDir($)
    if (dir) {
      path = versionFile(dir, saved.version)
      try {
        await $.fs.write(path, serializeVersion(saved))
      } catch (error) {
        $.ui.log(`plan-crutches: could not write ${path}: ${String(error)}`, { to: 'debug' })
        path = ''
      }
    }
  }
  return versionEntry(saved, path)
}

/** A saved version, from this process's memory or from its file. */
async function loadVersion($: EngineInterface, version: number): Promise<SavedVersion | undefined> {
  const cached = versionCache.get(version)
  if (cached) return cached
  const entry = (await read($, versionsAtom)).find(one => one.version === version)
  if (!entry || !entry.path) return undefined
  try {
    if (!(await $.fs.exists(entry.path))) return undefined
    const saved = parseSavedVersion(await $.fs.read(entry.path))
    if (saved) versionCache.set(version, saved)
    return saved ?? undefined
  } catch (error) {
    $.ui.log(`plan-crutches: could not read ${entry.path}: ${String(error)}`, { to: 'debug' })
    return undefined
  }
}

async function viewVersion($: EngineInterface, version: number | null): Promise<void> {
  const review = await read($, reviewAtom)
  if (version === null || version === review.version) {
    await update($, viewingAtom, () => null)
    changed($)
    return
  }
  const saved = await loadVersion($, version)
  if (!saved) {
    setNotice(`Version ${version} is not available.`)
    changed($)
    return
  }
  await update($, viewingAtom, () => ({ version: saved.version, plan: saved.plan }))
  changed($)
}

async function compareWith($: EngineInterface, version: number | null): Promise<void> {
  if (version === null) {
    await update($, compareAtom, () => null)
    changed($)
    return
  }
  const saved = await loadVersion($, version)
  if (!saved) {
    setNotice(`Version ${version} is not available.`)
    changed($)
    return
  }
  await update($, compareAtom, () => ({ version: saved.version, plan: saved.plan }))
  changed($)
}

/** Brings an earlier version back as the next version: its plan file text is written again and received anew. */
async function restoreVersion($: EngineInterface, version: number): Promise<void> {
  const [plan, review] = await Promise.all([read($, planAtom), read($, reviewAtom)])
  if (!plan || review.status !== 'reviewing') {
    setNotice(review.status === 'revising' ? 'Claude is revising the plan; a version can come back once the new version has arrived.' : 'No plan is under review.')
    changed($)
    return
  }
  if (version === review.version) return
  const saved = await loadVersion($, version)
  if (!saved) {
    setNotice(`Version ${version} is not available.`)
    changed($)
    return
  }
  if (!review.isDemo && review.planFilePath) {
    try {
      await $.fs.write(review.planFilePath, saved.markdown)
    } catch (error) {
      setNotice(`Could not write the plan file: ${String(error)}`)
      changed($)
      return
    }
  }
  const next = await receivePlan($, {
    markdown: saved.markdown,
    ...(review.planFilePath ? { planFilePath: review.planFilePath } : {}),
    isDemo: Boolean(review.isDemo),
    prebuilt: { plan: saved.plan, parsedFrom: saved.parsedFrom, warnings: saved.warnings },
    source: 'restored',
    from: version,
  })
  setNotice(`Version ${next} is version ${version} brought back.`)
  changed($)
}

// ---- the review -------------------------------------------------------------

async function resetAll($: EngineInterface): Promise<void> {
  await update($, planAtom, () => null)
  await update($, reviewAtom, () => EMPTY_REVIEW)
  await update($, commentsAtom, () => [])
  await update($, diagramAtom, () => EMPTY_DIAGRAM)
  await update($, qaAtom, () => [])
  await update($, bodiesAtom, () => ({}))
  await update($, filesAtom, () => ({}))
  await update($, taskAtom, () => ({}))
  await update($, okAtom, () => ({}))
  await update($, explainAtom, () => ({}))
  await update($, versionsAtom, () => [])
  await update($, compareAtom, () => null)
  await update($, viewingAtom, () => null)
  await update($, uiAtom, freshUi)
  versionCache.clear()
  await clearStore($)
  notice = undefined
  changed($)
}

async function isoNow($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

async function findLatestPlanFile($: EngineInterface): Promise<string | undefined> {
  const home = await homeDir($)
  if (!home) return undefined
  const dir = `${home}/.claude/plans`
  if (!(await $.fs.exists(dir))) return undefined
  return newestPlanFile(dir, await $.fs.list(dir))
}

/**
 * The plan to open when the person names none: the file this session already
 * knows (from plan mode, an earlier open or a restore), while it is still on
 * disk, else the newest plan file under `~/.claude/plans`.
 */
async function findPlanFile($: EngineInterface): Promise<FoundPlan | undefined> {
  const review = await read($, reviewAtom)
  if (review.planFilePath && (await $.fs.exists(review.planFilePath).catch(() => false))) return { path: review.planFilePath, source: 'review' }
  const newest = await findLatestPlanFile($).catch(() => undefined)
  return newest ? { path: newest, source: 'newest' } : undefined
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
  const [plan, review, comments, diagram, qa, ok, versions] = await Promise.all([
    read($, planAtom),
    read($, reviewAtom),
    read($, commentsAtom),
    read($, diagramAtom),
    read($, qaAtom),
    read($, okAtom),
    read($, versionsAtom),
  ])
  if (!plan || review.isDemo || !review.recordPath) return
  try {
    const text = renderRecord({ plan, review, comments, diagram, qa, ok, versions, nowMs: await $.clock.now() })
    await $.fs.write(review.recordPath, text)
  } catch (error) {
    $.ui.log(`plan-crutches: could not write ${review.recordPath}: ${String(error)}`, { to: 'debug' })
  }
}

type BuiltPlan = { plan: PlanModel; parsedFrom: ParsedFrom; warnings: string[] }

async function buildPlan($: EngineInterface, markdown: string): Promise<BuiltPlan> {
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

/** A plan coming in: from plan mode or a file (received), or an earlier version brought back (restored). */
type Incoming = {
  markdown: string
  planFilePath?: string
  isDemo: boolean
  /** The plan already read from the markdown, when a saved version holds it. */
  prebuilt?: BuiltPlan
  source?: VersionSource
  from?: number
}

async function receivePlan($: EngineInterface, incoming: Incoming): Promise<number> {
  const { markdown, planFilePath, isDemo } = incoming
  const review = await read($, reviewAtom)
  const previous = await read($, planAtom)
  const isRevision = !isDemo && (review.status === 'revising' || review.status === 'reviewing') && previous !== null
  const built = incoming.prebuilt ?? (await buildPlan($, markdown))
  const plan = built.plan
  if (!isDemo && !incoming.prebuilt) applyTask(plan, await read($, taskAtom))
  const version = isRevision ? review.version + 1 : 1
  const now = await isoNow($)
  const source: VersionSource = incoming.source ?? 'received'

  if (isRevision) {
    await update($, commentsAtom, list =>
      list.map(one => (one.sentInVersion !== undefined && one.resolvedInVersion === undefined ? { ...one, resolvedInVersion: version } : one)),
    )
    // An OK stays only on a file the new version plans the same way.
    await update($, okAtom, marks => keepOkMarks(marks, previous, plan))
    await update($, compareAtom, () => (previous ? { version: review.version, plan: previous } : null))
  } else {
    await update($, commentsAtom, () => [])
    await update($, diagramAtom, () => EMPTY_DIAGRAM)
    await update($, qaAtom, () => [])
    await update($, okAtom, () => ({}))
    await update($, versionsAtom, () => [])
    await update($, compareAtom, () => null)
    versionCache.clear()
  }
  await update($, explainAtom, () => ({}))
  await update($, viewingAtom, () => null)
  await update($, planAtom, () => plan)
  await update($, bodiesAtom, () => ({}))
  await update($, filesAtom, () => ({}))
  await update($, uiAtom, ui => ({ ...freshUi(ui), collapsed: isRevision ? ui.collapsed : [] }))

  let recordPath: string | undefined
  if (!isDemo) {
    if (isRevision && review.recordPath) {
      recordPath = review.recordPath
    } else {
      const [cwd, home] = await Promise.all([sessionCwd($), homeDir($)])
      recordPath = `${recordsDir(options.plansDir, cwd, home)}/${recordFileName(await $.clock.now(), plan)}`
    }
  }
  const entry = await saveVersion(
    $,
    buildSavedVersion({ version, receivedAt: now, markdown, plan, parsedFrom: built.parsedFrom, warnings: built.warnings, source, ...(incoming.from !== undefined ? { from: incoming.from } : {}) }),
    isDemo,
  )
  await update($, versionsAtom, list => [...list.filter(one => one.version !== version), entry])
  const line = source === 'restored' ? `v${version} restored from v${incoming.from ?? '?'} ${now}` : `v${version} received ${now}`
  await update($, reviewAtom, current => ({
    status: 'reviewing' as const,
    version,
    parsedFrom: built.parsedFrom,
    warnings: built.warnings,
    previousPaths: previous?.files.map(file => file.path) ?? [],
    history: [...(isRevision ? current.history : []), line],
    ...(planFilePath ? { planFilePath } : {}),
    ...(recordPath ? { recordPath } : {}),
    ...(isRevision && current.diagramSvgPath ? { diagramSvgPath: current.diagramSvgPath } : {}),
    ...(isDemo ? { isDemo: true } : {}),
  }))
  await writeRecord($)
  changed($)
  return version
}

/**
 * Reviews a plan file without plan mode, the way an ExitPlanMode call is
 * reviewed: the file at `given`, or, with no path, the one `findPlanFile`
 * picks. The file already under review gets its next version, so the
 * comments stay; any other live review is reset first.
 */
async function openPlanFile($: EngineInterface, given: string): Promise<string> {
  let planFilePath: string
  let note = ''
  if (given) {
    planFilePath = resolvePlanPath(given, await sessionCwd($), await homeDir($))
    const exists = await $.fs.exists(planFilePath).catch(() => false)
    if (!exists) return `Plan Crutches: no file at ${planFilePath}.`
  } else {
    const found = await findPlanFile($)
    if (!found) return 'Plan Crutches: no plan found: this session has no plan file and ~/.claude/plans holds none. Name one: /plan-review open <path>.'
    planFilePath = found.path
    note = `, ${planSourceNote(found.source)}`
  }
  let markdown: string
  try {
    markdown = await $.fs.read(planFilePath)
  } catch (error) {
    return `Plan Crutches: could not read ${planFilePath}: ${String(error)}`
  }
  if (!markdown.trim()) return `Plan Crutches: ${planFilePath} is empty.`
  const review = await read($, reviewAtom)
  const sameFile = !review.isDemo && isRestorable(review) && review.planFilePath === planFilePath
  if (!sameFile) await resetAll($)
  const version = await receivePlan($, { markdown, planFilePath, isDemo: false })
  const url = await openWeb($, true)
  await openPane($, true)
  return `Plan Crutches: plan v${version} opened from ${planFilePath}${note}.${url ? ` Page: ${url}` : ''}`
}

async function submit($: EngineInterface): Promise<void> {
  const [plan, review, comments, ok] = await Promise.all([read($, planAtom), read($, reviewAtom), read($, commentsAtom), read($, okAtom)])
  if (!plan || review.status !== 'reviewing') return
  const pending = comments.filter(one => one.sentInVersion === undefined && one.resolvedInVersion === undefined)
  const now = await isoNow($)
  const notes = { okPaths: Object.keys(ok).sort(), summaryEdited: review.summaryEditedInVersion === review.version }
  if (review.isDemo) {
    const text = pending.length ? `Demo: ${pending.length} comments would go to Claude as a revision request.` : 'Demo: the plan would be approved.'
    $.ui.toast(text)
    setNotice(text)
    changed($)
    return
  }
  if (pending.length === 0) {
    await update($, reviewAtom, current => ({ ...current, status: 'approved' as const, history: [...current.history, `v${review.version} approved ${now}`] }))
    try {
      await $.prompt.submit({ text: approvePrompt(review.version, notes), asUser: true })
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
    history: [...current.history, `v${review.version} sent back with ${pending.length} comments ${now}`],
  }))
  try {
    await $.prompt.submit({ text: revisionPrompt(plan, pending, review.version, notes), asUser: true })
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
  const currentCode = symbol.change === 'modified' && fileText ? currentSymbolText(fileText, symbol.name, file.path) : null
  const reply = await $.model.complete({
    model: options.bodyModel || options.model,
    system: BODY_SYSTEM,
    prompt: bodyPrompt({ plan, file, symbol, fileText, bodies, related, currentCode }),
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
  // The prompt already carries the plan (askPrompt); the fork adds the session.
  // Whatever goes wrong becomes a failed turn, never a thread stuck on "asking".
  try {
    const forked = await $.model.fork({ prompt })
    if (forked.isAnswered) return { answer: forked.text }
    if (forked.reason !== 'nothing-to-fork') return { failure: forked.reason === 'api-error' ? `${forked.reason} ${forked.status}` : forked.reason }
    const direct = await $.model.complete({
      model: options.model,
      system: `You answer questions about the implementation plan "${plan.title}", which is under review. Be brief. Answer in the language the request asks for; when it asks for none, answer in the language of the question.`,
      prompt,
      maxTokens: 1500,
      timeoutMs: 90_000,
    })
    if (direct.isAnswered) return { answer: direct.text }
    return { failure: direct.reason === 'api-error' ? `${direct.reason} ${direct.status}` : direct.reason }
  } catch (error) {
    return { failure: String(error) }
  }
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

/**
 * The popup's Explain tab: what the place the user points at is, where it
 * sits and why the plan changes it. Asked only when the tab opens; the page
 * names the id so it can follow the answer.
 */
async function explain($: EngineInterface, id: string, target: CommentTarget, focus?: string): Promise<void> {
  const [plan, review, ui, known, comments, qa] = await Promise.all([read($, planAtom), read($, reviewAtom), read($, uiAtom), read($, explainAtom), read($, commentsAtom), read($, qaAtom)])
  if (!plan || known[id]) return
  await update($, explainAtom, map => ({ ...map, [id]: { status: 'asking' as const, target, ...(focus ? { focus } : {}), createdInVersion: review.version } }))
  changed($)
  let fileText: string | null = null
  const path = target.path && !target.path.endsWith('/') ? target.path : undefined
  if (path && plan.files.some(file => file.path === path && file.status !== 'new')) {
    await loadFile($, path)
    fileText = (await read($, filesAtom))[path] ?? null
  }
  const { answer, failure } = await answerQuestion($, plan, explainPrompt(plan, target, focus, fileText, ui.lang, userWords(plan, comments, qa)))
  await update($, explainAtom, map => {
    const current = map[id]
    if (!current) return map
    return { ...map, [id]: answer !== undefined ? { ...current, status: 'done' as const, text: answer } : { ...current, status: 'failed' as const, text: failure ?? 'unknown' } }
  })
  changed($)
}

/** The user's OK on files: no comments wanted there. A folder path (`dir/`) covers every planned file under it. */
async function setOk($: EngineInterface, paths: readonly string[], ok: boolean): Promise<void> {
  const [plan, review] = await Promise.all([read($, planAtom), read($, reviewAtom)])
  if (!plan) return
  const now = await isoNow($)
  const targets = new Set<string>()
  for (const path of paths) {
    if (path.endsWith('/')) for (const under of pathsUnderFolder(plan, path)) targets.add(under)
    else if (plan.files.some(file => file.path === path)) targets.add(path)
  }
  if (targets.size === 0) return
  await update($, okAtom, marks => {
    const next = { ...marks }
    for (const path of targets) {
      if (ok) next[path] = { version: review.version, at: now }
      else delete next[path]
    }
    return next
  })
  await writeRecord($)
  changed($)
}

/**
 * The summary as the user edited it on the page: into the plan state, into
 * the plan file (so Claude's next read sees it) and into the saved version.
 */
async function editSummary($: EngineInterface, text: string): Promise<void> {
  const [plan, review] = await Promise.all([read($, planAtom), read($, reviewAtom)])
  if (!plan) return
  if (review.status !== 'reviewing') {
    setNotice(review.status === 'revising' ? 'Claude is revising the plan; edit the text once the new version has arrived.' : 'The plan is not under review.')
    changed($)
    return
  }
  if (text === plan.summary) return
  const next: PlanModel = { ...plan, summary: text }
  await update($, planAtom, () => next)
  const now = await isoNow($)
  let markdown: string | undefined
  if (!review.isDemo && review.planFilePath) {
    try {
      markdown = applySummary(await $.fs.read(review.planFilePath), text)
      await $.fs.write(review.planFilePath, markdown)
    } catch (error) {
      setNotice(`Could not write the plan file: ${String(error)}`)
      markdown = undefined
    }
  }
  const saved = await loadVersion($, review.version)
  if (saved) {
    const edited = buildSavedVersion({ ...saved, markdown: markdown ?? applySummary(saved.markdown, text), plan: next, source: 'edited' })
    const entry = await saveVersion($, edited, Boolean(review.isDemo))
    await update($, versionsAtom, list => list.map(one => (one.version === entry.version ? entry : one)))
  }
  await update($, reviewAtom, current => ({
    ...current,
    summaryEditedInVersion: review.version,
    history: [...current.history, `v${review.version} summary edited by the user ${now}`],
  }))
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

/** A new text for a pending comment. A sent or resolved comment stays as Claude saw it. */
async function editComment($: EngineInterface, id: string, text: string): Promise<void> {
  const comments = await read($, commentsAtom)
  const comment = comments.find(one => one.id === id)
  if (!comment || comment.sentInVersion !== undefined || comment.resolvedInVersion !== undefined || comment.text === text) return
  await update($, commentsAtom, list => list.map(one => (one.id === id ? { ...one, text } : one)))
  await writeRecord($)
  changed($)
}

// ---- the change diagram -----------------------------------------------------
// A clean session draws it: a subagent of the mod's own type, read-only tools,
// no history, the plan in its prompt. Its answer arrives as its turn.complete.
// Where no subagent can start, a tool-less completion answers from the plan
// and the planned files' text.

let diagramAgentReady = false
const agentWaiters = new Map<string, (answer: string | undefined) => void>()

async function registerDiagramAgent($: EngineInterface): Promise<void> {
  try {
    await $.agent.register({
      name: DIAGRAM_AGENT_NAME,
      description: DIAGRAM_AGENT_DESCRIPTION,
      prompt: DIAGRAM_AGENT_PROMPT,
      tools: ['Read', 'Grep', 'Glob'],
      model: options.model,
      omitClaudeMd: true,
      background: true,
      maxTurns: 60,
    })
    diagramAgentReady = true
  } catch (error) {
    diagramAgentReady = false
    $.ui.log(`plan-crutches: the diagram agent did not register, model calls answer instead: ${String(error)}`, { to: 'debug' })
  }
}

/** The answer of a subagent run, once its turn completes; undefined when it ends without one or after AGENT_WAIT_MS. */
function awaitAgent($: EngineInterface, agentId: string): Promise<string | undefined> {
  return new Promise(resolve => {
    agentWaiters.set(agentId, resolve)
    void $.clock.sleep(AGENT_WAIT_MS).then(() => {
      if (agentWaiters.delete(agentId)) resolve(undefined)
    })
  })
}

function settleAgent(agentId: string, answer: string | undefined): void {
  const waiter = agentWaiters.get(agentId)
  if (!waiter) return
  agentWaiters.delete(agentId)
  waiter(answer)
}

type FreshAnswer = { text?: string; source: 'session' | 'model'; failure?: string }

/**
 * One answer from a clean session: the diagram agent with `prompt` in `cwd`,
 * else a tool-less completion with `fallbackPrompt`.
 */
async function freshSessionAnswer($: EngineInterface, prompt: string, fallbackPrompt: string, cwd: string, description: string): Promise<FreshAnswer> {
  if (diagramAgentReady) {
    try {
      const spawned = await $.agent.spawn({ subagentType: DIAGRAM_AGENT_TYPE, prompt, description, cwd })
      if (spawned.deny) {
        $.ui.log(`plan-crutches: the diagram session was refused: ${spawned.deny}`, { to: 'debug' })
      } else if (spawned.agentId) {
        const answer = await awaitAgent($, spawned.agentId)
        if (answer && answer.trim()) return { text: answer, source: 'session' }
        $.ui.log('plan-crutches: the diagram session ended without an answer; a model call answers instead', { to: 'debug' })
      }
    } catch (error) {
      $.ui.log(`plan-crutches: the diagram session did not start: ${String(error)}`, { to: 'debug' })
    }
  }
  const reply = await $.model.complete({
    model: options.model,
    system: DIAGRAM_SYSTEM,
    prompt: fallbackPrompt,
    maxTokens: 8000,
    timeoutMs: 240_000,
  })
  if (reply.isAnswered) return { text: reply.text, source: 'model' }
  const detail = reply.reason === 'api-error' ? `${reply.reason} ${reply.status}` : reply.reason
  return { source: 'model', failure: detail }
}

async function generateDiagram($: EngineInterface): Promise<void> {
  const [plan, review, current] = await Promise.all([read($, planAtom), read($, reviewAtom), read($, diagramAtom)])
  if (!plan || current.status === 'loading') return
  await update($, diagramAtom, () => ({ status: 'loading' as const, callers: {} }))
  changed($)
  const base = await projectBase($)
  const texts: Record<string, string | null> = {}
  for (const file of plan.files) {
    if (file.status !== 'new' && !isTestPath(file.path)) texts[file.path] = await readProjectFile($, base, file.path)
  }
  const answer = await freshSessionAnswer($, diagramPrompt(plan, texts, { tools: true }), diagramPrompt(plan, texts, { tools: false }), base, 'Plan Crutches: change diagram')
  const graph = answer.text ? parseDiagramReply(answer.text, plan) : null
  if (graph) {
    await update($, diagramAtom, () => ({ status: 'ready' as const, graph, version: review.version, source: answer.source, callers: {} }))
  } else {
    const error = answer.failure ?? 'the answer held no diagram'
    await update($, diagramAtom, () => ({ status: 'failed' as const, error, callers: {} }))
  }
  await writeRecord($)
  changed($)
}

/** Lines of the project that name the symbol, from git grep, else grep; each with its enclosing symbol. */
async function searchCallers($: EngineInterface, base: string, ref: DiagramRef): Promise<CallerCandidate[]> {
  // a method named `Class.method` is called by its last part
  const needle = ref.symbol.split('.').pop() || ref.symbol
  let output = ''
  const commands = [
    ['git', 'grep', '-n', '-I', '-w', '--untracked', '--', needle],
    ['grep', '-rnIw', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=build', '--', needle, '.'],
  ]
  for (const argv of commands) {
    try {
      const ran = await $.process.run(argv, { cwd: base, timeoutMs: 30_000 })
      if (ran.exitCode === 0 || ran.exitCode === 1) {
        output = ran.stdout
        break
      }
    } catch {
      // try the next search
    }
  }
  const hits = parseGrepOutput(output)
  const lines = new Map<string, string[] | null>()
  const candidates: CallerCandidate[] = []
  for (const hit of hits) {
    if (isTestPath(hit.path)) continue
    if (hit.path === ref.path && isDeclarationOf(hit.text, needle)) continue
    if (isImportLine(hit.text)) continue
    if (!lines.has(hit.path)) {
      if (lines.size >= 60) break
      const text = await readProjectFile($, base, hit.path)
      lines.set(hit.path, text === null ? null : text.replace(/\r\n?/g, '\n').split('\n'))
    }
    const fileLines = lines.get(hit.path)
    const enclosing = fileLines ? enclosingSymbol(fileLines, hit.line - 1) : { name: '(module)', kind: 'other' as const }
    if (hit.path === ref.path && enclosing.name === ref.symbol) continue
    candidates.push({ path: hit.path, line: hit.line, text: hit.text, enclosing: enclosing.name, kind: enclosing.kind })
  }
  return candidates
}

/** What a session may put before a project-relative path: the folder itself, or its place inside the git repository. */
async function pathPrefixes($: EngineInterface, base: string): Promise<string[]> {
  const folder = base.replace(/\/+$/, '')
  const prefixes = [`${folder}/`]
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: base, timeoutMs: 10_000 })
    const top = ran.stdout.trim().replace(/\/+$/, '')
    if (ran.exitCode === 0 && top && folder.startsWith(`${top}/`)) prefixes.push(`${folder.slice(top.length + 1)}/`)
  } catch {
    // not a git repository
  }
  return prefixes
}

async function findCallers($: EngineInterface, ref: DiagramRef): Promise<void> {
  const key = bodyKey(ref.path, ref.symbol)
  const [plan, current] = await Promise.all([read($, planAtom), read($, diagramAtom)])
  if (!plan || current.status !== 'ready') return
  const existing = current.callers[key]
  if (existing && existing.status === 'loading') return
  await update($, diagramAtom, state => ({ ...state, callers: { ...state.callers, [key]: loadingCallers() } }))
  changed($)
  const base = await projectBase($)
  const candidates = await searchCallers($, base, ref)
  const prompt = callersPrompt(plan, ref, candidates, CALLERS_LIMIT, base)
  const answer = await freshSessionAnswer($, prompt, prompt, base, `Plan Crutches: callers of ${ref.symbol}`)
  const parsed = answer.text ? parseCallersReply(answer.text, CALLERS_LIMIT, await pathPrefixes($, base)) : null
  let result: CallersQuery
  if (parsed) {
    result = { status: 'ready', callers: parsed.callers, more: parsed.more, source: answer.source }
  } else {
    const grouped = groupCandidates(candidates, CALLERS_LIMIT)
    result = { status: 'ready', callers: grouped.callers, more: grouped.more, source: 'search', ...(answer.failure ? { error: answer.failure } : {}) }
  }
  await update($, diagramAtom, state => (state.status === 'ready' ? { ...state, callers: { ...state.callers, [key]: result } } : state))
  changed($)
}

async function saveDiagramSvg($: EngineInterface, svg: string): Promise<void> {
  const review = await read($, reviewAtom)
  if (review.isDemo || !review.recordPath) {
    setNotice('Demo: the SVG is saved next to the record only for a real plan.')
    changed($)
    return
  }
  const svgPath = `${review.recordPath.replace(/\.md$/, '')}.svg`
  try {
    await $.fs.write(svgPath, svg)
    await update($, reviewAtom, current => ({ ...current, diagramSvgPath: svgPath }))
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
    case 'editComment':
      return editComment($, action.id, action.text)
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
    case 'explain':
      return explain($, action.id, action.target, action.focus)
    case 'setOk':
      return setOk($, action.paths, action.ok)
    case 'editSummary':
      return editSummary($, action.text)
    case 'viewVersion':
      return viewVersion($, action.version)
    case 'compareWith':
      return compareWith($, action.version)
    case 'restoreVersion':
      return restoreVersion($, action.version)
    case 'generateDiagram':
      return generateDiagram($)
    case 'callers':
      return findCallers($, { path: action.path, symbol: action.symbol })
    case 'diagramSvg':
      return saveDiagramSvg($, action.svg)
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
      description: 'Plan Crutches: open the plan review page (demo | open [plan file] | url | restore | close | stop | reset)',
      argumentHint: '[demo|open [plan file]|url|restore|close|stop|reset]',
    })
    await registerDiagramAgent($)
    let review = await read($, reviewAtom)
    if (review.status === 'idle') {
      // A new process: the session state is empty. The same session resumed
      // takes its stored review up; another session is told it is there.
      const found = await readStored($)
      if (found && found.stored.sessionId === (await currentSessionId($))) {
        if ((await restoreReview($, found)) === 'restored') {
          review = await read($, reviewAtom)
          $.ui.toast(`Plan Crutches: plan v${review.version} restored after the restart; /plan-review opens the page.`)
        }
      } else if (found) {
        $.ui.toast(`Plan Crutches: an unfinished review of "${found.stored.plan.title}" (v${found.stored.review.version}) is stored for this folder; /plan-review restore brings it back.`)
      }
    }
    if (review.status === 'idle') await update($, uiAtom, ui => ({ ...ui, lang: options.language }))
    if (review.status === 'reviewing' || review.status === 'revising') {
      void openPane($, false)
      void ensureServer($)
    }
    return next(e)
  })

  // The diagram agent is the mod's own: the model never sees it in its listing.
  on('agent.offer', { agent: 'plan-crutches:diagram' }, async () => ({ isOffered: false })).catch(async () => ({ isOffered: false }))

  // A diagram session's answer is its turn's end; the waiter that spawned it takes it.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId && agentWaiters.has(e.agentId)) settleAgent(e.agentId, e.reason === 'answer' ? e.answer : undefined)
    return next(e)
  })

  on('command.run', { command: 'plan-review' }, async ($, e) => {
    // The path of `open` keeps its case; every other form is one keyword.
    const open = openArgument(e.args)
    if (open.isOpen) return { text: await openPlanFile($, open.path) }
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
    if (arg === 'restore') {
      const review = await read($, reviewAtom)
      if (review.status === 'reviewing' || review.status === 'revising') return { text: `Plan v${review.version} is already under review in this session.` }
      const found = await readStored($)
      if (!found) return { text: 'No stored review for this folder.' }
      if ((await restoreReview($, found)) === 'gone') return { text: `The stored review cannot come back: its plan file is gone (${found.stored.review.planFilePath ?? 'no path'}).` }
      const url = await openWeb($, true)
      await openPane($, true)
      return { text: `Plan Crutches: plan v${found.stored.review.version} restored.${url ? ` Page: ${url}` : ''}` }
    }
    if (arg === 'demo') {
      await resetAll($)
      const version = await receivePlan($, { markdown: DEMO_PLAN, isDemo: true })
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
      await clearStore($)
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
        await clearStore($)
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
    const version = await receivePlan($, { markdown, planFilePath, isDemo: false })
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
