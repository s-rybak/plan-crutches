// The change diagram, the pure part: the prompts a clean session answers, the
// readers of its answers, the text search for callers and the record text.
// register.tsx runs the session and keeps the result in `$.state.diagram`.
import type { CallersQuery, DiagramCaller, DiagramEdge, DiagramFile, DiagramGraph, DiagramRef, DiagramSymbol, PlanModel, SymbolKind } from '../types'
import { extractJson } from './plan-parser'
import { planSurface } from './prompts'

/** How many callers one query shows; the rest is one "others" block. */
export const CALLERS_LIMIT = 20
/** How many text-search hits go to the session as candidates. */
export const CANDIDATE_LIMIT = 150
/** How much of the plan the graph question carries: the whole plan, within reason. */
const PLAN_TEXT_LIMIT = 120000
const FILE_TEXT_LIMIT = 16000
const FILES_TEXT_LIMIT = 150000
const KINDS: readonly SymbolKind[] = ['function', 'method', 'class', 'type', 'const', 'other']

export const DIAGRAM_AGENT_NAME = 'diagram'
export const DIAGRAM_AGENT_DESCRIPTION = 'Plan Crutches: maps the calls between the symbols of an implementation plan. Read-only; the mod spawns it, never the model.'

/** The system prompt of the clean session: it reads code and answers JSON. */
export const DIAGRAM_AGENT_PROMPT =
  'You are a code analyst in a clean session with read-only tools (Read, Grep, Glob). ' +
  'You get an implementation plan and one question about the calls between symbols. ' +
  'Read the project files when the answer depends on them; a text-search candidate list, when given, is a start, not the truth. ' +
  'Answer with one JSON object only: no prose before or after it, no code fence.'

/** The system prompt of the fallback completion, which has no tools. */
export const DIAGRAM_SYSTEM =
  'You are a code analyst. You get an implementation plan, the current text of its files and one question about the calls between symbols. ' +
  'Answer from the text given. Answer with one JSON object only: no prose, no code fence.'

const GRAPH_SHAPE = `{
  "files": [
    { "path": "relative/path.ts", "symbols": [ { "name": "symbolName", "kind": "function" | "method" | "class" | "type" | "const" | "other" } ] }
  ],
  "edges": [
    { "from": { "path": "relative/path.ts", "symbol": "caller" }, "to": { "path": "relative/other.ts", "symbol": "callee" }, "kind": "call" | "use" }
  ]
}`

const CALLERS_SHAPE = `{
  "callers": [ { "path": "relative/path.ts", "symbol": "enclosingSymbol", "kind": "function" | "method" | "class" | "type" | "const" | "other", "line": 12 } ],
  "total": 3
}`

/**
 * Test files and folders (tests/, __tests__/, spec/, e2e/, fixtures/, *.test.*,
 * *.spec.*, *_test.go, test_*.py, *Test.java …) stay out of the diagram: not as
 * blocks of the plan, not as callers.
 */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|specs?|e2e|cypress|__mocks__|__snapshots__|testdata|fixtures)(\/|$)|(^|\/)(test_[^/]*\.py|conftest\.py)$|[._-](test|spec|tests|specs)\.[a-z0-9]+$|_test\.(go|rs|py|rb|ex|exs|c|cc|cpp)$|(Test|Tests|Spec|IT)\.(java|kt|kts|cs|php|scala|swift|groovy)$|\.feature$/i

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(normalizePath(path))
}

function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (cut, ${text.length - limit} more characters)` : text
}

function filesText(texts: Readonly<Record<string, string | null>>): string {
  const blocks: string[] = []
  let used = 0
  for (const [path, text] of Object.entries(texts)) {
    if (text === null || !text.trim()) continue
    const block = `${path}:\n\`\`\`\n${cut(text, FILE_TEXT_LIMIT)}\n\`\`\``
    if (used + block.length > FILES_TEXT_LIMIT) {
      blocks.push(`… ${Object.keys(texts).length - blocks.length} more files not shown`)
      break
    }
    blocks.push(block)
    used += block.length
  }
  return blocks.length ? `Current content of the planned files that exist in the project:\n\n${blocks.join('\n\n')}` : ''
}

