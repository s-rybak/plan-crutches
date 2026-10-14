// The change tree: folders first, each with the status of what is under it.
import { escapeHtml } from './markdown.js'
import { t } from './i18n.js'

export function buildTree(files) {
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
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let parent = null
    for (let index = 0; index < parts.length - 1; index += 1) parent = ensureDir(parts.slice(0, index + 1), parent)
    const leaf = { key: `file:${file.path}`, name: parts[parts.length - 1] || file.path, path: file.path, kind: 'file', depth: parts.length - 1, status: file.status, children: [], file }
    ;(parent ? parent.children : roots).push(leaf)
  }
  const finish = nodes => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    for (const node of nodes) {
      if (node.kind !== 'dir') continue
      finish(node.children)
      const statuses = new Set(node.children.map(child => child.status))
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

export function pathsUnder(node) {
  if (node.kind === 'file') return [node.path]
  return node.children.flatMap(pathsUnder)
}

const FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
const FILE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>'

export function renderTree(roots, { collapsed, selected, lang, commentCounts }) {
  const rows = []
  const walk = nodes => {
    for (const node of nodes) {
      const isDir = node.kind === 'dir'
      const isCollapsed = isDir && collapsed.has(node.key)
      const count = commentCounts.get(isDir ? `${node.path}/` : node.path) || 0
      const classes = ['row', node.kind, node.status]
      if (selected === node.path && !isDir) classes.push('selected')
      const label = node.status === 'unchanged' ? '' : `<span class="chip ${node.status}">${t(lang, `status_${node.status}`)}</span>`
      rows.push(
        `<div class="${classes.join(' ')}" data-key="${escapeHtml(node.key)}" data-path="${escapeHtml(node.path)}" data-kind="${node.kind}" style="padding-left:${6 + node.depth * 16}px" title="${escapeHtml(node.path)}">` +
          `<span class="caret">${isDir ? (isCollapsed ? '▸' : '▾') : ''}</span>` +
          `<span class="icon">${isDir ? FOLDER_ICON : FILE_ICON}</span>` +
          `<span class="name">${escapeHtml(node.name)}${isDir ? '/' : ''}</span>` +
          `<span class="spacer"></span>` +
          (count ? `<span class="chip count">${count}</span>` : '') +
          label +
          `<button class="mini" data-action="comment-node" data-path="${escapeHtml(node.path)}" data-kind="${node.kind}" title="${t(lang, isDir ? 'commentOnFolder' : 'commentOnFile')}">💬</button>` +
          `</div>`,
      )
      if (isDir && !isCollapsed) walk(node.children)
    }
  }
  walk(roots)
  return rows.join('')
}
