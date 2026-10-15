// The `open` form of the /plan-review command: a plan file the person names,
// reviewed without plan mode. Pure: hooks/register.tsx reads the file and
// starts the review.

export type OpenArgument = { isOpen: boolean; path: string }

/**
 * Reads the command's arguments as `open <path>`: the keyword in any case,
 * the path as typed, with one pair of surrounding quotes removed. `path` is
 * empty when the person gave none.
 */
export function openArgument(args: string): OpenArgument {
  const match = args.trim().match(/^open(?:\s+([\s\S]*))?$/i)
  if (!match) return { isOpen: false, path: '' }
  const given = (match[1] ?? '').trim()
  const quoted = given.match(/^(["'])([\s\S]*)\1$/)
  return { isOpen: true, path: (quoted?.[2] ?? given).trim() }
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Where a path the person typed lands: `~` is the home folder, an absolute
 * path stays as it is, any other path is under `cwd`. `.` and `..` segments
 * are folded, so the same file always gets the same path.
 */
export function resolvePlanPath(given: string, cwd: string, home: string): string {
  let path = given.trim()
  if (path === '~' || path.startsWith('~/')) path = `${home.replace(/\/+$/, '')}${path.slice(1)}`
  if (!isAbsolutePath(path)) path = `${cwd.replace(/\/+$/, '')}/${path}`
  return foldSegments(path)
}

function foldSegments(path: string): string {
  const drive = path.match(/^[A-Za-z]:/)?.[0] ?? ''
  const parts: string[] = []
  for (const part of path.slice(drive.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}

/** One row of a folder listing, as `$.fs.list` gives it; only these fields matter here. */
export type FolderEntry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

/** Where the plan came from when the person named no path. */
export type PlanSource = 'review' | 'newest'

export type FoundPlan = { path: string; source: PlanSource }

/**
 * The newest plan file in `dir`: the `.md` file with the latest change.
 * Folders, links and other files are skipped; undefined when none is left.
 */
export function newestPlanFile(dir: string, entries: readonly FolderEntry[]): string | undefined {
  const newest = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest ? `${dir.replace(/\/+$/, '')}/${newest.name}` : undefined
}

/** How the reply names the plan the mod found on its own. */
export function planSourceNote(source: PlanSource): string {
  return source === 'review' ? 'the plan file of this session' : 'the newest file under ~/.claude/plans'
}
