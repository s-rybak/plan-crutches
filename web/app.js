// Plan Crutches review page. State comes from the mod over SSE; every action
// goes back as one POST and returns as a new state.
import { connect, act, projectUrl } from './api.js'
import { t } from './i18n.js'
import { renderMarkdown, escapeHtml } from './markdown.js'
import { renderSource, renderDiff } from './codeview.js'
import { buildTree, renderTree, allDirKeys } from './tree.js'
import { mountDiagram } from './diagram.js'

const app = document.getElementById('app')
const popup = document.getElementById('popup')
const toasts = document.getElementById('toasts')

const TASK_LIMIT = 6000

function stored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode: keep it in memory only
  }
}

const ui = {
  tab: 'changes',
  selected: null,
  collapsed: new Set(),
  expanded: new Set(),
  inlineExpanded: new Set(),
  fullFile: new Set(),
  fullText: new Map(),
  requested: new Set(),
  showFullSummary: false,
  showTask: true,
  showFullTask: false,
  theme: stored('plan-crutches-theme', 'auto'),
  online: false,
  planKey: '',
}

let state = null
let lang = 'en'
let diagram = null
let diagramHost = null
let lastNotice = 0
let renderTimer = null

const L = (key, params) => t(lang, key, params)
const bodyKey = (path, symbol) => `${path}#${symbol}`

