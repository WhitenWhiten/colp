import { forwardRef, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { CollectionKind } from '../api/types'
import type { Collection } from '../types/catalog'
import { publicCollectionKindLabel } from '../lib/publicCollectionTree'
import { pluralNoun } from '../lib/plural'
import { AvatarImage } from './AvatarImage'
import { Icon } from './Icon'

function collectionKindChip(kind: CollectionKind | undefined): string | null {
  if (!kind || kind === 'bookmarks') return null
  return publicCollectionKindLabel(kind)
}

function formatCompactCount(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(n)
}

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u

/** A well-formed language tag, or undefined so no `lang` attribute is written. */
function contentLang(language: string | null | undefined): string | undefined {
  return language && LANGUAGE_TAG.test(language) ? language : undefined
}

type CollectionCardProps = {
  c: Pick<
    Collection,
    'id' | 'slug' | 'title' | 'description' | 'curator' | 'curatorHandle' | 'tags' | 'links' | 'updated' | 'public'
  > & Partial<Collection> & {
    viewCount?: number
    curatorAvatar?: string | null
    kind?: CollectionKind
    curatorNote?: string | null
    /** True on a moderation tombstone (#21): keeps the slot, renders inert (no link, no arrow). */
    hiddenPublic?: boolean
    /** BCP 47 tag of the collection's own language (R15-40). */
    language?: string | null
  }
  namedTransition?: boolean
  /** Off on the curator's own profile, where every card would repeat the
      name and avatar the page head already shows. */
  showCurator?: boolean
}

export const CollectionCard = forwardRef<HTMLAnchorElement, CollectionCardProps>(
  function CollectionCard({ c, namedTransition = false, showCurator = true }, ref) {
    /* R15-40: curator text in another language gets its own lang (pronunciation,
       hyphenation, CJK glyphs) and dir="auto" (right-to-left scripts). */
    const lang = contentLang(c.language)
    const initials = c.curator
      .split(' ')
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
    const kindLabel = collectionKindChip(c.kind)

    const stats: ReactNode[] = []
    if (c.links > 0) {
      stats.push(
        <span key="links">
          <strong>{c.links}</strong> {pluralNoun(c.links, 'bookmark')}
        </span>,
      )
    }
    if ((c.viewCount ?? 0) > 0) {
      stats.push(
        <span key="views">
          <strong>{formatCompactCount(c.viewCount ?? 0)}</strong> {pluralNoun(c.viewCount ?? 0, 'view')}
        </span>,
      )
    }
    if (c.updated) {
      stats.push(
        <span key="updated" className="collection-card-updated">
          <time>{c.updated}</time>
        </span>,
      )
    }

    if (c.hiddenPublic === true) {
      // #21: moderation tombstone — keeps the grid slot but is inert: no
      // link, no hover lift, no arrow, no kind chips. It says what happened
      // instead of leaving the slot blank under the title (R12-12).
      return (
        <div className="result-card result-card--collection result-card--tombstone" data-collection-hidden>
          <div className="collection-card-body">
            <div className="collection-card-tombstone">
              <span className="collection-card-mark" aria-hidden>
                <Icon name="eye-off" />
              </span>
              <h3 className="collection-card-title" lang={lang} dir="auto">{c.title}</h3>
              <p className="meta">Hidden by moderation</p>
            </div>
            <div className="collection-card-foot">
              <div className="curator-row">
                <span className="avatar" aria-hidden>
                  <AvatarImage url={c.curatorAvatar} initials={initials} />
                </span>
                <span className="collection-card-curator">{c.curator}</span>
              </div>
            </div>
          </div>
        </div>
      )
    }

    return (
      <Link
        ref={ref}
        to={`/c/${c.slug}`}
        className="result-card result-card--collection"
        style={namedTransition ? ({ viewTransitionName: `collection-${c.id}` } as CSSProperties) : undefined}
      >
        <div className="collection-card-body">
          <div className="collection-card-kicker">
            <span className="collection-card-mark" aria-hidden>
              <Icon name={c.kind === 'reading_path' ? 'lines' : 'folder'} />
            </span>
            <div className="collection-card-tags">
              {c.tags.slice(0, 2).map((t) => (
                <span key={t} className="chip chip--label">
                  {t}
                </span>
              ))}
            </div>
            {kindLabel ? <span className="chip">{kindLabel}</span> : null}
          </div>

          <h3 className="collection-card-title" lang={lang} dir="auto">{c.title}</h3>

          {c.curatorNote ? (
            <p className="collection-card-curation" data-testid="collection-card-curation" lang={lang} dir="auto">{c.curatorNote}</p>
          ) : (
            <p className="collection-card-desc" data-testid="collection-card-desc" lang={lang} dir="auto">{c.description}</p>
          )}

          {stats.length > 0 && (
            <p className="collection-card-stats" data-testid="collection-card-stats">
              {stats.map((node, i) => (
                <span key={i} className="collection-card-stat">
                  {i > 0 ? <span className="dot-sep" aria-hidden /> : null}
                  {node}
                </span>
              ))}
            </p>
          )}

          <div className="collection-card-foot">
            {showCurator ? (
              <div className="curator-row">
                <span className="avatar" aria-hidden>
                  <AvatarImage url={c.curatorAvatar} initials={initials} />
                </span>
                <span className="collection-card-curator">{c.curator}</span>
              </div>
            ) : (
              <span className="collection-card-open">Open collection</span>
            )}
            {c.public === false && <span className="meta">Private</span>}
            <span className="collection-card-arrow" aria-hidden><Icon name="arrow-right" /></span>
          </div>
        </div>
      </Link>
    )
  },
)
