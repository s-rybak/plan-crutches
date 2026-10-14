// A small Markdown renderer: headings, paragraphs, lists, fenced code, tables,
// quotes, rules, inline code, emphasis, links and images. Escapes HTML first.

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function safeUrl(url) {
  const trimmed = url.trim()
  if (/^(javascript|vbscript|data:text\/html)/i.test(trimmed)) return '#'
  return trimmed
}

export function renderInline(text, options = {}) {
  const imageUrl = options.imageUrl || (src => src)
  const codes = []
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, src, title) => {
    const resolved = /^(https?:|data:image\/|\/)/i.test(src) ? src : imageUrl(src)
    return `<img src="${escapeHtml(safeUrl(resolved))}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy" />`
  })
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${escapeHtml(safeUrl(href))}" target="_blank" rel="noopener">${label}</a>`)
  out = out.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, href) => `<a href="${href}" target="_blank" rel="noopener">${href}</a>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)])
  return out
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
}

function splitCells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
}

export function renderMarkdown(markdown, options = {}) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  const html = []
  let index = 0
  const inline = text => renderInline(text, options)

  while (index < lines.length) {
    const line = lines[index]

    if (/^\s*$/.test(line)) {
      index += 1
      continue
    }

    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/)
    if (fence) {
      const marker = fence[1]
      const language = fence[2]
      const body = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      html.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push('<hr />')
      index += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const body = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      html.push(`<blockquote>${renderMarkdown(body.join('\n'), options)}</blockquote>`)
      continue
    }

    if (isTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const head = splitCells(line)
      index += 2
      const rows = []
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitCells(lines[index]))
        index += 1
      }
      html.push(
        `<table><thead><tr>${head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows
          .map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      )
      continue
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+/)
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2])
      const baseIndent = listMatch[1].length
      const items = []
      while (index < lines.length) {
        const current = lines[index]
        const match = current.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
        if (match && match[1].length === baseIndent) {
          items.push([match[3]])
          index += 1
          continue
        }
        if (/^\s*$/.test(current)) {
          const next = lines[index + 1]
          if (next !== undefined && (/^\s+\S/.test(next) || /^(\s*)([-*+]|\d+[.)])\s+/.test(next))) {
            if (items.length) items[items.length - 1].push('')
            index += 1
            continue
          }
          break
        }
        if (/^\s+\S/.test(current) && items.length) {
          items[items.length - 1].push(current.replace(new RegExp(`^\\s{0,${baseIndent + 2}}`), ''))
          index += 1
          continue
        }
        break
      }
      const tag = ordered ? 'ol' : 'ul'
      html.push(
        `<${tag}>${items
          .map(parts => {
            const [first, ...rest] = parts
            const nested = rest.join('\n').trim()
            const nestedHtml = nested ? renderMarkdown(nested, options) : ''
            return `<li>${inline(first)}${nestedHtml}</li>`
          })
          .join('')}</${tag}>`,
      )
      continue
    }

    const paragraph = []
    while (index < lines.length && !/^\s*$/.test(lines[index])) {
      const current = lines[index]
      if (paragraph.length && (/^\s*(```|~~~|#{1,6}\s|>)/.test(current) || /^(\s*)([-*+]|\d+[.)])\s+/.test(current))) break
      paragraph.push(current.trim())
      index += 1
    }
    html.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br />')}</p>`)
  }
  return html.join('\n')
}
