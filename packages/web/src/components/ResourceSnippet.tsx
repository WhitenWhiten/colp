import { AnnotationText } from './annotation-markdown'
import type { AnnotationSnippet } from '../lib/useBookmarkAnnotations'

type Props = {
  kind: 'tldr' | 'note'
  tag: string
  snippet?: AnnotationSnippet
  /** Empty-state copy for editor surfaces (e.g. the collist notes popover). */
  empty?: string
  /** Host modifier on the shared .lib-snippet anatomy (e.g. collist-pop-snippet). */
  className?: string
  testId?: string
}

/**
 * R10-01: one TL;DR / Note snippet anatomy (`.lib-snippet`, shared-chrome.css)
 * for every surface that shows annotation excerpts — library comfort rows,
 * the collist notes popover and search result details. Hosts only add a
 * modifier class for local density; tag + text slots never fork.
 */
export function ResourceSnippet({ kind, tag, snippet, empty, className, testId }: Props) {
  return (
    <div
      className={`lib-snippet lib-snippet--${kind}${className ? ` ${className}` : ''}`}
      data-testid={testId}
    >
      <span className="lib-snippet-tag">{tag}</span>
      <div className="lib-snippet-text" dir="auto" title={snippet?.text}>
        {snippet
          ? <AnnotationText value={snippet.text} format={snippet.format} variant="snippet" />
          : empty}
      </div>
    </div>
  )
}
