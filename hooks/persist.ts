// The review as the mod keeps it between processes. The session state
// (`$.state`) lives only as long as the process. The record itself is a JSON
// file under the mod's own folder in the Claude configuration directory (see
// hooks/paths.ts), so its size is not bound by the plugin store; `$.store`
// holds only the small index of folders that have one. These helpers are
// pure: the mod reads and writes the files in hooks/register.tsx.

import type {
  Diagram,
  Explanation,
  GeneratedBody,
  OkMark,
  PlanModel,
  PlanVersion,
  QaItem,
  Review,
  ReviewComment,
  StoredIndexEntry,
  StoredReview,
  TaskCapture,
  UiState,
} from '../types'

/** The layout of a stored record; bump it when the record's shape changes. */
export const STORED_SHAPE = 2
/** The store key of the index of folders with a stored review. */
export const STORE_INDEX_KEY = 'reviews'
/** How many folders keep a stored review; the oldest beyond it are dropped. */
export const STORE_KEEP = 8
/**
 * The largest file the mod reads back (`$.fs.read` refuses more than 4 MiB),
 * with room to spare: a record or a bodies file is cut to fit under it.
 */
export const STORE_FILE_LIMIT = 3_800_000

/** The legacy store key of a folder's record, from the time the record lived in the store itself. */
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
  ok: Readonly<Record<string, OkMark>>
  versions: readonly PlanVersion[]
  explanations?: Readonly<Record<string, Explanation>>
  token?: string
}

/** The record of a live review, without the generated bodies (they have a file of their own). */
export function buildStored(input: StoredInput): StoredReview {
  const explanations = Object.fromEntries(Object.entries(input.explanations ?? {}).filter(([, one]) => one.status === 'done'))
  return {
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
    ok: { ...input.ok },
    versions: [...input.versions],
    ...(Object.keys(explanations).length ? { explanations } : {}),
    ...(input.token ? { token: input.token } : {}),
  }
}

/**
 * The record as JSON text that fits under `limit`: when the whole record is
 * too large, the explanations go first, then the questions, then the
 * diagram, so the plan and the comments always survive.
 */
export function serializeStored(record: StoredReview, limit = STORE_FILE_LIMIT): string {
  let current: StoredReview = record
  let text = JSON.stringify(current)
  if (text.length <= limit) return text
  const { explanations: _explanations, ...withoutExplanations } = current
  current = withoutExplanations
  text = JSON.stringify(current)
  if (text.length <= limit) return text
  current = { ...current, qa: [] }
  text = JSON.stringify(current)
  if (text.length <= limit) return text
  current = { ...current, diagram: { status: 'idle', callers: {} } }
  return JSON.stringify(current)
}

/** The ready bodies as JSON text for their own file, the largest dropped until the text fits under `limit`. */
export function serializeBodies(bodies: Readonly<Record<string, GeneratedBody>>, limit = STORE_FILE_LIMIT): string {
  const ready = Object.entries(bodies).filter(([, body]) => body.status === 'ready')
  ready.sort(([, a], [, b]) => (a.code ?? '').length - (b.code ?? '').length)
  let kept = ready
  let text = JSON.stringify(Object.fromEntries(kept))
  while (text.length > limit && kept.length > 0) {
    kept = kept.slice(0, -1)
    text = JSON.stringify(Object.fromEntries(kept))
  }
  return text
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stored record, or null when the value is not one this shape of the code wrote. */
export function parseStored(value: unknown): StoredReview | null {
  if (!isObject(value) || value.shape !== STORED_SHAPE) return null
  const { cwd, sessionId, savedAt, plan, review, comments, qa, diagram, task, ui, ok, versions, explanations, bodies, token } = value
  if (typeof cwd !== 'string' || !cwd || typeof sessionId !== 'string' || typeof savedAt !== 'string') return null
  if (!isObject(plan) || typeof plan.title !== 'string' || typeof plan.summary !== 'string' || !Array.isArray(plan.files) || !isObject(plan.task)) return null
  if (!isObject(review) || typeof review.status !== 'string' || typeof review.version !== 'number' || !Array.isArray(review.history)) return null
  if (!Array.isArray(review.warnings) || !Array.isArray(review.previousPaths)) return null
  if (!Array.isArray(comments) || !Array.isArray(qa) || !isObject(diagram) || !isObject(task) || !isObject(ui)) return null
  if (ok !== undefined && !isObject(ok)) return null
  if (versions !== undefined && !Array.isArray(versions)) return null
  if (explanations !== undefined && !isObject(explanations)) return null
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
    ok: (ok ?? {}) as Record<string, OkMark>,
    versions: (versions ?? []) as PlanVersion[],
    ...(explanations ? { explanations: explanations as Record<string, Explanation> } : {}),
    ...(bodies ? { bodies: bodies as Record<string, GeneratedBody> } : {}),
    ...(token ? { token } : {}),
  }
}

