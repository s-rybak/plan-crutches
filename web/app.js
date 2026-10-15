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
  replyOpen: new Set(),
}

let state = null
let lang = 'en'
let diagram = null
let diagramHost = null
let lastNotice = 0
let renderTimer = null
let popupState = null

const L = (key, params) => t(lang, key, params)
const bodyKey = (path, symbol) => `${path}#${symbol}`
const newId = () => Math.random().toString(36).slice(2, 10)
/** An id no thread holds yet, so the mod keeps it and the popup can follow its thread. */
function freshId() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = newId()
    if (!state || !state.qa.some(one => one.id === id)) return id
  }
  return newId()
}
// The state shape and the actions this page expects; hooks/web.ts carries the
// same number. A session keeps the mod it started with, while this file comes
// from disk, so an older mod behind a newer page gets a warning.
const PROTOCOL = 3
const staleMod = () => Boolean(state && state.plan && state.protocol !== PROTOCOL)

// ---------- question threads ----------

/** The turns of a thread in order: the first question, then every follow-up. */
function qaTurns(item) {
  return [{ id: item.id, question: item.question, answer: item.answer, status: item.status }, ...(item.followups || [])]
}

function threadBusy(item) {
  return qaTurns(item).some(turn => turn.status === 'asking')
}

/** A thread as text, the shape a comment gets. */
function threadTextOf(item, answerLimit = 1500) {
  const lines = []
  for (const turn of qaTurns(item)) {
    if (turn.status !== 'done') continue
    lines.push(`Q: ${turn.question}`)
    lines.push(`A: ${(turn.answer || '').slice(0, answerLimit)}`)
  }
  return lines.join('\n')
}

function qaTarget(item) {
  if (item.target && Object.keys(item.target).length) return { ...item.target }
  return item.focus ? { path: item.focus } : {}
}

function renderTurn(turn, { pending = false } = {}) {
  let reply
  if (pending || turn.status === 'asking') reply = `<div class="msg assistant"><span class="who">${L('claude')}</span><div class="status"><span class="spinner"></span> ${L('asking')}</div></div>`
  else if (turn.status === 'failed') reply = `<div class="msg assistant failed"><span class="who">${L('claude')}</span>${L('askFailed')}: ${escapeHtml(turn.answer || '')}</div>`
  else reply = `<div class="msg assistant"><span class="who">${L('claude')}</span><div class="md" data-selectable data-scope="plan">${renderMarkdown(turn.answer || '', { imageUrl: projectUrl })}</div></div>`
  return `<div class="msg user"><span class="who">${L('you')}</span>${escapeHtml(turn.question)}</div>${reply}`
}

function renderThread(item, pendingQuestion) {
  const turns = item ? qaTurns(item) : []
  let html = turns.map(turn => renderTurn(turn)).join('')
  if (pendingQuestion) html += renderTurn({ question: pendingQuestion, status: 'asking' }, { pending: true })
  return html ? `<div class="thread">${html}</div>` : ''
}

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
  if (staleMod()) banners.push(`<div class="banner warn">⚠ ${L('staleMod')}</div>`)
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

