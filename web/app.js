// Plan Crutches review page. State comes from the mod over SSE; every action
// goes back as one POST and returns as a new state.
import { connect, act, projectUrl } from './api.js'
import { t } from './i18n.js'
import { renderMarkdown, escapeHtml } from './markdown.js'
import { renderSource, renderDiff, renderReplaceDiff, renderDeletion, oldLinesBefore, weaveDiff, deletionOfFile } from './codeview.js'
import { buildTree, renderTree, allDirKeys, pathsUnder } from './tree.js'
import { mountDiagram } from './diagram.js'
import { fileDeltas, symbolDeltas, folderDelta } from './compare.js'
import { renderTextDiff, textsDiffer } from './textdiff.js'

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
  highlight: stored('plan-crutches-highlight', '0') === '1',
  editingSummary: false,
  editingComment: null,
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
function freshId(taken = state ? state.qa.map(one => one.id) : []) {
  const used = new Set(taken)
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = newId()
    if (!used.has(id)) return id
  }
  return newId()
}
// The state shape and the actions this page expects; hooks/web.ts carries the
// same number. A session keeps the mod it started with, while this file comes
// from disk, so an older mod behind a newer page gets a warning.
const PROTOCOL = 5
const staleMod = () => Boolean(state && state.plan && state.protocol !== PROTOCOL)

// ---------- what the page shows: the current plan, or an earlier version ----------

const viewing = () => (state && state.viewing) || null
const shownPlan = () => (viewing() ? viewing().plan : state.plan)
const shownFiles = () => (viewing() ? viewing().files : state.files)
const isReadonly = () => Boolean(viewing())
/** The version the current plan is compared with, when the page highlights the changes. */
const comparePlan = () => (state && state.compare && !viewing() ? state.compare.plan : null)
const highlighting = () => Boolean(ui.highlight && comparePlan())

/** The file deltas of the current plan against the compared version, or null when not highlighting. */
function planDeltas() {
  const compare = comparePlan()
  if (!highlighting() || !state.plan) return null
  const { byPath, removed } = fileDeltas(state.plan, compare)
  return { since: state.compare.version, byPath, removed }
}

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

/**
 * The Full file view of a planned file: the whole file with the diff's
 * changes woven in at their place, as one block. While the file loads, or
 * when it is gone, the plain diff stays with a note; when the file no longer
 * matches the diff, the diff stays and the file follows it as a listing.
 */
