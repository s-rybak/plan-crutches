// The scene of the change diagram, computed from the generated graph and the
// callers queries the user opened: one block per file in columns by call
// direction (callers left, callees right), one row per symbol, and every edge
// between rows. The callers of an opened symbol come as rows of the planned
// blocks or as blocks of their own in a lane left of the callee; callers past
// the limit are one "others" block. Pure: the renderer draws it on the 3D
// plane, the SVG export draws it flat.

export const BLOCK_W = 250
export const HEAD_H = 38
export const ROW_H = 24
export const PAD = 6
export const NOTE_H = 26
export const COL_GAP = 120
export const ROW_GAP = 34
export const MARGIN = 48

export const rowKey = (path, symbol) => `${path}#${symbol}`

function blockHeight(block) {
  if (block.kind === 'others') return HEAD_H
  return HEAD_H + (block.rows.length ? PAD * 2 + block.rows.length * ROW_H : NOTE_H)
}

/**
 * Longest-path layers of a file graph: a callee sits one layer past its
 * callers. The back edges of cycles are ignored, so every file gets a layer.
 */
export function layerFiles(paths, links) {
  const out = new Map()
  const next = new Map(paths.map(path => [path, []]))
  for (const link of links) {
    if (link.from === link.to || !next.has(link.from) || !next.has(link.to)) continue
    next.get(link.from).push(link.to)
  }
  // back edges by a depth-first walk
  const state = new Map()
  const back = new Set()
  const walk = node => {
    state.set(node, 'open')
    for (const to of next.get(node)) {
      const seen = state.get(to)
      if (seen === 'open') back.add(`${node}>${to}`)
      else if (!seen) walk(to)
    }
    state.set(node, 'done')
  }
  for (const path of paths) if (!state.has(path)) walk(path)
  const incoming = new Map(paths.map(path => [path, []]))
  for (const [from, list] of next) for (const to of list) if (!back.has(`${from}>${to}`)) incoming.get(to).push(from)
  const layerOf = node => {
    if (out.has(node)) return out.get(node)
    out.set(node, 0)
    let layer = 0
    for (const from of incoming.get(node)) layer = Math.max(layer, layerOf(from) + 1)
    out.set(node, layer)
    return layer
  }
  for (const path of paths) layerOf(path)
  return out
}

function orderColumns(columns, links) {
  const neighbours = new Map()
  for (const link of links) {
    if (!neighbours.has(link.to)) neighbours.set(link.to, [])
    if (!neighbours.has(link.from)) neighbours.set(link.from, [])
    neighbours.get(link.to).push(link.from)
    neighbours.get(link.from).push(link.to)
  }
  const position = new Map()
  columns.forEach((column, index) => {
    const previous = index > 0 ? columns[index - 1] : []
    const prevIndex = new Map(previous.map((block, at) => [block.path, at]))
    const score = block => {
      const touching = (neighbours.get(block.path) || []).filter(path => prevIndex.has(path)).map(path => prevIndex.get(path))
      if (!touching.length) return Infinity
      return touching.reduce((sum, at) => sum + at, 0) / touching.length
    }
    column.sort((a, b) => {
      const sa = score(a)
      const sb = score(b)
      if (sa !== sb) return sa - sb
      const ca = (neighbours.get(a.path) || []).length
      const cb = (neighbours.get(b.path) || []).length
      if (ca !== cb) return cb - ca
      return a.path.localeCompare(b.path)
    })
    column.forEach((block, at) => position.set(block.path, at))
  })
}

/**
 * Lays out the scene. `graph` is the generated graph, `callers` the queries by
 * `path#symbol`, `expanded` the set of keys whose callers are shown.
 */
