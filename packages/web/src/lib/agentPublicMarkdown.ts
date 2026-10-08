import { safeExternalUrl } from './publicCollectionTree'

/** Markdown helpers aligned with `scripts/generate-agent-public.mjs` (do not drift). */

const MAILTO_HREF = /^mailto:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u

/** http(s) via `safeExternalUrl`, same-origin `/path` (not `//`), or a simple mailto. */
export function safeAgentPublicHref(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || /[\s\\]/.test(trimmed)) return null
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed
  if (MAILTO_HREF.test(trimmed)) return trimmed
  return safeExternalUrl(trimmed)
}

export function normalizeAgentPublicMarkdown(source: string): string {
  return `${source.replace(/\s+$/u, '')}\n`
}

export function extractAgentPublicTitle(markdown: string): string {
  const heading = /^#\s+(.+)$/mu.exec(markdown)
  if (!heading) {
    throw new Error('Markdown document is missing a top-level # heading')
  }
  return (heading[1] ?? '').replace(/\*\*/gu, '').trim()
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/gu, '&quot;')
}

export function renderAgentPublicInlineHtml(text: string): string {
  const escaped = escapeHtml(text)
  const withBold = escaped.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
  return withBold.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (match, label: string, href: string) => {
    const safe = safeAgentPublicHref(href)
    if (!safe) return match
    return `<a href="${escapeAttr(safe)}">${label}</a>`
  })
}

export function agentPublicMarkdownToHtml(markdown: string): string {
  const lines = normalizeAgentPublicMarkdown(markdown).replace(/\n$/u, '').split('\n')
  const html: string[] = []
  let listItems: string[] = []
  let codeLines: string[] | null = null

  const flushList = () => {
    if (listItems.length === 0) return
    html.push('<ul>')
    for (const item of listItems) html.push(`<li>${item}</li>`)
    html.push('</ul>')
    listItems = []
  }

  const flushCode = () => {
    if (codeLines === null) return
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
    codeLines = null
  }

  for (const line of lines) {
    if (/^```/u.test(line)) {
      if (codeLines === null) {
        flushList()
        codeLines = []
      } else {
        flushCode()
      }
      continue
    }
    if (codeLines !== null) {
      codeLines.push(line)
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading) {
      flushList()
      const level = (heading[1] ?? '#').length
      html.push(`<h${level}>${renderAgentPublicInlineHtml((heading[2] ?? '').trim())}</h${level}>`)
      continue
    }
    const listItem = /^[-*]\s+(.+)$/u.exec(line)
    if (listItem) {
      listItems.push(renderAgentPublicInlineHtml((listItem[1] ?? '').trim()))
      continue
    }
    flushList()
    const trimmed = line.trim()
    if (trimmed === '') continue
    html.push(`<p>${renderAgentPublicInlineHtml(trimmed)}</p>`)
  }
  flushList()
  flushCode()
  return html.join('\n')
}

export function splitAgentPublicMarkdown(markdown: string): {
  title: string
  lede: string | undefined
  bodyHtml: string
} {
  const title = extractAgentPublicTitle(markdown)
  const lines = normalizeAgentPublicMarkdown(markdown).replace(/\n$/u, '').split('\n')
  let index = 0
  for (; index < lines.length; index += 1) {
    if (/^#\s+/u.test(lines[index] ?? '')) {
      index += 1
      break
    }
  }
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1
  const ledeLine = lines[index]
  let lede: string | undefined
  let restStart = index
  if (
    ledeLine &&
    !/^#{1,6}\s+/u.test(ledeLine) &&
    !/^[-*]\s+/u.test(ledeLine)
  ) {
    lede = ledeLine.trim()
    restStart = index + 1
  }
  const bodyMarkdown = lines.slice(restStart).join('\n')
  return {
    title,
    lede,
    bodyHtml: agentPublicMarkdownToHtml(bodyMarkdown),
  }
}
