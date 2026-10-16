// The change diagram: the generated graph drawn as blocks on a tilted 3D board.
// Each block is a file, colored by its status, with one row per symbol the
// plan changes; the lines between rows are the calls. A click on a row asks
// the mod for every caller of that symbol in the project and draws them as
// new rows and blocks; a second click hides them. The plan's own blocks are
// always drawn whole. Drag on the board rotates it, Shift+drag pans, the wheel
// zooms; drag on a block moves the block, and the board grows to hold it.
import { t } from './i18n.js'
import { escapeHtml } from './markdown.js'
import { HEAD_H, PAD, ROW_H, layoutScene, pathD, rowKey } from './diagram-layout.js'

const DEPTH = 14
const HOME_VIEW = { spin: -24, tilt: 52 }
const KIND_SHORT = { function: 'fn', method: 'fn', class: 'class', type: 'type', const: 'const', other: '' }
const MARKERS = { plan: 'pc-arrow-plan', use: 'pc-arrow-use', callers: 'pc-arrow-callers', others: 'pc-arrow-others' }
const MIN_ZOOM = 0.08

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const cssEscape = value => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&'))

function markerOf(edge) {
  if (edge.origin === 'others') return MARKERS.others
  if (edge.origin === 'callers') return MARKERS.callers
  return edge.kind === 'use' ? MARKERS.use : MARKERS.plan
}

