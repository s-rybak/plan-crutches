// The diagram editor: boxes, arrows, free strokes and text labels on an SVG.
// Local state first; changes reach the mod debounced through onChange.
import { t } from './i18n.js'
import { escapeHtml } from './markdown.js'

const WIDTH = 1600
const HEIGHT = 1000
const NODE_W = 170
const NODE_H = 66
const TOOLS = ['select', 'box', 'arrow', 'pen', 'text', 'delete']

const newId = prefix => `${prefix}_${Math.random().toString(36).slice(2, 8)}`
const clone = value => JSON.parse(JSON.stringify(value))
const empty = () => ({ nodes: [], edges: [], strokes: [] })

function anchor(node, towardX, towardY) {
  const cx = node.x + node.w / 2
  const cy = node.y + node.h / 2
  const dx = towardX - cx
  const dy = towardY - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const sx = node.w ? node.w / 2 / Math.abs(dx || 1e-9) : Infinity
  const sy = node.h ? node.h / 2 / Math.abs(dy || 1e-9) : Infinity
  const scale = Math.min(sx, sy, 1)
  return [cx + dx * scale, cy + dy * scale]
}

function wrapLabel(label, width) {
  const perLine = Math.max(6, Math.floor(width / 8.6))
  const words = String(label || '').split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    if ((current + ' ' + word).trim().length > perLine && current) {
      lines.push(current)
      current = word
    } else {
      current = (current + ' ' + word).trim()
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, 4)
}

