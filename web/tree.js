// The change tree: folders first, each with the status of what is under it.
// Every file row carries an OK box (reviewed, no comments) and, when the page
// highlights the changes since another version, a delta chip; files that
// version had and this one dropped are drawn as ghost rows.
import { escapeHtml } from './markdown.js'
import { t } from './i18n.js'

export function buildTree(files, ghosts = []) {
  const roots = []
  const byKey = new Map()
  const ensureDir = (parts, parent) => {
    const path = parts.join('/')
    const key = `dir:${path}`
    let node = byKey.get(key)
    if (!node) {
      node = { key, name: parts[parts.length - 1], path, kind: 'dir', depth: parts.length - 1, status: 'unchanged', children: [], files: [] }
      byKey.set(key, node)
      ;(parent ? parent.children : roots).push(node)
    }
    return node
  }
  const addLeaf = (file, ghost) => {
    const parts = file.path.split('/').filter(Boolean)
    let parent = null
    for (let index = 0; index < parts.length - 1; index += 1) parent = ensureDir(parts.slice(0, index + 1), parent)
    const leaf = { key: `file:${file.path}`, name: parts[parts.length - 1] || file.path, path: file.path, kind: 'file', depth: parts.length - 1, status: file.status, children: [], file, ghost }
    ;(parent ? parent.children : roots).push(leaf)
  }
  for (const file of files) addLeaf(file, false)
  for (const file of ghosts) addLeaf(file, true)
  const finish = nodes => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    for (const node of nodes) {
      if (node.kind !== 'dir') continue
      finish(node.children)
      const statuses = new Set(node.children.filter(child => !child.ghost).map(child => child.status))
      node.status = statuses.size === 1 ? [...statuses][0] : 'mixed'
      if (node.status === 'unchanged') node.status = 'mixed'
    }
  }
  finish(roots)
  return roots
}

export function allDirKeys(roots) {
  const keys = []
  const walk = nodes => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue
      keys.push(node.key)
      walk(node.children)
    }
  }
  walk(roots)
  return keys
}

/** Every planned file path under a node (the node itself for a file); ghosts are not planned. */
export function pathsUnder(node) {
  if (node.kind === 'file') return node.ghost ? [] : [node.path]
  return node.children.flatMap(pathsUnder)
}

/** The planned files under a node that are marked OK, and how many there are in all. */
export function okUnder(node, ok) {
  const paths = pathsUnder(node)
  const marked = paths.filter(path => Boolean(ok && ok[path]))
  return { marked: marked.length, total: paths.length }
}

const FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
const FILE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>'

function okBox(node, lang, ok) {
  const { marked, total } = okUnder(node, ok)
  if (total === 0) return '<span class="okbox none"></span>'
  const all = marked === total
  const some = marked > 0 && !all
  const title = node.kind === 'dir' ? (all ? t(lang, 'okFolderOn') : t(lang, 'okFolder')) : all ? t(lang, 'okTitleOn') : t(lang, 'okTitle')
  const classes = ['okbox']
  if (all) classes.push('on')
  else if (some) classes.push('part')
  return `<button class="${classes.join(' ')}" data-action="ok-toggle" data-path="${escapeHtml(node.kind === 'dir' ? `${node.path}/` : node.path)}" data-ok="${all ? 'off' : 'on'}" title="${escapeHtml(title)}" aria-pressed="${all}">${all ? '✓' : some ? '–' : ''}</button>`
}

function deltaChip(delta, lang, since) {
  if (!delta || delta === 'same') return ''
  const key = delta === 'added' ? 'deltaAdded' : delta === 'removed' ? 'deltaRemoved' : 'deltaChanged'
  const sign = delta === 'added' ? '+' : delta === 'removed' ? '−' : '~'
  return `<span class="chip delta ${delta}" title="${escapeHtml(`${t(lang, key)} ${t(lang, 'deltaSince', { n: since })}`)}">${sign} ${t(lang, key)}</span>`
}

/**
 * The rows of the tree. `ok` maps paths to OK marks; `deltas` (optional)
 * is `{ since, byPath, folders }` from the compare view: `byPath` maps a
 * file path to its delta, `folders` maps a folder path to its delta.
 */
export function renderTree(roots, { collapsed, selected, lang, commentCounts, ok = {}, deltas = null, readonly = false }) {
  const rows = []
  const walk = nodes => {
    for (const node of nodes) {
      const isDir = node.kind === 'dir'
      const isCollapsed = isDir && collapsed.has(node.key)
      const count = commentCounts.get(isDir ? `${node.path}/` : node.path) || 0
      const classes = ['row', node.kind, node.status]
      if (node.ghost) classes.push('ghost')
      if (selected === node.path && !isDir && !node.ghost) classes.push('selected')
      if (!isDir && !node.ghost && ok[node.path]) classes.push('ok')
      const label = node.status === 'unchanged' ? '' : `<span class="chip ${node.status}">${t(lang, `status_${node.status}`)}</span>`
      const delta = deltas ? (node.ghost ? 'removed' : isDir ? deltas.folders.get(node.path) : deltas.byPath.get(node.path)) : null
      rows.push(
        `<div class="${classes.join(' ')}" data-key="${escapeHtml(node.key)}" data-path="${escapeHtml(node.path)}" data-kind="${node.kind}"${node.ghost ? ' data-ghost="1"' : ''} style="padding-left:${6 + node.depth * 16}px" title="${escapeHtml(node.path)}">` +
          `<span class="caret">${isDir ? (isCollapsed ? '▸' : '▾') : ''}</span>` +
          (readonly || node.ghost ? '<span class="okbox none"></span>' : okBox(node, lang, ok)) +
          `<span class="icon">${isDir ? FOLDER_ICON : FILE_ICON}</span>` +
          `<span class="name">${escapeHtml(node.name)}${isDir ? '/' : ''}</span>` +
          `<span class="spacer"></span>` +
          (count ? `<span class="chip count">${count}</span>` : '') +
          (deltas ? deltaChip(delta, lang, deltas.since) : '') +
          label +
          (readonly || node.ghost ? '' : `<button class="mini" data-action="comment-node" data-path="${escapeHtml(node.path)}" data-kind="${node.kind}" title="${t(lang, isDir ? 'commentOnFolder' : 'commentOnFile')}">💬</button>`) +
          `</div>`,
      )
      if (isDir && !isCollapsed) walk(node.children)
    }
  }
  walk(roots)
  return rows.join('')
}