/**
 * The question that builds the change graph: every planned file and symbol,
 * and the calls between them. With `tools`, the session may read the project;
 * without, the planned files' text in the prompt is all it has.
 */
export function diagramPrompt(plan: PlanModel, texts: Readonly<Record<string, string | null>>, options: { tools: boolean }): string {
  const parts = [
    'Build the call graph of the implementation plan below for an architecture diagram.',
    planSurface(plan, PLAN_TEXT_LIMIT),
  ]
  const existing = filesText(texts)
  if (existing) parts.push(existing)
  parts.push(
    `Answer with JSON of exactly this shape:\n${GRAPH_SHAPE}\n\n` +
      'Rules:\n' +
      '- List every planned file with every planned symbol (same paths and names as the plan). For a deleted file, list the symbols it exports today, since other code may still use them.\n' +
      '- Skip test files and test folders (tests/, __tests__/, spec/, *.test.*, *.spec.*, fixtures): the diagram shows the production code only.\n' +
      '- An edge from A to B means A calls B (kind "call") or A uses B as a type or a constant (kind "use"). Include edges between symbols of the same file.\n' +
      '- Only edges between symbols listed in this answer. Use the plan descriptions and signatures' +
      (options.tools ? ', and read the project files to confirm calls that exist in the current code.' : ' and the file texts given above.') +
      '\n- No prose, no code fence: the JSON object only.',
  )
  return parts.join('\n\n')
}

/** One hit of the text search for a symbol, with the symbol that encloses the line. */
export type CallerCandidate = { path: string; line: number; text: string; enclosing: string; kind: SymbolKind }