function applyTheme() {
  if (ui.theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = ui.theme
}

function toast(text) {
  const element = document.createElement('div')
  element.className = 'toast'
  element.textContent = text
  toasts.appendChild(element)
  setTimeout(() => element.remove(), 4500)
}

async function run(action) {
  try {
    await act(action)
  } catch (error) {
    toast(L('actionFailed', { error: error.message || String(error) }))
  }
}

// The full text of a file is not in the state: the page reads it from the
// server's /project/ route the first time the Full file button is pressed.
async function loadFullFile(path) {
  if (ui.fullText.has(path)) return
  ui.fullText.set(path, { status: 'loading' })
  try {
    const response = await fetch(projectUrl(path))
    if (!response.ok) throw new Error(String(response.status))
    ui.fullText.set(path, { status: 'ready', text: await response.text() })
  } catch {
    ui.fullText.set(path, { status: 'failed' })
  }
  render()
}

function renderFullFile(path) {
  const full = ui.fullText.get(path)
  if (!full || full.status === 'loading') return `<div class="status hint"><span class="spinner"></span> ${L('loadingFile')}</div>`
  if (full.status === 'failed') return `<div class="hint">${L('fileMissing')}</div>`
  return block(renderSource(full.text, { path }), { path })
}

function pendingComments() {
  return (state?.comments || []).filter(one => one.sentInVersion === undefined && one.resolvedInVersion === undefined)
}

function commentState(comment) {
  if (comment.resolvedInVersion !== undefined) return 'resolved'
  if (comment.sentInVersion !== undefined) return 'sent'
  return 'pending'
}

function describeTarget(target) {
  const parts = []
  if (!target.path) parts.push(L('plan'))
  else parts.push(target.path.endsWith('/') ? `${target.path} (${L('folder')})` : target.path)
  if (target.symbol) parts.push(target.symbol)
  if (target.lines) parts.push(`${L('lines')} ${target.lines[0]}${target.lines[1] !== target.lines[0] ? `-${target.lines[1]}` : ''}`)
  else if (target.selection) parts.push(L('selection'))
  return parts.join(' · ')
}

function renderComment(comment, { withOpen = false } = {}) {
  const kind = commentState(comment)
  const label = kind === 'pending' ? L('pending') : kind === 'sent' ? `${L('sent')} (v${comment.sentInVersion})` : `${L('resolved')} (v${comment.resolvedInVersion})`
  const open = withOpen && comment.target.path && !comment.target.path.endsWith('/') ? ` data-action="open-file" data-path="${escapeHtml(comment.target.path)}" style="cursor:pointer"` : ''
  return (
    `<div class="comment ${kind}">` +
    `<div class="body"><div class="where"${open}>${escapeHtml(describeTarget(comment.target))}</div>` +
    (comment.target.selection ? `<div class="quote">${escapeHtml(comment.target.selection.slice(0, 400))}</div>` : '') +
    `<div class="text">${escapeHtml(comment.text)}</div></div>` +
    `<div class="state">${escapeHtml(label)}</div>` +
    (kind === 'pending' ? `<button class="del" data-action="delete-comment" data-id="${comment.id}" title="${L('delete')}">✕</button>` : '') +
    `</div>`
  )
}

function renderHeader() {
  const { plan, review } = state
  const pending = pendingComments().length
  let action = ''
  if (review.status === 'reviewing' && plan) {
    action = `<button class="btn primary" data-action="submit">${pending ? L('submitWith', { n: pending }) : L('approve')}</button>`
  }
  const themeLabel = L(`theme_${ui.theme}`)
  const record = review.recordPath ? `<span title="${escapeHtml(review.recordPath)}">${L('recorded')}: ${escapeHtml(review.recordPath.replace(`${state.cwd}/`, ''))}</span>` : ''
  return (
    `<header class="top">` +
    `<div class="brand"><span class="logo"><svg viewBox="0 0 32 32"><path d="M9 10h14M9 16h10M9 22h7" stroke="white" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg></span>${L('appName')}</div>` +
    (plan ? `<div class="title" title="${escapeHtml(plan.title)}">${escapeHtml(plan.title)}</div>` : '') +
    `<div class="meta">` +
    (plan ? `<span class="badge">${L('version')}${review.version}</span>` : '') +
    `<span class="badge status-${review.status}">${L(`status_${review.status}`)}</span>` +
    (review.isDemo ? `<span class="badge">${L('demo')}</span>` : '') +
    (plan ? `<span>${state.comments.length} ${L('comments')}</span>` : '') +
    record +
    `</div>` +
    `<span class="spacer"></span>` +
    `<div class="actions">` +
    `<span class="dot${ui.online ? ' online' : ''}" title="${ui.online ? L('online') : L('offlineShort')}"></span>` +
    `<button class="btn ghost small" data-action="theme" title="${themeLabel}">${ui.theme === 'dark' ? '☾' : ui.theme === 'light' ? '☀' : '◐'}</button>` +
    `<button class="btn ghost small" data-action="lang">${L('lang')}</button>` +
    action +
    `</div>` +
    `</header>`
  )
}

function renderTabs() {
  const tabs = ['changes', 'diagram', 'ask', 'comments']
  return `<nav class="tabs">${tabs
    .map(tab => {
      const count = tab === 'comments' ? state.comments.length : tab === 'ask' ? state.qa.length : 0
      return `<button class="tab${ui.tab === tab ? ' active' : ''}" data-action="tab" data-tab="${tab}">${L(`tab_${tab}`)}${count ? ` <span class="chip count">${count}</span>` : ''}</button>`
    })
    .join('')}</nav>`
}

function renderBanner() {
  const { plan, review } = state
  const banners = []
  if (!ui.online) banners.push(`<div class="banner warn"><span class="spinner"></span>${L('offline')}</div>`)
  if (!plan) banners.push(`<div class="banner">${L('noPlan')}</div>`)
  else if (review.status === 'revising') banners.push(`<div class="banner revising"><span class="spinner"></span>${L('revisingNote')}</div>`)
  else if (review.status === 'approved') banners.push(`<div class="banner approved">${L('approvedNote')}</div>`)
  return banners.join('')
}

function renderTask(plan) {
  const task = plan.task || { source: 'none', text: '' }
  const source = task.source === 'jira' ? `${L('taskFromJira')}${task.key ? ` · ${escapeHtml(task.key)}` : ''}` : task.source === 'user' ? L('taskFromUser') : ''
  const text = task.text || ''
  const cut = !ui.showFullTask && text.length > TASK_LIMIT
  return (
    `<section class="card task${ui.showTask ? '' : ' collapsed'}">` +
    `<h2><button class="btn ghost small" data-action="toggle-task">${ui.showTask ? '▾' : '▸'}</button>${L('task')}${source ? ` <span class="hint">${source}</span>` : ''}<span class="spacer"></span><button class="btn small" data-action="comment-plan">💬 ${L('planComment')}</button></h2>` +
    `<div class="body">` +
    (text ? `<pre data-selectable data-scope="plan">${escapeHtml(cut ? text.slice(0, TASK_LIMIT) + '…' : text)}</pre>` : `<div class="hint">${L('taskNone')}</div>`) +
    (text.length > TASK_LIMIT ? `<button class="btn ghost small" data-action="toggle-full-task">${ui.showFullTask ? L('showLess') : L('showAll')}</button>` : '') +
    `</div></section>`
  )
}

function renderSummary(plan) {
  const limit = state.summaryLimit || 9000
  const summary = plan.summary || ''
  const cut = !ui.showFullSummary && summary.length > limit
  const shown = cut ? summary.slice(0, limit) + '…' : summary
  return (
    `<section class="card summary">` +
    `<h2>${L('summary')}<span class="spacer"></span><span class="hint">${summary.length} / ${limit}</span></h2>` +
    `<div class="md" data-selectable data-scope="plan">${renderMarkdown(shown, { imageUrl: projectUrl })}</div>` +
    (summary.length > limit ? `<button class="btn ghost small" data-action="toggle-summary">${ui.showFullSummary ? L('showLess') : L('showAll')}</button>` : '') +
    `</section>`
  )
}

function renderWarnings(review) {
  if (!review.warnings.length && review.parsedFrom === 'block') return ''
  return (
    `<section class="card warnings"><h2>${L('warnings')}<span class="spacer"></span><span class="hint">${L(`parsed_${review.parsedFrom}`)}</span></h2>` +
    (review.warnings.length ? `<ul>${review.warnings.map(one => `<li>${escapeHtml(one)}</li>`).join('')}</ul>` : '') +
    `</section>`
  )
}

function commentCounts() {
  const counts = new Map()
  for (const comment of state.comments) {
    if (comment.resolvedInVersion !== undefined) continue
    const path = comment.target.path
    if (!path) continue
    counts.set(path, (counts.get(path) || 0) + 1)
  }
  return counts
}

function renderTreePanel(plan) {
  const roots = buildTree(plan.files)
  return (
    `<aside class="card tree-panel">` +
    `<div class="tree-toolbar"><strong>${L('changes')}</strong><span class="spacer"></span>` +
    `<button class="btn ghost small" data-action="collapse-all">${L('collapseAll')}</button>` +
    `<button class="btn ghost small" data-action="expand-all">${L('expandAll')}</button></div>` +
    renderTree(roots, { collapsed: ui.collapsed, selected: ui.selected, lang, commentCounts: commentCounts() }) +
    `</aside>`
  )
}

function linesCommented(path, symbol) {
  const set = new Set()
  for (const comment of state.comments) {
    if (comment.resolvedInVersion !== undefined || comment.target.path !== path || !comment.target.lines) continue
    if ((comment.target.symbol || '') !== (symbol || '')) continue
    for (let line = comment.target.lines[0]; line <= comment.target.lines[1]; line += 1) set.add(line)
  }
  return set
}

function block(inner, { path, symbol }) {
  return `<div data-selectable data-scope="code" data-path="${escapeHtml(path)}"${symbol ? ` data-symbol="${escapeHtml(symbol)}"` : ''}>${inner}</div>`
}

function renderSymbol(file, symbol) {
  const key = bodyKey(file.path, symbol.name)
  const body = state.bodies[key]
  const isExpanded = ui.expanded.has(key)
  let bodyHtml = ''
  if (isExpanded) {
    if (!body || body.status === 'loading') bodyHtml = `<div class="status"><span class="spinner"></span>${L('generating')}</div>`
    else if (body.status === 'failed') bodyHtml = `<div class="status error">${L('generationFailed')}: ${escapeHtml(body.error || '')}</div>`
    else bodyHtml = block(renderSource(body.code || '', { path: file.path, commented: linesCommented(file.path, symbol.name) }), { path: file.path, symbol: symbol.name })
  }
  return (
    `<div class="symbol" data-symbol-card="${escapeHtml(symbol.name)}">` +
    `<div class="sym-head"><span class="chip kind">${escapeHtml(symbol.kind)}</span><span class="sym-name">${escapeHtml(symbol.name)}</span>` +
    (symbol.anchor ? `<span class="anchor">${L('anchor')}: ${escapeHtml(symbol.anchor)}</span>` : '') +
    `<span class="spacer"></span>` +
    (isExpanded
      ? `<button class="btn small" data-action="collapse" data-key="${escapeHtml(key)}">${L('collapseImpl')}</button>` +
        `<button class="btn small" data-action="regen" data-path="${escapeHtml(file.path)}" data-symbol="${escapeHtml(symbol.name)}">${L('regenerate')}</button>`
      : `<button class="btn small" data-action="expand" data-path="${escapeHtml(file.path)}" data-symbol="${escapeHtml(symbol.name)}">${L('expandImpl')}</button>`) +
    `<button class="btn small" data-action="comment-symbol" data-path="${escapeHtml(file.path)}" data-symbol="${escapeHtml(symbol.name)}">💬</button>` +
    `</div>` +
    block(renderSource(symbol.signature, { path: file.path, commented: linesCommented(file.path, symbol.name) }), { path: file.path, symbol: symbol.name }) +
    `<div class="sym-desc">${escapeHtml(symbol.description || '')}</div>` +
    bodyHtml +
    `</div>`
  )
}

function inlineFor(file) {
  return {
    path: file.path,
    symbols: file.symbols,
    bodies: state.bodies,
    expanded: ui.inlineExpanded,
    lang,
    commentedFor: symbol => linesCommented(file.path, symbol),
  }
}

function renderFile(file) {
  const entry = state.files[file.path] || { loaded: false }
  const inline = inlineFor(file)
  let changes = ''
  if (file.status === 'new') {
    changes = `<div class="section-title">${L('newFileTitle')}</div>`
    if (entry.view && entry.view.format === 'source') {
      changes += block(renderSource(entry.view.text, { path: file.path, commented: linesCommented(file.path), inline }), { path: file.path })
    } else if (entry.view) {
      changes += block(renderDiff(entry.view.text, { path: file.path, commented: linesCommented(file.path), inline }), { path: file.path })
    }
  } else if (!entry.loaded) {
    changes = `<div class="status hint"><span class="spinner"></span> ${L('loadingFile')}</div>`
  } else if (entry.missing) {
    changes = `<div class="hint">${L('fileMissing')}</div>`
  } else {
    const title = file.status === 'deleted' ? L('deletedFile') : L('diffTitle')
    const showFull = ui.fullFile.has(file.path)
    changes =
      `<div class="section-title">${title}<span class="spacer"></span>` +
      `<button class="btn ghost small" data-action="full-file" data-path="${escapeHtml(file.path)}">${showFull ? L('hideFullFile') : L('fullFile')}</button>` +
      `</div>` +
      (entry.view ? block(renderDiff(entry.view.text, { path: file.path, commented: linesCommented(file.path), inline: file.status === 'modified' ? inline : null }), { path: file.path }) : '') +
      (showFull ? `<div class="section-title">${L('fullFile')}</div>` + renderFullFile(file.path) : '')
  }
  const comments = state.comments.filter(one => one.target.path === file.path)
  return (
    `<section class="card detail-card">` +
    `<div class="file-head"><button class="btn ghost small" data-action="back">←</button><span class="path">${escapeHtml(file.path)}</span><span class="chip ${file.status}">${L(`status_${file.status}`)}</span><span class="spacer"></span>` +
    `<button class="btn small" data-action="comment-file" data-path="${escapeHtml(file.path)}">💬 ${L('commentOnFile')}</button></div>` +
    `<div class="desc" data-selectable data-scope="file" data-path="${escapeHtml(file.path)}">${escapeHtml(file.description || '')}</div>` +
    `<div class="section-title">${L('symbols')}</div>` +
    (file.symbols.length ? file.symbols.map(symbol => renderSymbol(file, symbol)).join('') : `<div class="hint">${L('noSymbols')}</div>`) +
    changes +
    (comments.length ? `<div class="section-title">${L('tab_comments')}</div><div class="comments">${comments.map(one => renderComment(one)).join('')}</div>` : '') +
    `</section>`
  )
}

function renderChanges() {
  const { plan, review } = state
  if (!plan) return ''
  const file = ui.selected ? plan.files.find(one => one.path === ui.selected) : null
  const detail = file ? renderFile(file) : `<section class="card detail"><div class="empty">${L('pickFile')}</div></section>`
  return renderTask(plan) + renderSummary(plan) + renderWarnings(review) + `<div class="split">${renderTreePanel(plan)}<div class="detail">${detail}</div></div>`
}

function renderAsk() {
  const items = [...state.qa].reverse()
  return (
    `<section class="card"><div class="ask-form"><textarea id="ask-input" placeholder="${escapeHtml(L('askPlaceholder'))}"></textarea><button class="btn primary" data-action="ask" ${state.plan ? '' : 'disabled'}>${L('ask')}</button></div>` +
    (ui.selected ? `<div class="hint">${L('anchor')}: ${escapeHtml(ui.selected)}</div>` : '') +
    `</section>` +
    items
      .map(item => {
        let answer = ''
        if (item.status === 'asking') answer = `<div class="status hint"><span class="spinner"></span> ${L('asking')}</div>`
        else if (item.status === 'failed') answer = `<div class="hint">${L('askFailed')}: ${escapeHtml(item.answer || '')}</div>`
        else answer = `<div class="a md" data-selectable data-scope="plan">${renderMarkdown(item.answer || '', { imageUrl: projectUrl })}</div>`
        return (
          `<div class="qa"><div class="q">${escapeHtml(item.question)}</div>` +
          (item.focus ? `<div class="focus">${escapeHtml(item.focus)}</div>` : '') +
          answer +
          (item.status === 'done' ? `<div class="qa-actions"><button class="btn small" data-action="qa-comment" data-id="${item.id}">💬 ${L('makeComment')}</button></div>` : '') +
          `</div>`
        )
      })
      .join('')
  )
}

function renderComments() {
  const groups = { pending: [], sent: [], resolved: [] }
  for (const comment of state.comments) groups[commentState(comment)].push(comment)
  const section = (key, list) => (list.length ? `<div class="section-title">${L(key)} <span class="chip count">${list.length}</span></div><div class="comments">${list.map(one => renderComment(one, { withOpen: true })).join('')}</div>` : '')
  const history = state.review.history.length ? `<div class="section-title">${L('history')}</div><ul class="hint">${state.review.history.map(one => `<li>${escapeHtml(one)}</li>`).join('')}</ul>` : ''
  return `<section class="card">${state.comments.length ? section('pending', groups.pending) + section('sent', groups.sent) + section('resolved', groups.resolved) : `<div class="hint">${L('noComments')}</div>`}${history}</section>`
}

function ensureDiagram() {
  if (!diagramHost) {
    diagramHost = document.createElement('section')
    diagramHost.className = 'card diagram-card'
    diagram = mountDiagram(diagramHost, {
      lang,
      initial: state.canvas,
      onChange: canvas => run({ type: 'canvas', canvas }),
      onSaveSvg: svg => run({ type: 'canvasSvg', svg }),
    })
  } else {
    diagram.setLang(lang)
    diagram.setCanvas(state.canvas)
  }
  const slot = document.getElementById('diagram-slot')
  if (slot && diagramHost.parentElement !== slot) slot.appendChild(diagramHost)
}

function render() {
  if (!state) {
    app.innerHTML = `<div class="boot">${L('connecting')}</div>`
    return
  }
  if (diagram && diagram.isBusy()) {
    clearTimeout(renderTimer)
    renderTimer = setTimeout(render, 300)
    return
  }
  const askDraft = document.getElementById('ask-input')?.value
  const scrollY = window.scrollY
  const treeScroll = document.querySelector('.tree-panel')?.scrollTop ?? 0
  let main = ''
  if (ui.tab === 'changes') main = renderChanges()
  else if (ui.tab === 'diagram') main = `<div id="diagram-slot"></div>`
  else if (ui.tab === 'ask') main = renderAsk()
  else main = renderComments()
  app.innerHTML = renderHeader() + renderTabs() + renderBanner() + `<main>${main}</main>`
  if (askDraft !== undefined) {
    const input = document.getElementById('ask-input')
    if (input) input.value = askDraft
  }
  if (ui.tab === 'diagram') ensureDiagram()
  window.scrollTo(0, scrollY)
  const panel = document.querySelector('.tree-panel')
  if (panel) panel.scrollTop = treeScroll
  requestFileIfNeeded()
}

function requestFileIfNeeded() {
  if (!state?.plan || !ui.selected) return
  const file = state.plan.files.find(one => one.path === ui.selected)
  if (!file || file.status === 'new') return
  const entry = state.files[file.path]
  if (entry && entry.loaded) return
  if (ui.requested.has(file.path)) return
  ui.requested.add(file.path)
  run({ type: 'loadFile', path: file.path })
}

function onState(next) {
  state = next
  lang = next.lang === 'uk' ? 'uk' : 'en'
  document.documentElement.lang = lang
  document.title = next.plan ? `${next.plan.title} · Plan Review` : 'Plan Review'
  const planKey = `${next.review.version}:${next.plan ? next.plan.title : ''}`
  if (planKey !== ui.planKey) {
    ui.planKey = planKey
    ui.requested.clear()
    ui.expanded.clear()
    ui.inlineExpanded.clear()
    ui.fullFile.clear()
    ui.fullText.clear()
    if (ui.selected && !(next.plan && next.plan.files.some(one => one.path === ui.selected))) ui.selected = null
  }
  if (next.notice && next.notice.id !== lastNotice) {
    lastNotice = next.notice.id
    toast(next.notice.text)
  }
  render()
}

// ---------- popup ----------

function openPopup({ title, target, selection, prefill, at }) {
  popup.innerHTML =
    `<div class="ptitle"><span>${escapeHtml(title)}</span><span class="spacer"></span><button class="btn ghost small" data-popup="cancel">✕</button></div>` +
    (selection ? `<div class="pquote">${escapeHtml(selection)}</div>` : '') +
    `<textarea id="popup-text" placeholder="${escapeHtml(L('commentPlaceholder'))}">${escapeHtml(prefill || '')}</textarea>` +
    `<div class="pactions"><span class="hint"><kbd>Enter</kbd> ${L('save')} · <kbd>Esc</kbd> ${L('cancel')}</span>` +
    `<button class="btn" data-popup="cancel">${L('cancel')}</button><button class="btn primary" data-popup="save">${L('save')}</button></div>`
  popup.hidden = false
  popup.dataset.target = JSON.stringify(target || {})
  popup.dataset.selection = selection || ''
  const width = popup.offsetWidth
  const height = popup.offsetHeight
  let left = Math.min(Math.max(12, at.x), window.innerWidth - width - 12)
  let top = at.y + 10
  if (top + height > window.innerHeight - 12) top = Math.max(12, at.y - height - 10)
  popup.style.left = `${left}px`
  popup.style.top = `${top}px`
  const textarea = popup.querySelector('textarea')
  textarea.focus()
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
}

function closePopup() {
  popup.hidden = true
  popup.innerHTML = ''
}

async function savePopup() {
  const textarea = popup.querySelector('textarea')
  if (!textarea) return
  const text = textarea.value.trim()
  if (!text) return closePopup()
  const target = JSON.parse(popup.dataset.target || '{}')
  const selection = popup.dataset.selection
  if (selection) target.selection = selection.slice(0, 2000)
  closePopup()
  await run({ type: 'comment', target, text })
}

popup.addEventListener('click', event => {
  const button = event.target.closest('[data-popup]')
  if (!button) return
  if (button.dataset.popup === 'save') savePopup()
  else closePopup()
})

popup.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    savePopup()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closePopup()
  }
})