/** The record in a file's text, or null. */
export function parseStoredText(text: string): StoredReview | null {
  try {
    return parseStored(JSON.parse(text))
  } catch {
    return null
  }
}

/** The bodies in their file's text; an unreadable file is no bodies. */
export function parseBodiesText(text: string): Record<string, GeneratedBody> {
  try {
    const raw: unknown = JSON.parse(text)
    if (!isObject(raw)) return {}
    const out: Record<string, GeneratedBody> = {}
    for (const [key, body] of Object.entries(raw)) {
      if (isObject(body) && body.status === 'ready' && typeof body.code === 'string') out[key] = { status: 'ready', code: body.code }
    }
    return out
  } catch {
    return {}
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
  ok: Record<string, OkMark>
  versions: PlanVersion[]
  explanations: Record<string, Explanation>
}

const INTERRUPTED = 'interrupted by a restart of Claude Code'

/**
 * The record as a new process takes it up: nothing is still loading, since the
 * calls that were under way died with the old process, and the pane's
 * transient fields are cleared.
 */
export function thawStored(stored: StoredReview, bodies: Readonly<Record<string, GeneratedBody>> = stored.bodies ?? {}): Thawed {
  const qa = stored.qa.map(item => {
    const followups = (item.followups ?? []).map(turn => (turn.status === 'asking' ? { ...turn, status: 'failed' as const, answer: INTERRUPTED } : turn))
    const settled = item.status === 'asking' ? { ...item, status: 'failed' as const, answer: INTERRUPTED } : item
    return item.followups ? { ...settled, followups } : settled
  })
  const diagram: Diagram =
    stored.diagram.status === 'loading'
      ? { status: 'idle', callers: {} }
      : { ...stored.diagram, callers: Object.fromEntries(Object.entries(stored.diagram.callers ?? {}).filter(([, query]) => query.status !== 'loading')) }
  const ready = Object.fromEntries(Object.entries(bodies).filter(([, body]) => body.status === 'ready'))
  const explanations = Object.fromEntries(Object.entries(stored.explanations ?? {}).filter(([, one]) => one.status === 'done'))
  const { commenting: _commenting, pendingSelection: _pendingSelection, clientBroken: _clientBroken, ...ui } = stored.ui
  return {
    plan: stored.plan,
    review: { ...stored.review, history: [...stored.review.history] },
    comments: [...stored.comments],
    qa,
    diagram,
    task: stored.task,
    ui: { ...ui, collapsed: [...(ui.collapsed ?? [])], expanded: [...(ui.expanded ?? [])] },
    bodies: ready,
    ok: { ...(stored.ok ?? {}) },
    versions: [...(stored.versions ?? [])],
    explanations,
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
      ...(typeof row.dir === 'string' && row.dir ? { dir: row.dir } : {}),
    })
  }
  return entries
}

/** The index with `entry` in place of its folder's old row, newest first, cut at `keep`; `dropped` names the folders cut off. */
export function indexWith(entries: readonly StoredIndexEntry[], entry: StoredIndexEntry, keep: number): { entries: StoredIndexEntry[]; dropped: StoredIndexEntry[] } {
  const merged = [entry, ...entries.filter(one => one.cwd !== entry.cwd)].sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0))
  return { entries: merged.slice(0, keep), dropped: merged.slice(keep) }
}

export function indexWithout(entries: readonly StoredIndexEntry[], cwd: string): StoredIndexEntry[] {
  return entries.filter(one => one.cwd !== cwd)
}
