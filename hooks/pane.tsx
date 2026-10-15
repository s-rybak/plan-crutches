import type { Elements, RenderElement } from 'claude-code'

import type {
  CommentTarget,
  FileCache,
  GeneratedBody,
  Lang,
  PlanFile,
  PlanModel,
  PlanSymbol,
  QaItem,
  Review,
  ReviewComment,
  UiState,
} from '../types'
import { deletedDiff, newFileStub, stubDiff } from './diff'
import { otherLang, statusLabel, t } from './i18n'
import type { StringKey } from './i18n'
import { threadText } from './prompts'
import type { SelectableProps } from './select'
import { bodyKey } from './state'
import { allDirKeys, buildTree, pathsUnder, visibleRows } from './tree'
import type { TreeNode, TreeStatus } from './tree'

/** The element constructors the pane draws with, as the surface resolved them. */
export type PaneEl = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Input' | 'Code' | 'Markdown' | 'Link'>

/** Everything the pane reads: the session state as read for this drawing. */
export type PaneModel = {
  plan: PlanModel | null
  review: Review
  comments: ReviewComment[]
  ui: UiState
  bodies: Record<string, GeneratedBody>
  qa: QaItem[]
  files: FileCache
  summaryLimit: number
  /** The review page's address with its token, once the server runs. */
  webUrl?: string
}

/** Everything the pane does: closures the hooks module made over its `$`. */
export type PaneActions = {
  setUi: (change: (ui: UiState) => UiState) => Promise<unknown>
  addComment: (target: CommentTarget, text: string) => Promise<void>
  deleteComment: (id: string) => Promise<void>
  submit: () => Promise<void>
  loadFile: (path: string) => Promise<void>
  generateBody: (file: PlanFile, symbol: PlanSymbol) => Promise<void>
  ask: (question: string, focus?: string) => Promise<void>
  commentOnSelection: (path: string) => Promise<void>
  /** Starts the review page server if needed and opens the page. */
  openWeb: () => Promise<unknown>
  /** Draws a code block whose lines the person selects with the mouse; absent where the surface has no Client. */
  selectable?: (args: { key: string; props: SelectableProps }) => RenderElement
}

type Ctx = { el: PaneEl; m: PaneModel; a: PaneActions; lang: Lang; plan: PlanModel }

const TASK_LIMIT = 6000

function colorOf(status: TreeStatus): string {
  switch (status) {
    case 'new':
      return 'diffAdded'
    case 'deleted':
      return 'diffRemoved'
    case 'modified':
      return 'warning'
    default:
      return 'subtle'
  }
}

const MAX_BLOCK_LINES = 1500
const MAX_BLOCK_CHARS = 90000

/** A code block: selectable with the mouse where the surface allows, plain Code elsewhere. */
function codeBlock(
  ctx: Ctx,
  key: string,
  source: string,
  path: string,
  format: 'source' | 'diff',
  target: { path: string; symbol?: string },
  startLine = 1,
) {
  const { Code } = ctx.el
  if (!ctx.a.selectable) return <Code source={source || ' '} path={path} format={format} />
  let lines = source.split('\n')
  if (lines.length > MAX_BLOCK_LINES) lines = [...lines.slice(0, MAX_BLOCK_LINES), '…']
  let total = 0
  const kept: string[] = []
  for (const line of lines) {
    total += line.length + 1
    if (total > MAX_BLOCK_CHARS) {
      kept.push('…')
      break
    }
    kept.push(line)
  }
  const lang = ctx.lang
  return ctx.a.selectable({
    key,
    props: {
      lines: kept,
      path,
      format,
      startLine,
      target,
      hint: t(lang, 'selectHint'),
      placeholder: t(lang, 'commentPlaceholder'),
      cancelLabel: t(lang, 'cancel'),
      selectedLabel: t(lang, 'selectedLines'),
    },
  })
}

export function withoutKeys(ui: UiState, keys: readonly (keyof UiState)[]): UiState {
  const copy: Record<string, unknown> = { ...ui }
  for (const key of keys) delete copy[key]
  return copy as UiState
}