function rectOf(element) {
  const rect = element.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom }
}

function elementOf(node) {
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
}

function checkSelection() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
  const text = selection.toString().trim()
  if (!text) return
  const range = selection.getRangeAt(0)
  const start = elementOf(range.startContainer)
  const end = elementOf(range.endContainer)
  if (!start || !end) return
  const blockEl = start.closest('[data-selectable]')
  if (!blockEl || blockEl !== end.closest('[data-selectable]')) return
  const target = {}
  if (blockEl.dataset.path) target.path = blockEl.dataset.path
  if (blockEl.dataset.symbol) target.symbol = blockEl.dataset.symbol
  const first = start.closest('.line')
  const last = end.closest('.line')
  if (first && last && first.dataset.line && last.dataset.line) {
    const a = Number(first.dataset.line)
    const b = Number(last.dataset.line)
    if (a && b) target.lines = [Math.min(a, b), Math.max(a, b)]
  }
  const rect = range.getBoundingClientRect()
  const where = target.path ? `${target.path}${target.symbol ? ` · ${target.symbol}` : ''}` : L('plan')
  openPopup({ title: `${L('commentOnSelection')} · ${where}${target.lines ? ` · ${L('linesSelected', { n: target.lines[1] - target.lines[0] + 1 })}` : ''}`, target, selection: text.slice(0, 2000), at: { x: rect.left, y: rect.bottom } })
}

