/**
 * Demo-only bookmark stack at `/demo/library`.
 *
 * Product `/library` is `Library` in `./Library.tsx` (owned collections + Reading).
 * Do not wire this component to the product library route.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useToast } from '../components/AppToast'
import { BookmarkNotePanel } from '../components/BookmarkNotePanel'
import { AnnotationText } from '../components/annotation-markdown'
import { Collapse } from '../components/Collapse'
import { DensitySwitch } from '../components/DensitySwitch'
import { EmptyState } from '../components/EmptyState'
import { PageShell } from '../components/PageShell'
import { Icon, ReadMarkGlyph } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { VirtualList } from '../components/VirtualList'
import { myFolders, myLinks, type MyLink } from '../api/mock-data'
import {
  applyLibrarySeedsOnce,
  getLinkMeta,
  loadMetaMap,
  loadReadIds,
  setLinkMeta,
  simulateAiTldr,
  toggleReadId,
  type LinkMeta,
} from '../lib/libraryMarks'
import { useUiDensity } from '../lib/useUiDensity'
import '../styles/library.css'

type LayoutMode = 'full' | 'compact'

export function LegacyLibrary() {
  const [searchParams] = useSearchParams()
  const forceEmpty = searchParams.get('empty') === '1'
  const [folder, setFolder] = useState('All bookmarks')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [density] = useUiDensity()
  const layout: LayoutMode = density === 'compact' ? 'compact' : 'full'
  const [readIds, setReadIds] = useState(() => loadReadIds())
  const [metaMap, setMetaMap] = useState(() => {
    applyLibrarySeedsOnce(
      myLinks.map((l) => ({
        id: l.id,
        note: l.seedNote,
        tldr: l.seedTldr,
      })),
    )
    return loadMetaMap()
  })
  const { toast } = useToast()
  const root = myFolders[0]
  const isCompact = layout === 'compact'

  useEffect(() => {
    // Compact list is scan-only — collapse any open annotate panel
    if (isCompact) setSelected(null)
  }, [isCompact])

  useEffect(() => {
    const sync = () => {
      setReadIds(loadReadIds())
      setMetaMap(loadMetaMap())
    }
    window.addEventListener('known-library-marks', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('known-library-marks', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const links = useMemo(() => {
    if (forceEmpty) return [] as MyLink[]
    const base =
      folder === 'All bookmarks'
        ? myLinks
        : myLinks.filter((l) => l.folder === folder)
    const q = query.trim().toLowerCase()
    if (!q) return base
    return base.filter((l) => {
      const meta = metaMap[l.id]
      return (
        l.title.toLowerCase().includes(q) ||
        l.host.toLowerCase().includes(q) ||
        l.folder.toLowerCase().includes(q) ||
        (meta?.note?.toLowerCase().includes(q) ?? false) ||
        (meta?.tldr?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [folder, query, metaMap, forceEmpty])

  const readCount = useMemo(
    () => links.filter((l) => readIds.has(l.id)).length,
    [links, readIds],
  )

  const onToggleRead = useCallback(
    (id: string) => {
      const next = toggleReadId(id)
      setReadIds(new Set(next))
      toast(next.has(id) ? 'Marked as read' : 'Marked as unread')
    },
    [toast],
  )

  const onMetaChange = useCallback((id: string, meta: LinkMeta) => {
    setMetaMap((prev) => ({ ...prev, [id]: meta }))
  }, [])

  // Demo seed always ships a root folder; render nothing rather than crash if it ever does not.
  if (!root) return null

  return (
    <PageShell variant="bare">
      <div className="library-layout">
        <aside className="library-sidebar">
          <h3 className="section-label library-eyebrow">
            Folders
          </h3>
          <button
            type="button"
            className="tree-item"
            aria-current={folder === root.name ? 'true' : undefined}
            onClick={() => setFolder(root.name)}
          >
            {root.name}
            <span className="count">{root.count}</span>
          </button>
          <div className="tree-nested">
            {root.children.map((c) => (
              <button
                key={c.id}
                type="button"
                className="tree-item"
                aria-current={folder === c.name ? 'true' : undefined}
                onClick={() => setFolder(c.name)}
              >
                {c.name}
                <span className="count">{c.count}</span>
              </button>
            ))}
          </div>
          <hr className="divider" />
          <Link to="/library/new" className="tree-item">
            <Icon name="plus" /> New collection
          </Link>
          <Link to="/classify" className="tree-item">
            Smart classify
          </Link>
          <Link to="/import" className="tree-item">
            Import…
          </Link>
        </aside>

        <div className="library-main">
          <PageHead
            eyebrow="Library"
            title={folder}
            documentTitle={folder}
            lede={`${links.length} visible · ${readCount} read${selected ? ' · editing notes' : ''}`}
          />
          {/* ≤719px .library-sidebar is display:none (library.css); this
              select keeps folder switching reachable on phones — the same
              .library-mobile-nav pattern the desk header uses. New
              collection / Import stay in the toolbar below. */}
          <div className="library-mobile-nav">
            <label className="library-mobile-select">
              <span>Folder</span>
              <select
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              >
                <option value={root.name}>{root.name} ({root.count})</option>
                {root.children.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name} ({c.count})
                  </option>
                ))}
              </select>
            </label>
            <Link to="/classify" className="btn btn-ghost btn-sm mt-2">
              Smart classify
            </Link>
          </div>
          <div className="library-toolbar">
            <div className="row library-toolbar-actions">
              <DensitySwitch />
              <Link to="/sync" className="btn btn-secondary btn-sm">
                Sync status
              </Link>
              <Link to="/import" className="btn btn-ghost btn-sm">
                Import
              </Link>
              <Link to="/library/new" className="btn btn-primary btn-sm">
                New collection
              </Link>
            </div>
          </div>

          {forceEmpty && (
            <div className="mb-4">
              <EmptyState
                illustration="books"
                title="Your library is empty"
                description="Sync browser folders into collections you own, import an archive, or capture the active tab with the extension. The extension only syncs collections you own, not ones shared with you."
                action={
                  <>
                    <Link to="/onboarding" className="btn btn-primary btn-sm">
                      Start setup
                    </Link>
                    <Link to="/extension/popup" className="btn btn-secondary btn-sm">
                      Capture popup
                    </Link>
                    <Link to="/import" className="btn btn-ghost btn-sm">
                      Import bookmarks
                    </Link>
                    <Link to="/library" className="btn btn-ghost btn-sm">
                      Show sample data
                    </Link>
                  </>
                }
              />
            </div>
          )}

          <label className="search-field explore-search mb-hair-85">
            <span className="visually-hidden">Filter links</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                isCompact
                  ? 'Filter by title or host…'
                  : 'Filter by title, host, note, or TL;DR…'
              }
            />
          </label>

          <div
            className={isCompact ? 'lib-link-list lib-link-list--compact' : 'lib-link-list'}
            role="list"
          >
            {links.length === 0 ? (
              <EmptyState
                className="lib-link-empty"
                icon="link"
                title={forceEmpty ? 'Demo empty mode' : 'No matching links'}
                description={forceEmpty
                  ? 'Clear ?empty=1 to restore sample links.'
                  : 'No links in this folder match your filter.'}
              />
            ) : links.length > 50 ? (
              <VirtualList
                items={links}
                itemHeight={isCompact ? 44 : 72}
                overscan={5}
                className={isCompact ? 'lib-link-list lib-link-list--compact' : 'lib-link-list'}
                renderItem={(l) => (
                  <LibraryLinkRow
                    link={l}
                    layout={layout}
                    expanded={!isCompact && selected === l.id}
                    isRead={readIds.has(l.id)}
                    meta={metaMap[l.id] ?? getLinkMeta(l.id)}
                    onToggleExpand={() =>
                      setSelected((cur) => (cur === l.id ? null : l.id))
                    }
                    onToggleRead={() => onToggleRead(l.id)}
                    onMetaChange={onMetaChange}
                  />
                )}
              />
            ) : (
              links.map((l) => (
                <LibraryLinkRow
                  key={l.id}
                  link={l}
                  layout={layout}
                  expanded={!isCompact && selected === l.id}
                  isRead={readIds.has(l.id)}
                  meta={metaMap[l.id] ?? getLinkMeta(l.id)}
                  onToggleExpand={() =>
                    setSelected((cur) => (cur === l.id ? null : l.id))
                  }
                  onToggleRead={() => onToggleRead(l.id)}
                  onMetaChange={onMetaChange}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </PageShell>
  )
}

type RowProps = {
  link: MyLink
  layout: LayoutMode
  expanded: boolean
  isRead: boolean
  meta: LinkMeta
  onToggleExpand: () => void
  onToggleRead: () => void
  onMetaChange: (id: string, meta: LinkMeta) => void
}

function LibraryLinkRow({
  link,
  layout,
  expanded,
  isRead,
  meta,
  onToggleExpand,
  onToggleRead,
  onMetaChange,
}: RowProps) {
  const isCompact = layout === 'compact'
  const hasNote = Boolean(meta.note?.trim())
  const hasTldr = Boolean(meta.tldr?.trim())

  return (
    <article
      role="listitem"
      className={[
        'lib-link',
        isCompact ? 'lib-link--compact' : 'lib-link--full',
        expanded ? 'is-expanded' : '',
        isRead ? 'is-read' : '',
        !isCompact && (hasNote || hasTldr) ? 'has-meta' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="lib-link-main">
        <button
          type="button"
          className={`read-mark lib-read-btn ${isRead ? 'is-active' : ''}`}
          aria-pressed={isRead}
          aria-label={isRead ? 'Mark as unread' : 'Mark as read'}
          title={isRead ? 'Mark as unread' : 'Mark as read'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleRead()
          }}
        >
          <ReadMarkGlyph />
        </button>

        <div className="lib-link-body">
          {isCompact ? (
            link.url ? (
              <a
                className="lib-link-hit"
                href={link.url}
                target="_blank"
                rel="noreferrer"
              >
                <h4>{link.title}</h4>
              </a>
            ) : (
              <div className="lib-link-hit">
                <h4>{link.title}</h4>
              </div>
            )
          ) : (
            <button
              type="button"
              className="lib-link-hit"
              onClick={onToggleExpand}
              aria-expanded={expanded}
            >
              <h4>{link.title}</h4>
            </button>
          )}

          <div className="lib-link-meta">
            <span className="lib-source">
              <span className="lib-host">{link.host}</span>
              <span className="lib-meta-sep" aria-hidden>
                ·
              </span>
              <span className="lib-folder">{link.folder}</span>
            </span>
            {!isCompact && (isRead || hasNote || hasTldr) && (
              <span className="lib-flags" aria-label="Annotations">
                {isRead && <span className="badge badge--read">Read</span>}
                {hasNote && <span className="badge badge--note">Note</span>}
                {hasTldr && (
                  <span className="badge badge--accent">
                    TL;DR
                    {meta.tldrSource === 'ai' && (
                      <span className="badge badge--ai">AI</span>
                    )}
                    {meta.tldrSource === 'user' && (
                      <span className="badge badge--ai badge--ai-user">edited</span>
                    )}
                  </span>
                )}
              </span>
            )}
            {isCompact && isRead && (
              <span className="lib-flags" aria-label="Status">
                <span className="badge badge--read">Read</span>
              </span>
            )}
          </div>
        </div>

        <div className="lib-link-side">
          <span className="meta lib-added">{link.added}</span>
          {!isCompact && (
            <div className="lib-link-actions">
              {link.url && (
                <a
                  className="btn btn-ghost btn-sm"
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  Open
                </a>
              )}
              <button
                type="button"
                className={`btn btn-sm ${expanded ? 'btn-secondary is-active' : 'btn-ghost'}`}
                aria-expanded={expanded}
                onClick={onToggleExpand}
              >
                {expanded ? 'Close' : 'Annotate'}
              </button>
            </div>
          )}
        </div>
      </div>

      {!isCompact && !expanded && (hasNote || hasTldr) && (
        <div className="lib-link-preview">
          {hasTldr && (
            <div className="lib-snippet lib-snippet--tldr">
              <span className="lib-snippet-tag">
                TL;DR
                {/* R7-24: same product semantic as the shared AI badge — one class. */}
                {meta.tldrSource === 'ai' && (
                  <span className="badge badge--ai">AI</span>
                )}
                {meta.tldrSource === 'user' && (
                  <span className="badge badge--ai badge--ai-user">
                    edited
                  </span>
                )}
              </span>
              <AnnotationText value={meta.tldr} format={meta.tldrFormat} variant="snippet" className="lib-snippet-text" />
            </div>
          )}
          {hasNote && (
            <div className="lib-snippet lib-snippet--note">
              <span className="lib-snippet-tag">Note</span>
              <AnnotationText value={meta.note} format={meta.noteFormat} variant="snippet" className="lib-snippet-text" />
            </div>
          )}
        </div>
      )}

      <Collapse open={!isCompact && expanded}>
        <BookmarkNotePanel
          id={link.id}
          meta={meta}
          onPersist={(patch) => {
            const next = setLinkMeta(link.id, patch)
            onMetaChange(link.id, next)
            return next
          }}
          onGenerate={() => simulateAiTldr(link.title, link.host)}
        />
      </Collapse>
    </article>
  )
}
