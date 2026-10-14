import type { Canvas, PlanFile, PlanModel, PlanSymbol, ReviewComment } from '../types'

export const BLOCK_SCHEMA = `\`\`\`plan-crutches
{
  "title": "Short plan title",
  "summary": "Markdown. What changes and why, for a reviewer. Under 9000 characters.",
  "task": { "source": "jira" | "user", "key": "ABC-123 (Jira only)", "title": "task title", "text": "the task text verbatim, as the user or Jira gave it" },
  "files": [
    {
      "path": "relative/path/to/file.ts",
      "status": "new" | "modified" | "deleted",
      "description": "What changes in this file and why.",
      "symbols": [
        {
          "name": "functionName",
          "kind": "function" | "method" | "class" | "type" | "const" | "other",
          "signature": "the full signature, no body (several lines allowed)",
          "description": "What it does, one or two sentences.",
          "anchor": "where it goes: after existingName | before existingName | top of file | end of file"
        }
      ]
    }
  ]
}
\`\`\``

export const PLAN_BLOCK_INSTRUCTIONS = `<plan-crutches>
Plan Crutches is installed: the user reviews your plan in a visual pane built from a structured block.
When you write the plan file, END it with exactly one fenced code block whose info string is plan-crutches and whose body is valid JSON (no comments, no trailing commas) of this shape:

${BLOCK_SCHEMA}

Rules for the block:
- List every file the plan creates, changes or deletes. A deleted file has an empty symbols list.
- Give signatures only, never implementations. Methods of a changed class are separate symbols with kind "method".
- Put the task text in "task.text" verbatim: the Jira issue text when you fetched one (source "jira", with its key), else the user's request (source "user").
- Keep the Markdown plan above the block as you normally write it.

Review protocol:
- When ExitPlanMode answers that the plan is under review, stop: end your turn with one short sentence and wait. Do not call ExitPlanMode again and do not change the plan until the user's next message.
- When the user's next message carries review comments, update the plan file (both the Markdown and the block), then call ExitPlanMode again.
- When the user's next message approves the plan, call ExitPlanMode again right away.
</plan-crutches>`

export const PLAN_BLOCK_REMINDER =
  'Plan Crutches: end the plan file with the ```plan-crutches JSON block (title, summary, task, files with status and symbol signatures). Wait after ExitPlanMode reports the plan is under review.'

export function denyMessage(version: number): string {
  return (
    `Plan Crutches: plan version ${version} is now open for the user's review in the Plan Review pane. ` +
    'Do not call ExitPlanMode again and do not change the plan now. End your turn with one short sentence saying the plan awaits review. ' +
    "The user's decision arrives as the next user message: either review comments (then update the plan file and call ExitPlanMode again) or an approval (then call ExitPlanMode again)."
  )
}

export const EXTRACTION_SYSTEM =
  'You convert a Markdown implementation plan into a JSON object for a code review tool. Answer with the JSON object only, no prose, no code fence.'

export function extractionPrompt(markdown: string): string {
  return (
    'Read the plan below and produce JSON of exactly this shape:\n\n' +
    BLOCK_SCHEMA.replace(/```plan-crutches\n|\n```$/g, '') +
    '\n\nRules: list every file the plan creates, changes or deletes with its status; give signatures only, never bodies; ' +
    'copy the task text verbatim when the plan states it, else leave task.text empty with source "none"; keep summary to the essentials.\n\n' +
    '<plan>\n' +
    markdown.slice(0, 60000) +
    '\n</plan>'
  )
}

export const BODY_SYSTEM =
  'You are a senior engineer implementing one symbol of a planned change. Answer with one fenced code block holding only that symbol with its implementation, in the language of the file. No prose outside the block.'

