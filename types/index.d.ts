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
  diagramSvgPath?: string
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

export type DiagramStatus = 'idle' | 'loading' | 'ready' | 'failed'
export type DiagramFileStatus = FileStatus | 'unchanged'

/** One row of a diagram block: a planned symbol, or an existing one a callers query brought in. */
export type DiagramSymbol = { name: string; kind: SymbolKind; line?: number }

/** One block of the diagram: a file with the symbols the plan changes (a deleted file: its exported symbols). */
export type DiagramFile = { path: string; status: DiagramFileStatus; symbols: DiagramSymbol[] }

export type DiagramRef = { path: string; symbol: string }

/** `from` calls `to` (kind `call`), or uses it as a type or a constant (kind `use`). */
export type DiagramEdge = { from: DiagramRef; to: DiagramRef; kind: 'call' | 'use' }

/** The change graph: every planned file with its symbols, and the calls between them. */
export type DiagramGraph = { files: DiagramFile[]; edges: DiagramEdge[] }

/** One place in the project that calls or uses a planned symbol: the enclosing symbol of the use. */
export type DiagramCaller = { path: string; symbol: string; kind?: SymbolKind; line?: number }

/** The callers of one planned symbol, as the page asked for them; `more` is how many beyond the limit. */
export type CallersQuery = {
  status: 'loading' | 'ready' | 'failed'
  callers: DiagramCaller[]
  more: number
  /** Where the list came from: the clean session, a model call without files, or the text search alone. */
  source?: 'session' | 'model' | 'search'
  error?: string
}

/** Where the diagram came from: a clean session with read-only tools, or a model call without them. */
export type DiagramSource = 'session' | 'model'

/** The generated change diagram and the callers queries made on it, keyed `path#symbol`. */
export type Diagram = {
  status: DiagramStatus
  graph?: DiagramGraph
  /** The plan version the graph was generated for. */
  version?: number
  source?: DiagramSource
  error?: string
  callers: Record<string, CallersQuery>
}

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
  diagram: Diagram
  files: Record<string, WebFileEntry>
  lang: Lang
  summaryLimit: number
  cwd: string
  notice?: WebNotice
  generatedAt: string
  /** The shape of this state and of the actions the mod understands; the page warns when its own number differs. */
  protocol: number
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
      diagram: Diagram
      files: FileCache
      web: WebState
    }
  }
}