export function layoutScene(graph, callers = {}, expanded = new Set()) {
  const files = (graph && graph.files) || []
  const planned = new Map()
  for (const file of files) {
    const rows = file.symbols.map(symbol => ({ key: rowKey(file.path, symbol.name), name: symbol.name, kind: symbol.kind || 'other', planned: true }))
    planned.set(file.path, { id: `file:${file.path}`, path: file.path, status: file.status, kind: 'file', rows, extra: false })
  }
  const edgeList = []
  const seenEdges = new Set()
  const addEdge = (from, to, kind, origin) => {
    const id = `${from}>${to}`
    if (seenEdges.has(id)) return
    seenEdges.add(id)
    edgeList.push({ id, from, to, kind, origin })
  }
  for (const edge of (graph && graph.edges) || []) addEdge(rowKey(edge.from.path, edge.from.symbol), rowKey(edge.to.path, edge.to.symbol), edge.kind, 'plan')

  const extra = new Map()
  const others = []
  for (const key of expanded) {
    const query = callers[key]
    if (!query || query.status !== 'ready') continue
    for (const caller of query.callers) {
      let block = planned.get(caller.path)
      if (!block) {
        block = extra.get(caller.path)
        if (!block) {
          block = { id: `file:${caller.path}`, path: caller.path, status: 'unchanged', kind: 'file', rows: [], extra: true }
          extra.set(caller.path, block)
        }
      }
      const callerKey = rowKey(caller.path, caller.symbol)
      if (!block.rows.some(row => row.key === callerKey)) {
        block.rows.push({ key: callerKey, name: caller.symbol, kind: caller.kind || 'other', planned: false, line: caller.line })
      }
      addEdge(callerKey, key, 'call', 'callers')
    }
    if (query.more > 0) {
      const id = `others:${key}`
      others.push({ id, path: '', status: 'unchanged', kind: 'others', count: query.more, rows: [{ key: id, name: '', kind: 'other', planned: false }], extra: true, target: key })
      addEdge(id, key, 'call', 'others')
    }
  }

  const blocks = [...planned.values(), ...extra.values(), ...others]
  const rowIndex = new Map()
  for (const block of blocks) block.rows.forEach((row, index) => rowIndex.set(row.key, { block, index }))

  // columns of the planned files, by the calls between them
  const links = []
  for (const edge of edgeList) {
    if (edge.origin !== 'plan') continue
    const from = rowIndex.get(edge.from)
    const to = rowIndex.get(edge.to)
    if (from && to && from.block !== to.block) links.push({ from: from.block.path, to: to.block.path })
  }
  const layer = layerFiles([...planned.keys()], links)
  const columns = []
  for (const block of planned.values()) {
    const at = layer.get(block.path) || 0
    while (columns.length <= at) columns.push([])
    columns[at].push(block)
  }
  orderColumns(columns, links)

  // the lane of each extra block: left of the first column it points into
  const lanes = []
  for (const block of [...extra.values(), ...others]) {
    let target = Infinity
    for (const edge of edgeList) {
      const from = rowIndex.get(edge.from)
      if (!from || from.block !== block) continue
      const to = rowIndex.get(edge.to)
      if (to && !to.block.extra) target = Math.min(target, layer.get(to.block.path) || 0)
    }
    const at = target === Infinity ? 0 : target
    while (lanes.length <= at) lanes.push([])
    lanes[at].push(block)
  }

  for (const block of blocks) {
    block.w = BLOCK_W
    block.h = blockHeight(block)
  }
  // planned columns first: top-aligned stacks
  for (const column of columns) {
    let y = MARGIN
    for (const block of column) {
      block.y = y
      y += block.h + ROW_GAP
    }
  }
  const rowCenter = (block, index) => (block.kind === 'others' ? block.y + HEAD_H / 2 : block.y + HEAD_H + PAD + index * ROW_H + ROW_H / 2)
  // lanes: each block as close to its callee's row as the stack allows
  for (const lane of lanes) {
    const wanted = block => {
      let best = Infinity
      for (const edge of edgeList) {
        const from = rowIndex.get(edge.from)
        if (!from || from.block !== block) continue
        const to = rowIndex.get(edge.to)
        if (to && !to.block.extra) best = Math.min(best, rowCenter(to.block, to.index) - HEAD_H / 2)
      }
      return best === Infinity ? MARGIN : best
    }
    lane.sort((a, b) => wanted(a) - wanted(b) || a.path.localeCompare(b.path))
    let y = MARGIN
    for (const block of lane) {
      block.y = Math.max(y, wanted(block))
      y = block.y + block.h + ROW_GAP
    }
  }
  // x positions: lane k, then column k
  let x = MARGIN
  const count = Math.max(columns.length, lanes.length)
  for (let k = 0; k < count; k += 1) {
    if (lanes[k] && lanes[k].length) {
      for (const block of lanes[k]) block.x = x
      x += BLOCK_W + COL_GAP
    }
    if (columns[k] && columns[k].length) {
      for (const block of columns[k]) block.x = x
      x += BLOCK_W + COL_GAP
    }
  }

  const edges = []
  for (const edge of edgeList) {
    const a = rowIndex.get(edge.from)
    const b = rowIndex.get(edge.to)
    if (!a || !b) continue
    const ya = rowCenter(a.block, a.index)
    const yb = rowCenter(b.block, b.index)
    let mode
    let x1
    let x2
    if (a.block === b.block) {
      mode = a.index === b.index ? 'self' : 'inside'
      x1 = a.block.x
      x2 = b.block.x
    } else if (a.block.x + a.block.w <= b.block.x) {
      mode = 'forward'
      x1 = a.block.x + a.block.w
      x2 = b.block.x
    } else if (b.block.x + b.block.w <= a.block.x) {
      mode = 'backward'
      x1 = a.block.x
      x2 = b.block.x + b.block.w
    } else {
      mode = 'side'
      x1 = a.block.x
      x2 = b.block.x
    }
    edges.push({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, origin: edge.origin, mode, x1, y1: ya, x2, y2: yb })
  }

  let width = MARGIN * 2
  let height = MARGIN * 2
  for (const block of blocks) {
    width = Math.max(width, block.x + block.w + MARGIN)
    height = Math.max(height, block.y + block.h + MARGIN)
  }
  return { blocks, edges, rows: rowIndex, width, height }
}

/** The SVG path of an edge, by how its ends face each other. */
export function pathD(edge) {
  const { x1, y1, x2, y2, mode } = edge
  const round = value => Math.round(value * 10) / 10
  switch (mode) {
    case 'forward': {
      const dx = Math.max(40, (x2 - x1) / 2)
      return `M ${round(x1)} ${round(y1)} C ${round(x1 + dx)} ${round(y1)}, ${round(x2 - dx)} ${round(y2)}, ${round(x2)} ${round(y2)}`
    }
    case 'backward':
      return `M ${round(x1)} ${round(y1)} C ${round(x1 - 70)} ${round(y1)}, ${round(x2 + 70)} ${round(y2)}, ${round(x2)} ${round(y2)}`
    case 'side':
      return `M ${round(x1)} ${round(y1)} C ${round(x1 - 56)} ${round(y1)}, ${round(x2 - 56)} ${round(y2)}, ${round(x2)} ${round(y2)}`
    case 'inside':
      return `M ${round(x1)} ${round(y1)} C ${round(x1 - 38)} ${round(y1)}, ${round(x2 - 38)} ${round(y2)}, ${round(x2)} ${round(y2)}`
    default:
      return `M ${round(x1)} ${round(y1 - 7)} C ${round(x1 - 36)} ${round(y1 - 22)}, ${round(x1 - 36)} ${round(y1 + 22)}, ${round(x1)} ${round(y1 + 7)}`
  }
}