export function mountDiagram(host, { lang, initial, onChange, onSaveSvg }) {
  let canvas = initial ? clone(initial) : empty()
  let known = JSON.stringify(canvas)
  let tool = 'select'
  let selected = null
  let drag = null
  let timer = null
  let editor = null
  let language = lang

  host.innerHTML = `
    <div class="diagram-toolbar"></div>
    <div class="hint diagram-hint"></div>
    <div class="diagram-wrap" style="position:relative">
      <svg class="diagram" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMinYMin meet" tabindex="0">
        <defs>
          <marker id="pc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path>
          </marker>
        </defs>
        <g class="layer-edges"></g>
        <g class="layer-strokes"></g>
        <g class="layer-nodes"></g>
        <g class="layer-ghost"></g>
      </svg>
    </div>`
  const toolbar = host.querySelector('.diagram-toolbar')
  const hint = host.querySelector('.diagram-hint')
  const wrap = host.querySelector('.diagram-wrap')
  const svg = host.querySelector('svg')
  const layers = {
    edges: svg.querySelector('.layer-edges'),
    strokes: svg.querySelector('.layer-strokes'),
    nodes: svg.querySelector('.layer-nodes'),
    ghost: svg.querySelector('.layer-ghost'),
  }

  function renderToolbar() {
    toolbar.innerHTML =
      TOOLS.map(name => `<button class="btn small${tool === name ? ' active' : ''}" data-tool="${name}">${t(language, `tool_${name}`)}</button>`).join('') +
      `<span class="spacer"></span>` +
      `<button class="btn small" data-diagram="clear">${t(language, 'clear')}</button>` +
      `<button class="btn small" data-diagram="svg">${t(language, 'attachSvg')}</button>`
    hint.textContent = t(language, 'diagramHint')
    svg.className.baseVal = `diagram tool-${tool}`
  }

  function nodeById(id) {
    return canvas.nodes.find(node => node.id === id)
  }

  function edgePath(edge) {
    const from = nodeById(edge.from)
    const to = nodeById(edge.to)
    if (!from || !to) return null
    const [x1, y1] = anchor(from, to.x + to.w / 2, to.y + to.h / 2)
    const [x2, y2] = anchor(to, from.x + from.w / 2, from.y + from.h / 2)
    return { x1, y1, x2, y2 }
  }

  function render() {
    layers.edges.innerHTML = canvas.edges
      .map(edge => {
        const geometry = edgePath(edge)
        if (!geometry) return ''
        const { x1, y1, x2, y2 } = geometry
        const isSelected = selected && selected.type === 'edge' && selected.id === edge.id
        const mx = (x1 + x2) / 2
        const my = (y1 + y2) / 2
        return (
          `<g data-type="edge" data-id="${edge.id}">` +
          `<line class="edge-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>` +
          `<line class="edge${isSelected ? ' selected' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#pc-arrow)"></line>` +
          (edge.label ? `<text class="edge-label" x="${mx}" y="${my - 8}" text-anchor="middle">${escapeHtml(edge.label)}</text>` : '') +
          `</g>`
        )
      })
      .join('')
    layers.strokes.innerHTML = canvas.strokes
      .map(stroke => {
        const isSelected = selected && selected.type === 'stroke' && selected.id === stroke.id
        return `<polyline data-type="stroke" data-id="${stroke.id}" class="stroke${isSelected ? ' selected' : ''}" points="${stroke.points.map(point => point.join(',')).join(' ')}"></polyline>`
      })
      .join('')
    layers.nodes.innerHTML = canvas.nodes
      .map(node => {
        const isSelected = selected && selected.type === 'node' && selected.id === node.id
        if (node.kind === 'text') {
          return `<g data-type="node" data-id="${node.id}" class="label${isSelected ? ' selected' : ''}" transform="translate(${node.x},${node.y})"><rect x="-6" y="-20" width="${Math.max(40, (node.label || '').length * 8.6 + 12)}" height="28" fill="transparent"></rect><text x="0" y="0">${escapeHtml(node.label || '')}</text></g>`
        }
        const lines = wrapLabel(node.label, node.w)
        const lineHeight = 18
        const startY = node.h / 2 - ((lines.length - 1) * lineHeight) / 2 + 5
        return (
          `<g data-type="node" data-id="${node.id}" class="node${isSelected ? ' selected' : ''}" transform="translate(${node.x},${node.y})">` +
          `<rect width="${node.w}" height="${node.h}"></rect>` +
          `<text x="${node.w / 2}" y="${startY}" text-anchor="middle">${lines.map((line, index) => `<tspan x="${node.w / 2}" dy="${index === 0 ? 0 : lineHeight}">${escapeHtml(line)}</tspan>`).join('')}</text>` +
          `</g>`
        )
      })
      .join('')
  }

  function renderGhost() {
    if (!drag) {
      layers.ghost.innerHTML = ''
      return
    }
    if (drag.kind === 'arrow') {
      const from = nodeById(drag.from)
      if (!from) return
      const [x1, y1] = anchor(from, drag.x, drag.y)
      layers.ghost.innerHTML = `<line class="ghost" x1="${x1}" y1="${y1}" x2="${drag.x}" y2="${drag.y}"></line>`
    } else if (drag.kind === 'pen') {
      layers.ghost.innerHTML = `<polyline class="stroke" points="${drag.points.map(point => point.join(',')).join(' ')}"></polyline>`
    } else {
      layers.ghost.innerHTML = ''
    }
  }

  function changed() {
    known = JSON.stringify(canvas)
    render()
    clearTimeout(timer)
    timer = setTimeout(() => onChange(clone(canvas)), 400)
  }

  function toPoint(event) {
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const matrix = svg.getScreenCTM()
    if (!matrix) return { x: 0, y: 0 }
    const local = point.matrixTransform(matrix.inverse())
    return { x: Math.round(local.x), y: Math.round(local.y) }
  }

  function hit(event) {
    const element = event.target.closest('[data-type]')
    return element ? { type: element.dataset.type, id: element.dataset.id } : null
  }

  function remove(target) {
    if (!target) return
    if (target.type === 'node') {
      canvas.nodes = canvas.nodes.filter(node => node.id !== target.id)
      canvas.edges = canvas.edges.filter(edge => edge.from !== target.id && edge.to !== target.id)
    } else if (target.type === 'edge') {
      canvas.edges = canvas.edges.filter(edge => edge.id !== target.id)
    } else if (target.type === 'stroke') {
      canvas.strokes = canvas.strokes.filter(stroke => stroke.id !== target.id)
    }
    if (selected && selected.id === target.id) selected = null
    changed()
  }

  function closeEditor(save) {
    if (!editor) return
    const { input, apply } = editor
    editor = null
    if (save) apply(input.value.trim())
    input.remove()
  }

  function editLabel(target) {
    closeEditor(false)
    let current = ''
    let apply
    let rect
    if (target.type === 'node') {
      const node = nodeById(target.id)
      if (!node) return
      current = node.label || ''
      apply = value => {
        node.label = value
        changed()
      }
      rect = svg.querySelector(`[data-id="${node.id}"] rect`)?.getBoundingClientRect()
    } else if (target.type === 'edge') {
      const edge = canvas.edges.find(one => one.id === target.id)
      if (!edge) return
      current = edge.label || ''
      apply = value => {
        edge.label = value
        changed()
      }
      rect = svg.querySelector(`[data-id="${edge.id}"] .edge`)?.getBoundingClientRect()
    } else {
      return
    }
    const wrapRect = wrap.getBoundingClientRect()
    const input = document.createElement('input')
    input.className = 'label-editor'
    input.value = current
    input.placeholder = t(language, target.type === 'edge' ? 'edgeLabel' : 'rename')
    const left = rect ? rect.left - wrapRect.left : 20
    const top = rect ? rect.top - wrapRect.top + (target.type === 'edge' ? rect.height / 2 - 14 : rect.height / 2 - 14) : 20
    input.style.left = `${Math.max(4, left)}px`
    input.style.top = `${Math.max(4, top)}px`
    input.style.width = `${Math.max(120, rect ? rect.width : 160)}px`
    wrap.appendChild(input)
    editor = { input, apply }
    input.focus()
    input.select()
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        closeEditor(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closeEditor(false)
      }
    })
    input.addEventListener('blur', () => closeEditor(true))
  }

  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    if (editor) closeEditor(true)
    const point = toPoint(event)
    const target = hit(event)
    svg.focus({ preventScroll: true })
    if (tool === 'box') {
      const node = { id: newId('n'), x: point.x - NODE_W / 2, y: point.y - NODE_H / 2, w: NODE_W, h: NODE_H, label: '' }
      canvas.nodes.push(node)
      selected = { type: 'node', id: node.id }
      changed()
      // The browser moves focus to the svg after this handler; open the editor after that.
      setTimeout(() => editLabel(selected), 0)
      return
    }
    if (tool === 'text') {
      const node = { id: newId('t'), x: point.x, y: point.y, w: 0, h: 0, label: '', kind: 'text' }
      canvas.nodes.push(node)
      selected = { type: 'node', id: node.id }
      changed()
      setTimeout(() => editLabel(selected), 0)
      return
    }
    if (tool === 'delete') {
      remove(target)
      return
    }
    if (tool === 'arrow') {
      if (target && target.type === 'node') {
        drag = { kind: 'arrow', from: target.id, x: point.x, y: point.y }
        svg.setPointerCapture(event.pointerId)
        renderGhost()
      }
      return
    }
    if (tool === 'pen') {
      drag = { kind: 'pen', points: [[point.x, point.y]] }
      svg.setPointerCapture(event.pointerId)
      renderGhost()
      return
    }
    // select
    if (target && target.type === 'node') {
      const node = nodeById(target.id)
      selected = target
      drag = { kind: 'move', id: node.id, dx: point.x - node.x, dy: point.y - node.y, moved: false }
      svg.setPointerCapture(event.pointerId)
      render()
      return
    }
    selected = target
    render()
  })

  svg.addEventListener('pointermove', event => {
    if (!drag) return
    const point = toPoint(event)
    if (drag.kind === 'move') {
      const node = nodeById(drag.id)
      if (!node) return
      node.x = point.x - drag.dx
      node.y = point.y - drag.dy
      drag.moved = true
      render()
    } else if (drag.kind === 'arrow') {
      drag.x = point.x
      drag.y = point.y
      renderGhost()
    } else if (drag.kind === 'pen') {
      const last = drag.points[drag.points.length - 1]
      if (Math.abs(last[0] - point.x) + Math.abs(last[1] - point.y) >= 3) {
        drag.points.push([point.x, point.y])
        renderGhost()
      }
    }
  })

  function finishDrag(event, point) {
    if (!drag) return
    const current = drag
    drag = null
    renderGhost()
    if (current.kind === 'pen' && point) {
      const last = current.points[current.points.length - 1]
      if (last[0] !== point.x || last[1] !== point.y) current.points.push([point.x, point.y])
    }
    if (current.kind === 'move') {
      if (current.moved) changed()
      return
    }
    if (current.kind === 'arrow') {
      const target = event ? hit(event) : null
      if (target && target.type === 'node' && target.id !== current.from) {
        const edge = { id: newId('e'), from: current.from, to: target.id }
        canvas.edges.push(edge)
        selected = { type: 'edge', id: edge.id }
        changed()
      }
      return
    }
    if (current.kind === 'pen') {
      if (current.points.length > 1) {
        canvas.strokes.push({ id: newId('s'), points: current.points })
        changed()
      }
    }
  }

  svg.addEventListener('pointerup', event => {
    // With pointer capture the target is the svg; find what is under the pointer.
    const under = document.elementFromPoint(event.clientX, event.clientY)
    finishDrag(under ? { target: under } : null, toPoint(event))
  })
  svg.addEventListener('pointercancel', () => finishDrag(null))

  svg.addEventListener('dblclick', event => {
    const target = hit(event)
    if (target && (target.type === 'node' || target.type === 'edge')) editLabel(target)
  })

  svg.addEventListener('keydown', event => {
    if (editor) return
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      event.preventDefault()
      remove(selected)
    } else if (event.key === 'Escape') {
      selected = null
      render()
    }
  })

  toolbar.addEventListener('click', event => {
    const toolButton = event.target.closest('[data-tool]')
    if (toolButton) {
      tool = toolButton.dataset.tool
      renderToolbar()
      return
    }
    const command = event.target.closest('[data-diagram]')
    if (!command) return
    if (command.dataset.diagram === 'clear') {
      canvas = empty()
      selected = null
      changed()
    } else if (command.dataset.diagram === 'svg') {
      onSaveSvg(toSvg())
    }
  })

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  }

  function toSvg() {
    const stroke = cssVar('--fg', '#222')
    const nodeFill = cssVar('--accent-soft', '#e8ebff')
    const nodeStroke = cssVar('--accent', '#5b6cff')
    const penStroke = cssVar('--comment', '#7c3aed')
    const bounds = { minX: WIDTH, minY: HEIGHT, maxX: 0, maxY: 0 }
    const grow = (x, y) => {
      bounds.minX = Math.min(bounds.minX, x)
      bounds.minY = Math.min(bounds.minY, y)
      bounds.maxX = Math.max(bounds.maxX, x)
      bounds.maxY = Math.max(bounds.maxY, y)
    }
    for (const node of canvas.nodes) {
      grow(node.x - 10, node.y - 24)
      grow(node.x + Math.max(node.w, (node.label || '').length * 8.6) + 10, node.y + node.h + 10)
    }
    for (const stroke of canvas.strokes) for (const [x, y] of stroke.points) grow(x - 5, y - 5), grow(x + 5, y + 5)
    if (bounds.maxX <= bounds.minX) Object.assign(bounds, { minX: 0, minY: 0, maxX: WIDTH, maxY: HEIGHT })
    const parts = []
    parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${stroke}"/></marker></defs>`)
    for (const edge of canvas.edges) {
      const geometry = edgePath(edge)
      if (!geometry) continue
      const { x1, y1, x2, y2 } = geometry
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="2" marker-end="url(#arrow)"/>`)
      if (edge.label) parts.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 8}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${stroke}">${escapeHtml(edge.label)}</text>`)
    }
    for (const line of canvas.strokes) parts.push(`<polyline points="${line.points.map(point => point.join(',')).join(' ')}" fill="none" stroke="${penStroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`)
    for (const node of canvas.nodes) {
      if (node.kind === 'text') {
        parts.push(`<text x="${node.x}" y="${node.y}" font-family="sans-serif" font-size="15" fill="${stroke}">${escapeHtml(node.label || '')}</text>`)
        continue
      }
      parts.push(`<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="10" fill="${nodeFill}" stroke="${nodeStroke}" stroke-width="1.5"/>`)
      const lines = wrapLabel(node.label, node.w)
      const startY = node.y + node.h / 2 - ((lines.length - 1) * 18) / 2 + 5
      parts.push(`<text x="${node.x + node.w / 2}" y="${startY}" text-anchor="middle" font-family="sans-serif" font-size="15" fill="${stroke}">${lines.map((line, index) => `<tspan x="${node.x + node.w / 2}" dy="${index === 0 ? 0 : 18}">${escapeHtml(line)}</tspan>`).join('')}</text>`)
    }
    const width = Math.ceil(bounds.maxX - bounds.minX)
    const height = Math.ceil(bounds.maxY - bounds.minY)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX} ${bounds.minY} ${width} ${height}" width="${width}" height="${height}"><rect x="${bounds.minX}" y="${bounds.minY}" width="${width}" height="${height}" fill="white"/>${parts.join('')}</svg>`
  }

  renderToolbar()
  render()

  return {
    element: host,
    isBusy: () => drag !== null || editor !== null,
    setLang(next) {
      language = next
      renderToolbar()
    },
    setCanvas(next) {
      const incoming = JSON.stringify(next || empty())
      if (incoming === known) return
      if (drag || editor) return
      canvas = next ? clone(next) : empty()
      known = incoming
      selected = null
      render()
    },
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
        onChange(clone(canvas))
      }
    },
  }
}
