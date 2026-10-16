// Text diffs for the "highlight changes" view of the summary: a line diff
// first, then a word diff inside each run of changed lines, drawn as <del>
// and <ins> marks in a pre-wrapped block.
import { escapeHtml } from './markdown.js'

const MAX_CELLS = 4_000_000

/**
 * The longest-common-subsequence diff of two arrays, as operations in order:
 * `{ type: 'eq' | 'del' | 'ins', value }`. Two sequences too long to compare
 * cell by cell are one deletion and one insertion.
 */
export function diffSequences(a, b) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const head = a.slice(0, start).map(value => ({ type: 'eq', value }))
  const tail = a.slice(endA).map(value => ({ type: 'eq', value }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  let middle
  if (midA.length === 0 || midB.length === 0 || (midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    middle = [...midA.map(value => ({ type: 'del', value })), ...midB.map(value => ({ type: 'ins', value }))]
  } else {
    middle = lcsDiff(midA, midB)
  }
  return [...head, ...middle, ...tail]
}

function lcsDiff(a, b) {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', value: a[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: 'del', value: a[i] })
      i += 1
    } else {
      ops.push({ type: 'ins', value: b[j] })
      j += 1
    }
  }
  while (i < n) ops.push({ type: 'del', value: a[i++] })
  while (j < m) ops.push({ type: 'ins', value: b[j++] })
  return ops
}

/** Words, runs of whitespace and single punctuation marks, in order. */
export function tokenize(text) {
  return String(text).match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || []
}

export function diffWords(oldText, newText) {
  return diffSequences(tokenize(oldText), tokenize(newText))
}

/** Whether two texts differ at all, ignoring line endings. */
export function textsDiffer(oldText, newText) {
  return String(oldText ?? '').replace(/\r\n?/g, '\n') !== String(newText ?? '').replace(/\r\n?/g, '\n')
}

function lines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
}

function joinRun(run) {
  return run.join('\n')
}

function renderWordOps(ops) {
  let html = ''
  let open = ''
  for (const op of ops) {
    const tag = op.type === 'del' ? 'del' : op.type === 'ins' ? 'ins' : ''
    if (tag !== open) {
      if (open) html += `</${open}>`
      if (tag) html += `<${tag}>`
      open = tag
    }
    html += escapeHtml(op.value)
  }
  if (open) html += `</${open}>`
  return html
}

/**
 * The two texts as one marked text: unchanged lines plain, a run of changed
 * lines diffed word by word, removed text in <del>, added text in <ins>.
 */
export function renderTextDiff(oldText, newText) {
  const ops = diffSequences(lines(oldText), lines(newText))
  const parts = []
  let dels = []
  let inss = []
  const flush = () => {
    if (dels.length === 0 && inss.length === 0) return
    if (dels.length && inss.length) parts.push(renderWordOps(diffWords(joinRun(dels), joinRun(inss))))
    else if (dels.length) parts.push(`<del>${escapeHtml(joinRun(dels))}</del>`)
    else parts.push(`<ins>${escapeHtml(joinRun(inss))}</ins>`)
    dels = []
    inss = []
  }
  for (const op of ops) {
    if (op.type === 'eq') {
      flush()
      parts.push(escapeHtml(op.value))
    } else if (op.type === 'del') {
      dels.push(op.value)
    } else {
      inss.push(op.value)
    }
  }
  flush()
  return `<div class="textdiff">${parts.join('\n')}</div>`
}

/** How many tokens the two texts add and remove, for a short label. */
export function countChanges(oldText, newText) {
  let added = 0
  let removed = 0
  for (const op of diffWords(oldText, newText)) {
    if (/^\s+$/.test(op.value)) continue
    if (op.type === 'ins') added += 1
    else if (op.type === 'del') removed += 1
  }
  return { added, removed }
}