function renderFileChanges(file, entry, { commented, inline }) {
  const diffHtml = entry.view ? block(renderDiff(entry.view.text, { path: file.path, commented, inline }), { path: file.path }) : ''
  if (!ui.fullFile.has(file.path)) return diffHtml
  const full = ui.fullText.get(file.path)
  if (!full || full.status === 'loading') return diffHtml + `<div class="status hint"><span class="spinner"></span> ${L('loadingFile')}</div>`
  if (full.status === 'failed') return diffHtml + `<div class="hint">${L('fileMissing')}</div>`
  const woven = file.status === 'deleted' ? deletionOfFile(full.text) : entry.view ? weaveDiff(full.text, entry.view.text) : null
  if (woven === null) return diffHtml + `<div class="hint">${L('fileChanged')}</div>` + block(renderSource(full.text, { path: file.path }), { path: file.path })
  return block(renderDiff(woven, { path: file.path, commented, inline, headers: false }), { path: file.path })
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

/**
 * One comment card. A pending comment can be edited in place (the text turns
 * into a textarea with Save and Cancel) or deleted; a sent or resolved one
 * stays as Claude saw it.
 */
function renderComment(comment, { withOpen = false } = {}) {
  const kind = commentState(comment)
  const label = kind === 'pending' ? L('pending') : kind === 'sent' ? `${L('sent')} (v${comment.sentInVersion})` : `${L('resolved')} (v${comment.resolvedInVersion})`
  const open = withOpen && comment.target.path && !comment.target.path.endsWith('/') ? ` data-action="open-file" data-path="${escapeHtml(comment.target.path)}" style="cursor:pointer"` : ''
  const id = escapeHtml(comment.id)
  const editing = kind === 'pending' && ui.editingComment === comment.id
  const text = editing
    ? `<textarea class="comment-edit" data-draft="comment:${id}" data-comment-edit="${id}" rows="${Math.min(12, Math.max(2, comment.text.split('\n').length + 1))}">${escapeHtml(comment.text)}</textarea>` +
      `<div class="edit-actions"><span class="hint"><kbd>Enter</kbd> ${L('save')} · <kbd>Esc</kbd> ${L('cancel')}</span><span class="spacer"></span>` +
      `<button class="btn small" data-action="cancel-comment-edit">${L('cancel')}</button><button class="btn small primary" data-action="save-comment-edit" data-id="${id}">${L('save')}</button></div>`
    : `<div class="text">${escapeHtml(comment.text)}</div>`
  const tools =
    kind === 'pending' && !editing
      ? `<button class="tool" data-action="edit-comment" data-id="${id}" title="${L('editComment')}">✎</button>` +
        `<button class="tool del" data-action="delete-comment" data-id="${id}" title="${L('delete')}">✕</button>`
      : ''
  return (
    `<div class="comment ${kind}${editing ? ' editing' : ''}">` +
    `<div class="body"><div class="where"${open}>${escapeHtml(describeTarget(comment.target))}</div>` +
    (comment.target.selection ? `<div class="quote">${escapeHtml(comment.target.selection.slice(0, 400))}</div>` : '') +
    text +
    `</div>` +
    `<div class="state">${escapeHtml(label)}</div>` +
    tools +
    `</div>`
  )
}

function shortTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function versionSourceLabel(entry) {
  if (entry.source === 'restored') return L('versionSource_restored', { n: entry.from ?? '?' })
  if (entry.source === 'edited') return L('versionSource_edited')
  return L('versionSource_received')
}

function renderVersionSelect() {
  const versions = state.versions || []
  if (versions.length < 2) return ''
  const shown = viewing() ? viewing().version : state.review.version
  const options = [...versions]
    .sort((a, b) => b.version - a.version)
    .map(entry => {
      const current = entry.version === state.review.version ? ` · ${L('versionCurrent')}` : ''
      return `<option value="${entry.version}"${entry.version === shown ? ' selected' : ''}>v${entry.version} · ${escapeHtml(shortTime(entry.receivedAt))}${current}</option>`
    })
    .join('')
  return `<select class="select small" data-action="pick-version" title="${L('versions')}">${options}</select>`
}

function okCountOf(plan) {
  const ok = state.ok || {}
  return plan.files.filter(file => ok[file.path]).length
}

function renderHeader() {
  const { plan, review } = state
  const pending = pendingComments().length
  let action = ''
  if (review.status === 'reviewing' && plan && !isReadonly()) {
    action = `<button class="btn primary" data-action="submit">${pending ? L('submitWith', { n: pending }) : L('approve')}</button>`
  }
  const themeLabel = L(`theme_${ui.theme}`)
  // The record path is long: it takes a line of its own under the badges, so the Submit button stays on the first line.
  const record = review.recordPath ? `<div class="record" title="${escapeHtml(review.recordPath)}">${L('recorded')}: <span class="path">${escapeHtml(review.recordPath.replace(`${state.cwd}/`, ''))}</span></div>` : ''
  const okCount = plan && plan.files.length ? `<span class="badge ok${okCountOf(plan) === plan.files.length ? ' done' : ''}" title="${L('okTitle')}">${L('okCount', { n: okCountOf(plan), m: plan.files.length })}</span>` : ''
  return (
    `<header class="top">` +
    `<div class="brand"><span class="logo"><svg viewBox="0 0 32 32"><path d="M9 10h14M9 16h10M9 22h7" stroke="white" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg></span>${L('appName')}</div>` +
    (plan ? `<div class="title" title="${escapeHtml(plan.title)}">${escapeHtml(plan.title)}</div>` : '') +
    `<div class="meta">` +
    (plan ? renderVersionSelect() || `<span class="badge">${L('version')}${review.version}</span>` : '') +
    `<span class="badge status-${review.status}">${L(`status_${review.status}`)}</span>` +
    (review.isDemo ? `<span class="badge">${L('demo')}</span>` : '') +
    (plan ? `<span>${state.comments.length} ${L('comments')}</span>` : '') +
    okCount +
    `</div>` +
    `<span class="spacer"></span>` +
    `<div class="actions">` +
    `<span class="dot${ui.online ? ' online' : ''}" title="${ui.online ? L('online') : L('offlineShort')}"></span>` +
    `<button class="btn ghost small" data-action="theme" title="${themeLabel}">${ui.theme === 'dark' ? '☾' : ui.theme === 'light' ? '☀' : '◐'}</button>` +
    `<button class="btn ghost small" data-action="lang">${L('lang')}</button>` +
    action +
    `</div>` +
    record +
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
  const old = viewing()
  if (plan && old) {
    const restore = review.status === 'reviewing' && !staleMod() ? `<button class="btn small primary" data-action="restore-version" data-version="${old.version}">${L('restoreVersion')}</button>` : ''
    banners.push(
      `<div class="banner viewing"><span>${L('viewingVersion', { n: old.version, m: review.version })} ${L('readOnlyVersion')}</span><span class="spacer"></span>${restore}<button class="btn small" data-action="view-current">${L('backToCurrent')}</button></div>`,
    )
  }
  return banners.join('')
}

function renderTask(plan) {
  const task = plan.task || { source: 'none', text: '' }
  const source = task.source === 'jira' ? `${L('taskFromJira')}${task.key ? ` · ${escapeHtml(task.key)}` : ''}` : task.source === 'user' ? L('taskFromUser') : ''
  const text = task.text || ''
  const cut = !ui.showFullTask && text.length > TASK_LIMIT
  const comment = isReadonly() ? '' : `<button class="btn small" data-action="comment-plan">💬 ${L('planComment')}</button>`
  return (
    `<section class="card task${ui.showTask ? '' : ' collapsed'}">` +
    `<h2><button class="btn ghost small" data-action="toggle-task">${ui.showTask ? '▾' : '▸'}</button>${L('task')}${source ? ` <span class="hint">${source}</span>` : ''}<span class="spacer"></span>${comment}</h2>` +
    `<div class="body">` +
    (text ? `<pre data-selectable data-scope="plan">${escapeHtml(cut ? text.slice(0, TASK_LIMIT) + '…' : text)}</pre>` : `<div class="hint">${L('taskNone')}</div>`) +
    (text.length > TASK_LIMIT ? `<button class="btn ghost small" data-action="toggle-full-task">${ui.showFullTask ? L('showLess') : L('showAll')}</button>` : '') +
    `</div></section>`
  )
}

function renderCompareControls() {
  const versions = state.versions || []
  if (isReadonly() || versions.length < 2) return ''
  const compare = state.compare
  const options = versions
    .filter(entry => entry.version !== state.review.version)
    .sort((a, b) => b.version - a.version)
    .map(entry => `<option value="${entry.version}"${compare && compare.version === entry.version ? ' selected' : ''}>v${entry.version}</option>`)
    .join('')
  const on = highlighting()
  return (
    `<span class="compare">` +
    `<button class="btn small${on ? ' active' : ''}" data-action="toggle-highlight"${compare ? '' : ' disabled'}>${on ? L('highlightOff') : L('highlightChanges')}</button>` +
    `<span class="hint">${L('compareWith')}</span><select class="select small" data-action="compare-version">${options}</select>` +
    `</span>`
  )
}

function renderSummary(plan) {
  const limit = state.summaryLimit || 9000
  const summary = plan.summary || ''
  const readonly = isReadonly()
  const editing = ui.editingSummary && !readonly && state.review.status === 'reviewing'
  const edited =
    !readonly && state.review.summaryEditedInVersion === state.review.version
      ? `<span class="hint edited" title="${escapeHtml(L('summaryEditHint'))}">✎ ${L('summaryEdited', { n: state.review.summaryEditedInVersion })}</span>`
      : ''
  const editButton = !editing && !readonly && state.review.status === 'reviewing' ? `<button class="btn ghost small" data-action="edit-summary">✎ ${L('editSummary')}</button>` : ''
  let body
  if (editing) {
    const rows = Math.min(36, Math.max(10, summary.split('\n').length + 2))
    body =
      `<textarea class="summary-edit" data-draft="summary" rows="${rows}" spellcheck="true">${escapeHtml(summary)}</textarea>` +
      `<div class="edit-actions"><span class="hint">${L('summaryEditHint')} <kbd>⌘/Ctrl+Enter</kbd> ${L('save')} · <kbd>Esc</kbd> ${L('cancel')}</span><span class="spacer"></span>` +
      `<button class="btn small" data-action="cancel-summary">${L('cancel')}</button><button class="btn small primary" data-action="save-summary">${L('saveSummary')}</button></div>`
  } else if (highlighting()) {
    const compare = comparePlan()
    body = textsDiffer(compare.summary, summary)
      ? `<div class="textdiff-legend"><ins>${L('legendIns')}</ins><del>${L('legendDel')}</del><span class="hint">${L('deltaSince', { n: state.compare.version })}</span></div>` + renderTextDiff(compare.summary, summary)
      : `<div class="hint">${L('textDiffEmpty')}</div><div class="md" data-selectable data-scope="plan">${renderMarkdown(summary, { imageUrl: projectUrl })}</div>`
  } else {
    const cut = !ui.showFullSummary && summary.length > limit
    const shown = cut ? summary.slice(0, limit) + '…' : summary
    body =
      `<div class="md" data-selectable data-scope="plan">${renderMarkdown(shown, { imageUrl: projectUrl })}</div>` +
      (summary.length > limit ? `<button class="btn ghost small" data-action="toggle-summary">${ui.showFullSummary ? L('showLess') : L('showAll')}</button>` : '')
  }
  return (
    `<section class="card summary">` +
    `<h2>${L('summary')}${edited}<span class="spacer"></span>${renderCompareControls()}${editButton}<span class="hint">${summary.length} / ${limit}</span></h2>` +
    body +
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
  const deltas = planDeltas()
  const roots = buildTree(plan.files, deltas ? deltas.removed : [])
  let treeDeltas = null
  if (deltas) {
    const folders = new Map()
    const removedPaths = deltas.removed.map(file => file.path)
    const walk = nodes => {
      for (const node of nodes) {
        if (node.kind !== 'dir') continue
        folders.set(node.path, folderDelta(pathsUnder(node), deltas.byPath, removedPaths.filter(path => path.startsWith(`${node.path}/`))))
        walk(node.children)
      }
    }
    walk(roots)
    treeDeltas = { since: deltas.since, byPath: deltas.byPath, folders }
  }
  const readonly = isReadonly()
  const ok = readonly ? {} : state.ok || {}
  const okCount = plan.files.filter(file => ok[file.path]).length
  const counter = !readonly && plan.files.length ? `<span class="chip okcount${okCount === plan.files.length ? ' done' : ''}" title="${L('okTitle')}">${L('okCount', { n: okCount, m: plan.files.length })}</span>` : ''
  return (
    `<aside class="card tree-panel">` +
    `<div class="tree-toolbar"><strong>${L('changes')}</strong>${counter}<span class="spacer"></span>` +
    `<button class="btn ghost small" data-action="collapse-all">${L('collapseAll')}</button>` +
    `<button class="btn ghost small" data-action="expand-all">${L('expandAll')}</button></div>` +
    renderTree(roots, { collapsed: ui.collapsed, selected: ui.selected, lang, commentCounts: commentCounts(), ok, deltas: treeDeltas, readonly }) +
    (deltas && deltas.removed.length ? `<div class="hint ghost-note">${L('removedFiles')}: ${deltas.removed.length}</div>` : '') +
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

function deltaChipHtml(delta) {
  if (!delta || delta === 'same') return ''
  const key = delta === 'added' ? 'deltaAdded' : delta === 'removed' ? 'deltaRemoved' : 'deltaChanged'
  const sign = delta === 'added' ? '+' : delta === 'removed' ? '−' : '~'
  return `<span class="chip delta ${delta}">${sign} ${L(key)}</span>`
}

/**
 * One symbol card. `context.entry` is the file's view (its diff holds the
 * code a modified symbol has today), `context.delta` and `context.previous`
 * come from the compare view, `context.readonly` hides the actions when an
 * earlier version is shown.
 */
function renderSymbol(file, symbol, context) {
  const key = bodyKey(file.path, symbol.name)
  const body = state.bodies[key]
  const change = symbol.change || 'new'
  const { readonly, entry } = context
  const isExpanded = !readonly && ui.expanded.has(key)
  const oldLines = change === 'modified' && entry && entry.view && entry.view.format === 'diff' ? oldLinesBefore(entry.view.text, symbol) : []
  let bodyHtml = ''
  if (isExpanded) {
    if (!body || body.status === 'loading') bodyHtml = `<div class="status"><span class="spinner"></span>${L('generating')}</div>`
    else if (body.status === 'failed') bodyHtml = `<div class="status error">${L('generationFailed')}: ${escapeHtml(body.error || '')}</div>`
    else if (oldLines.length) bodyHtml = block(renderReplaceDiff(oldLines, body.code || '', { path: file.path, commented: linesCommented(file.path, symbol.name) }), { path: file.path, symbol: symbol.name })
    else bodyHtml = block(renderSource(body.code || '', { path: file.path, commented: linesCommented(file.path, symbol.name) }), { path: file.path, symbol: symbol.name })
  }
  const previous = context.previous
  const signatureChanged = context.delta === 'changed' && previous && previous.signature !== symbol.signature
  const signature =
    change === 'deleted'
      ? block(renderDeletion(symbol.signature, { path: file.path }), { path: file.path, symbol: symbol.name })
      : signatureChanged
        ? block(renderReplaceDiff(previous.signature.split('\n'), symbol.signature, { path: file.path, commented: linesCommented(file.path, symbol.name) }), { path: file.path, symbol: symbol.name })
        : block(renderSource(symbol.signature, { path: file.path, commented: linesCommented(file.path, symbol.name) }), { path: file.path, symbol: symbol.name })
  const wasDescription = context.delta === 'changed' && previous && previous.description !== symbol.description ? `<div class="sym-desc was-desc"><span class="hint">${L('was')}:</span> <del>${escapeHtml(previous.description || '')}</del></div>` : ''
  const note = change === 'deleted' ? `<div class="hint">${L('deletedSymbolNote')}</div>` : change === 'modified' ? `<div class="hint">${L('modifiedSymbolNote')}</div>` : ''
  let actions = ''
  if (!readonly) {
    if (change !== 'deleted') {
      actions += isExpanded
        ? `<button class="btn small" data-action="collapse" data-key="${escapeHtml(key)}">${L('collapseImpl')}</button>` +
          `<button class="btn small" data-action="regen" data-path="${escapeHtml(file.path)}" data-symbol="${escapeHtml(symbol.name)}">${L('regenerate')}</button>`
        : `<button class="btn small" data-action="expand" data-path="${escapeHtml(file.path)}" data-symbol="${escapeHtml(symbol.name)}">${L('expandImpl')}</button>`
    }
    actions += `<button class="btn small" data-action="comment-symbol" data-path="${escapeHtml(file.path)}" data-symbol="${escapeHtml(symbol.name)}">💬</button>`
  }
  return (
    `<div class="symbol change-${change}" data-symbol-card="${escapeHtml(symbol.name)}">` +
    `<div class="sym-head"><span class="chip kind">${escapeHtml(symbol.kind)}</span><span class="sym-name">${escapeHtml(symbol.name)}</span>` +
    (change !== 'new' ? `<span class="chip change ${change}">${L(`change_${change}`)}</span>` : '') +
    deltaChipHtml(context.delta) +
    (symbol.anchor ? `<span class="anchor">${L('anchor')}: ${escapeHtml(symbol.anchor)}</span>` : '') +
    `<span class="spacer"></span>` +
    actions +
    `</div>` +
    signature +
    `<div class="sym-desc">${escapeHtml(symbol.description || '')}</div>` +
    wasDescription +
    note +
    bodyHtml +
    `</div>`
  )
}

function renderRemovedSymbol(file, symbol) {
  return (
    `<div class="symbol ghost" data-symbol-card="${escapeHtml(symbol.name)}">` +
    `<div class="sym-head"><span class="chip kind">${escapeHtml(symbol.kind)}</span><span class="sym-name">${escapeHtml(symbol.name)}</span>${deltaChipHtml('removed')}</div>` +
    renderDeletion(symbol.signature, { path: file.path }) +
    `<div class="sym-desc">${escapeHtml(symbol.description || '')}</div>` +
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
  const readonly = isReadonly()
  const entry = shownFiles()[file.path] || { loaded: false }
  const inline = readonly ? null : inlineFor(file)
  const deltas = planDeltas()
  const compare = comparePlan()
  const symbolDelta = deltas ? symbolDeltas(file, compare.files.find(one => one.path === file.path)) : null
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
    const showFull = ui.fullFile.has(file.path)
    const title = showFull ? L('fullFileTitle') : file.status === 'deleted' ? L('deletedFile') : L('diffTitle')
    changes =
      `<div class="section-title">${title}<span class="spacer"></span>` +
      `<button class="btn ghost small" data-action="full-file" data-path="${escapeHtml(file.path)}">${showFull ? L('hideFullFile') : L('fullFile')}</button>` +
      `</div>` +
      renderFileChanges(file, entry, { commented: linesCommented(file.path), inline: file.status === 'modified' ? inline : null })
  }
  const comments = readonly ? [] : state.comments.filter(one => one.target.path === file.path)
  const symbols = file.symbols.map(symbol =>
    renderSymbol(file, symbol, {
      readonly,
      entry,
      delta: symbolDelta ? symbolDelta.byName.get(symbol.name) : null,
      previous: symbolDelta ? symbolDelta.previous.get(symbol.name) : null,
    }),
  )
  const removed = symbolDelta && symbolDelta.removed.length ? `<div class="section-title">${L('removedSymbols')}</div>` + symbolDelta.removed.map(symbol => renderRemovedSymbol(file, symbol)).join('') : ''
  const ok = !readonly && state.ok && state.ok[file.path]
  return (
    `<section class="card detail-card">` +
    `<div class="file-head"><button class="btn ghost small" data-action="back">←</button><span class="path">${escapeHtml(file.path)}</span><span class="chip ${file.status}">${L(`status_${file.status}`)}</span>` +
    (deltas ? deltaChipHtml(deltas.byPath.get(file.path)) : '') +
    (ok ? `<span class="chip okcount done" title="${L('okTitleOn')}">✓ OK v${ok.version}</span>` : '') +
    `<span class="spacer"></span>` +
    (readonly
      ? ''
      : `<button class="btn small${ok ? ' active' : ''}" data-action="ok-toggle" data-path="${escapeHtml(file.path)}" data-ok="${ok ? 'off' : 'on'}" title="${escapeHtml(ok ? L('okTitleOn') : L('okTitle'))}">✓ OK</button>` +
        `<button class="btn small" data-action="comment-file" data-path="${escapeHtml(file.path)}">💬 ${L('commentOnFile')}</button>`) +
    `</div>` +
    `<div class="desc" data-selectable data-scope="file" data-path="${escapeHtml(file.path)}">${escapeHtml(file.description || '')}</div>` +
    `<div class="section-title">${L('symbols')}</div>` +
    (file.symbols.length ? symbols.join('') : `<div class="hint">${L('noSymbols')}</div>`) +
    removed +
    changes +
    (comments.length ? `<div class="section-title">${L('tab_comments')}</div><div class="comments">${comments.map(one => renderComment(one)).join('')}</div>` : '') +
    `</section>`
  )
}

function renderChanges() {
  const { review } = state
  const plan = shownPlan()
  if (!plan) return ''
  const file = ui.selected ? plan.files.find(one => one.path === ui.selected) : null
  const detail = file ? renderFile(file) : `<section class="card detail"><div class="empty">${L('pickFile')}</div></section>`
  return renderTask(plan) + renderSummary(plan) + (isReadonly() ? '' : renderWarnings(review)) + `<div class="split">${renderTreePanel(plan)}<div class="detail">${detail}</div></div>`
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

function renderVersions() {
  const versions = state.versions || []
  if (!versions.length) return ''
  const current = state.review.version
  const canRestore = state.review.status === 'reviewing' && !staleMod()
  const rows = [...versions]
    .sort((a, b) => b.version - a.version)
    .map(entry => {
      const isCurrent = entry.version === current
      const look = isCurrent ? `<span class="chip count">${L('versionCurrent')}</span>` : `<button class="btn small ghost" data-action="view-version" data-version="${entry.version}">${L('open')}</button>`
      const compare = isCurrent ? '' : `<button class="btn small ghost" data-action="compare-version-button" data-version="${entry.version}">${L('highlightChanges')}</button>`
      const restore = !isCurrent && canRestore ? `<button class="btn small" data-action="restore-version" data-version="${entry.version}">${L('restoreVersion')}</button>` : ''
      return `<li><strong>v${entry.version}</strong><span class="hint">${escapeHtml(shortTime(entry.receivedAt))} · ${escapeHtml(versionSourceLabel(entry))} · ${escapeHtml(entry.title)} · ${entry.fileCount}</span><span class="spacer"></span>${look}${compare}${restore}</li>`
    })
    .join('')
  return `<div class="section-title">${L('versions')}</div><ul class="versions">${rows}</ul>`
}

function renderComments() {
  const groups = { pending: [], sent: [], resolved: [] }
  for (const comment of state.comments) groups[commentState(comment)].push(comment)
  const section = (key, list) => (list.length ? `<div class="section-title">${L(key)} <span class="chip count">${list.length}</span></div><div class="comments">${list.map(one => renderComment(one, { withOpen: true })).join('')}</div>` : '')
  const history = state.review.history.length ? `<div class="section-title">${L('history')}</div><ul class="hint">${state.review.history.map(one => `<li>${escapeHtml(one)}</li>`).join('')}</ul>` : ''
  return `<section class="card">${state.comments.length ? section('pending', groups.pending) + section('sent', groups.sent) + section('resolved', groups.resolved) : `<div class="hint">${L('noComments')}</div>`}${renderVersions()}${history}</section>`
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
  if (!state || !ui.selected) return
  const plan = shownPlan()
  if (!plan) return
  const file = plan.files.find(one => one.path === ui.selected)
  if (!file || file.status === 'new') return
  const entry = shownFiles()[file.path]
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
    ui.editingSummary = false
    ui.editingComment = null
  }
  // A comment that was sent or deleted meanwhile is no longer edited.
  if (ui.editingComment && !pendingComments().some(one => one.id === ui.editingComment)) ui.editingComment = null
  const plan = shownPlan()
  if (ui.selected && !(plan && plan.files.some(one => one.path === ui.selected))) ui.selected = null
  if (next.notice && next.notice.id !== lastNotice) {
    lastNotice = next.notice.id
    toast(next.notice.text)
  }
  render()
  // The popup follows its own thread or explanation: the answer arrives with the state.
  if (popupState && ((popupState.mode === 'ask' && popupState.qaId) || popupState.mode === 'explain')) renderPopup()
}

// ---------- popup ----------
// One floating window with three tabs. Comment saves a review comment on the
// target. Ask opens a question thread about the same target; the thread goes
// on in the window and is kept in the Ask tab, and can end up as a comment.
// Explain asks, once the tab opens, what the place is, where it sits and why
// the plan changes it.

function openPopup({ title, target, selection, prefill, at, mode = 'comment' }) {
  popupState = { title, target: target || {}, selection: selection || '', prefill: prefill || '', at, moved: null, mode, qaId: null, pending: null, explainId: null }
  if (mode === 'explain') requestExplanation()
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

/** The same place of the plan gets the same explanation: one key per target. */
function explainKey(target) {
  return JSON.stringify([target.path || '', target.symbol || '', target.lines || null, (target.selection || '').slice(0, 2000)])
}

/** The explanation of the popup's target, its own or an earlier one for the same place in this version. */
function popupExplanation() {
  if (!popupState || !state) return null
  const all = state.explanations || {}
  if (popupState.explainId && all[popupState.explainId]) return all[popupState.explainId]
  const key = explainKey(popupTarget())
  const found = Object.entries(all).find(([, one]) => one.createdInVersion === state.review.version && explainKey(one.target || {}) === key)
  if (found) {
    popupState.explainId = found[0]
    return found[1]
  }
  return null
}

/** Asks for the explanation of the popup's target, unless one is there or on its way. */
function requestExplanation(force = false) {
  if (!state || !state.plan || !popupState) return
  const existing = popupExplanation()
  if (existing && !force && existing.status !== 'failed') return
  if (popupState.explainWaiting && !force) return
  if (staleMod()) return toast(L('staleMod'))
  const id = freshId(Object.keys(state.explanations || {}))
  popupState.explainId = id
  popupState.explainWaiting = true
  void run({ type: 'explain', id, target: popupTarget(), ...(ui.selected ? { focus: ui.selected } : {}) })
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
    `<button class="ptab${mode === 'explain' ? ' active' : ''}" data-popup="mode" data-mode="explain">ⓘ ${L('popupExplain')}</button>` +
    `</div>`
  let body
  if (mode === 'comment') {
    body =
      `<textarea id="popup-text" placeholder="${escapeHtml(L('commentPlaceholder'))}"></textarea>` +
      `<div class="pactions"><span class="hint"><kbd>Enter</kbd> ${L('save')} · <kbd>Esc</kbd> ${L('cancel')}</span>` +
      `<button class="btn" data-popup="cancel">${L('cancel')}</button><button class="btn primary" data-popup="save">${L('save')}</button></div>`
  } else if (mode === 'explain') {
    const explanation = popupExplanation()
    if (explanation && explanation.status !== 'asking') popupState.explainWaiting = false
    let content
    if (!explanation || explanation.status === 'asking') content = `<div class="status"><span class="spinner"></span> ${L('explaining')}</div>`
    else if (explanation.status === 'failed') content = `<div class="msg assistant failed">${L('explainFailed')}: ${escapeHtml(explanation.text || '')}</div>`
    else content = `<div class="explain md" data-selectable data-scope="plan">${renderMarkdown(explanation.text || '', { imageUrl: projectUrl })}</div>`
    body =
      content +
      `<div class="pactions"><span class="hint"><kbd>Esc</kbd> ${L('close')}</span>` +
      (explanation && explanation.status !== 'asking' ? `<button class="btn" data-popup="explain-again">${L('explainAgain')}</button>` : '') +
      `<button class="btn" data-popup="mode" data-mode="ask">? ${L('explainAsk')}</button>` +
      `<button class="btn" data-popup="cancel">${L('close')}</button></div>`
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
    `<div class="ptitle" title="${escapeHtml(L('dragToMove'))}"><span>${escapeHtml(title)}</span><span class="spacer"></span><button class="btn ghost small" data-popup="cancel" title="${escapeHtml(L('close'))}">✕</button></div>` +
    (selection && !(mode === 'ask' && (item || pending)) ? `<div class="pquote">${escapeHtml(selection)}</div>` : '') +
    tabs +
    body
  popup.hidden = false
  const textarea = popup.querySelector('textarea')
  if (textarea && draft) textarea.value = draft
  const thread = popup.querySelector('.thread')
  if (thread) thread.scrollTop = thread.scrollHeight
  placePopup()
  if (textarea && (focus || hadFocus)) {
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }
}

/**
 * Puts the popup next to its anchor, or where the user dragged it. A moved
 * popup keeps its place while its content changes, and is kept inside the
 * window when the content grows or the window shrinks.
 */
function placePopup() {
  const { at, moved } = popupState
  const width = popup.offsetWidth
  const height = popup.offsetHeight
  let left
  let top
  if (moved) {
    left = Math.min(Math.max(0, moved.left), Math.max(0, window.innerWidth - width))
    top = Math.min(Math.max(0, moved.top), Math.max(0, window.innerHeight - height))
    popupState.moved = { left, top }
  } else {
    left = Math.min(Math.max(12, at.x), window.innerWidth - width - 12)
    top = at.y + 10
    if (top + height > window.innerHeight - 12) top = Math.max(12, Math.min(at.y - height - 10, window.innerHeight - height - 12))
  }
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
        if (popupState.mode === 'explain') requestExplanation()
        renderPopup({ focus: true })
      }
      break
    case 'explain-again':
      requestExplanation(true)
      renderPopup()
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

// ---------- moving the popup ----------
// The title bar drags the window. The pointer is captured, so the drag goes on
// outside the popup, and the mouseup that ends it opens no new popup from a
// selection that is still on the page.

let popupDrag = null
let popupDragEndedAt = 0

popup.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !popupState) return
  if (!event.target.closest('.ptitle') || event.target.closest('button')) return
  event.preventDefault()
  const rect = popup.getBoundingClientRect()
  popupDrag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  popup.classList.add('dragging')
  try {
    popup.setPointerCapture(event.pointerId)
  } catch {
    // a synthetic pointer takes no capture; the drag still follows the pointer while it stays over the popup
  }
})

popup.addEventListener('pointermove', event => {
  if (!popupDrag || event.pointerId !== popupDrag.pointerId || !popupState) return
  popupState.moved = { left: event.clientX - popupDrag.dx, top: event.clientY - popupDrag.dy }
  placePopup()
})

function endPopupDrag(event) {
  if (!popupDrag || event.pointerId !== popupDrag.pointerId) return
  popupDrag = null
  popupDragEndedAt = Date.now()
  popup.classList.remove('dragging')
  try {
    popup.releasePointerCapture(event.pointerId)
  } catch {
    // already released
  }
}

popup.addEventListener('pointerup', endPopupDrag)
popup.addEventListener('pointercancel', endPopupDrag)
window.addEventListener('resize', () => {
  if (popupState && !popup.hidden) placePopup()
})

function rectOf(element) {
  const rect = element.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom }
}

function elementOf(node) {
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
}

function checkSelection() {
  if (isReadonly()) return
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
  if (popupDrag || Date.now() - popupDragEndedAt < 250) return
  if (event.target.closest('#popup') || event.target.closest('button, textarea, input, select, .diagram-card')) return
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
    if (control.tagName === 'SELECT') return
    handleAction(control)
    return
  }
  const row = event.target.closest('.row')
  if (row) {
    if (row.dataset.ghost) return
    if (row.dataset.kind === 'dir') {
      if (ui.collapsed.has(row.dataset.key)) ui.collapsed.delete(row.dataset.key)
      else ui.collapsed.add(row.dataset.key)
      render()
    } else {
      selectFile(row.dataset.path)
    }
  }
})

app.addEventListener('change', event => {
  const control = event.target.closest('select[data-action]')
  if (!control) return
  const value = Number(control.value)
  if (control.dataset.action === 'pick-version') {
    run({ type: 'viewVersion', version: value === state.review.version ? null : value })
  } else if (control.dataset.action === 'compare-version') {
    ui.highlight = true
    store('plan-crutches-highlight', '1')
    run({ type: 'compareWith', version: value })
  }
})

app.addEventListener('keydown', event => {
  if (event.target.tagName !== 'TEXTAREA') return
  if (event.target.dataset.draft === 'summary') {
    if (event.key === 'Escape') {
      event.preventDefault()
      ui.editingSummary = false
      render()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      saveSummary()
    }
    return
  }
  if (event.target.dataset.commentEdit) {
    // Like the popup's composer: Enter saves, Shift+Enter adds a line, Esc cancels.
    if (event.key === 'Escape') {
      event.preventDefault()
      ui.editingComment = null
      render()
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      saveCommentEdit(event.target.dataset.commentEdit)
    }
    return
  }
  if (event.key !== 'Enter') return
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

function saveSummary() {
  const area = app.querySelector('textarea[data-draft="summary"]')
  if (!area || !state || !state.plan) return
  const text = area.value.replace(/\r\n?/g, '\n').trimEnd()
  ui.editingSummary = false
  if (text !== (state.plan.summary || '')) {
    if (staleMod()) return toast(L('staleMod'))
    run({ type: 'editSummary', text })
  }
  render()
}

function focusEnd(area) {
  if (!area) return
  area.focus({ preventScroll: true })
  area.setSelectionRange(area.value.length, area.value.length)
}

/** Saves the edited text of a pending comment; an empty or unchanged text only closes the editor. */
function saveCommentEdit(id) {
  const area = app.querySelector(`textarea[data-comment-edit="${id}"]`)
  const comment = state && state.comments.find(one => one.id === id)
  const text = area ? area.value.trim() : ''
  if (area && comment && text && text !== comment.text) {
    if (staleMod()) return toast(L('staleMod'))
    run({ type: 'editComment', id, text })
  }
  ui.editingComment = null
  render()
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
    case 'edit-summary':
      ui.editingSummary = true
      render()
      app.querySelector('textarea[data-draft="summary"]')?.focus()
      break
    case 'cancel-summary':
      ui.editingSummary = false
      render()
      break
    case 'save-summary':
      saveSummary()
      break
    case 'toggle-highlight':
      ui.highlight = !ui.highlight
      store('plan-crutches-highlight', ui.highlight ? '1' : '0')
      render()
      break
    case 'compare-version-button':
      ui.highlight = true
      store('plan-crutches-highlight', '1')
      ui.tab = 'changes'
      run({ type: 'compareWith', version: Number(data.version) })
      render()
      break
    case 'view-version':
      ui.tab = 'changes'
      run({ type: 'viewVersion', version: Number(data.version) })
      break
    case 'view-current':
      run({ type: 'viewVersion', version: null })
      break
    case 'restore-version':
      if (staleMod()) return toast(L('staleMod'))
      if (window.confirm(L('restoreConfirm', { n: data.version }))) run({ type: 'restoreVersion', version: Number(data.version) })
      break
    case 'ok-toggle':
      if (staleMod()) return toast(L('staleMod'))
      run({ type: 'setOk', paths: [data.path], ok: data.ok !== 'off' })
      break
    case 'collapse-all':
      ui.collapsed = new Set(allDirKeys(buildTree(shownPlan().files)))
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
    case 'edit-comment':
      ui.editingComment = data.id
      render()
      focusEnd(app.querySelector(`textarea[data-comment-edit="${data.id}"]`))
      break
    case 'cancel-comment-edit':
      ui.editingComment = null
      render()
      break
    case 'save-comment-edit':
      saveCommentEdit(data.id)
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
