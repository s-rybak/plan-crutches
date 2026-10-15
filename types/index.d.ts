export type FileStatus = 'new' | 'modified' | 'deleted'
export type SymbolKind = 'function' | 'method' | 'class' | 'type' | 'const' | 'other'

export type PlanSymbol = {
  name: string
  kind: SymbolKind
  signature: string
  description: string
  anchor?: string
}

export type PlanFile = {
  path: string
  status: FileStatus
  description: string
  symbols: PlanSymbol[]
}

export type PlanTask = {
  source: 'jira' | 'user' | 'none'
  key?: string
  title?: string
  text: string
}

export type PlanModel = {
  title: string
  summary: string
  task: PlanTask
  files: PlanFile[]
}

export type ReviewStatus = 'idle' | 'reviewing' | 'revising' | 'approved'
export type ParsedFrom = 'block' | 'model' | 'markdown' | 'none'

export type Review = {
  status: ReviewStatus
  version: number
  planFilePath?: string
  recordPath?: string
  parsedFrom: ParsedFrom
  warnings: string[]
  history: string[]
  previousPaths: string[]
  canvasSentInVersion?: number
  canvasSvgPath?: string
  isDemo?: boolean
}

export type ReviewComment = {
  id: string
  target: CommentTarget
  text: string
  createdInVersion: number
  sentInVersion?: number
  resolvedInVersion?: number
}

export type Lang = 'en' | 'uk'
export type PaneTab = 'changes' | 'diagram' | 'ask'
export type PaneView = 'tree' | 'file'

export type UiState = {
  lang: Lang
  tab: PaneTab
  view: PaneView
  collapsed: string[]
  selected?: string
  commenting?: string
  showFullSummary: boolean
  showTask: boolean
  expanded: string[]
  pendingSelection?: string
  clientBroken?: boolean
}

export type CommentTarget = {
  path?: string
  symbol?: string
  selection?: string
  lines?: [number, number]
}

export type TaskCapture = {
  userPrompt?: string
  jira?: { key?: string; text: string }
}

export type GeneratedBody = {
  status: 'loading' | 'ready' | 'failed'
  code?: string
  error?: string
}

export type QaStatus = 'asking' | 'done' | 'failed'

/** One follow-up turn under a question: the reply the user typed and its answer. */
export type QaFollowup = {
  id: string
  question: string
  answer?: string
  status: QaStatus
}

/**
 * A question thread. The first question and its answer live on the item
 * itself; later turns are `followups`. `target` is the text the user selected
 * when the question came from the selection popup.
 */
export type QaItem = {
  id: string
  question: string
  answer?: string
  status: QaStatus
  focus?: string
  target?: CommentTarget
  followups?: QaFollowup[]
  createdInVersion?: number
}

export type CanvasNode = { id: string; x: number; y: number; w: number; h: number; label: string; kind?: 'box' | 'text' }
export type CanvasEdge = { id: string; from: string; to: string; label?: string }
export type CanvasStroke = { id: string; points: [number, number][] }
export type Canvas = { nodes: CanvasNode[]; edges: CanvasEdge[]; strokes: CanvasStroke[] }

export type FileCache = Record<string, string | null>

/** The review page server as the mod knows it; the token outlives restarts. */
export type WebState = {
  token?: string
  url?: string
  port?: number
  error?: string
}

export type WebFileView = { format: 'source' | 'diff'; text: string; startLine?: number }

/** A file as the page sees it; the full text comes from /project/<path> on demand. */
export type WebFileEntry = {
  loaded: boolean
  missing?: boolean
  view?: WebFileView
}

export type WebNotice = { id: number; text: string }

/** Everything the page draws, pushed whole after each change. */
export type WebSnapshot = {
  plan: PlanModel | null
  review: Review
  comments: ReviewComment[]
  bodies: Record<string, GeneratedBody>
  qa: QaItem[]
  canvas: Canvas
  files: Record<string, WebFileEntry>
  lang: Lang
  summaryLimit: number
  cwd: string
  notice?: WebNotice
  generatedAt: string
}

declare module 'claude-code' {
  interface PluginState {
    'plan-crutches': {
      plan: PlanModel | null
      review: Review
      comments: ReviewComment[]
      ui: UiState
      task: TaskCapture
      lastPrompt: string
      bodies: Record<string, GeneratedBody>
      qa: QaItem[]
      canvas: Canvas
      files: FileCache
      web: WebState
    }
  }
}