export function pendingComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return comments.filter(one => one.sentInVersion === undefined && one.resolvedInVersion === undefined)
}

export function renderPane(el: PaneEl, m: PaneModel, a: PaneActions) {
  const { Box, Text, Button } = el
  const lang = m.ui.lang
  const toggleLang = () => a.setUi(state => ({ ...state, lang: otherLang(state.lang) }))

  if (!m.plan) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>{t(lang, 'appName')}</Text>
          <Text> </Text>
          <Button key="lang" plain onPress={toggleLang}>
            {t(lang, 'lang')}
          </Button>
        </Box>
        <Text dimColor>{t(lang, 'noPlan')}</Text>
        {renderWebRow(el, m, a, lang)}
      </Box>
    )
  }

  const ctx: Ctx = { el, m, a, lang, plan: m.plan }
  return (
    <Box flexDirection="column">
      {renderHeader(ctx, toggleLang)}
      {renderTabs(ctx)}
      {m.ui.tab === 'changes' && renderChanges(ctx)}
      {m.ui.tab === 'diagram' && <Text dimColor>{t(lang, 'comingSoon')}</Text>}
      {m.ui.tab === 'ask' && renderAsk(ctx)}
    </Box>
  )
}

function renderWebRow(el: PaneEl, m: PaneModel, a: PaneActions, lang: Lang) {
  const { Box, Text, Button, Link } = el
  return (
    <Box flexDirection="row">
      <Text dimColor>{t(lang, 'reviewPage')} </Text>
      {m.webUrl ? <Link href={m.webUrl} label={m.webUrl} /> : <Text dimColor>{t(lang, 'pageDown')}</Text>}
      <Text> </Text>
      <Button key="open-web" plain onPress={() => a.openWeb()}>
        {t(lang, 'openPage')}
      </Button>
    </Box>
  )
}

function renderHeader(ctx: Ctx, toggleLang: () => Promise<unknown>) {
  const { el, lang, plan, m, a } = ctx
  const { Box, Text, Button } = el
  const { review, comments } = m
  const pending = pendingComments(comments).length
  const statusKey = `status_${review.status}` as StringKey
  let action
  if (review.status === 'reviewing') {
    action = (
      <Button key="submit" variant="primary" onPress={() => a.submit()}>
        {pending > 0 ? t(lang, 'submitWith', { n: pending }) : t(lang, 'approve')}
      </Button>
    )
  } else if (review.status === 'revising') {
    action = <Text dimColor>{t(lang, 'revisingNote')}</Text>
  } else if (review.status === 'approved') {
    action = <Text color="success">{t(lang, 'approvedNote')}</Text>
  } else {
    action = null
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text bold>{t(lang, 'appName')}</Text>
          <Text> · {plan.title} </Text>
        </Box>
        <Button key="lang" plain onPress={toggleLang}>
          {t(lang, 'lang')}
        </Button>
      </Box>
      <Text dimColor>
        {t(lang, 'version')}
        {review.version} · {t(lang, statusKey)} · {comments.length} {t(lang, 'comments')}
        {review.isDemo ? ' · demo' : ''}
      </Text>
      <Box flexDirection="row">{action}</Box>
      {renderWebRow(el, m, a, lang)}
      {review.recordPath && (
        <Text dimColor>
          {t(lang, 'recorded')} {review.recordPath}
        </Text>
      )}
    </Box>
  )
}

function renderTabs(ctx: Ctx) {
  const { el, lang, m, a } = ctx
  const { Box, Text, Button } = el
  const tabs = ['changes', 'diagram', 'ask'] as const
  return (
    <Box flexDirection="row">
      {tabs.map(tab => (
        <Button key={`tab:${tab}`} plain onPress={() => a.setUi(state => ({ ...state, tab }))}>
          {m.ui.tab === tab ? (
            <Text bold inverse> {t(lang, `tab_${tab}`)} </Text>
          ) : (
            <Text dimColor> {t(lang, `tab_${tab}`)} </Text>
          )}
        </Button>
      ))}
    </Box>
  )
}