function renderQaItem(item) {
  const target = item.target && Object.keys(item.target).length ? item.target : null
  const where = target ? describeTarget(target) : item.focus || ''
  const followups = item.followups || []
  const busy = threadBusy(item)
  const replyOpen = ui.replyOpen.has(item.id) || followups.some(turn => turn.status === 'asking')
  const open = target && target.path && !target.path.endsWith('/') ? ` data-action="open-file" data-path="${escapeHtml(target.path)}" style="cursor:pointer"` : ''
  const answered = qaTurns(item).some(turn => turn.status === 'done')
  const count = followups.length === 1 ? L('replyOne') : L('replies', { n: followups.length })
  return (
    `<div class="qa" data-qa="${item.id}">` +
    (where
      ? `<div class="focus"><span${open}>${escapeHtml(where)}</span>${followups.length ? `<span class="chip count">${count}</span>` : ''}</div>`
      : followups.length
        ? `<div class="focus"><span class="chip count">${count}</span></div>`
        : '') +
    (target && target.selection ? `<div class="quote">${escapeHtml(target.selection.slice(0, 600))}</div>` : '') +
    renderThread(item) +
    `<div class="qa-actions">` +
    (answered ? `<button class="btn small" data-action="qa-comment" data-id="${item.id}">💬 ${L('threadToComment')}</button>` : '') +
    (!replyOpen && !busy ? `<button class="btn small ghost" data-action="qa-reply-open" data-id="${item.id}">↩ ${L('reply')}</button>` : '') +
    `</div>` +
    (replyOpen
      ? `<div class="reply"><textarea data-draft="reply:${item.id}" data-reply="${item.id}" placeholder="${escapeHtml(L('replyPlaceholder'))}"></textarea>` +
        `<button class="btn primary small" data-action="qa-reply" data-id="${item.id}" ${busy ? 'disabled' : ''}>${L('send')}</button></div>`
      : '') +
    `</div>`
  )
}

function renderAsk() {
  const items = [...state.qa].reverse()
  return (
    `<section class="card"><div class="ask-form"><textarea id="ask-input" data-draft="ask" placeholder="${escapeHtml(L('askPlaceholder'))}"></textarea><button class="btn primary" data-action="ask" ${state.plan ? '' : 'disabled'}>${L('ask')}</button></div>` +
    (ui.selected ? `<div class="hint">${L('anchor')}: ${escapeHtml(ui.selected)}</div>` : '') +
    `</section>` +
    items.map(renderQaItem).join('')
  )
}

function renderComments() {
  const groups = { pending: [], sent: [], resolved: [] }
  for (const comment of state.comments) groups[commentState(comment)].push(comment)
  const section = (key, list) => (list.length ? `<div class="section-title">${L(key)} <span class="chip count">${list.length}</span></div><div class="comments">${list.map(one => renderComment(one, { withOpen: true })).join('')}</div>` : '')
  const history = state.review.history.length ? `<div class="section-title">${L('history')}</div><ul class="hint">${state.review.history.map(one => `<li>${escapeHtml(one)}</li>`).join('')}</ul>` : ''
  return `<section class="card">${state.comments.length ? section('pending', groups.pending) + section('sent', groups.sent) + section('resolved', groups.resolved) : `<div class="hint">${L('noComments')}</div>`}${history}</section>`
}

// The diagram keeps its own element across redraws: its view (rotation, zoom,
// opened symbols) lives in the module, the data comes from the state.
function ensureDiagram() {
  if (!diagramHost) {
    diagramHost = document.createElement('section')
    diagramHost.className = 'card diagram-card'
    diagram = mountDiagram(diagramHost, {
      lang,
      onGenerate: () => run({ type: 'generateDiagram' }),
      onCallers: (path, symbol) => run({ type: 'callers', path, symbol }),
      onOpenFile: path => {
        if (state.plan && state.plan.files.some(one => one.path === path)) selectFile(path)
      },
      onSaveSvg: svg => run({ type: 'diagramSvg', svg }),
    })
  }
  // Attach first: the fit of the view measures the viewport, which has no size while detached.
  const slot = document.getElementById('diagram-slot')
  if (slot && diagramHost.parentElement !== slot) slot.appendChild(diagramHost)
  diagram.setLang(lang)
  diagram.setData({ plan: state.plan, diagram: state.diagram, review: state.review })
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
  // Drafts in every textarea survive the redraw, and the focused one keeps focus.
  const drafts = new Map()
  let focusedDraft = null
  for (const area of app.querySelectorAll('textarea[data-draft]')) {
    drafts.set(area.dataset.draft, area.value)
    if (document.activeElement === area) focusedDraft = { key: area.dataset.draft, start: area.selectionStart, end: area.selectionEnd }
  }
  const scrollY = window.scrollY
  const treeScroll = document.querySelector('.tree-panel')?.scrollTop ?? 0
  let main = ''
  if (ui.tab === 'changes') main = renderChanges()
  else if (ui.tab === 'diagram') main = `<div id="diagram-slot"></div>`
  else if (ui.tab === 'ask') main = renderAsk()
  else main = renderComments()
  app.innerHTML = `<div class="topbar${scrollY > 4 ? ' scrolled' : ''}">${renderHeader()}${renderTabs()}</div>` + renderBanner() + `<main>${main}</main>`
  for (const area of app.querySelectorAll('textarea[data-draft]')) {
    if (drafts.has(area.dataset.draft)) area.value = drafts.get(area.dataset.draft)
    if (focusedDraft && focusedDraft.key === area.dataset.draft) {
      area.focus({ preventScroll: true })
      try {
        area.setSelectionRange(focusedDraft.start, focusedDraft.end)
      } catch {
        // a disabled textarea takes no caret
      }
    }
  }
  if (ui.tab === 'diagram') ensureDiagram()
  window.scrollTo(0, scrollY)
  const panel = document.querySelector('.tree-panel')
  if (panel) panel.scrollTop = treeScroll
  measureTopbar()
  requestFileIfNeeded()
}

