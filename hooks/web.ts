// The mod's side of the review page, the pure part: what the page may ask
// (actions), what the mod sends it (the snapshot) and the server's stdout
// protocol. Nothing here touches `$`; register.tsx wires it.
import type {
  CommentTarget,
  Diagram,
  FileCache,
  GeneratedBody,
  Lang,
  PlanModel,
  QaItem,
  Review,
  ReviewComment,
  WebFileEntry,
  WebNotice,
  WebSnapshot,
} from '../types'
import { deletedDiff, newFileStub, stubDiff } from './diff'

export type WebAction =
  | { type: 'comment'; target: CommentTarget; text: string }
  | { type: 'deleteComment'; id: string }
  | { type: 'submit' }
  | { type: 'loadFile'; path: string }
  | { type: 'generateBody'; path: string; symbol: string }
  | { type: 'ask'; id?: string; question: string; focus?: string; target?: CommentTarget }
  | { type: 'askMore'; id: string; question: string }
  | { type: 'generateDiagram' }
  | { type: 'callers'; path: string; symbol: string }
  | { type: 'diagramSvg'; svg: string }
  | { type: 'setLang'; lang: Lang }
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'listening'; host: string; port: number; token: string; url: string }
  | { type: 'action'; action: unknown }
  | { type: 'log'; text: string }
  | { type: 'fatal'; text: string }

const MAX_TEXT = 20000

/**
 * The shape of the state and the set of actions the mod understands. The page
 * carries the same number and warns when they differ: a session keeps the mod
 * it loaded at its start, while the server serves the page files from disk,
 * so after an update of the mod an open session shows a newer page.
 */
import { WEB_PROTOCOL } from './state'

export { WEB_PROTOCOL }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, limit = MAX_TEXT): string | undefined => (typeof value === 'string' ? value.slice(0, limit) : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

export function parseTarget(raw: unknown): CommentTarget {
  const target: CommentTarget = {}
  if (!isRecord(raw)) return target
  const path = str(raw.path, 2000)
  if (path) target.path = path
  const symbol = str(raw.symbol, 500)
  if (symbol) target.symbol = symbol
  const selection = str(raw.selection, 2000)
  if (selection) target.selection = selection
  if (Array.isArray(raw.lines) && raw.lines.length === 2) {
    const a = num(raw.lines[0])
    const b = num(raw.lines[1])
    if (a !== undefined && b !== undefined) target.lines = [Math.min(a, b), Math.max(a, b)]
  }
  return target
}

export function parseAction(raw: unknown): WebAction | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null
  switch (raw.type) {
    case 'comment': {
      const text = str(raw.text)?.trim()
      if (!text) return null
      return { type: 'comment', target: parseTarget(raw.target), text }
    }
    case 'deleteComment': {
      const id = str(raw.id, 64)
      return id ? { type: 'deleteComment', id } : null
    }
    case 'submit':
      return { type: 'submit' }
    case 'loadFile': {
      const path = str(raw.path, 2000)
      return path ? { type: 'loadFile', path } : null
    }
    case 'generateBody': {
      const path = str(raw.path, 2000)
      const symbol = str(raw.symbol, 500)
      return path && symbol ? { type: 'generateBody', path, symbol } : null
    }
    case 'ask': {
      const question = str(raw.question)?.trim()
      if (!question) return null
      const focus = str(raw.focus, 2000)
      const target = raw.target === undefined ? undefined : parseTarget(raw.target)
      const hasTarget = target !== undefined && Object.keys(target).length > 0
      const id = str(raw.id, 64)
      const validId = id && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined
      return { type: 'ask', question, ...(validId ? { id: validId } : {}), ...(focus ? { focus } : {}), ...(hasTarget ? { target } : {}) }
    }
    case 'askMore': {
      const id = str(raw.id, 64)
      const question = str(raw.question)?.trim()
      return id && question ? { type: 'askMore', id, question } : null
    }
    case 'generateDiagram':
      return { type: 'generateDiagram' }
    case 'callers': {
      const path = str(raw.path, 2000)
      const symbol = str(raw.symbol, 500)
      return path && symbol ? { type: 'callers', path, symbol } : null
    }
    case 'diagramSvg': {
      const svg = str(raw.svg, 2_000_000)
      return svg && svg.trimStart().startsWith('<svg') ? { type: 'diagramSvg', svg } : null
    }
    case 'setLang':
      return { type: 'setLang', lang: raw.lang === 'uk' ? 'uk' : 'en' }
    case 'ping':
      return { type: 'ping' }
    default:
      return null
  }
}

/** Splits a stream of text into whole lines; `rest` is the unfinished tail. */
export function splitLines(buffer: string, text: string): { lines: string[]; rest: string } {
  const joined = buffer + text
  const parts = joined.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(line => line.trim() !== ''), rest }
}

export function parseServerLine(line: string): ServerMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { type: 'log', text: line }
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return null
  if (parsed.type === 'listening') {
    const port = num(parsed.port)
    const token = str(parsed.token, 200)
    const url = str(parsed.url, 500)
    const host = str(parsed.host, 200) ?? '127.0.0.1'
    return port !== undefined && token && url ? { type: 'listening', host, port, token, url } : null
  }
  if (parsed.type === 'action') return { type: 'action', action: parsed.action }
  if (parsed.type === 'fatal') return { type: 'fatal', text: str(parsed.text) ?? 'fatal' }
  return { type: 'log', text: str(parsed.text) ?? line }
}

export function pageUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/?t=${encodeURIComponent(token)}`
}

/** The commands that open a URL, one per platform; the first that exits 0 wins. */
export function openCommands(url: string): string[][] {
  return [
    ['open', url],
    ['xdg-open', url],
    ['cmd', '/c', 'start', '', url],
  ]
}

export function fileEntries(plan: PlanModel | null, files: FileCache): Record<string, WebFileEntry> {
  const entries: Record<string, WebFileEntry> = {}
  if (!plan) return entries
  for (const file of plan.files) {
    if (file.status === 'new') {
      entries[file.path] = { loaded: true, view: { format: 'source', text: newFileStub(file), startLine: 1 } }
      continue
    }
    if (!(file.path in files)) {
      entries[file.path] = { loaded: false }
      continue
    }
    const content = files[file.path]
    if (typeof content !== 'string') {
      entries[file.path] = { loaded: true, missing: true }
      continue
    }
    const text = file.status === 'deleted' ? deletedDiff(content) : stubDiff(content, file)
    entries[file.path] = { loaded: true, view: { format: 'diff', text } }
  }
  return entries
}

export function buildSnapshot(args: {
  plan: PlanModel | null
  review: Review
  comments: ReviewComment[]
  bodies: Record<string, GeneratedBody>
  qa: QaItem[]
  diagram: Diagram
  files: FileCache
  lang: Lang
  summaryLimit: number
  cwd: string
  notice?: WebNotice
  nowMs: number
}): WebSnapshot {
  return {
    plan: args.plan,
    review: args.review,
    comments: args.comments,
    bodies: args.bodies,
    qa: args.qa,
    diagram: args.diagram,
    files: fileEntries(args.plan, args.files),
    lang: args.lang,
    summaryLimit: args.summaryLimit,
    cwd: args.cwd,
    ...(args.notice ? { notice: args.notice } : {}),
    generatedAt: new Date(args.nowMs).toISOString(),
    protocol: WEB_PROTOCOL,
  }
}