function renderChanges(ctx: Ctx) {
  const { el, m, plan } = ctx
  const { Box } = el
  if (m.ui.view === 'file' && m.ui.selected) {
    const file = plan.files.find(one => `file:${one.path}` === m.ui.selected)
    if (file) return renderFileView(ctx, file)
  }
  return (
    <Box flexDirection="column">
      {renderTask(ctx)}
      {renderSummary(ctx)}
      {renderTree(ctx)}
      {renderWarnings(ctx)}
    </Box>
  )
}

function renderTask(ctx: Ctx) {
  const { el, lang, plan, m, a } = ctx
  const { Box, Text, Button, Markdown } = el
  const task = plan.task
  const label =
    task.source === 'jira'
      ? `${t(lang, 'taskFromJira')}${task.key ? ` · ${task.key}` : ''}`
      : task.source === 'user'
        ? t(lang, 'taskFromUser')
        : t(lang, 'task')
  const toggle = () => a.setUi(state => ({ ...state, showTask: !state.showTask }))
  const text = task.text.length > TASK_LIMIT ? `${task.text.slice(0, TASK_LIMIT)}\n\n…` : task.text
  return (
    <Box flexDirection="column">
      <Button key="task-toggle" plain onPress={toggle}>
        {m.ui.showTask ? '▾ ' : '▸ '}
        <Text bold>{t(lang, 'task')}</Text>
        {task.title ? ` · ${task.title}` : ''}
      </Button>
      {m.ui.showTask && (
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor>{label}</Text>
          {task.text ? <Markdown text={text} /> : <Text dimColor>{t(lang, 'taskNone')}</Text>}
        </Box>
      )}
    </Box>
  )
}

function renderCommentInput(ctx: Ctx, inputKey: string, target: CommentTarget) {
  const { el, lang, a } = ctx
  const { Input } = el
  return <Input key={inputKey} placeholder={t(lang, 'commentPlaceholder')} autoFocus onSubmit={value => a.addComment(target, value.trim())} />
}

function renderCommentList(ctx: Ctx, list: readonly ReviewComment[]) {
  const { el, lang, a } = ctx
  const { Box, Text, Button } = el
  if (list.length === 0) return null
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {list.map(comment => (
        <Box flexDirection="row">
          <Text color="suggestion">┆ </Text>
          <Text>{comment.text}</Text>
          {comment.target.lines ? (
            <Text dimColor> ({t(lang, 'lines')} {comment.target.lines[0]}-{comment.target.lines[1]})</Text>
          ) : comment.target.selection ? (
            <Text dimColor> ({t(lang, 'selection')})</Text>
          ) : null}
          {comment.resolvedInVersion !== undefined ? (
            <Text dimColor> · {t(lang, 'resolved', { n: comment.resolvedInVersion })}</Text>
          ) : comment.sentInVersion !== undefined ? (
            <Text dimColor> · {t(lang, 'sent')}</Text>
          ) : (
            <Button key={`del:${comment.id}`} plain dimColor onPress={() => a.deleteComment(comment.id)}>
              {' ✕'}
            </Button>
          )}
        </Box>
      ))}
    </Box>
  )
}

function renderSummary(ctx: Ctx) {
  const { el, lang, plan, m, a } = ctx
  const { Box, Text, Button, Markdown } = el
  const limit = m.summaryLimit
  const isLong = plan.summary.length > limit
  const shown = isLong && !m.ui.showFullSummary ? `${plan.summary.slice(0, limit)}\n\n…` : plan.summary
  const planComments = m.comments.filter(one => !one.target.path)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text bold>{t(lang, 'summary')}</Text>
        <Text> </Text>
        <Button key="plan-comment" plain onPress={() => a.setUi(state => ({ ...state, commenting: 'plan' }))}>
          {t(lang, 'planComment')}
        </Button>
      </Box>
      <Markdown text={shown || ' '} />
      {isLong && (
        <Button key="summary-toggle" plain onPress={() => a.setUi(state => ({ ...state, showFullSummary: !state.showFullSummary }))}>
          {m.ui.showFullSummary ? t(lang, 'showLess') : t(lang, 'showAll')}
        </Button>
      )}
      {m.ui.commenting === 'plan' && renderCommentInput(ctx, 'input:plan', {})}
      {renderCommentList(ctx, planComments)}
    </Box>
  )
}