// The tree panel sticks right under the floating header, whatever its height.
const topbarObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measureTopbar()) : null

function measureTopbar() {
  const topbar = app.querySelector('.topbar')
  if (!topbar) return
  document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)
  if (topbarObserver) {
    topbarObserver.disconnect()
    topbarObserver.observe(topbar)
  }
}

window.addEventListener(
  'scroll',
  () => {
    const topbar = app.querySelector('.topbar')
    if (topbar) topbar.classList.toggle('scrolled', window.scrollY > 4)
  },
  { passive: true },
)

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
  // The popup follows its own thread: the answer arrives with the state.
  if (popupState && popupState.mode === 'ask' && popupState.qaId) renderPopup()
}

// ---------- popup ----------
// One floating window with two tabs. Comment saves a review comment on the
// target. Ask opens a question thread about the same target; the thread goes
// on in the window and is kept in the Ask tab, and can end up as a comment.

function openPopup({ title, target, selection, prefill, at, mode = 'comment' }) {
  popupState = { title, target: target || {}, selection: selection || '', prefill: prefill || '', at, mode, qaId: null, pending: null }
  renderPopup({ focus: true })
}

function popupThread() {
  if (!popupState || !state) return null
  if (popupState.qaId) {
    const own = state.qa.find(one => one.id === popupState.qaId)
    if (own) return own
  }
  // A mod older than this page names the thread itself and ignores the id
  // the popup chose: adopt the newest thread that asks the popup's question.
  const { pending } = popupState
  if (pending && pending.turns === 0) {
    const adopted = [...state.qa].reverse().find(one => one.question === pending.question)
    if (adopted) {
      popupState.qaId = adopted.id
      return adopted
    }
  }
  return null
}

/** The question the popup is waiting for, until the state shows it. */
function popupPending() {
  const { pending } = popupState
  if (!pending) return ''
  const item = popupThread()
  const turns = item ? qaTurns(item).length : 0
  if (turns > pending.turns) {
    popupState.pending = null
    return ''
  }
  return pending.question
}

