import type { CommentTarget, GeneratedBody, PlanFile, PlanModel, PlanSymbol, QaItem, ReviewComment } from '../types'

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
          "change": "new" | "modified" | "deleted",
          "signature": "the full signature, no body (several lines allowed)",
          "description": "What it does, one or two sentences.",
          "anchor": "for a new symbol, where it goes: after existingName | before existingName | top of file | end of file"
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
- List every symbol the plan touches in a modified file, with "change": "new" for one that does not exist yet, "modified" for an existing one whose signature or body changes, "deleted" for an existing one that goes away. Use the exact name the file declares today for modified and deleted symbols. A deleted symbol needs only name, kind and a short description.
- Give signatures only, never implementations. Methods of a changed class are separate symbols with kind "method".
- Put the task text in "task.text" verbatim: the Jira issue text when you fetched one (source "jira", with its key), else the user's request (source "user").
- Keep the Markdown plan above the block as you normally write it.

Review protocol:
- When ExitPlanMode answers that the plan is under review, stop: end your turn with one short sentence and wait. Do not call ExitPlanMode again and do not change the plan until the user's next message.
- When the user's next message carries review comments, update the plan file (both the Markdown and the block), then call ExitPlanMode again.
- When the user's next message approves the plan, call ExitPlanMode again right away.
</plan-crutches>`

export const PLAN_BLOCK_REMINDER =
  'Plan Crutches: end the plan file with the ```plan-crutches JSON block (title, summary, task, files with status and symbols with change new/modified/deleted and signatures). Wait after ExitPlanMode reports the plan is under review.'

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
    '\n\nRules: list every file the plan creates, changes or deletes with its status; list every symbol the plan touches with its change (new, modified or deleted); give signatures only, never bodies; ' +
    'copy the task text verbatim when the plan states it, else leave task.text empty with source "none"; keep summary to the essentials.\n\n' +
    '<plan>\n' +
    markdown.slice(0, 60000) +
    '\n</plan>'
  )
}

export const BODY_SYSTEM =
  'You are a senior engineer implementing one symbol of a planned change. ' +
  'The whole plan, the code already generated for its other symbols and the real project files are given: ' +
  'call the planned symbols by the exact names and signatures the plan gives, reuse the helpers that exist in the project files, ' +
  'and keep the logic consistent with the generated code and the plan summary. ' +
  'Answer with one fenced code block holding only that symbol with its implementation, in the language of the file. No prose outside the block.'

/** Caps of the body prompt, in characters. */
export const BODY_LIMITS = {
  summary: 8000,
  surface: 30000,
  bodies: 40000,
  currentFile: 24000,
  currentSymbol: 12000,
  relatedFile: 10000,
  relatedTotal: 60000,
  fileList: 3500,
}

function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (cut, ${text.length - limit} more characters)` : text
}

function changeTag(symbol: PlanSymbol): string {
  return symbol.change && symbol.change !== 'new' ? `, ${symbol.change}` : ''
}

/**
 * The whole plan as an API surface: every file with its status and description,
 * every symbol with its full signature and description. Stable across the
 * symbols of one plan version, so it opens the prompt and can be cached.
 */
export function planSurface(plan: PlanModel, limit = BODY_LIMITS.surface): string {
  const lines: string[] = [`Plan: ${plan.title}`, '', `Plan summary:\n${cut(plan.summary, BODY_LIMITS.summary)}`, '', 'All planned files and symbols:']
  for (const file of plan.files) {
    lines.push(`- ${file.path} (${file.status})${file.description ? `: ${file.description}` : ''}`)
    for (const symbol of file.symbols) {
      lines.push(`  - [${symbol.kind}${changeTag(symbol)}] ${symbol.name}${symbol.anchor ? ` (${symbol.anchor})` : ''}`)
      for (const part of symbol.signature.split('\n')) lines.push(`      ${part}`)
      if (symbol.description) lines.push(`      ${symbol.description}`)
    }
  }
  return cut(lines.join('\n'), limit)
}

/** Already generated implementations, the current file's own first. */
export function generatedBodiesText(bodies: Record<string, GeneratedBody>, exceptKey: string, ownPath: string, limit = BODY_LIMITS.bodies): string {
  const ready = Object.entries(bodies)
    .filter(([key, body]) => key !== exceptKey && body.status === 'ready' && body.code)
    .sort(([a], [b]) => Number(b.startsWith(`${ownPath}#`)) - Number(a.startsWith(`${ownPath}#`)))
  if (ready.length === 0) return ''
  const blocks: string[] = []
  let used = 0
  for (const [key, body] of ready) {
    const [path, symbol] = key.split('#')
    const block = `// ${path} · ${symbol}\n${body.code ?? ''}`
    if (used + block.length > limit) {
      blocks.push(`// … ${ready.length - blocks.length} more generated symbols not shown`)
      break
    }
    blocks.push(block)
    used += block.length
  }
  return `Implementations already generated for other planned symbols (match their names, signatures and behavior):\n\`\`\`\n${blocks.join('\n\n')}\n\`\`\``
}

