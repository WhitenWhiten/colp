import { bookmarkIconSrc } from '../lib/bookmarkIcon'
import { BookmarkIcon } from './BookmarkIcon'

const TONES = ['domain-mark--a', 'domain-mark--b', 'domain-mark--c'] as const

function toneIndex(host: string): number {
  let hash = 0
  for (let i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) | 0
  return Math.abs(hash) % TONES.length
}

export function hostLetter(host: string): string {
  return host.replace(/^www\./, '').charAt(0).toUpperCase() || '·'
}

/* Editorial origin anchor: favicon when we have a page/object URL, else a
   serif initial on a pale domain-mark tint. Purely decorative — host text
   accompanies it. When used as BookmarkIcon's letter fallback, omit URLs
   so this stays a monogram. The third-party favicon CDN fails closed: only
   an explicit `faviconCdnAllowed` (a public projection) may hotlink it, so a
   private host never leaks (R15-07). */
export function DomainMark({
  host,
  small = false,
  pageUrl,
  iconUrl,
  faviconCdnAllowed,
}: {
  host: string
  small?: boolean
  pageUrl?: string | null
  iconUrl?: string | null
  faviconCdnAllowed?: boolean | null
}) {
  const className = `domain-mark ${TONES[toneIndex(host)]}${small ? ' domain-mark--sm' : ''}`
  const letter = hostLetter(host)
  const icon = bookmarkIconSrc({
    iconUrl,
    pageUrl,
    faviconCdnAllowed: faviconCdnAllowed === true,
  })
  return (
    <span className={className} aria-hidden data-testid="domain-mark">
      {icon.kind === 'letter' ? letter : <BookmarkIcon icon={icon} letter={letter} />}
    </span>
  )
}
