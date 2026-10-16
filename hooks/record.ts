import type { Diagram, OkMark, PlanModel, PlanVersion, QaItem, Review, ReviewComment } from '../types'
import { diagramText } from './diagram'
import { slugify } from './paths'
import { describeQaTarget, threadText } from './prompts'

export { slugify }

export function recordFileName(nowMs: number, plan: PlanModel): string {
  const date = new Date(nowMs).toISOString().slice(0, 10)
  const key = plan.task.key ? `${plan.task.key.toLowerCase()}-` : ''
  return `${date}-${key}${slugify(plan.title)}.md`
}

function commentLine(comment: ReviewComment): string {
  const where: string[] = []
  if (comment.target.path) where.push(comment.target.path)
  if (comment.target.symbol) where.push(`#${comment.target.symbol}`)
  if (comment.target.selection) where.push(`"${comment.target.selection.slice(0, 120).replace(/\s+/g, ' ')}"`)
  const place = where.length ? `${where.join(' ')}: ` : ''
  const state = comment.resolvedInVersion
    ? ` (resolved in v${comment.resolvedInVersion})`
    : comment.sentInVersion !== undefined
      ? ' (sent)'
      : ''
  return `- ${place}${comment.text}${state}`
}

function versionLine(entry: PlanVersion): string {
  const how = entry.source === 'restored' ? ` restored from v${entry.from ?? '?'}` : entry.source === 'edited' ? ' edited by the user' : ' received'
  return `- v${entry.version}${how} ${entry.receivedAt}: ${entry.title}, ${entry.fileCount} files${entry.path ? ` (${entry.path})` : ''}`
}

/** The Markdown record of a reviewed plan, rewritten whole on every change. */
export function renderRecord(args: {
  plan: PlanModel
  review: Review
  comments: readonly ReviewComment[]
  diagram?: Diagram
  qa?: readonly QaItem[]
  ok?: Readonly<Record<string, OkMark>>
  versions?: readonly PlanVersion[]
  nowMs: number
}): string {
  const { plan, review, comments, nowMs } = args
  const qa = args.qa ?? []
  const ok = args.ok ?? {}
  const out: string[] = []
  out.push(`# ${plan.title}`)
  out.push('')
  out.push(`Status: ${review.status} | Version: ${review.version} | Updated: ${new Date(nowMs).toISOString()}`)
  if (review.planFilePath) out.push(`Plan file: ${review.planFilePath}`)
  out.push(`Structure source: ${review.parsedFrom}`)
  if (review.summaryEditedInVersion !== undefined) out.push(`Summary edited by the user in v${review.summaryEditedInVersion}`)
  out.push('')
  out.push('## Task')
  out.push('')
  if (plan.task.text) {
    const source = plan.task.source === 'jira' ? `Jira${plan.task.key ? ` ${plan.task.key}` : ''}` : 'the user'
    out.push(`Source: ${source}${plan.task.title ? ` | ${plan.task.title}` : ''}`)
    out.push('')
    out.push(plan.task.text)
  } else {
    out.push('No task text was captured.')
  }
  out.push('')
  out.push('## Summary')
  out.push('')
  out.push(plan.summary)
  out.push('')
  out.push('## Changes')
  out.push('')
  if (plan.files.length === 0) out.push('No structured file list.')
  for (const file of plan.files) {
    const mark = ok[file.path] ? ` (OK in v${ok[file.path]?.version})` : ''
    out.push(`- [${file.status}] ${file.path}${mark}${file.description ? ` — ${file.description}` : ''}`)
    for (const symbol of file.symbols) {
      const signature = symbol.signature.split('\n')[0] ?? symbol.name
      const change = symbol.change && symbol.change !== 'new' ? `[${symbol.change}] ` : ''
      out.push(`  - ${change}\`${signature}\`${symbol.description ? ` — ${symbol.description}` : ''}`)
    }
  }
  out.push('')
  out.push('## Review comments')
  out.push('')
  if (comments.length === 0) out.push('None.')
  const versions = [...new Set(comments.map(one => one.createdInVersion))].sort((a, b) => a - b)
  for (const version of versions) {
    out.push(`### Version ${version}`)
    out.push('')
    for (const comment of comments.filter(one => one.createdInVersion === version)) out.push(commentLine(comment))
    out.push('')
  }
  const answered = qa.filter(item => item.status === 'done')
  if (answered.length) {
    out.push('## Questions')
    out.push('')
    for (const item of answered) {
      const where = describeQaTarget(item.target) || item.focus || ''
      out.push(`### ${item.question.split('\n')[0]?.slice(0, 120) ?? 'Question'}${where ? ` (${where})` : ''}`)
      out.push('')
      if (item.target?.selection) {
        out.push('> ' + item.target.selection.slice(0, 600).split('\n').join('\n> '))
        out.push('')
      }
      out.push(threadText(item, 4000))
      out.push('')
    }
  }
  const diagram = diagramText(args.diagram?.graph)
  if (diagram) {
    out.push('## Diagram')
    out.push('')
    out.push(`Generated for version ${args.diagram?.version ?? review.version}${review.diagramSvgPath ? ` | SVG: ${review.diagramSvgPath}` : ''}`)
    out.push('')
    out.push(diagram)
    out.push('')
  }
  if (review.warnings.length) {
    out.push('## Warnings')
    out.push('')
    for (const warning of review.warnings) out.push(`- ${warning}`)
    out.push('')
  }
  if (args.versions && args.versions.length) {
    out.push('## Versions')
    out.push('')
    for (const entry of args.versions) out.push(versionLine(entry))
    out.push('')
  }
  out.push('## History')
  out.push('')
  for (const entry of review.history) out.push(`- ${entry}`)
  out.push('')
  return out.join('\n')
}