export type RelatedFile = { path: string; text: string; why: string }

export function relatedFilesText(files: readonly RelatedFile[], limit = BODY_LIMITS.relatedTotal): string {
  if (files.length === 0) return ''
  const blocks: string[] = []
  let used = 0
  for (const file of files) {
    const text = cut(file.text, BODY_LIMITS.relatedFile)
    const block = `${file.path} (${file.why}):\n\`\`\`\n${text}\n\`\`\``
    if (used + block.length > limit) {
      blocks.push(`… ${files.length - blocks.length} more files not shown`)
      break
    }
    blocks.push(block)
    used += block.length
  }
  return `Current content of related project files:\n\n${blocks.join('\n\n')}`
}

export type BodyContext = {
  plan: PlanModel
  file: PlanFile
  symbol: PlanSymbol
  fileText: string | null
  bodies: Record<string, GeneratedBody>
  related: readonly RelatedFile[]
  /** For a modified symbol: its code as the file holds it today. */
  currentCode?: string | null
}

/**
 * The prompt that asks for one symbol's implementation. The plan surface is
 * the first block and marked for the prompt cache: it is the same for every
 * symbol of one plan version.
 */
export function bodyPrompt(context: BodyContext): { text: string; cache?: true }[] {
  const { plan, file, symbol, fileText, bodies, related } = context
  const own = file.symbols
    .filter(one => one.name !== symbol.name)
    .map(one => `- ${one.signature.split('\n')[0]}${one.change && one.change !== 'new' ? ` (${one.change})` : ''}`)
    .join('\n')
  const parts = [
    `File: ${file.path} (${file.status})`,
    `What changes in this file: ${file.description}`,
    `Other symbols planned for this file:\n${own || '- none'}`,
  ]
  const generated = generatedBodiesText(bodies, `${file.path}#${symbol.name}`, file.path)
  if (generated) parts.push(generated)
  const relatedText = relatedFilesText(related)
  if (relatedText) parts.push(relatedText)
  if (fileText) parts.push(`Current content of ${file.path}:\n\`\`\`\n${cut(fileText, BODY_LIMITS.currentFile)}\n\`\`\``)
  if (symbol.change === 'modified') {
    const current = context.currentCode ? `Its code today, which your implementation replaces:\n\`\`\`\n${cut(context.currentCode, BODY_LIMITS.currentSymbol)}\n\`\`\`\n` : ''
    parts.push(
      `Modify this existing symbol: write its whole new implementation, keep the behavior the plan does not change, and keep the planned signature.\n${current}` +
        `Signature:\n${symbol.signature}\nWhat changes: ${symbol.description}`,
    )
  } else {
    parts.push(`Implement this symbol:\nSignature:\n${symbol.signature}\nWhat it does: ${symbol.description}`)
  }
  return [{ text: `${planSurface(plan)}\n\n`, cache: true }, { text: parts.join('\n\n') }]
}

export const PICK_FILES_SYSTEM =
  'You pick which project files an engineer must read before implementing one symbol of a plan. Answer with a JSON array of relative file paths taken from the list, nothing else. An empty array is a valid answer.'

/** Asks a cheap model which project files the implementation needs to see. */
export function pickFilesPrompt(plan: PlanModel, file: PlanFile, symbol: PlanSymbol, fileText: string | null, fileList: readonly string[], already: readonly string[]): string {
  const list = fileList.join('\n')
  const parts = [
    planSurface(plan, 12000),
    `Symbol to implement: ${symbol.name} in ${file.path} (${file.status}).\nSignature:\n${symbol.signature}\nWhat it does: ${symbol.description}`,
  ]
  if (fileText) parts.push(`Current content of ${file.path}:\n\`\`\`\n${cut(fileText, 6000)}\n\`\`\``)
  if (already.length) parts.push(`Already provided, do not list again:\n${already.map(path => `- ${path}`).join('\n')}`)
  parts.push(
    `Project files (${fileList.length}):\n${cut(list, BODY_LIMITS.fileList)}\n\n` +
      'List up to 8 paths from this list whose content the engineer needs: the types and helpers the symbol uses, ' +
      'the callers it must fit, the modules it imports. Only existing paths from the list, most useful first. JSON array only.',
  )
  return parts.join('\n\n')
}

