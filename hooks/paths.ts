// Where the mod keeps its files: the live review, the saved plan versions and
// the Markdown records. All of it sits under one folder in the user's Claude
// configuration directory, one subfolder per project, so nothing lands in
// the project itself. Pure: hooks/register.tsx reads and writes the files.

/** The folder under the home directory that holds every project's review files. */
export const REVIEWS_FOLDER = '.claude/plan-crutches'

/** A short, stable hash of a text, for folder names that must not collide. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9Ѐ-ӿ]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'plan'
  )
}

function trimSlashes(path: string): string {
  return path.replace(/\/+$/, '')
}

function baseName(path: string): string {
  const parts = trimSlashes(path).split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? 'project'
}

/** The name of a project's subfolder: its folder name and a hash of its whole path. */
export function projectSlug(cwd: string): string {
  return `${slugify(baseName(cwd))}-${shortHash(trimSlashes(cwd))}`
}

/** The root of the mod's files for every project. */
export function reviewsRoot(home: string): string {
  return `${trimSlashes(home)}/${REVIEWS_FOLDER}`
}

/** The folder of one project's review files. */
export function projectDir(home: string, cwd: string): string {
  return `${reviewsRoot(home)}/${projectSlug(cwd)}`
}

/** The live review record of a project. */
export function reviewFile(dir: string): string {
  return `${trimSlashes(dir)}/review.json`
}

/** The generated bodies of a project's live review, beside the record. */
export function bodiesFile(dir: string): string {
  return `${trimSlashes(dir)}/bodies.json`
}

/** The file of one saved plan version. */
export function versionFile(dir: string, version: number): string {
  return `${trimSlashes(dir)}/versions/v${version}.json`
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Where the Markdown records of a project go, from the `plansDir` option:
 * empty or `~`-relative or absolute means a shared folder with one subfolder
 * per project; any other path is a folder inside the project.
 */
export function recordsDir(plansDir: string, cwd: string, home: string): string {
  const option = plansDir.trim().replace(/\/+$/, '')
  if (!option) return projectDir(home, cwd)
  if (option === '~' || option.startsWith('~/')) return `${trimSlashes(home)}${option.slice(1)}/${projectSlug(cwd)}`
  if (isAbsolutePath(option)) return `${option}/${projectSlug(cwd)}`
  return `${trimSlashes(cwd)}/${option}`
}