/** The question that lists the callers of one symbol across the project; `root` names the folder paths are relative to. */
export function callersPrompt(plan: PlanModel, ref: DiagramRef, candidates: readonly CallerCandidate[], limit = CALLERS_LIMIT, root?: string): string {
  const planned = plan.files.find(file => file.path === ref.path)?.symbols.find(symbol => symbol.name === ref.symbol)
  const parts = [
    `Find every place in the project that calls or uses the symbol \`${ref.symbol}\` of ${ref.path}.`,
    planSurface(plan, 12000),
    `Symbol: ${ref.symbol} in ${ref.path}${planned ? `\nSignature:\n${planned.signature}\nWhat it does: ${planned.description}` : ''}`,
  ]
  if (candidates.length) {
    const lines = candidates.map(one => `${one.path}:${one.line}: ${one.text.trim().slice(0, 160)}    [in ${one.enclosing}]`)
    parts.push(`Text-search candidates (path:line: text [in enclosing symbol]):\n${lines.join('\n')}`)
  } else {
    parts.push('A text search for the name found nothing; the symbol may be new, or called under another name.')
  }
  parts.push(
    `Answer with JSON of exactly this shape:\n${CALLERS_SHAPE}\n\n` +
      'Rules:\n' +
      `- One entry per enclosing symbol (the function, method, class or constant whose body holds the use); "(module)" for a use at module level. At most ${limit} entries, the most important first.\n` +
      '- Drop false positives: the declaration itself, comments, strings, and other symbols that only share the name. An import line alone is no caller: name the function that uses the symbol. A re-export counts, as "(module)".\n' +
      '- Add callers the text search missed (re-exports, calls through an interface, other spellings).\n' +
      '- Skip uses in test files and test folders (tests/, __tests__/, spec/, *.test.*, *.spec.*, fixtures): they are not callers for this diagram.\n' +
      '- "total" is the number of distinct callers you found, including the ones beyond the limit.\n' +
      (root ? `- Write every path relative to the project folder ${root}, as the plan writes them.\n` : '') +
      '- No prose, no code fence: the JSON object only.',
  )
  return parts.join('\n\n')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const asKind = (value: unknown): SymbolKind => ((KINDS as readonly string[]).includes(asString(value)) ? (asString(value) as SymbolKind) : 'other')

export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/** A path with the first matching prefix removed (an absolute project folder, or the folder's path inside its git repository). */
export function stripPrefixes(path: string, prefixes: readonly string[]): string {
  const raw = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  for (const prefix of prefixes) {
    if (prefix && raw.startsWith(prefix)) return normalizePath(raw.slice(prefix.length))
  }
  return normalizePath(raw)
}

function readRef(raw: unknown): DiagramRef | null {
  if (!isRecord(raw)) return null
  const path = normalizePath(asString(raw.path))
  const symbol = asString(raw.symbol)
  return path && symbol ? { path, symbol } : null
}

/**
 * Turns the session's answer into the graph the page draws. The plan decides
 * the blocks and their rows: every planned file with every planned symbol,
 * whatever the answer forgot, without a cap; a deleted file takes the exports
 * the answer found. Test files stay out. Edges stay only between rows that
 * exist.
 */
export function normalizeGraph(raw: unknown, plan: PlanModel): DiagramGraph {
  const answered = new Map<string, Record<string, unknown>>()
  if (isRecord(raw) && Array.isArray(raw.files)) {
    for (const item of raw.files) {
      if (!isRecord(item)) continue
      const path = normalizePath(asString(item.path))
      if (path) answered.set(path, item)
    }
  }
  const files: DiagramFile[] = []
  for (const planned of plan.files) {
    if (isTestPath(planned.path)) continue
    const symbols: DiagramSymbol[] = planned.symbols.map(symbol => ({ name: symbol.name, kind: symbol.kind }))
    if (symbols.length === 0) {
      const found = answered.get(planned.path)
      if (found && Array.isArray(found.symbols)) {
        const seen = new Set<string>()
        for (const item of found.symbols) {
          if (!isRecord(item)) continue
          const name = asString(item.name)
          if (!name || seen.has(name)) continue
          seen.add(name)
          symbols.push({ name, kind: asKind(item.kind) })
        }
      }
    }
    files.push({ path: planned.path, status: planned.status, symbols })
  }
  const known = new Set<string>()
  for (const file of files) for (const symbol of file.symbols) known.add(`${file.path}#${symbol.name}`)
  const edges: DiagramEdge[] = []
  const seenEdges = new Set<string>()
  if (isRecord(raw) && Array.isArray(raw.edges)) {
    for (const item of raw.edges) {
      if (!isRecord(item)) continue
      const from = readRef(item.from)
      const to = readRef(item.to)
      if (!from || !to) continue
      if (!known.has(`${from.path}#${from.symbol}`) || !known.has(`${to.path}#${to.symbol}`)) continue
      const key = `${from.path}#${from.symbol}>${to.path}#${to.symbol}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      edges.push({ from, to, kind: asString(item.kind) === 'use' ? 'use' : 'call' })
    }
  }
  return { files, edges }
}

/** The graph in a session's reply, or null when the reply holds no JSON object. */
export function parseDiagramReply(text: string, plan: PlanModel): DiagramGraph | null {
  try {
    return normalizeGraph(extractJson(text), plan)
  } catch {
    return null
  }
}

/** The callers in a session's reply, capped, their paths made relative to the project, test files left out; null when the reply holds no JSON object. */
export function parseCallersReply(text: string, limit = CALLERS_LIMIT, prefixes: readonly string[] = []): { callers: DiagramCaller[]; more: number } | null {
  let raw: unknown
  try {
    raw = extractJson(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || !Array.isArray(raw.callers)) return null
  const callers: DiagramCaller[] = []
  const seen = new Set<string>()
  let tests = 0
  for (const item of raw.callers) {
    if (!isRecord(item)) continue
    const path = stripPrefixes(asString(item.path), prefixes)
    const symbol = asString(item.symbol) || '(module)'
    if (!path) continue
    if (isTestPath(path)) {
      tests += 1
      continue
    }
    const key = `${path}#${symbol}`
    if (seen.has(key)) continue
    seen.add(key)
    const caller: DiagramCaller = { path, symbol, kind: asKind(item.kind) }
    if (typeof item.line === 'number' && Number.isFinite(item.line) && item.line > 0) caller.line = Math.floor(item.line)
    callers.push(caller)
  }
  const counted = typeof raw.total === 'number' && Number.isFinite(raw.total) ? Math.floor(raw.total) - tests : 0
  const total = Math.max(counted, callers.length)
  const shown = callers.slice(0, limit)
  return { callers: shown, more: Math.max(0, total - shown.length) }
}

// ---- the text search for callers --------------------------------------------

const SKIP_PATH = /(^|\/)(node_modules|dist|build|vendor|\.git|coverage|target|__pycache__)(\/|$)|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|lock|map|min\.js)$/i

/** The lines of `git grep -n` (or `grep -rn`) output as hits, skipping generated folders. */
export function parseGrepOutput(output: string, limit = CANDIDATE_LIMIT): { path: string; line: number; text: string }[] {
  const hits: { path: string; line: number; text: string }[] = []
  for (const raw of output.split('\n')) {
    const match = raw.match(/^(.+?):(\d+):(.*)$/)
    if (!match) continue
    const path = normalizePath(match[1] ?? '')
    if (!path || SKIP_PATH.test(path)) continue
    hits.push({ path, line: Number(match[2]), text: match[3] ?? '' })
    if (hits.length >= limit) break
  }
  return hits
}

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'function', 'with', 'elif', 'except', 'match', 'when', 'try', 'do', 'new', 'await', 'yield', 'foreach', 'unless', 'until', 'case', 'typeof', 'throw'])

