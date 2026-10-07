import type { PublicCollectionResource } from '../lib/publicCollectionTree'
import type { AnnotationSnippet } from '../lib/useBookmarkAnnotations'
import { recordResourceOpen } from '../lib/recordCollectionInsight'
import { DomainMark } from './DomainMark'
import { Icon } from './Icon'
import { UGC_REL } from '../lib/ugcRel'

function HostLabel({ host, href, cdnAllowed }: { host: string; href: string | null; cdnAllowed: boolean }) {
  return (
    <span className="digest-entry-host" data-testid="digest-entry-host">
      <DomainMark host={host} small pageUrl={href} faviconCdnAllowed={cdnAllowed} />
      <span className="digest-entry-host-name" data-testid="digest-entry-host-name">{host}</span>
    </span>
  )
}

function snippetText(value: AnnotationSnippet | string | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.text
}

function DigestNote({ kind, label, text, testId }: {
  kind: 'tldr' | 'note'
  label: string
  text: string
  testId: string
}) {
  return (
    <p className={`digest-entry-note digest-entry-note--${kind}`} data-testid={testId}>
      <span className="digest-entry-note-label">{label}</span>{' '}
      <span className="digest-entry-note-body" dir="auto">{text}</span>
    </p>
  )
}

type Props = {
  resource: PublicCollectionResource
  slug: string
  /** The source collection's favicon-CDN gate; the node's own opt-out
      still wins (R15-07). */
  cdnAllowed: boolean
}

/**
 * One entry of a digest edition (R10-07): a headline that links out to the
 * original with the host on the same line, the bookmark's standfirst, and
 * the curator's note / TL;DR — the "why this made the issue" voice that
 * separates an edition from a bookmark list. Saving is a page-level action
 * (Save all), never a per-row icon.
 */
export function DigestEntry({ resource, slug, cdnAllowed }: Props) {
  const { node, href, host } = resource
  const tldr = snippetText(node.tldr)
  const note = snippetText(node.note)

  const title = href ? (
    <a
      className="digest-entry-title"
      href={href}
      target="_blank"
      rel={UGC_REL}
      data-collection-resource-link
      aria-label={`Open ${node.title} on ${host}`}
      onClick={() => recordResourceOpen(slug, node.id)}
    >
      {node.title}
      <Icon name="arrow-up-right" />
    </a>
  ) : (
    <span className="digest-entry-title is-unavailable">{node.title}</span>
  )

  return (
    <article className="digest-entry" data-testid="digest-entry" data-collection-resource={node.id}>
      <div className="digest-entry-head">
        {title}
        {host ? <HostLabel host={host} href={href} cdnAllowed={cdnAllowed && node.faviconCdnAllowed !== false} /> : null}
      </div>
      {node.description ? <p className="digest-entry-desc">{node.description}</p> : null}
      {tldr || note ? (
        <div className="digest-entry-notes">
          {tldr ? <DigestNote kind="tldr" label="TL;DR" text={tldr} testId="bookmark-tldr" /> : null}
          {note ? <DigestNote kind="note" label="Curator’s note" text={note} testId="bookmark-note" /> : null}
        </div>
      ) : null}
    </article>
  )
}