document.addEventListener('mouseup', event => {
  if (event.button !== 0) return
  if (event.target.closest('#popup') || event.target.closest('button, textarea, input, .diagram-card')) return
  setTimeout(checkSelection, 0)
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !popup.hidden) closePopup()
})

// ---------- actions ----------

function selectFile(path) {
  ui.selected = path
  ui.tab = 'changes'
  render()
  const detail = document.querySelector('.detail-card')
  if (detail) detail.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

app.addEventListener('click', event => {
  const control = event.target.closest('[data-action]')
  if (control) {
    handleAction(control)
    return
  }
  const row = event.target.closest('.row')
  if (row) {
    if (row.dataset.kind === 'dir') {
      if (ui.collapsed.has(row.dataset.key)) ui.collapsed.delete(row.dataset.key)
      else ui.collapsed.add(row.dataset.key)
      render()
    } else {
      selectFile(row.dataset.path)
    }
  }
})

app.addEventListener('keydown', event => {
  if (event.target.id === 'ask-input' && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    submitQuestion()
  }
})

function submitQuestion() {
  const input = document.getElementById('ask-input')
  if (!input) return
  const question = input.value.trim()
  if (!question) return
  input.value = ''
  run({ type: 'ask', question, ...(ui.selected ? { focus: ui.selected } : {}) })
}

function handleAction(control) {
  const { action } = control.dataset
  const data = control.dataset
  switch (action) {
    case 'tab':
      ui.tab = data.tab
      render()
      break
    case 'lang':
      run({ type: 'setLang', lang: lang === 'en' ? 'uk' : 'en' })
      break
    case 'theme':
      ui.theme = ui.theme === 'auto' ? 'light' : ui.theme === 'light' ? 'dark' : 'auto'
      store('plan-crutches-theme', ui.theme)
      applyTheme()
      render()
      break
    case 'submit':
      run({ type: 'submit' })
      break
    case 'toggle-task':
      ui.showTask = !ui.showTask
      render()
      break
    case 'toggle-full-task':
      ui.showFullTask = !ui.showFullTask
      render()
      break
    case 'toggle-summary':
      ui.showFullSummary = !ui.showFullSummary
      render()
      break
    case 'collapse-all':
      ui.collapsed = new Set(allDirKeys(buildTree(state.plan.files)))
      render()
      break
    case 'expand-all':
      ui.collapsed = new Set()
      render()
      break
    case 'back':
      ui.selected = null
      render()
      break
    case 'open-file':
      selectFile(data.path)
      break
    case 'comment-plan':
      openPopup({ title: L('planComment'), target: {}, at: rectOf(control) })
      break
    case 'comment-node':
      if (data.kind === 'dir') openPopup({ title: `${L('commentOnFolder')} · ${data.path}/`, target: { path: `${data.path}/` }, at: rectOf(control) })
      else openPopup({ title: `${L('commentOnFile')} · ${data.path}`, target: { path: data.path }, at: rectOf(control) })
      break
    case 'comment-file':
      openPopup({ title: `${L('commentOnFile')} · ${data.path}`, target: { path: data.path }, at: rectOf(control) })
      break
    case 'comment-symbol':
      openPopup({ title: `${L('commentOnSymbol')} · ${data.symbol}`, target: { path: data.path, symbol: data.symbol }, at: rectOf(control) })
      break
    case 'expand': {
      const key = bodyKey(data.path, data.symbol)
      ui.expanded.add(key)
      const body = state.bodies[key]
      if (!body || body.status === 'failed') run({ type: 'generateBody', path: data.path, symbol: data.symbol })
      render()
      break
    }
    case 'collapse':
      ui.expanded.delete(data.key)
      render()
      break
    case 'inline-expand': {
      const key = bodyKey(data.path, data.symbol)
      ui.inlineExpanded.add(key)
      const body = state.bodies[key]
      if (!body || body.status === 'failed') run({ type: 'generateBody', path: data.path, symbol: data.symbol })
      render()
      break
    }
    case 'inline-collapse':
      ui.inlineExpanded.delete(bodyKey(data.path, data.symbol))
      render()
      break
    case 'inline-regen':
      run({ type: 'generateBody', path: data.path, symbol: data.symbol })
      break
    case 'regen':
      run({ type: 'generateBody', path: data.path, symbol: data.symbol })
      break
    case 'full-file':
      if (ui.fullFile.has(data.path)) ui.fullFile.delete(data.path)
      else {
        ui.fullFile.add(data.path)
        void loadFullFile(data.path)
      }
      render()
      break
    case 'delete-comment':
      run({ type: 'deleteComment', id: data.id })
      break
    case 'ask':
      submitQuestion()
      break
    case 'qa-comment': {
      const item = state.qa.find(one => one.id === data.id)
      if (!item) break
      const prefill = `Q: ${item.question}\nA: ${(item.answer || '').slice(0, 600)}`
      openPopup({ title: L('planComment'), target: item.focus ? { path: item.focus } : {}, prefill, at: rectOf(control) })
      break
    }
    default:
      break
  }
}

applyTheme()
render()
connect(onState, online => {
  if (ui.online === online) return
  ui.online = online
  if (state) render()
})
