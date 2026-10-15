// The review as the plugin store keeps it between processes. The session
// state (`$.state`) lives only as long as the process; `$.store` is the
// plugin's own JSON file and outlives a restart. These helpers are pure: the
// mod reads and writes the store in hooks/register.tsx.

import type {
  Diagram,
  GeneratedBody,
  PlanModel,
  QaItem,
  Review,
  ReviewComment,
  StoredIndexEntry,
  StoredReview,
  TaskCapture,
  UiState,
} from '../types'

/** The layout of a stored record; bump it when the record's shape changes. */
export const STORED_SHAPE = 1
/** The store key of the index of folders with a stored review. */
export const STORE_INDEX_KEY = 'reviews'
/** How many folders keep a stored review; the oldest beyond it are dropped. */
export const STORE_KEEP = 8
/** A record with its bodies is written only while its JSON stays under this. */
export const STORE_RECORD_LIMIT = 1024 * 1024

export function storeKey(cwd: string): string {
  return `review:${cwd}`
}

/** A review a later process can take up: one still under review or being revised. */
export function isRestorable(review: Pick<Review, 'status'>): boolean {
  return review.status === 'reviewing' || review.status === 'revising'
}

export type StoredInput = {
  cwd: string
  sessionId: string
  savedAt: string
  plan: PlanModel
  review: Review
  comments: readonly ReviewComment[]
  qa: readonly QaItem[]
  diagram: Diagram
  task: TaskCapture
  ui: UiState
  bodies: Record<string, GeneratedBody>
  token?: string
}

/** The record of a live review; the bodies ride along only while the whole record stays small. */
export function buildStored(input: StoredInput): StoredReview {
  const base: StoredReview = {
    shape: STORED_SHAPE,
    cwd: input.cwd,
    sessionId: input.sessionId,
    savedAt: input.savedAt,
    plan: input.plan,
    review: input.review,
    comments: [...input.comments],
    qa: [...input.qa],
    diagram: input.diagram,
    task: input.task,
    ui: input.ui,
    ...(input.token ? { token: input.token } : {}),
  }
  const ready = Object.fromEntries(Object.entries(input.bodies).filter(([, body]) => body.status === 'ready'))
  if (Object.keys(ready).length === 0) return base
  const withBodies: StoredReview = { ...base, bodies: ready }
  return JSON.stringify(withBodies).length <= STORE_RECORD_LIMIT ? withBodies : base
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stored record, or null when the value is not one this shape of the code wrote. */
export function parseStored(value: unknown): StoredReview | null {
  if (!isObject(value) || value.shape !== STORED_SHAPE) return null
  const { cwd, sessionId, savedAt, plan, review, comments, qa, diagram, task, ui, bodies, token } = value
  if (typeof cwd !== 'string' || !cwd || typeof sessionId !== 'string' || typeof savedAt !== 'string') return null
  if (!isObject(plan) || typeof plan.title !== 'string' || typeof plan.summary !== 'string' || !Array.isArray(plan.files) || !isObject(plan.task)) return null
  if (!isObject(review) || typeof review.status !== 'string' || typeof review.version !== 'number' || !Array.isArray(review.history)) return null
  if (!Array.isArray(review.warnings) || !Array.isArray(review.previousPaths)) return null
  if (!Array.isArray(comments) || !Array.isArray(qa) || !isObject(diagram) || !isObject(task) || !isObject(ui)) return null
  if (bodies !== undefined && !isObject(bodies)) return null
  if (token !== undefined && typeof token !== 'string') return null
  return {
    shape: STORED_SHAPE,
    cwd,
    sessionId,
    savedAt,
    plan: plan as unknown as PlanModel,
    review: review as unknown as Review,
    comments: comments as ReviewComment[],
    qa: qa as QaItem[],
    diagram: diagram as unknown as Diagram,
    task: task as TaskCapture,
    ui: ui as unknown as UiState,
    ...(bodies ? { bodies: bodies as Record<string, GeneratedBody> } : {}),
    ...(token ? { token } : {}),
  }
}

export type Thawed = {
  plan: PlanModel
  review: Review
  comments: ReviewComment[]
  qa: QaItem[]
  diagram: Diagram
  task: TaskCapture
  ui: UiState
  bodies: Record<string, GeneratedBody>
}

const INTERRUPTED = 'interrupted by a restart of Claude Code'

/**
 * The record as a new process takes it up: nothing is still loading, since the
 * calls that were under way died with the old process, and the pane's
 * transient fields are cleared.
 */
export function thawStored(stored: StoredReview): Thawed {
  const qa = stored.qa.map(item => {
    const followups = (item.followups ?? []).map(turn => (turn.status === 'asking' ? { ...turn, status: 'failed' as const, answer: INTERRUPTED } : turn))
    const settled = item.status === 'asking' ? { ...item, status: 'failed' as const, answer: INTERRUPTED } : item
    return item.followups ? { ...settled, followups } : settled
  })
  const diagram: Diagram =
    stored.diagram.status === 'loading'
      ? { status: 'idle', callers: {} }
      : { ...stored.diagram, callers: Object.fromEntries(Object.entries(stored.diagram.callers ?? {}).filter(([, query]) => query.status !== 'loading')) }
  const bodies = Object.fromEntries(Object.entries(stored.bodies ?? {}).filter(([, body]) => body.status === 'ready'))
  const { commenting: _commenting, pendingSelection: _pendingSelection, clientBroken: _clientBroken, ...ui } = stored.ui
  return {
    plan: stored.plan,
    review: { ...stored.review, history: [...stored.review.history] },
    comments: [...stored.comments],
    qa,
    diagram,
    task: stored.task,
    ui: { ...ui, collapsed: [...(ui.collapsed ?? [])], expanded: [...(ui.expanded ?? [])] },
    bodies,
  }
}

export function parseIndex(value: unknown): StoredIndexEntry[] {
  if (!Array.isArray(value)) return []
  const entries: StoredIndexEntry[] = []
  for (const row of value) {
    if (!isObject(row) || typeof row.cwd !== 'string' || !row.cwd || typeof row.savedAt !== 'string') continue
    entries.push({
      cwd: row.cwd,
      savedAt: row.savedAt,
      title: typeof row.title === 'string' ? row.title : '',
      version: typeof row.version === 'number' ? row.version : 0,
    })
  }
  return entries
}

/** The index with `entry` in place of its folder's old row, newest first, cut at `keep`; `dropped` names the folders cut off. */
export function indexWith(entries: readonly StoredIndexEntry[], entry: StoredIndexEntry, keep: number): { entries: StoredIndexEntry[]; dropped: string[] } {
  const merged = [entry, ...entries.filter(one => one.cwd !== entry.cwd)].sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0))
  return { entries: merged.slice(0, keep), dropped: merged.slice(keep).map(one => one.cwd) }
}

export function indexWithout(entries: readonly StoredIndexEntry[], cwd: string): StoredIndexEntry[] {
  return entries.filter(one => one.cwd !== cwd)
}
