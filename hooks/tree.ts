import type { FileStatus, PlanFile } from '../types'

export type TreeStatus = FileStatus | 'mixed' | 'unchanged'

export type TreeNode = {
  key: string
  name: string
  path: string
  kind: 'dir' | 'file'
  depth: number
  status: TreeStatus
  children: TreeNode[]
  file?: PlanFile
}

function dirStatus(children: TreeNode[]): TreeStatus {
  const statuses = new Set(children.map(child => child.status))
  if (statuses.size === 1) {
    const only = [...statuses][0]
    if (only === 'new' || only === 'deleted') return only
  }
  return 'mixed'
}

/** Builds the folder tree of a plan's files, folders first, names sorted. */
export function buildTree(files: readonly PlanFile[]): TreeNode[] {
  const root: TreeNode = { key: '', name: '', path: '', kind: 'dir', depth: -1, status: 'mixed', children: [] }
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i] ?? ''
      const path = parts.slice(0, i + 1).join('/')
      const isLeaf = i === parts.length - 1
      let child = node.children.find(one => one.name === name && one.kind === (isLeaf ? 'file' : 'dir'))
      if (!child) {
        child = {
          key: `${isLeaf ? 'file' : 'dir'}:${path}`,
          name,
          path,
          kind: isLeaf ? 'file' : 'dir',
          depth: i,
          status: isLeaf ? file.status : 'mixed',
          children: [],
        }
        if (isLeaf) child.file = file
        node.children.push(child)
      }
      node = child
    }
  }
  const finish = (node: TreeNode): void => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const child of node.children) if (child.kind === 'dir') finish(child)
    if (node.kind === 'dir' && node.children.length > 0) node.status = dirStatus(node.children)
  }
  finish(root)
  return root.children
}

/** The rows a tree shows, in order, with collapsed folders closed. */
export function visibleRows(roots: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeNode[] {
  const rows: TreeNode[] = []
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      rows.push(node)
      if (node.kind === 'dir' && !collapsed.has(node.key)) walk(node.children)
    }
  }
  walk(roots)
  return rows
}

export function allDirKeys(roots: readonly TreeNode[]): string[] {
  const keys: string[] = []
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue
      keys.push(node.key)
      walk(node.children)
    }
  }
  walk(roots)
  return keys
}

/** Every file path under a node (the node itself for a file). */
export function pathsUnder(node: TreeNode): string[] {
  if (node.kind === 'file') return [node.path]
  return node.children.flatMap(pathsUnder)
}