export function bodyPrompt(plan: PlanModel, file: PlanFile, symbol: PlanSymbol, fileText: string | null): string {
  const parts = [
    `Plan: ${plan.title}`,
    `Plan summary:\n${plan.summary.slice(0, 6000)}`,
    `File: ${file.path} (${file.status})`,
    `What changes in this file: ${file.description}`,
    `Other symbols planned for this file:\n${file.symbols
      .filter(one => one.name !== symbol.name)
      .map(one => `- ${one.signature.split('\n')[0]}`)
      .join('\n') || '- none'}`,
  ]
  if (fileText) parts.push(`Current content of the file (may be cut):\n\`\`\`\n${fileText.slice(0, 14000)}\n\`\`\``)
  parts.push(`Implement this symbol:\nSignature:\n${symbol.signature}\nWhat it does: ${symbol.description}`)
  return parts.join('\n\n')
}

export function canvasText(canvas: Canvas): string {
  if (canvas.nodes.length === 0 && canvas.edges.length === 0 && canvas.strokes.length === 0) return ''
  const lines: string[] = []
  if (canvas.nodes.length) {
    lines.push('Nodes:')
    for (const node of canvas.nodes) lines.push(`- ${node.id}: ${node.label || '(unnamed)'}`)
  }
  if (canvas.edges.length) {
    lines.push('Edges:')
    for (const edge of canvas.edges) {
      const from = canvas.nodes.find(node => node.id === edge.from)?.label ?? edge.from
      const to = canvas.nodes.find(node => node.id === edge.to)?.label ?? edge.to
      lines.push(`- ${from} -> ${to}${edge.label ? `: ${edge.label}` : ''}`)
    }
  }
  if (canvas.strokes.length) lines.push(`Freehand strokes: ${canvas.strokes.length} (see the SVG file).`)
  return lines.join('\n')
}

function commentLine(comment: ReviewComment): string {
  const where: string[] = []
  if (comment.target.symbol) where.push(`symbol ${comment.target.symbol}`)
  if (comment.target.selection) where.push(`selected code: "${comment.target.selection.slice(0, 300).replace(/\s+/g, ' ')}"`)
  const prefix = where.length ? `[${where.join('; ')}] ` : ''
  return `  - ${prefix}${comment.text}`
}

export function revisionPrompt(plan: PlanModel, comments: readonly ReviewComment[], canvas: Canvas, version: number, svgPath?: string): string {
  const planLevel = comments.filter(one => !one.target.path)
  const byPath = new Map<string, ReviewComment[]>()
  for (const comment of comments) {
    if (!comment.target.path) continue
    const list = byPath.get(comment.target.path) ?? []
    list.push(comment)
    byPath.set(comment.target.path, list)
  }
  const sections: string[] = [
    `Plan review (Plan Crutches), plan version ${version} of "${plan.title}". Revise the plan per the comments below, update the plan file (the Markdown and the plan-crutches block), then call ExitPlanMode again.`,
  ]
  if (planLevel.length) {
    sections.push('Comments on the whole plan:\n' + planLevel.map(one => `- ${one.text}`).join('\n'))
  }
  if (byPath.size) {
    const blocks: string[] = []
    for (const [path, list] of byPath) {
      const isFolder = path.endsWith('/')
      const file = plan.files.find(one => one.path === path)
      const status = isFolder ? ' (folder)' : file ? ` (${file.status})` : ''
      blocks.push(`- ${path}${status}\n${list.map(commentLine).join('\n')}`)
    }
    sections.push('Comments by file:\n' + blocks.join('\n'))
  }
  const diagram = canvasText(canvas)
  if (diagram) {
    sections.push('Architecture the user drew (nodes and edges):\n' + diagram + (svgPath ? `\nSVG: ${svgPath}` : ''))
  }
  return sections.join('\n\n')
}

export function approvePrompt(version: number): string {
  return `Plan review (Plan Crutches): the user approved plan version ${version} without comments. Call ExitPlanMode now to proceed to implementation.`
}

export function askPrompt(plan: PlanModel, question: string, focus?: string): string {
  const where = focus ? `The user is looking at ${focus}. ` : ''
  return (
    `Plan Crutches question about the plan "${plan.title}" currently under review. ${where}` +
    'Answer briefly in the language of the question, from the plan and the project you already know. Do not change the plan and do not call tools.\n\n' +
    `Question: ${question}`
  )
}
