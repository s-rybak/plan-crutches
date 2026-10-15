// The mod's side of the review page, the pure part: what the page may ask
// (actions), what the mod sends it (the snapshot) and the server's stdout
// protocol. Nothing here touches `$`; register.tsx wires it.
import type {
  Canvas,
  CanvasEdge,
  CanvasNode,
  CanvasStroke,
  CommentTarget,
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
  | { type: 'canvas'; canvas: Canvas }
  | { type: 'canvasSvg'; svg: string }
  | { type: 'setLang'; lang: Lang }
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'listening'; host: string; port: number; token: string; url: string }
  | { type: 'action'; action: unknown }
  | { type: 'log'; text: string }
  | { type: 'fatal'; text: string }

const MAX_TEXT = 20000
const MAX_NODES = 500
const MAX_POINTS = 5000

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

export function parseCanvas(raw: unknown): Canvas | null {
  if (!isRecord(raw)) return null
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const strokes: CanvasStroke[] = []
  if (Array.isArray(raw.nodes)) {
    for (const item of raw.nodes.slice(0, MAX_NODES)) {
      if (!isRecord(item)) continue
      const id = str(item.id, 64)
      const x = num(item.x)
      const y = num(item.y)
      const w = num(item.w)
      const h = num(item.h)
      if (!id || x === undefined || y === undefined || w === undefined || h === undefined) continue
      const node: CanvasNode = { id, x, y, w, h, label: str(item.label, 500) ?? '' }
      if (item.kind === 'text') node.kind = 'text'
      nodes.push(node)
    }
  }
  const ids = new Set(nodes.map(node => node.id))
  if (Array.isArray(raw.edges)) {
    for (const item of raw.edges.slice(0, MAX_NODES * 2)) {
      if (!isRecord(item)) continue
      const id = str(item.id, 64)
      const from = str(item.from, 64)
      const to = str(item.to, 64)
      if (!id || !from || !to || !ids.has(from) || !ids.has(to)) continue
      const edge: CanvasEdge = { id, from, to }
      const label = str(item.label, 500)
      if (label) edge.label = label
      edges.push(edge)
    }
  }
  if (Array.isArray(raw.strokes)) {
    for (const item of raw.strokes.slice(0, MAX_NODES)) {
      if (!isRecord(item) || !Array.isArray(item.points)) continue
      const id = str(item.id, 64)
      if (!id) continue
      const points: [number, number][] = []
      for (const point of item.points.slice(0, MAX_POINTS)) {
        if (!Array.isArray(point)) continue
        const x = num(point[0])
        const y = num(point[1])
        if (x !== undefined && y !== undefined) points.push([x, y])
      }
      if (points.length > 1) strokes.push({ id, points })
    }
  }
  return { nodes, edges, strokes }
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
    case 'canvas': {
      const canvas = parseCanvas(raw.canvas)
      return canvas ? { type: 'canvas', canvas } : null
    }
    case 'canvasSvg': {
      const svg = str(raw.svg, 2_000_000)
      return svg && svg.trimStart().startsWith('<svg') ? { type: 'canvasSvg', svg } : null
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
  canvas: Canvas
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
    canvas: args.canvas,
    files: fileEntries(args.plan, args.files),
    lang: args.lang,
    summaryLimit: args.summaryLimit,
    cwd: args.cwd,
    ...(args.notice ? { notice: args.notice } : {}),
    generatedAt: new Date(args.nowMs).toISOString(),
  }
}