function renderPopup({ focus = false, keepDraft = true } = {}) {
  if (!popupState) return
  const { title, target, selection, mode } = popupState
  const current = popup.querySelector('textarea')
  const draft = keepDraft && current ? current.value : popupState.prefill
  const hadFocus = current && document.activeElement === current
  popupState.prefill = ''
  const item = mode === 'ask' ? popupThread() : null
  const pending = mode === 'ask' ? popupPending() : ''
  const busy = Boolean(pending) || (item ? threadBusy(item) : false)
  const answered = item ? qaTurns(item).some(turn => turn.status === 'done') : false
  const tabs =
    `<div class="ptabs">` +
    `<button class="ptab${mode === 'comment' ? ' active' : ''}" data-popup="mode" data-mode="comment">💬 ${L('popupComment')}</button>` +
    `<button class="ptab${mode === 'ask' ? ' active' : ''}" data-popup="mode" data-mode="ask">? ${L('popupAsk')}</button>` +
    `</div>`
  let body
  if (mode === 'comment') {
    body =
      `<textarea id="popup-text" placeholder="${escapeHtml(L('commentPlaceholder'))}"></textarea>` +
      `<div class="pactions"><span class="hint"><kbd>Enter</kbd> ${L('save')} · <kbd>Esc</kbd> ${L('cancel')}</span>` +
      `<button class="btn" data-popup="cancel">${L('cancel')}</button><button class="btn primary" data-popup="save">${L('save')}</button></div>`
  } else {
    // The textarea stays enabled while an answer is on its way, so it keeps
    // the focus and the next question can be typed; sending waits.
    body =
      renderThread(item, pending) +
      `<textarea id="popup-text" placeholder="${escapeHtml(item || pending ? L('replyPlaceholder') : L('askSelectionPlaceholder'))}"></textarea>` +
      `<div class="pactions"><span class="hint"><kbd>Enter</kbd> ${L('send')} · <kbd>Esc</kbd> ${L('close')}</span>` +
      (answered ? `<button class="btn" data-popup="thread-comment">💬 ${L('threadToComment')}</button>` : '') +
      `<button class="btn" data-popup="cancel">${L('close')}</button><button class="btn primary" data-popup="send" ${busy ? 'disabled' : ''}>${L('send')}</button></div>`
  }
  popup.className = `popup mode-${mode}`
  popup.innerHTML =
    `<div class="ptitle"><span>${escapeHtml(title)}</span><span class="spacer"></span><button class="btn ghost small" data-popup="cancel">✕</button></div>` +
    (selection && !(mode === 'ask' && (item || pending)) ? `<div class="pquote">${escapeHtml(selection)}</div>` : '') +
    tabs +
    body
  popup.hidden = false
  const textarea = popup.querySelector('textarea')
  if (draft) textarea.value = draft
  const thread = popup.querySelector('.thread')
  if (thread) thread.scrollTop = thread.scrollHeight
  placePopup()
  if (focus || hadFocus) {
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }
}

function placePopup() {
  const { at } = popupState
  const width = popup.offsetWidth
  const height = popup.offsetHeight
  const left = Math.min(Math.max(12, at.x), window.innerWidth - width - 12)
  let top = at.y + 10
  if (top + height > window.innerHeight - 12) top = Math.max(12, Math.min(at.y - height - 10, window.innerHeight - height - 12))
  popup.style.left = `${left}px`
  popup.style.top = `${top}px`
}

function closePopup() {
  popupState = null
  popup.hidden = true
  popup.innerHTML = ''
}

function popupTarget() {
  const target = { ...popupState.target }
  if (popupState.selection) target.selection = popupState.selection.slice(0, 2000)
  return target
}

async function savePopup() {
  const textarea = popup.querySelector('textarea')
  if (!textarea) return
  const text = textarea.value.trim()
  if (!text) return closePopup()
  const target = popupTarget()
  closePopup()
  await run({ type: 'comment', target, text })
}

function sendPopupQuestion() {
  const textarea = popup.querySelector('textarea')
  if (!textarea) return
  const question = textarea.value.trim()
  if (!question) return
  const item = popupThread()
  if (popupPending() || (item && threadBusy(item))) return
  // A mod older than this page drops a follow-up without a word: say so and keep the draft.
  if (item && staleMod()) return toast(L('staleMod'))
  textarea.value = ''
  if (item) {
    popupState.pending = { question, turns: qaTurns(item).length }
    void run({ type: 'askMore', id: item.id, question })
  } else {
    const id = freshId()
    popupState.qaId = id
    popupState.pending = { question, turns: 0 }
    const target = popupTarget()
    void run({ type: 'ask', id, question, ...(Object.keys(target).length ? { target } : {}), ...(ui.selected ? { focus: ui.selected } : {}) })
  }
  renderPopup({ keepDraft: false })
}