/** The paths of a model reply to pickFilesPrompt that exist in `known`. */
export function parseFileList(reply: string, known: ReadonlySet<string>, max = 8): string[] {
  const match = reply.match(/\[[\s\S]*?\]/)
  if (!match) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const path = item.trim().replace(/^\.\//, '')
    if (known.has(path) && !out.includes(path)) out.push(path)
    if (out.length >= max) break
  }
  return out
}

/** Relative imports of a source file, as written (`./x`, `../y/z`). */
export function relativeImports(text: string): string[] {
  const out = new Set<string>()
  const patterns = [
    /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /^\s*from\s+(\.+[\w.]*)\s+import\b/gm,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1]
      if (spec) out.add(spec)
    }
  }
  return [...out]
}

/** Project paths an import could mean, for the extensions that are usual. */
export function importCandidates(fromPath: string, spec: string): string[] {
  const dir = fromPath.split('/').slice(0, -1)
  let parts: string[]
  if (/^\.+[\w.]*$/.test(spec) && !spec.includes('/')) {
    // Python: `from ..pkg.mod import x` -> up one per extra dot, then the module path
    const dots = spec.match(/^\.+/)?.[0].length ?? 1
    const module = spec.slice(dots)
    parts = [...dir.slice(0, dir.length - (dots - 1)), ...(module ? module.split('.') : [])]
    return module ? [`${parts.join('/')}.py`, `${parts.join('/')}/__init__.py`] : [`${parts.join('/')}/__init__.py`]
  }
  parts = [...dir]
  for (const piece of spec.split('/')) {
    if (piece === '.' || piece === '') continue
    if (piece === '..') parts.pop()
    else parts.push(piece)
  }
  const base = parts.join('/')
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.php', '.swift', '.vue', '.svelte']
  const candidates = extensions.map(ext => `${base}${ext}`)
  for (const ext of ['.ts', '.tsx', '.js', '.mjs']) candidates.push(`${base}/index${ext}`)
  return candidates.filter(path => !path.includes('//'))
}

function commentLine(comment: ReviewComment): string {
  const where: string[] = []
  if (comment.target.symbol) where.push(`symbol ${comment.target.symbol}`)
  if (comment.target.selection) where.push(`selected code: "${comment.target.selection.slice(0, 300).replace(/\s+/g, ' ')}"`)
  const prefix = where.length ? `[${where.join('; ')}] ` : ''
  return `  - ${prefix}${comment.text}`
}

/** What the review adds to a revision or approval prompt beyond the comments. */
export type ReviewNotes = {
  /** The files the user marked OK: reviewed, no change wanted. */
  okPaths?: readonly string[]
  /** Whether the user edited the summary text in the plan file in this version. */
  summaryEdited?: boolean
}

function summaryEditedNote(): string {
  return 'The user edited the plan text (the summary) directly in the plan file. The file already holds that edit: keep the user\'s wording and build on it.'
}

export function revisionPrompt(plan: PlanModel, comments: readonly ReviewComment[], version: number, notes: ReviewNotes = {}): string {
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
  if (notes.summaryEdited) sections.push(summaryEditedNote())
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
  if (notes.okPaths && notes.okPaths.length) {
    sections.push('Files the user marked as reviewed OK (no change wanted there; change them only when a comment above requires it):\n' + notes.okPaths.map(path => `- ${path}`).join('\n'))
  }
  return sections.join('\n\n')
}

export function approvePrompt(version: number, notes: ReviewNotes = {}): string {
  const base = `Plan review (Plan Crutches): the user approved plan version ${version} without comments.`
  if (notes.summaryEdited) return `${base} ${summaryEditedNote()} Read the plan file again, then call ExitPlanMode to proceed to implementation.`
  return `${base} Call ExitPlanMode now to proceed to implementation.`
}

/** Where a question's selection came from, for the prompts and the record. */
export function describeQaTarget(target: CommentTarget | undefined): string {
  if (!target) return ''
  const parts: string[] = []
  if (target.path) parts.push(target.path.endsWith('/') ? `folder ${target.path}` : target.path)
  if (target.symbol) parts.push(`symbol ${target.symbol}`)
  if (target.lines) parts.push(`lines ${target.lines[0]}${target.lines[1] !== target.lines[0] ? `-${target.lines[1]}` : ''}`)
  return parts.join(', ')
}

