// A light syntax highlighter: comments, strings, numbers, keywords, types and
// calls, for the languages a plan usually touches. Good enough to read a diff.
import { escapeHtml } from './markdown.js'

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const constructor continue debugger declare default delete do else enum export extends ' +
    'false finally for from function get if implements import in instanceof interface is keyof let module namespace new null of package ' +
    'private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique var void ' +
    'while with yield ' +
    'def elif except lambda nonlocal not or and pass raise global assert del None True False self print ' +
    'fn impl let mut pub struct trait use where match loop crate mod ref unsafe dyn ' +
    'func go chan defer map range select package var ' +
    'final override val var when object data sealed companion fun ' +
    'echo foreach endforeach require include namespace use trait insteadof clone ' +
    'begin end rescue ensure module unless until elsif then nil ' +
    'int long float double char bool boolean string void short byte unsigned signed sizeof nullptr auto template typename ' +
    'select insert update delete create table alter drop where join on into values set from group order by having limit'
  ).split(/\s+/),
)

const HASH_COMMENT = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'pl', 'r', 'ex', 'exs', 'nim', 'cr', 'env', 'ini', 'cfg', 'conf', 'dockerfile', 'makefile'])
const NO_SLASH_COMMENT = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ex', 'exs', 'sql', 'html', 'xml', 'md', 'css'])

export function languageOf(path) {
  const name = (path || '').toLowerCase()
  const base = name.split('/').pop() || ''
  if (base === 'dockerfile' || base === 'makefile') return base
  const extension = base.includes('.') ? base.split('.').pop() : ''
  return extension
}

const TOKEN = /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)|(#[^\n]*)|(--[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:=<>+\-*/%!&|^~?@])|(\s+)|(.)/gi

export function highlight(code, path) {
  const language = languageOf(path)
  const hash = HASH_COMMENT.has(language)
  const slash = !NO_SLASH_COMMENT.has(language)
  const dashes = language === 'sql' || language === 'lua' || language === 'hs'
  let out = ''
  let match
  TOKEN.lastIndex = 0
  const text = String(code)
  while ((match = TOKEN.exec(text)) !== null) {
    const [raw, block, line, hashLine, dashLine, string, number, word, punct, space] = match
    if (block && slash) out += `<span class="tok-cm">${escapeHtml(raw)}</span>`
    else if (block) out += highlightPlain(raw)
    else if (line && slash) out += `<span class="tok-cm">${escapeHtml(raw)}</span>`
    else if (line) out += highlightPlain(raw)
    else if (hashLine && hash) out += `<span class="tok-cm">${escapeHtml(raw)}</span>`
    else if (hashLine) out += highlightPlain(raw)
    else if (dashLine && dashes) out += `<span class="tok-cm">${escapeHtml(raw)}</span>`
    else if (dashLine) out += highlightPlain(raw)
    else if (string) out += `<span class="tok-str">${escapeHtml(raw)}</span>`
    else if (number) out += `<span class="tok-num">${escapeHtml(raw)}</span>`
    else if (word) out += classifyWord(raw, text, TOKEN.lastIndex)
    else if (punct) out += `<span class="tok-punct">${escapeHtml(raw)}</span>`
    else if (space) out += raw
    else out += escapeHtml(raw)
  }
  return out
}

function highlightPlain(raw) {
  // A comment marker in a language that does not use it: re-tokenize without comments.
  return escapeHtml(raw)
}

function classifyWord(word, text, end) {
  if (KEYWORDS.has(word) || KEYWORDS.has(word.toLowerCase()) && /^[A-Z]+$/.test(word)) return `<span class="tok-kw">${escapeHtml(word)}</span>`
  const after = text.slice(end, end + 2)
  if (/^\s?\(/.test(after)) return `<span class="tok-fn">${escapeHtml(word)}</span>`
  if (/^[A-Z][A-Za-z0-9_]*$/.test(word) && word.length > 1) return `<span class="tok-type">${escapeHtml(word)}</span>`
  return escapeHtml(word)
}