type Declaration = { name: string; kind: SymbolKind }

/** The symbol a line declares, by the usual forms of the usual languages, else null. */
export function declarationOf(line: string): Declaration | null {
  const text = line.trim()
  if (!text || text.startsWith('//') || text.startsWith('#') || text.startsWith('*') || text.startsWith('/*')) return null
  let match = text.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/)
  if (match?.[1]) return { name: match[1], kind: 'function' }
  match = text.match(/^(?:export\s+)?(?:abstract\s+)?(?:class|interface|enum|struct|trait|impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?|module|protocol|record)\s+([A-Za-z_$][\w$]*)/)
  if (match?.[1]) return { name: match[1], kind: text.includes('class') || text.includes('impl') || text.includes('module') ? 'class' : 'type' }
  match = text.match(/^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/)
  if (match?.[1]) return { name: match[1], kind: 'type' }
  match = text.match(/^(?:export\s+)?(?:const|let|var|val)\s+(?:\{[^}]*\}\s*=\s*)?([A-Za-z_$][\w$]*)/)
  if (match?.[1]) return { name: match[1], kind: /=>|\bfunction\b/.test(text) ? 'function' : 'const' }
  match = text.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/)
  if (match?.[1]) return { name: match[1], kind: 'function' }
  match = text.match(/^def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/)
  if (match?.[1]) return { name: match[1], kind: 'method' }
  match = text.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/)
  if (match?.[1]) return { name: match[1], kind: text.startsWith('func (') ? 'method' : 'function' }
  match = text.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/)
  if (match?.[1]) return { name: match[1], kind: 'function' }
  match = text.match(/^(?:(?:public|private|protected|internal|static|final|override|open|abstract|suspend|inline|operator)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)/)
  if (match?.[1]) return { name: match[1], kind: 'method' }
  match = text.match(/^(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)/)
  if (match?.[1]) return { name: match[1], kind: 'method' }
  // a method of a class or an object: `name(args) {`, `static async name<T>(a): R {`, `name(args):` in Python-like bodies
  match = text.match(
    /^(?:(?:public|private|protected|internal|static|async|override|readonly|abstract|final|virtual|get|set|export|default|synchronized)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^={;]+)?\s*(?:=>\s*)?\{?\s*$/,
  )
  if (match?.[1] && !CONTROL.has(match[1]) && (text.endsWith('{') || text.endsWith('=>'))) return { name: match[1], kind: 'method' }
  // a typed method of Java, C# or C++: `public Foo bar(int x) {`
  match = text.match(/^(?:(?:public|private|protected|internal|static|final|override|virtual|abstract|async)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w, ]+)?\s*\{?\s*$/)
  if (match?.[1] && !CONTROL.has(match[1])) return { name: match[1], kind: 'method' }
  return null
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * The symbol whose body holds line `index`: the nearest declaration above it
 * with less indentation, named `Class.method` when a class encloses that one;
 * `(module)` when nothing does. The line itself counts when it declares.
 */
export function enclosingSymbol(lines: readonly string[], index: number): Declaration {
  const own = declarationOf(lines[index] ?? '')
  if (own && indentOf(lines[index] ?? '') === 0) return own
  let limit = indentOf(lines[index] ?? '')
  let inner: Declaration | null = null
  let innerIndent = limit
  for (let i = index - 1; i >= 0 && limit > 0; i -= 1) {
    const line = lines[i] ?? ''
    if (!line.trim()) continue
    const indent = indentOf(line)
    if (indent >= limit) continue
    limit = indent
    const declared = declarationOf(line)
    if (!declared) continue
    if (!inner) {
      inner = declared
      innerIndent = indent
      if (indent === 0) break
      continue
    }
    if (declared.kind === 'class' && indent < innerIndent) return { name: `${declared.name}.${inner.name}`, kind: inner.kind === 'function' ? 'method' : inner.kind }
    if (indent === 0) break
  }
  return inner ?? own ?? { name: '(module)', kind: 'other' }
}

/** Whether a line only imports names: the use that matters is elsewhere in the file. */
export function isImportLine(text: string): boolean {
  const line = text.trim()
  return /^import\b(?!\s*\()/.test(line) || /^from\s+\S+\s+import\b/.test(line) || /^(?:const|let|var)\s+\{[^}]*\}\s*=\s*require\(/.test(line) || /^use\s+[\w:]+/.test(line)
}

/** Whether a hit line is the declaration of the symbol itself, which is no caller. */
export function isDeclarationOf(text: string, symbol: string): boolean {
  const declared = declarationOf(text)
  return declared !== null && declared.name === symbol
}

/**
 * Hits grouped into callers, one per enclosing symbol, capped, test files left
 * out; what the page shows when no session answered.
 */
export function groupCandidates(candidates: readonly CallerCandidate[], limit = CALLERS_LIMIT): { callers: DiagramCaller[]; more: number } {
  const callers: DiagramCaller[] = []
  const seen = new Set<string>()
  for (const one of candidates) {
    if (isTestPath(one.path)) continue
    const key = `${one.path}#${one.enclosing}`
    if (seen.has(key)) continue
    seen.add(key)
    callers.push({ path: one.path, symbol: one.enclosing, kind: one.kind, line: one.line })
  }
  const shown = callers.slice(0, limit)
  return { callers: shown, more: callers.length - shown.length }
}

/** The empty callers query, as the state holds it while a session runs. */
export function loadingCallers(): CallersQuery {
  return { status: 'loading', callers: [], more: 0 }
}

/** The graph as text, for the Markdown record. */
export function diagramText(graph: DiagramGraph | undefined): string {
  if (!graph || graph.files.length === 0) return ''
  const lines: string[] = ['Files:']
  for (const file of graph.files) {
    lines.push(`- [${file.status}] ${file.path}${file.symbols.length ? `: ${file.symbols.map(symbol => symbol.name).join(', ')}` : ''}`)
  }
  if (graph.edges.length) {
    lines.push('Calls:')
    for (const edge of graph.edges) {
      lines.push(`- ${edge.from.path}#${edge.from.symbol} -> ${edge.to.path}#${edge.to.symbol}${edge.kind === 'use' ? ' (uses)' : ''}`)
    }
  }
  return lines.join('\n')
}
