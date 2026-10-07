import type { ReactNode } from 'react'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Highlight case-insensitive query hits as `<mark class="search-hit">`. Text is not HTML. */
export function highlightQuery(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return text
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'))
  if (parts.length === 1) return text
  return parts.map((part, index) => {
    if (part.toLowerCase() === needle.toLowerCase()) {
      return (
        <mark key={index} className="search-hit">
          {part}
        </mark>
      )
    }
    return part
  })
}

export function isDuplicateSnippet(title: string, snippet: string): boolean {
  return snippet.trim().toLowerCase() === title.trim().toLowerCase()
}

export function cleanSnippet(title: string, snippet: string): string {
  const trimmedSnippet = snippet.trim()
  const trimmedTitle = title.trim()
  if (!trimmedSnippet || isDuplicateSnippet(title, snippet)) return ''
  if (trimmedTitle && trimmedSnippet.toLowerCase().startsWith(trimmedTitle.toLowerCase())) {
    const remainder = trimmedSnippet.slice(trimmedTitle.length).trim()
    // Strip leading punctuation often left after trimming title (e.g. "— ", ": ", "- ")
    return remainder.replace(/^[-—:·\s]+/, '').trim()
  }
  return trimmedSnippet
}