export function mountDiagram(host, { lang, onGenerate, onCallers, onOpenFile, onSaveSvg }) {
  let language = lang
  let data = { plan: null, diagram: { status: 'idle', callers: {} }, review: { version: 0 } }
  let known = ''
  let scene = null
  let drag = null
  let fitPending = true
  const expanded = new Set()
  /** Where the user dropped a block, by block id; cleared with a new graph. */
  const moved = new Map()
  const view = { spin: HOME_VIEW.spin, tilt: HOME_VIEW.tilt, zoom: 1, panX: 0, panY: 0, flat: false }

  host.innerHTML =
    `<div class="d3-toolbar"></div>` +
    `<div class="hint d3-hint"></div>` +
    `<div class="d3-viewport"><div class="d3-stage"><div class="d3-scene"></div></div><div class="d3-empty" hidden></div></div>`
  const toolbar = host.querySelector('.d3-toolbar')
  const hint = host.querySelector('.d3-hint')
  const viewport = host.querySelector('.d3-viewport')
  const stage = host.querySelector('.d3-stage')
  const sceneEl = host.querySelector('.d3-scene')
  const empty = host.querySelector('.d3-empty')

  const L = (key, params) => t(language, key, params)
  const graph = () => (data.diagram && data.diagram.status === 'ready' ? data.diagram.graph : null)
  const queries = () => (data.diagram && data.diagram.callers) || {}

  function applyView() {
    const tilt = view.flat ? 0 : view.tilt
    const spin = view.flat ? 0 : view.spin
    sceneEl.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom}) rotateX(${tilt}deg) rotateZ(${spin}deg)`
    viewport.classList.toggle('flat', view.flat)
  }

  /** Shows the whole board, turning around its pivot. */
  function fit() {
    if (!scene) return
    const rect = viewport.getBoundingClientRect()
    if (rect.width < 50 || rect.height < 50) {
      // not laid out yet (a detached host): fit once it is
      fitPending = true
      return
    }
    const halfW = Math.max(scene.pivot.x, scene.width - scene.pivot.x)
    const halfH = Math.max(scene.pivot.y, scene.height - scene.pivot.y)
    const zoomX = (rect.width - 40) / (halfW * 2)
    const zoomY = (rect.height - 40) / (view.flat ? halfH * 2 : halfH * 2 * 0.9)
    view.zoom = clamp(Math.min(zoomX, zoomY), MIN_ZOOM, 1.1)
    view.panX = 0
    view.panY = 0
    applyView()
  }

  /**
   * The board point under a screen point: the view transform (pan, zoom,
   * tilt, spin, then the stage's perspective) inverted for the board's plane.
   */
  function toScene(clientX, clientY) {
    const rect = stage.getBoundingClientRect()
    const style = getComputedStyle(stage)
    const perspective = parseFloat(style.perspective) || 1700
    const origin = style.perspectiveOrigin.split(' ').map(parseFloat)
    const originX = Number.isFinite(origin[0]) ? origin[0] : rect.width / 2
    const originY = Number.isFinite(origin[1]) ? origin[1] : rect.height * 0.42
    // screen point and the pivot (the stage center), both from the perspective origin
    const mx = clientX - rect.left - originX
    const my = clientY - rect.top - originY
    const cx = rect.width / 2 - originX
    const cy = rect.height / 2 - originY
    const tilt = ((view.flat ? 0 : view.tilt) * Math.PI) / 180
    const spin = ((view.flat ? 0 : view.spin) * Math.PI) / 180
    // a board point p turns by spin to (a, b), tilts to (a, b·cos, b·sin), scales, pans, then projects by P / (P − z)
    const b = (perspective * (my - view.panY - cy)) / (perspective * view.zoom * Math.cos(tilt) + my * Math.sin(tilt))
    const k = perspective / (perspective - b * Math.sin(tilt))
    const a = (mx / k - view.panX - cx) / view.zoom
    return { x: scene.pivot.x + a * Math.cos(spin) + b * Math.sin(spin), y: scene.pivot.y - a * Math.sin(spin) + b * Math.cos(spin) }
  }

  function renderToolbar() {
    const { diagram, review } = data
    const status = diagram ? diagram.status : 'idle'
    const ready = status === 'ready'
    const loading = status === 'loading'
    let note = ''
    if (loading) note = `<span class="d3-status"><span class="spinner"></span>${L('diagramGenerating')}</span>`
    else if (ready) {
      const stale = diagram.version !== undefined && review && review.version !== diagram.version
      const source = diagram.source ? ` · ${L(`diagramSource_${diagram.source}`)}` : ''
      note = `<span class="d3-status${stale ? ' stale' : ''}">${stale ? L('diagramStale', { n: diagram.version, m: review.version }) : L('diagramFor', { n: diagram.version })}${escapeHtml(source)}</span>`
    } else if (status === 'failed') note = `<span class="d3-status stale">${L('diagramFailed')}: ${escapeHtml(diagram.error || '')}</span>`
    const legend =
      `<span class="d3-legend">` +
      `<span><i class="sw new"></i>${L('legendNew')}</span><span><i class="sw modified"></i>${L('legendModified')}</span>` +
      `<span><i class="sw deleted"></i>${L('legendDeleted')}</span><span><i class="sw unchanged"></i>${L('legendUnchanged')}</span>` +
      `<span><i class="ln"></i>${L('legendCall')}</span><span><i class="ln use"></i>${L('legendUse')}</span>` +
      `</span>`
    toolbar.innerHTML =
      `<button class="btn ${ready ? 'small' : 'primary'}" data-d3="generate" ${loading || !data.plan ? 'disabled' : ''}>${ready ? L('diagramRegenerate') : L('diagramGenerate')}</button>` +
      note +
      `<span class="spacer"></span>` +
      (ready ? legend : '') +
      (ready
        ? `<button class="btn small${view.flat ? '' : ' active'}" data-d3="flat">${view.flat ? L('view3d') : L('view2d')}</button>` +
          `<button class="btn small" data-d3="fit">${L('fitView')}</button>` +
          (moved.size ? `<button class="btn small" data-d3="relayout">${L('autoLayout')}</button>` : '') +
          `<button class="btn small" data-d3="svg">${L('attachSvg')}</button>`
        : '')
    hint.textContent = ready ? L('diagramHint') : ''
    hint.hidden = !ready
  }

  function renderEmpty() {
    const status = data.diagram ? data.diagram.status : 'idle'
    if (status === 'ready') {
      empty.hidden = true
      empty.innerHTML = ''
      return
    }
    let inner
    if (status === 'loading') inner = `<div><span class="spinner big"></span><p>${L('diagramGenerating')}</p></div>`
    else if (status === 'failed') inner = `<div><p class="error">${L('diagramFailed')}: ${escapeHtml(data.diagram.error || '')}</p><button class="btn primary" data-d3="generate">${L('diagramRegenerate')}</button></div>`
    else inner = `<div><p>${L('diagramEmpty')}</p><button class="btn primary" data-d3="generate" ${data.plan ? '' : 'disabled'}>${L('diagramGenerate')}</button></div>`
    empty.innerHTML = inner
    empty.hidden = false
  }

  function rowTail(row, block) {
    if (!row.planned && block.kind !== 'file') return ''
    const key = row.key
    const query = queries()[key]
    const open = expanded.has(key)
    if (open && query && query.status === 'loading') return `<span class="d3-tail"><span class="spinner"></span></span>`
    if (open && query && query.status === 'ready') {
      const total = query.callers.length + query.more
      const label = total ? L('callersCount', { n: total }) : L('callersNone')
      const title = query.source === 'search' ? L('callersSource_search') : query.source === 'model' ? L('callersSource_model') : ''
      return `<span class="d3-tail" title="${escapeHtml(title)}"><span class="chip count">${escapeHtml(label)}</span><span class="caret">▾</span></span>`
    }
    if (open && query && query.status === 'failed') return `<span class="d3-tail error" title="${escapeHtml(query.error || '')}">${L('callersFailed')}</span>`
    return `<span class="d3-tail"><span class="caret">▸</span></span>`
  }

  function renderBlock(block) {
    const faces = `<div class="d3-face top"></div><div class="d3-face bottom"></div><div class="d3-face left"></div><div class="d3-face right"></div>`
    const style = `left:${block.x}px;top:${block.y}px;width:${block.w}px;height:${block.h}px`
    const movedClass = block.moved ? ' moved' : ''
    if (block.kind === 'others') {
      return (
        `<div class="d3-block others${movedClass}" style="${style}" data-block="${escapeHtml(block.id)}">${faces}` +
        `<div class="d3-head"><div class="d3-title"><span class="fname">⋯ ${escapeHtml(L('callersOthers', { n: block.count }))}</span></div></div></div>`
      )
    }
    const name = block.path.split('/').pop() || block.path
    const dir = block.path.slice(0, block.path.length - name.length)
    const chip = block.status === 'unchanged' ? '' : `<span class="chip ${block.status}">${L(`status_${block.status}`)}</span>`
    const rows = block.rows.length
      ? `<div class="d3-rows">${block.rows
          .map(row => {
            const clickable = row.name !== '(module)'
            const classes = ['d3-row', row.planned ? 'planned' : 'extra', `kind-${row.kind}`]
            if (expanded.has(row.key)) classes.push('open')
            if (!clickable) classes.push('static')
            const title = `${block.path} · ${row.name}${row.line ? `:${row.line}` : ''}`
            return (
              `<div class="${classes.join(' ')}" data-row="${escapeHtml(row.key)}" data-path="${escapeHtml(block.path)}" data-symbol="${escapeHtml(row.name)}" title="${escapeHtml(title)}">` +
              `<span class="d3-kind">${KIND_SHORT[row.kind] || ''}</span><span class="d3-name">${escapeHtml(row.name)}</span>${clickable ? rowTail(row, block) : ''}</div>`
            )
          })
          .join('')}</div>`
      : `<div class="d3-note">${block.status === 'deleted' ? L('deletedShort') : L('noSymbolsShort')}</div>`
    return (
      `<div class="d3-block ${block.status}${block.extra ? ' extra' : ''}${movedClass}" style="${style}" data-block="${escapeHtml(block.id)}">${faces}` +
      `<div class="d3-head" data-open="${escapeHtml(block.path)}" title="${escapeHtml(block.path)}">` +
      `<div class="d3-title"><span class="dot"></span><span class="fname">${escapeHtml(name)}</span>${chip}</div>` +
      `<div class="d3-dir">${escapeHtml(dir)}</div>` +
      `</div>` +
      rows +
      `</div>`
    )
  }

  const edgeMarkup = edge =>
    `<path class="d3-edge ${edge.origin} ${edge.kind} ${edge.mode}" d="${pathD(edge)}" data-edge="${escapeHtml(edge.id)}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" marker-end="url(#${markerOf(edge)})"></path>`

  function sizeScene() {
    sceneEl.style.width = `${scene.width}px`
    sceneEl.style.height = `${scene.height}px`
    sceneEl.style.marginLeft = `${-scene.pivot.x}px`
    sceneEl.style.marginTop = `${-scene.pivot.y}px`
    sceneEl.style.transformOrigin = `${scene.pivot.x}px ${scene.pivot.y}px`
    const svg = sceneEl.querySelector('.d3-edges')
    if (svg) {
      svg.setAttribute('width', scene.width)
      svg.setAttribute('height', scene.height)
      svg.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`)
    }
  }

  function renderScene() {
    const current = graph()
    if (!current) {
      scene = null
      sceneEl.innerHTML = ''
      sceneEl.style.width = '0px'
      sceneEl.style.height = '0px'
      return
    }
    const previous = scene
    scene = layoutScene(current, queries(), expanded, moved)
    // a lane that appears or goes changes the automatic layout: show the board whole again
    if (previous && (previous.pivot.x !== scene.pivot.x || previous.pivot.y !== scene.pivot.y)) fitPending = true
    const defs =
      `<defs>` +
      Object.entries(MARKERS)
        .map(([name, id]) => `<marker id="${id}" class="m-${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>`)
        .join('') +
      `</defs>`
    sceneEl.innerHTML =
      `<svg class="d3-edges" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" style="transform: translateZ(${DEPTH + 1}px)">${defs}${scene.edges.map(edgeMarkup).join('')}</svg>` +
      scene.blocks.map(renderBlock).join('')
    sizeScene()
    if (fitPending) {
      fitPending = false
      fit()
    } else {
      applyView()
    }
  }

  /** Moves one block on the drawn scene and redraws its edges, without a full render. */
  function placeBlock(id) {
    const current = graph()
    if (!current) return
    scene = layoutScene(current, queries(), expanded, moved)
    const block = scene.blocks.find(one => one.id === id)
    const element = sceneEl.querySelector(`[data-block="${cssEscape(id)}"]`)
    if (block && element) {
      element.style.left = `${block.x}px`
      element.style.top = `${block.y}px`
      element.classList.add('moved')
    }
    sizeScene()
    for (const edge of scene.edges) {
      const path = sceneEl.querySelector(`[data-edge="${cssEscape(edge.id)}"]`)
      if (!path) continue
      path.setAttribute('d', pathD(edge))
      path.setAttribute('class', `d3-edge ${edge.origin} ${edge.kind} ${edge.mode}`)
    }
  }

  function render() {
    renderToolbar()
    renderEmpty()
    renderScene()
  }

  function toggleRow(key, path, symbol) {
    if (expanded.has(key)) {
      expanded.delete(key)
    } else {
      expanded.add(key)
      const query = queries()[key]
      if (!query || query.status === 'failed') onCallers(path, symbol)
    }
    render()
  }

  host.addEventListener('click', event => {
    const command = event.target.closest('[data-d3]')
    if (command) {
      switch (command.dataset.d3) {
        case 'generate':
          expanded.clear()
          moved.clear()
          onGenerate()
          break
        case 'flat':
          view.flat = !view.flat
          renderToolbar()
          fit()
          break
        case 'fit':
          fit()
          break
        case 'relayout':
          moved.clear()
          fitPending = true
          render()
          break
        case 'svg':
          if (scene) onSaveSvg(toSvg())
          break
        default:
          break
      }
      return
    }
  })

  // Rows and file names are tapped through the pointer events: the viewport
  // captures the pointer for dragging, which would retarget a click to itself.
  function tap(target) {
    if (!target || !target.closest) return
    const row = target.closest('.d3-row')
    if (row && !row.classList.contains('static')) {
      toggleRow(row.dataset.row, row.dataset.path, row.dataset.symbol)
      return
    }
    const head = target.closest('[data-open]')
    if (head && onOpenFile) onOpenFile(head.dataset.open)
  }

  host.addEventListener('mouseover', event => {
    const row = event.target.closest('.d3-row')
    for (const lit of sceneEl.querySelectorAll('.d3-edge.lit')) lit.classList.remove('lit')
    if (!row) return
    const key = row.dataset.row
    for (const edge of sceneEl.querySelectorAll('.d3-edge')) {
      if (edge.dataset.from === key || edge.dataset.to === key) edge.classList.add('lit')
    }
  })

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 1) return
    if (event.target.closest('button')) return
    // Shift or the middle button pans; a plain drag on a block moves it, on the board it rotates (pans when flat)
    const forcePan = event.shiftKey || event.button === 1
    const blockEl = !forcePan && scene ? event.target.closest('.d3-block') : null
    let block = null
    if (blockEl) {
      const laid = scene.blocks.find(one => one.id === blockEl.dataset.block)
      if (laid) block = { id: laid.id, x: laid.x, y: laid.y, from: toScene(event.clientX, event.clientY) }
    }
    drag = {
      x: event.clientX,
      y: event.clientY,
      spin: view.spin,
      tilt: view.tilt,
      panX: view.panX,
      panY: view.panY,
      moved: false,
      pan: view.flat || forcePan,
      block,
      target: event.button === 0 ? event.target : null,
    }
    viewport.setPointerCapture(event.pointerId)
    viewport.classList.add(block ? 'moving' : 'dragging')
  })

  viewport.addEventListener('pointermove', event => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    drag.moved = true
    if (drag.block) {
      const now = toScene(event.clientX, event.clientY)
      const x = Math.round(Math.max(0, drag.block.x + now.x - drag.block.from.x))
      const y = Math.round(Math.max(0, drag.block.y + now.y - drag.block.from.y))
      moved.set(drag.block.id, { x, y })
      placeBlock(drag.block.id)
      return
    }
    if (drag.pan) {
      view.panX = drag.panX + dx
      view.panY = drag.panY + dy
    } else {
      view.spin = drag.spin + dx * 0.35
      view.tilt = clamp(drag.tilt - dy * 0.25, 0, 80)
    }
    applyView()
  })

  const endDrag = tapped => {
    if (!drag) return
    const { moved: didMove, target, block } = drag
    drag = null
    viewport.classList.remove('dragging', 'moving')
    if (tapped && !didMove) tap(target)
    else if (block && didMove) renderToolbar()
  }
  viewport.addEventListener('pointerup', () => endDrag(true))
  viewport.addEventListener('pointercancel', () => endDrag(false))

  viewport.addEventListener(
    'wheel',
    event => {
      if (!scene) return
      event.preventDefault()
      view.zoom = clamp(view.zoom * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, 3)
      applyView()
    },
    { passive: false },
  )

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  }

  /** The scene flat, as a standalone SVG with the theme's colors. */
  function toSvg() {
    const fg = cssVar('--fg', '#222')
    const dim = cssVar('--fg-dim', '#777')
    const accent = cssVar('--accent', '#5b6cff')
    const border = cssVar('--border', '#ddd')
    const elev = cssVar('--bg-elev', '#fff')
    const colors = {
      new: [cssVar('--new', '#1f9d55'), cssVar('--new-soft', '#e3f6ea')],
      modified: [cssVar('--mod', '#d9850b'), cssVar('--mod-soft', '#fff1dc')],
      deleted: [cssVar('--del', '#d64545'), cssVar('--del-soft', '#fde6e6')],
      unchanged: [cssVar('--mixed', '#6b7085'), cssVar('--mixed-soft', '#eceef4')],
    }
    const parts = []
    parts.push(
      `<defs>` +
        `<marker id="a-plan" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${fg}"/></marker>` +
        `<marker id="a-use" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${dim}"/></marker>` +
        `<marker id="a-callers" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${accent}"/></marker>` +
        `</defs>`,
    )
    for (const edge of scene.edges) {
      const callers = edge.origin !== 'plan'
      const stroke = callers ? accent : edge.kind === 'use' ? dim : fg
      const dash = edge.origin === 'others' ? ' stroke-dasharray="3 4"' : edge.kind === 'use' ? ' stroke-dasharray="5 4"' : ''
      parts.push(`<path d="${pathD(edge)}" fill="none" stroke="${stroke}" stroke-width="1.8"${dash} marker-end="url(#a-${callers ? 'callers' : edge.kind === 'use' ? 'use' : 'plan'})"/>`)
    }
    for (const block of scene.blocks) {
      const [line, soft] = colors[block.status] || colors.unchanged
      const dashed = block.extra ? ' stroke-dasharray="6 4"' : ''
      parts.push(`<rect x="${block.x}" y="${block.y}" width="${block.w}" height="${block.h}" rx="8" fill="${elev}" stroke="${line}" stroke-width="1.5"${dashed}/>`)
      parts.push(`<rect x="${block.x}" y="${block.y}" width="${block.w}" height="${HEAD_H}" rx="8" fill="${soft}"/>`)
      if (block.h > HEAD_H) parts.push(`<line x1="${block.x}" y1="${block.y + HEAD_H}" x2="${block.x + block.w}" y2="${block.y + HEAD_H}" stroke="${border}"/>`)
      if (block.kind === 'others') {
        parts.push(`<text x="${block.x + 10}" y="${block.y + HEAD_H / 2 + 4}" font-family="sans-serif" font-size="11.5" fill="${dim}">${escapeHtml(`⋯ ${L('callersOthers', { n: block.count })}`)}</text>`)
        continue
      }
      const name = block.path.split('/').pop() || block.path
      const dir = block.path.slice(0, block.path.length - name.length)
      const struck = block.status === 'deleted' ? ' text-decoration="line-through"' : ''
      parts.push(`<text x="${block.x + 10}" y="${block.y + 19}" font-family="monospace" font-size="12.5" font-weight="600" fill="${line}"${struck}>${escapeHtml(name)}</text>`)
      if (dir) parts.push(`<text x="${block.x + 10}" y="${block.y + 35}" font-family="monospace" font-size="9.5" fill="${dim}">${escapeHtml(dir)}</text>`)
      if (!block.rows.length) {
        parts.push(`<text x="${block.x + 10}" y="${block.y + HEAD_H + 17}" font-family="sans-serif" font-size="11" font-style="italic" fill="${dim}">${escapeHtml(block.status === 'deleted' ? L('deletedShort') : L('noSymbolsShort'))}</text>`)
        continue
      }
      block.rows.forEach((row, index) => {
        const y = block.y + HEAD_H + PAD + index * ROW_H + ROW_H / 2 + 4
        parts.push(`<text x="${block.x + 10}" y="${y}" font-family="monospace" font-size="10" fill="${dim}">${escapeHtml(KIND_SHORT[row.kind] || '')}</text>`)
        parts.push(`<text x="${block.x + 44}" y="${y}" font-family="monospace" font-size="12" fill="${row.planned ? fg : dim}">${escapeHtml(row.name)}</text>`)
      })
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}"><rect width="${scene.width}" height="${scene.height}" fill="${elev}"/>${parts.join('')}</svg>`
  }

  applyView()
  render()

  return {
    element: host,
    isBusy: () => drag !== null,
    setLang(next) {
      if (language === next) return
      language = next
      render()
    },
    setData(next) {
      const diagram = next.diagram || { status: 'idle', callers: {} }
      const incoming = JSON.stringify([diagram, next.review ? next.review.version : 0, Boolean(next.plan)])
      const hadGraph = data.diagram && data.diagram.status === 'ready' ? data.diagram.graph : null
      data = { plan: next.plan, diagram, review: next.review || { version: 0 } }
      if (incoming === known) return
      known = incoming
      if (diagram.status === 'ready' && diagram.graph !== hadGraph && JSON.stringify(diagram.graph) !== JSON.stringify(hadGraph)) {
        expanded.clear()
        moved.clear()
        fitPending = true
      }
      render()
    },
    fit,
  }
}
