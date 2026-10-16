// How two versions of a plan differ: which files and symbols the current
// version adds, changes or drops against the version it is compared with.
// Pure; hooks/versions.ts keeps the same notion of "the same file" for the
// OK marks on the mod's side.

export function symbolKey(symbol) {
  return JSON.stringify([symbol.name, symbol.kind, symbol.signature, symbol.description, symbol.anchor || '', symbol.change || 'new'])
}

export function sameSymbol(a, b) {
  return Boolean(a && b) && symbolKey(a) === symbolKey(b)
}

export function sameFile(a, b) {
  if (!a || !b) return false
  if (a.status !== b.status || a.description !== b.description || a.symbols.length !== b.symbols.length) return false
  return a.symbols.every((symbol, index) => sameSymbol(symbol, b.symbols[index]))
}

/**
 * The files of `current` against `compare`: `byPath` maps every current path
 * to `added`, `changed` or `same`; `removed` lists the compared version's
 * files the current one no longer has.
 */
export function fileDeltas(current, compare) {
  const byPath = new Map()
  const removed = []
  if (!current || !compare) return { byPath, removed }
  const before = new Map(compare.files.map(file => [file.path, file]))
  for (const file of current.files) {
    const old = before.get(file.path)
    byPath.set(file.path, !old ? 'added' : sameFile(old, file) ? 'same' : 'changed')
  }
  const now = new Set(current.files.map(file => file.path))
  for (const file of compare.files) if (!now.has(file.path)) removed.push(file)
  return { byPath, removed }
}

/**
 * The symbols of a current file against the same file in the compared
 * version: `byName` maps each current symbol to `added`, `changed` or `same`,
 * `previous` holds the compared version's symbol of the same name, and
 * `removed` lists the symbols the current file no longer plans.
 */
export function symbolDeltas(currentFile, compareFile) {
  const byName = new Map()
  const previous = new Map()
  const removed = []
  if (!currentFile) return { byName, previous, removed }
  const before = new Map((compareFile ? compareFile.symbols : []).map(symbol => [symbol.name, symbol]))
  for (const symbol of currentFile.symbols) {
    const old = before.get(symbol.name)
    if (old) previous.set(symbol.name, old)
    byName.set(symbol.name, !compareFile ? 'added' : !old ? 'added' : sameSymbol(old, symbol) ? 'same' : 'changed')
  }
  const now = new Set(currentFile.symbols.map(symbol => symbol.name))
  if (compareFile) for (const symbol of compareFile.symbols) if (!now.has(symbol.name)) removed.push(symbol)
  return { byName, previous, removed }
}

/** The delta of a folder: `changed` when anything under it was added, changed or removed. */
export function folderDelta(paths, byPath, removedPaths) {
  for (const path of paths) {
    const delta = byPath.get(path)
    if (delta && delta !== 'same') return 'changed'
  }
  return removedPaths.length ? 'changed' : 'same'
}