function renderWarnings(ctx: Ctx) {
  const { el, lang, m } = ctx
  const { Box, Text } = el
  const { review } = m
  if (review.warnings.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        {t(lang, 'warnings')} ({t(lang, 'source')}: {t(lang, `parsed_${review.parsedFrom}`)})
      </Text>
      {review.warnings.slice(0, 5).map(warning => (
        <Text dimColor>- {warning}</Text>
      ))}
    </Box>
  )
}

function renderTree(ctx: Ctx) {
  const { el, lang, plan, m, a } = ctx
  const { Box, Text, Button } = el
  const roots = buildTree(plan.files)
  const collapsed = new Set(m.ui.collapsed)
  const rows = visibleRows(roots, collapsed)
  const dirKeys = allDirKeys(roots)
  const allCollapsed = dirKeys.length > 0 && dirKeys.every(key => collapsed.has(key))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text bold>{t(lang, 'changes')}</Text>
        <Text> </Text>
        <Button key="tree-toggle-all" plain dimColor onPress={() => a.setUi(state => ({ ...state, collapsed: allCollapsed ? [] : dirKeys }))}>
          {allCollapsed ? t(lang, 'expandAll') : t(lang, 'collapseAll')}
        </Button>
      </Box>
      {plan.files.length === 0 && <Text dimColor>{t(lang, 'parsed_markdown')}</Text>}
      {rows.map(node => renderTreeRow(ctx, node, collapsed))}
    </Box>
  )
}

function commentsFor(comments: readonly ReviewComment[], node: TreeNode): ReviewComment[] {
  if (node.kind === 'file') return comments.filter(one => one.target.path === node.path)
  const under = new Set(pathsUnder(node))
  const folderPath = `${node.path}/`
  return comments.filter(one => {
    const path = one.target.path
    if (!path) return false
    if (path === folderPath) return true
    if (path.endsWith('/')) return path.startsWith(folderPath)
    return under.has(path)
  })
}

function renderTreeRow(ctx: Ctx, node: TreeNode, collapsed: ReadonlySet<string>) {
  const { el, lang, m, a } = ctx
  const { Box, Text, Button } = el
  const indent = '  '.repeat(node.depth)
  const isCollapsed = collapsed.has(node.key)
  const isSelected = m.ui.selected === node.key
  const related = commentsFor(m.comments, node)
  const own =
    node.kind === 'file'
      ? related.filter(one => !one.target.symbol && !one.target.selection)
      : related.filter(one => one.target.path === `${node.path}/`)
  const select = () =>
    a.setUi(state => ({ ...withoutKeys(state, ['commenting', 'pendingSelection']), selected: isSelected ? '' : node.key, view: 'tree' as const }))
  const openFile = async () => {
    await a.setUi(state => ({ ...withoutKeys(state, ['commenting', 'pendingSelection']), selected: node.key, view: 'file' as const }))
    void a.loadFile(node.path)
  }
  const toggle = () =>
    a.setUi(state => ({
      ...state,
      collapsed: isCollapsed ? state.collapsed.filter(key => key !== node.key) : [...state.collapsed, node.key],
    }))
  const chip = node.status === 'unchanged' ? null : <Text color={colorOf(node.status)}> [{statusLabel(lang, node.status)}]</Text>
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text>{indent}</Text>
        {node.kind === 'dir' ? (
          <Button key={`toggle:${node.key}`} plain onPress={toggle}>
            {isCollapsed ? '▸ ' : '▾ '}
          </Button>
        ) : (
          <Text>{'  '}</Text>
        )}
        <Button key={`row:${node.key}`} plain onPress={node.kind === 'dir' ? select : openFile}>
          {isSelected ? <Text bold inverse>{node.name}</Text> : node.name}
          {node.kind === 'dir' ? '/' : ''}
          {chip}
          {related.length > 0 ? <Text dimColor> ({related.length})</Text> : null}
        </Button>
      </Box>
      {isSelected && node.kind === 'dir' && (
        <Box flexDirection="row" paddingLeft={node.depth * 2 + 4}>
          <Button key={`comment:${node.key}`} onPress={() => a.setUi(state => ({ ...state, commenting: node.key }))}>
            {t(lang, 'addComment')}
          </Button>
        </Box>
      )}
      {m.ui.commenting === node.key && (
        <Box paddingLeft={node.depth * 2 + 4}>{renderCommentInput(ctx, `input:${node.key}`, { path: `${node.path}/` })}</Box>
      )}
      {own.length > 0 && <Box paddingLeft={node.depth * 2 + 2}>{renderCommentList(ctx, own)}</Box>}
    </Box>
  )
}