function selectionContext(target: CommentTarget | undefined): string {
  if (!target?.selection) return ''
  const where = describeQaTarget(target)
  return `The user selected this text${where ? ` in ${where}` : ''}:\n"""\n${target.selection.slice(0, 4000)}\n"""\n\n`
}

/**
 * How much of the plan an answer sees. The fork runs over the session's
 * transcript, which may not hold the plan (a resumed or compacted session,
 * the demo plan), so the prompt carries the plan itself; this tail of a fork
 * is never cached, so it stays bounded.
 */
const ASK_SURFACE_LIMIT = 16000

export function askPrompt(plan: PlanModel, question: string, focus?: string, target?: CommentTarget): string {
  const where = focus && !target?.path ? `The user is looking at ${focus}. ` : ''
  return (
    `Plan Crutches question about the plan "${plan.title}" currently under review. ${where}` +
    'Answer briefly in the language of the question, from the plan below and the project you already know. Do not change the plan and do not call tools.\n\n' +
    `${planSurface(plan, ASK_SURFACE_LIMIT)}\n\n` +
    selectionContext(target) +
    `Question: ${question}`
  )
}

/** The follow-up prompt: the thread so far, then the new question. */
export function askMorePrompt(plan: PlanModel, item: QaItem, question: string): string {
  const turns: string[] = [`User: ${item.question}`, `Assistant: ${item.answer ?? '(no answer)'}`]
  for (const followup of item.followups ?? []) {
    if (followup.status === 'asking') continue
    turns.push(`User: ${followup.question}`)
    turns.push(`Assistant: ${followup.answer ?? '(no answer)'}`)
  }
  return (
    `Plan Crutches follow-up question about the plan "${plan.title}" currently under review. ` +
    'Continue the conversation below. Answer briefly in the language of the question, from the plan below and the project you already know. Do not change the plan and do not call tools.\n\n' +
    `${planSurface(plan, ASK_SURFACE_LIMIT)}\n\n` +
    selectionContext(item.target) +
    `Conversation so far:\n${turns.join('\n\n')}\n\nUser: ${question}`
  )
}

/**
 * The prompt of the popup's Explain tab: what the place the user points at
 * is, where it sits in the project and why the plan makes the change.
 * `fileText` is the current file when the mod has it, for the "where".
 */
export function explainPrompt(plan: PlanModel, target: CommentTarget, focus?: string, fileText?: string | null, lang: 'en' | 'uk' = 'en'): string {
  const where = describeQaTarget(target) || focus || 'the whole plan'
  const file = target.path ? plan.files.find(one => one.path === target.path) : undefined
  const symbol = file && target.symbol ? file.symbols.find(one => one.name === target.symbol) : undefined
  const parts = [
    `Plan Crutches: explain one place of the plan "${plan.title}" currently under review to its reviewer. ` +
      `Answer in ${lang === 'uk' ? 'Ukrainian' : 'English'}, in Markdown, under 250 words, with three short sections titled What, Where and Why: ` +
      'what this change is, where it sits in the project (the file, the symbol and what calls it or depends on it, as far as the plan and the code you know tell), and why the plan makes it (the task it serves and what would break without it). ' +
      'Do not change the plan and do not call tools.',
    planSurface(plan, ASK_SURFACE_LIMIT),
    `The place to explain: ${where}.`,
  ]
  if (file) parts.push(`Planned change of ${file.path} (${file.status}): ${file.description}`)
  if (symbol) parts.push(`Planned symbol ${symbol.name} [${symbol.kind}${changeTag(symbol)}]:\n${symbol.signature}\n${symbol.description}`)
  if (fileText) parts.push(`Current content of ${target.path}:\n\`\`\`\n${cut(fileText, 8000)}\n\`\`\``)
  const selection = selectionContext(target)
  if (selection) parts.push(selection.trimEnd())
  return parts.join('\n\n')
}

/** A question thread as text, for a comment or the Markdown record. */
export function threadText(item: QaItem, answerLimit = 1500): string {
  const lines: string[] = [`Q: ${item.question}`, `A: ${(item.answer ?? '').slice(0, answerLimit)}`]
  for (const followup of item.followups ?? []) {
    if (followup.status !== 'done') continue
    lines.push(`Q: ${followup.question}`)
    lines.push(`A: ${(followup.answer ?? '').slice(0, answerLimit)}`)
  }
  return lines.join('\n')
}
