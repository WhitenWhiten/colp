import type { ExportLibraryDocument } from '../api'

export type ExportFormat = 'JSON' | 'Markdown' | 'HTML'
type Collection = ExportLibraryDocument['collections'][number]
type Node = Collection['nodes'][number]

const html = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!)
const markdown = (value: string) => value.replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/[&<>]/g, html).replace(/\r?\n/g, ' ')

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null
  } catch { return null }
}

// Iterative traversal also retains disconnected nodes and terminates on cycles.
function* walk(nodes: Collection['nodes']): Generator<{ node: Node; depth: number }> {
  const ids = new Set(nodes.map((node) => node.id))
  const children = new Map<string, Node[]>()
  for (const node of nodes) {
    if (node.parentId !== null) {
      const siblings = children.get(node.parentId) ?? []
      siblings.push(node)
      children.set(node.parentId, siblings)
    }
  }
  const roots = nodes.filter((node) => node.parentId === null || !ids.has(node.parentId))
  const visited = new Set<string>()
  for (const root of [...roots, ...nodes]) {
    const stack = [{ node: root, depth: 0 }]
    while (stack.length) {
      const item = stack.pop()!
      if (visited.has(item.node.id)) continue
      visited.add(item.node.id)
      yield item
      const descendants = children.get(item.node.id) ?? []
      for (let i = descendants.length - 1; i >= 0; i--) {
        stack.push({ node: descendants[i]!, depth: item.depth + 1 })
      }
    }
  }
}

function metadata(node: Node): string {
  return `ID: ${node.id} · Parent: ${node.parentId ?? 'none'} · ${node.kind}${node.isRoot ? ' (root)' : ''} · Visibility: ${node.visibility ?? 'inherit'}`
}

function renderMarkdown(doc: ExportLibraryDocument): string {
  const lines = ['# Know-N library', '', `Exported: ${markdown(doc.exportedAt)}`, '']
  for (const collection of doc.collections) {
    lines.push(`## ${markdown(collection.title)}`, '',
      `ID: ${markdown(collection.id)} · Visibility: ${markdown(collection.visibility)}`, '')
    if (collection.publicationSlug) lines.push(`Publication: ${markdown(collection.publicationSlug)}`, '')
    for (const { node, depth } of walk(collection.nodes)) {
      // Keep pathological depths bounded in size; explicit parent IDs remain lossless.
      const indent = '  '.repeat(Math.min(depth, 32))
      const title = markdown(node.title ?? (node.isRoot ? 'Root' : node.kind))
      const url = safeUrl(node.url)
      const link = url
        ? `[${title}](<${url.replace(/[<>\\]/g, (char) => encodeURIComponent(char)).replace(/&/g, '&amp;')}>)`
        : title
      lines.push(`${indent}- ${link}`, `${indent}  ${markdown(metadata(node))}`)
      if (node.url) lines.push(`${indent}  Source: ${markdown(node.url)}`)
      if (node.description) lines.push(`${indent}  ${markdown(node.description)}`)
      if (node.tags?.length) lines.push(`${indent}  Tags: ${node.tags.map(markdown).join(', ')}`)
    }
    if (!collection.nodes.length) lines.push('No items.')
    lines.push('')
  }
  if (!doc.collections.length) lines.push('No collections.', '')
  return lines.join('\n')
}

function renderHtml(doc: ExportLibraryDocument): string {
  const parts = ['<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">',
    '<title>Know-N library</title><style>body{font:16px system-ui;max-width:960px;margin:auto;padding:24px;overflow-wrap:anywhere}li{margin:12px 0}small{display:block}p{white-space:pre-wrap}ul{padding-left:24px}</style>',
    `</head><body><h1>Know-N library</h1><p>Exported: ${html(doc.exportedAt)}</p>`]
  for (const collection of doc.collections) {
    parts.push(`<section><h2>${html(collection.title)}</h2><p>ID: ${html(collection.id)} · Visibility: ${html(collection.visibility)}</p>`)
    if (collection.publicationSlug) parts.push(`<p>Publication: ${html(collection.publicationSlug)}</p>`)
    let previousDepth = -1
    for (const { node, depth: treeDepth } of walk(collection.nodes)) {
      const depth = Math.min(treeDepth, 32)
      if (depth > previousDepth) parts.push('<ul>')
      else {
        parts.push('</li>')
        for (let level = previousDepth; level > depth; level--) parts.push('</ul></li>')
      }
      const title = html(node.title ?? (node.isRoot ? 'Root' : node.kind))
      const url = safeUrl(node.url)
      parts.push('<li>', url
        ? `<a href="${html(url)}" rel="noreferrer noopener">${title}</a>` : `<strong>${title}</strong>`,
      `<small>${html(metadata(node))}</small>`)
      if (node.url) parts.push(`<p>Source: ${html(node.url)}</p>`)
      if (node.description) parts.push(`<p>${html(node.description)}</p>`)
      if (node.tags?.length) parts.push(`<p>Tags: ${node.tags.map(html).join(', ')}</p>`)
      previousDepth = depth
    }
    if (previousDepth >= 0) {
      parts.push('</li>')
      for (let level = previousDepth; level >= 0; level--) parts.push('</ul>', level > 0 ? '</li>' : '')
    } else parts.push('<p>No items.</p>')
    parts.push('</section>')
  }
  if (!doc.collections.length) parts.push('<p>No collections.</p>')
  parts.push('</body></html>')
  return parts.join('')
}

export function serializeLibraryExport(doc: ExportLibraryDocument, format: ExportFormat) {
  switch (format) {
    case 'JSON': return { content: JSON.stringify(doc, null, 2), type: 'application/json', extension: 'json' }
    case 'Markdown': return { content: renderMarkdown(doc), type: 'text/markdown;charset=utf-8', extension: 'md' }
    case 'HTML': return { content: renderHtml(doc), type: 'text/html;charset=utf-8', extension: 'html' }
  }
}