function renderFileView(ctx: Ctx, file: PlanFile) {
  const { el, lang, m, a } = ctx
  const { Box, Text, Button } = el
  const fileComments = m.comments.filter(one => one.target.path === file.path && !one.target.symbol && !one.target.selection)
  const selectionComments = m.comments.filter(one => one.target.path === file.path && one.target.selection)
  const content = m.files[file.path]
  const back = () => a.setUi(state => ({ ...withoutKeys(state, ['commenting', 'pendingSelection']), view: 'tree' as const }))
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button key="back" plain onPress={back}>
          {`‹ ${t(lang, 'back')}`}
        </Button>
        <Text bold> {file.path}</Text>
        <Text color={colorOf(file.status)}> [{statusLabel(lang, file.status)}]</Text>
      </Box>
      {file.description && <Text>{file.description}</Text>}
      <Box flexDirection="row" marginTop={1}>
        <Button key="comment-file" onPress={() => a.setUi(state => ({ ...state, commenting: `file:${file.path}` }))}>
          {t(lang, 'commentOnFile')}
        </Button>
        <Text> </Text>
        <Button key="comment-selection" onPress={() => a.commentOnSelection(file.path)}>
          {t(lang, 'commentOnSelection')}
        </Button>
      </Box>
      {m.ui.commenting === `file:${file.path}` && renderCommentInput(ctx, 'input:file', { path: file.path })}
      {m.ui.commenting === `sel:${file.path}` && m.ui.pendingSelection && (
        <Box flexDirection="column">
          <Text dimColor>"{m.ui.pendingSelection.slice(0, 200).replace(/\s+/g, ' ')}"</Text>
          {renderCommentInput(ctx, 'input:selection', { path: file.path, selection: m.ui.pendingSelection })}
        </Box>
      )}
      {renderCommentList(ctx, [...fileComments, ...selectionComments])}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{t(lang, 'symbols')}</Text>
        {file.symbols.length === 0 && <Text dimColor>{t(lang, 'noSymbols')}</Text>}
        {file.symbols.map(symbol => renderSymbol(ctx, file, symbol))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {file.status === 'new' && (
          <Box flexDirection="column">
            <Text bold>{t(lang, 'newFileTitle')}</Text>
            {codeBlock(ctx, `sel:${file.path}:preview`, newFileStub(file), file.path, 'source', { path: file.path })}
          </Box>
        )}
        {file.status === 'modified' && (
          <Box flexDirection="column">
            <Text bold>{t(lang, 'diffTitle')}</Text>
            {content === undefined && <Text dimColor>…</Text>}
            {content === null && <Text dimColor>{t(lang, 'fileMissing')}</Text>}
            {typeof content === 'string' && codeBlock(ctx, `sel:${file.path}:diff`, stubDiff(content, file), file.path, 'diff', { path: file.path })}
          </Box>
        )}
        {file.status === 'deleted' && (
          <Box flexDirection="column">
            <Text color="diffRemoved">{t(lang, 'deletedFile')}</Text>
            {typeof content === 'string' && codeBlock(ctx, `sel:${file.path}:deleted`, deletedDiff(content), file.path, 'diff', { path: file.path })}
          </Box>
        )}
      </Box>
    </Box>
  )
}

