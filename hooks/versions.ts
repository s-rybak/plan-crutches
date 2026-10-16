// Plan versions, the pure part: what one version holds on disk, how two
// versions of a file compare, and which OK marks survive a new version.
// hooks/register.tsx writes and reads the files.
import type { OkMark, ParsedFrom, PlanFile, PlanModel, PlanSymbol, PlanVersion, SavedVersion, VersionSource } from '../types'

/** The layout of a saved version file; bump it when the shape changes. */
export const VERSION_SHAPE = 1

type SavedVersionFile = SavedVersion & { shape: number }

export function buildSavedVersion(args: {
  version: number
  receivedAt: string
  markdown: string
  plan: PlanModel
  parsedFrom: ParsedFrom
  warnings: readonly string[]
  source: VersionSource
  from?: number
}): SavedVersion {
  return {
    version: args.version,
    receivedAt: args.receivedAt,
    markdown: args.markdown,
    plan: args.plan,
    parsedFrom: args.parsedFrom,
    warnings: [...args.warnings],
    source: args.source,
    ...(args.from !== undefined ? { from: args.from } : {}),
  }
}

/** The text written to a version file. */
export function serializeVersion(saved: SavedVersion): string {
  const file: SavedVersionFile = { shape: VERSION_SHAPE, ...saved }
  return JSON.stringify(file)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The version a file holds, or null when the text is not one this code wrote. */
export function parseSavedVersion(text: string): SavedVersion | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw.shape !== VERSION_SHAPE) return null
  const { version, receivedAt, markdown, plan, parsedFrom, warnings, source, from } = raw
  if (typeof version !== 'number' || typeof receivedAt !== 'string' || typeof markdown !== 'string') return null
  if (!isObject(plan) || typeof plan.title !== 'string' || typeof plan.summary !== 'string' || !Array.isArray(plan.files) || !isObject(plan.task)) return null
  const parsed: ParsedFrom = parsedFrom === 'block' || parsedFrom === 'model' || parsedFrom === 'markdown' ? parsedFrom : 'none'
  const origin: VersionSource = source === 'restored' || source === 'edited' ? source : 'received'
  return {
    version,
    receivedAt,
    markdown,
    plan: plan as unknown as PlanModel,
    parsedFrom: parsed,
    warnings: Array.isArray(warnings) ? warnings.filter((one): one is string => typeof one === 'string') : [],
    source: origin,
    ...(typeof from === 'number' ? { from } : {}),
  }
}

/** The row the state keeps for a saved version. */
export function versionEntry(saved: SavedVersion, path: string): PlanVersion {
  return {
    version: saved.version,
    receivedAt: saved.receivedAt,
    title: saved.plan.title,
    fileCount: saved.plan.files.length,
    source: saved.source,
    ...(saved.from !== undefined ? { from: saved.from } : {}),
    path,
  }
}

function symbolKey(symbol: PlanSymbol): string {
  return JSON.stringify([symbol.name, symbol.kind, symbol.signature, symbol.description, symbol.anchor ?? '', symbol.change ?? 'new'])
}

/** Whether two versions plan the same thing for a file: same status, description and symbols. */
export function sameFile(a: PlanFile | undefined, b: PlanFile | undefined): boolean {
  if (!a || !b) return false
  if (a.status !== b.status || a.description !== b.description || a.symbols.length !== b.symbols.length) return false
  return a.symbols.every((symbol, index) => symbolKey(symbol) === symbolKey(b.symbols[index] as PlanSymbol))
}

/**
 * The OK marks that still hold after a new version: a mark stays while its
 * file is planned the same way; a changed or dropped file loses its mark.
 */
export function keepOkMarks(marks: Readonly<Record<string, OkMark>>, previous: PlanModel | null, next: PlanModel): Record<string, OkMark> {
  if (!previous) return {}
  const before = new Map(previous.files.map(file => [file.path, file]))
  const after = new Map(next.files.map(file => [file.path, file]))
  const kept: Record<string, OkMark> = {}
  for (const [path, mark] of Object.entries(marks)) {
    if (sameFile(before.get(path), after.get(path))) kept[path] = mark
  }
  return kept
}

/** The paths a folder mark covers: every planned file under `dir/`. */
export function pathsUnderFolder(plan: PlanModel, folder: string): string[] {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`
  return plan.files.filter(file => file.path.startsWith(prefix)).map(file => file.path)
}