/** Carries the thread into the Comment tab, as the comment's text. */
function threadToComment() {
  const item = popupThread()
  if (!item) return
  popupState.mode = 'comment'
  popupState.prefill = threadTextOf(item)
  // The thread's own target wins; a thread without one keeps the popup's selection.
  if (item.target && Object.keys(item.target).length) {
    popupState.target = qaTarget(item)
    if (item.target.selection) popupState.selection = item.target.selection
  }
  renderPopup({ focus: true, keepDraft: false })
}

popup.addEventListener('click', event => {
  const button = event.target.closest('[data-popup]')
  if (!button) return
  switch (button.dataset.popup) {
    case 'save':
      savePopup()
      break
    case 'send':
      sendPopupQuestion()
      break
    case 'mode':
      if (popupState && popupState.mode !== button.dataset.mode) {
        popupState.mode = button.dataset.mode
        renderPopup({ focus: true })
      }
      break
    case 'thread-comment':
      threadToComment()
      break
    default:
      closePopup()
  }
})

popup.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && event.target.tagName === 'TEXTAREA') {
    event.preventDefault()
    if (popupState && popupState.mode === 'ask') sendPopupQuestion()
    else savePopup()
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
  openPopup({ title: `${L('selection')} · ${where}${target.lines ? ` · ${L('linesSelected', { n: target.lines[1] - target.lines[0] + 1 })}` : ''}`, target, selection: text.slice(0, 2000), at: { x: rect.left, y: rect.bottom } })
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
  if (event.key !== 'Enter' || event.target.tagName !== 'TEXTAREA') return
  // Enter sends, Shift+Enter adds a line; Cmd/Ctrl+Enter sends too.
  if (event.shiftKey) return
  if (event.target.id === 'ask-input') {
    event.preventDefault()
    submitQuestion()
  } else if (event.target.dataset.reply) {
    event.preventDefault()
    sendReply(event.target.dataset.reply)
  }
})

function submitQuestion() {
  const input = document.getElementById('ask-input')
  if (!input) return
  const question = input.value.trim()
  if (!question) return
  input.value = ''
  run({ type: 'ask', id: freshId(), question, ...(ui.selected ? { focus: ui.selected } : {}) })
}

function sendReply(id) {
  const input = app.querySelector(`textarea[data-reply="${id}"]`)
  const item = state && state.qa.find(one => one.id === id)
  if (!input || !item || threadBusy(item)) return
  const question = input.value.trim()
  if (!question) return
  // A mod older than this page drops a follow-up without a word: say so and keep the draft.
  if (staleMod()) return toast(L('staleMod'))
  input.value = ''
  run({ type: 'askMore', id, question })
}

function handleAction(control) {
  const { action } = control.dataset
  const data = control.dataset
  switch (action) {
    case 'tab':
      if (ui.tab !== data.tab) window.scrollTo(0, 0)
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
      openPopup({ title: L('plan'), target: {}, at: rectOf(control) })
      break
    case 'comment-node':
      if (data.kind === 'dir') openPopup({ title: `${L('folder')} · ${data.path}/`, target: { path: `${data.path}/` }, at: rectOf(control) })
      else openPopup({ title: data.path, target: { path: data.path }, at: rectOf(control) })
      break
    case 'comment-file':
      openPopup({ title: data.path, target: { path: data.path }, at: rectOf(control) })
      break
    case 'comment-symbol':
      openPopup({ title: `${data.path} · ${data.symbol}`, target: { path: data.path, symbol: data.symbol }, at: rectOf(control) })
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
      const target = qaTarget(item)
      const selection = target.selection || ''
      delete target.selection
      const where = Object.keys(target).length ? describeTarget(target) : L('plan')
      openPopup({ title: where, target, selection, prefill: threadTextOf(item), at: rectOf(control) })
      break
    }
    case 'qa-reply-open':
      ui.replyOpen.add(data.id)
      render()
      app.querySelector(`textarea[data-reply="${data.id}"]`)?.focus()
      break
    case 'qa-reply':
      sendReply(data.id)
      break
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