function renderSymbol(ctx: Ctx, file: PlanFile, symbol: PlanSymbol) {
  const { el, lang, m, a } = ctx
  const { Box, Text, Button } = el
  const key = bodyKey(file.path, symbol.name)
  const isExpanded = m.ui.expanded.includes(key)
  const body = m.bodies[key]
  const own = m.comments.filter(one => one.target.path === file.path && one.target.symbol === symbol.name)
  const toggleExpand = async () => {
    if (isExpanded) {
      await a.setUi(state => ({ ...state, expanded: state.expanded.filter(one => one !== key) }))
      return
    }
    await a.setUi(state => ({ ...state, expanded: [...state.expanded, key] }))
    if (!body || body.status === 'failed') void a.generateBody(file, symbol)
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text bold>{symbol.name}</Text>
        <Text dimColor> {symbol.kind}</Text>
      </Box>
      {codeBlock(ctx, `sel:${key}`, symbol.signature, file.path, 'source', { path: file.path, symbol: symbol.name })}
      {symbol.description && <Text dimColor>{symbol.description}</Text>}
      <Box flexDirection="row">
        <Button key={`expand:${key}`} plain onPress={toggleExpand}>
          {isExpanded ? t(lang, 'collapseImpl') : t(lang, 'expandImpl')}
        </Button>
        <Text> </Text>
        {isExpanded && body?.status === 'ready' && (
          <Button key={`regen:${key}`} plain dimColor onPress={() => a.generateBody(file, symbol)}>
            {t(lang, 'regenerate')}
          </Button>
        )}
        <Text> </Text>
        <Button key={`comment:${key}`} plain onPress={() => a.setUi(state => ({ ...state, commenting: `sym:${key}` }))}>
          {t(lang, 'addComment')}
        </Button>
      </Box>
      {isExpanded && body?.status === 'loading' && <Text dimColor>{t(lang, 'generating')}</Text>}
      {isExpanded && body?.status === 'failed' && (
        <Text color="error">
          {t(lang, 'generationFailed')}: {body.error ?? ''}
        </Text>
      )}
      {isExpanded && body?.status === 'ready' && codeBlock(ctx, `sel:${key}:body`, body.code ?? '', file.path, 'source', { path: file.path, symbol: symbol.name })}
      {m.ui.commenting === `sym:${key}` && renderCommentInput(ctx, `input:${key}`, { path: file.path, symbol: symbol.name })}
      {renderCommentList(ctx, own)}
    </Box>
  )
}

function renderAsk(ctx: Ctx) {
  const { el, lang, m, a } = ctx
  const { Box, Text, Input, Markdown, Button } = el
  const focus = m.ui.selected?.startsWith('file:') ? m.ui.selected.slice(5) : undefined
  return (
    <Box flexDirection="column">
      <Input
        key="ask"
        placeholder={t(lang, 'askPlaceholder')}
        onSubmit={value => {
          const question = value.trim()
          if (question) void a.ask(question, focus)
        }}
      />
      {m.qa
        .slice()
        .reverse()
        .map(item => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>? {item.question}</Text>
            {item.status === 'asking' && <Text dimColor>{t(lang, 'asking')}</Text>}
            {item.status === 'failed' && (
              <Text color="error">
                {t(lang, 'askFailed')}: {item.answer ?? ''}
              </Text>
            )}
            {item.status === 'done' && <Markdown text={item.answer ?? ''} />}
            {(item.followups ?? []).map(turn => (
              <Box flexDirection="column" marginLeft={2} marginTop={1}>
                <Text bold>↳ {turn.question}</Text>
                {turn.status === 'asking' && <Text dimColor>{t(lang, 'asking')}</Text>}
                {turn.status === 'failed' && (
                  <Text color="error">
                    {t(lang, 'askFailed')}: {turn.answer ?? ''}
                  </Text>
                )}
                {turn.status === 'done' && <Markdown text={turn.answer ?? ''} />}
              </Box>
            ))}
            {item.status === 'done' && (
              <Button
                key={`qa-comment:${item.id}`}
                plain
                dimColor
                onPress={() => a.addComment(item.target ?? (item.focus ? { path: item.focus } : {}), threadText(item))}
              >
                {t(lang, 'makeComment')}
              </Button>
            )}
          </Box>
        ))}
    </Box>
  )
}
