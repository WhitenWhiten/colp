import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { Resource } from '../types/catalog'
import { sourceLabel } from '../lib/sources'
import { useToast } from './AppToast'
import { ExternalLink } from './ExternalLink'
import { Icon, ReadMarkGlyph } from './Icon'
import { Modal } from './Modal'
import { anchorPopover, popoverStyle, type AnchorPopoverPos } from '../lib/anchorPopover'
import { EXIT_DURATION_FAST_MS } from '../lib/useExitAnimation'
import { useNoteTldrEditor } from '../lib/useNoteTldrEditor'
import { ResourceSnippet } from './ResourceSnippet'
import {
  getResourceMeta,
  loadReadIds,
  setResourceMeta,
  simulateAiTldr,
  toggleReadId,
  type ResourceMeta,
} from '../lib/resourceMarks'

type Mode = 'list' | 'compact'

type Props = {
  item: Resource
  mode: Mode
}

const PANEL_W = 320
const LEAVE_MS = 160

/**
 * One row inside a dashboard/collection list embed.
 * Read mark syncs via resourceMarks (same store as Collection board/list).
 * Hover shows note + TL;DR; click pins the panel for editing.
 */
export function CollistItem({ item, mode }: Props) {
  const { toast, success } = useToast()
  const rowRef = useRef<HTMLDivElement>(null)
  const notesBtnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const leaveTimer = useRef<number | undefined>(undefined)
  const panelId = useId()

  const [isRead, setIsRead] = useState(() => loadReadIds().has(item.id))
  const [meta, setMeta] = useState<ResourceMeta>(() => getResourceMeta(item.id))
  const [hoverOpen, setHoverOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<AnchorPopoverPos | null>(null)

  const {
    note,
    setNote,
    tldr,
    setTldr,
    tldrSource,
    noteDirty,
    tldrDirty,
    generating,
    syncMeta,
    saveNote,
    saveTldr,
    generateTldr,
  } = useNoteTldrEditor({
    initial: meta,
    persist: (patch) => setResourceMeta(item.id, patch),
    generate: () => simulateAiTldr(item.title, item.host),
    notify: (message, tone) => (tone === 'success' ? success(message) : toast(message)),
  })

  const open = pinned || hoverOpen
  const href = item.url !== '#' ? item.url : undefined

  const reposition = useCallback(() => {
    const el = notesBtnRef.current ?? rowRef.current
    if (!el) return
    setPos(anchorPopover(el.getBoundingClientRect(), { width: PANEL_W, maxHeight: 380, align: 'end' }))
  }, [])

  useEffect(() => {
    const sync = () => {
      setIsRead(loadReadIds().has(item.id))
      const m = getResourceMeta(item.id)
      setMeta(m)
      syncMeta(m)
    }
    window.addEventListener('known-resource-marks', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('known-resource-marks', sync)
      window.removeEventListener('storage', sync)
    }
  }, [item.id, syncMeta])

  useLayoutEffect(() => {
    // Keep the last position while the exit animation plays; a reopen
    // recomputes it here before paint.
    if (!open) return
    reposition()
  }, [open, reposition, pinned])

  useEffect(() => {
    if (!open) return
    const onReposition = () => reposition()
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open, reposition])

  useEffect(
    () => () => {
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    },
    [],
  )

  const clearLeave = () => {
    if (leaveTimer.current) {
      window.clearTimeout(leaveTimer.current)
      leaveTimer.current = undefined
    }
  }

  const scheduleLeave = () => {
    if (pinned) return
    clearLeave()
    leaveTimer.current = window.setTimeout(() => {
      setHoverOpen(false)
    }, LEAVE_MS)
  }

  const showHover = () => {
    if (pinned) return
    clearLeave()
    setHoverOpen(true)
  }

  const onToggleRead = (e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const next = toggleReadId(loadReadIds(), item.id)
    const now = next.has(item.id)
    setIsRead(now)
    toast(now ? 'Marked as read' : 'Marked as unread')
  }

  const pinPanel = () => {
    clearLeave()
    setPinned(true)
    setHoverOpen(false)
  }

  const closePinned = () => {
    setPinned(false)
    setHoverOpen(false)
  }

  const hasNote = Boolean(meta.note?.trim())
  const hasTldr = Boolean(meta.tldr?.trim())

  const panelStyle = pos ? popoverStyle(pos) : undefined

  // The Modal owns the whole presence lifecycle (delayed unmount at the
  // fast tier to match .collist-pop.is-closing); once positioned, the
  // portal stays and Modal renders null while fully closed.
  const panel =
    pos &&
    typeof document !== 'undefined' &&
    createPortal(
      <Modal
        open={open}
        exitDuration={EXIT_DURATION_FAST_MS}
        onClose={closePinned}
        label={`${item.title} notes`}
        chrome="inline"
        trapFocus={pinned}
        panelRef={panelRef}
        panelClassName={`collist-pop ${pinned ? 'is-pinned' : 'is-hover'} ${pos.openUp ? 'is-up' : ''}`}
        panelProps={{
          id: panelId,
          style: panelStyle,
          onPointerDown: (e) => e.stopPropagation(),
          onClick: (e) => {
            e.stopPropagation()
            if (!pinned) pinPanel()
          },
          onMouseEnter: () => {
            clearLeave()
            if (!pinned) setHoverOpen(true)
          },
          onMouseLeave: () => scheduleLeave(),
        }}
      >
        {/* Invisible bridge so the cursor can travel from row → panel without flicker */}
        {!pinned && (
          <span
            className={`collist-pop-bridge ${pos.openUp ? 'is-up' : ''}`}
            aria-hidden
          />
        )}

        <header className="collist-pop-head">
          <div className="collist-pop-titles">
            <p className="collist-pop-kicker">
              {sourceLabel[item.type] ?? item.type}
              {item.host ? ` · ${item.host}` : ''}
            </p>
            <h4 className="collist-pop-title">{item.title}</h4>
          </div>
          {pinned ? (
            <button
              type="button"
              className="collist-pop-close"
              aria-label="Close notes panel"
              onClick={(e) => {
                e.stopPropagation()
                closePinned()
              }}
            >
              <Icon name="cross" />
            </button>
          ) : (
            <span className="collist-pop-hint meta">Click to keep open</span>
          )}
        </header>

        {pinned ? (
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- event boundary only: keeps editor clicks from reaching the popover's pin/dismiss handlers; the interactive children are native inputs/buttons
          <div className="collist-pop-edit" onClick={(e) => e.stopPropagation()}>
            <section className="collist-pop-field">
              <div className="collist-pop-field-head">
                <label htmlFor={`${panelId}-note`}>
                  <span className="collist-pop-field-title">Note</span>
                  <span className="meta">Private</span>
                </label>
                {noteDirty && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={saveNote}>
                    Save
                  </button>
                )}
              </div>
              <textarea
                id={`${panelId}-note`}
                className="collist-pop-textarea"
                rows={3}
                value={note}
                placeholder="Why you saved this…"
                onChange={(e) => setNote(e.target.value)}
                onBlur={() => {
                  if (noteDirty) saveNote()
                }}
              />
            </section>

            <section className="collist-pop-field">
              <div className="collist-pop-field-head">
                <label htmlFor={`${panelId}-tldr`}>
                  <span className="collist-pop-field-title">TL;DR</span>
                  <span className="meta">
                    {tldrSource === 'ai' && 'AI draft'}
                    {tldrSource === 'user' && 'Edited'}
                    {tldrSource === 'empty' && 'Generate or write'}
                  </span>
                </label>
                <div className="collist-pop-field-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={generating}
                    onClick={generateTldr}
                  >
                    {generating ? '…' : tldr.trim() ? 'Regen' : 'Generate'}
                  </button>
                  {tldrDirty && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => saveTldr('user')}
                    >
                      Save
                    </button>
                  )}
                </div>
              </div>
              <textarea
                id={`${panelId}-tldr`}
                className={`collist-pop-textarea ${tldrSource === 'ai' ? 'is-ai' : ''}`}
                rows={3}
                value={tldr}
                placeholder="Short takeaway…"
                onChange={(e) => setTldr(e.target.value)}
                onBlur={() => {
                  if (tldrDirty) saveTldr('user')
                }}
              />
            </section>
          </div>
        ) : (
          <div className="collist-pop-preview" data-testid="collist-pop-preview">
            <ResourceSnippet
              kind="tldr"
              tag="TL;DR"
              className="collist-pop-snippet"
              snippet={hasTldr ? { text: meta.tldr, format: meta.tldrFormat ?? 'plain' } : undefined}
              empty="No TL;DR yet — click to add or generate."
            />
            <ResourceSnippet
              kind="note"
              tag="Note"
              className="collist-pop-snippet"
              snippet={hasNote ? { text: meta.note, format: meta.noteFormat ?? 'plain' } : undefined}
              empty="No note yet — click to write one."
            />
          </div>
        )}
      </Modal>,
      document.body,
    )

  const notesBtn = (
    <button
      ref={notesBtnRef}
      type="button"
      className="btn btn-ghost btn-sm collist-notes-btn"
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={pinned ? `Close notes for ${item.title}` : `Open notes for ${item.title}`}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseEnter={showHover}
      onMouseLeave={scheduleLeave}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (pinned) closePinned()
        else pinPanel()
      }}
    >
      Notes
    </button>
  )

  const readBtn = (
    <button
      type="button"
      className={`read-mark collist-read-btn ${isRead ? 'is-active' : ''}`}
      aria-pressed={isRead}
      aria-label={isRead ? 'Mark as unread' : 'Mark as read'}
      title={isRead ? 'Mark as unread' : 'Mark as read'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onToggleRead}
    >
      <ReadMarkGlyph />
    </button>
  )

  if (mode === 'compact') {
    return (
      <>
        <div
          ref={rowRef}
          className={[
            'collist-item',
            'collist-item--compact',
            isRead ? 'is-read' : '',
            open ? 'is-panel-open' : '',
            hasNote || hasTldr ? 'has-meta' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {readBtn}
          {href ? (
            <ExternalLink
              className="collist-item-main"
              href={href}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="collist-type">
                {sourceLabel[item.type] ?? item.type}
              </span>
              <span className="collist-item-title" title={item.title}>{item.title}</span>
              {item.meta?.duration != null ? (
                <span className="compact-mid">{String(item.meta.duration)}</span>
              ) : item.meta?.stars != null ? (
                <span className="compact-mid"><Icon name="star" /> {item.meta.stars}</span>
              ) : (
                <span className="compact-mid" aria-hidden />
              )}
              <span className="meta">{item.host}</span>
            </ExternalLink>
          ) : (
            <div className="collist-item-main">
              <span className="collist-type">
                {sourceLabel[item.type] ?? item.type}
              </span>
              <span className="collist-item-title" title={item.title}>{item.title}</span>
              {item.meta?.duration != null ? (
                <span className="compact-mid">{String(item.meta.duration)}</span>
              ) : item.meta?.stars != null ? (
                <span className="compact-mid"><Icon name="star" /> {item.meta.stars}</span>
              ) : (
                <span className="compact-mid" aria-hidden />
              )}
              <span className="meta">{item.host}</span>
            </div>
          )}
          {notesBtn}
        </div>
        {panel}
      </>
    )
  }

  return (
    <>
      <div
        ref={rowRef}
        className={[
          'collist-item',
          'collist-item--list',
          isRead ? 'is-read' : '',
          open ? 'is-panel-open' : '',
          hasNote || hasTldr ? 'has-meta' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="collist-item-head">
          {readBtn}
          <span className="source-dot" aria-hidden />
          <span className="collist-type">
            {sourceLabel[item.type] ?? item.type}
          </span>
          {(hasNote || hasTldr) && (
            <span className="collist-item-flags">
              {hasNote && <span className="badge badge--note">Note</span>}
              {hasTldr && <span className="badge badge--accent">TL;DR</span>}
            </span>
          )}
          {notesBtn}
        </div>
        {href ? (
          <ExternalLink
            className="collist-item-title"
            href={href}
            title={item.title}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {item.title}
          </ExternalLink>
        ) : (
          <span className="collist-item-title" title={item.title}>{item.title}</span>
        )}
        <p className="collist-item-summary" title={item.summary}>{item.summary}</p>
      </div>
      {panel}
    </>
  )
}
