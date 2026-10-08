import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as REPointerEvent,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { isWidgetResource, type Resource, type CardLayout } from '../types/catalog'
import { isVideoSource, sourceLabel } from '../lib/sources'
import { CARD_CHROME_H, shellFromContent } from '../lib/cardChrome'
import {
  defaultThemeForType,
  themeClass,
  themesForType,
  type DeskThemeId,
  type TileSkinId,
} from '../lib/deskThemes'
import { loadReadIds } from '../lib/resourceMarks'
import { useAnchoredMenu } from '../lib/useAnchoredMenu'
import { EXIT_DURATION_FAST_MS, useExitAnimation } from '../lib/useExitAnimation'
import { CardHead } from './resource-card/CardHead'
import { CardShell } from './resource-card/CardShell'
import { CardThemeMenu } from './resource-card/CardThemeMenu'
import { ResourceBody } from './resource-card/ResourceBody'
import { isToolType } from './resource-card/WidgetBody'

type Props = {
  resource: Resource
  layout: CardLayout
  editable?: boolean
  /** Canvas stack lock — pinned above unlocked modules. */
  stackLocked?: boolean
  selected?: boolean
  moving?: boolean
  resizing?: boolean
  onSelect?: () => void
  onToggleLock?: () => void
  /** When set (edit mode), show a remove control on the card chrome. */
  onRemove?: () => void
  /** Active tile skin — a picked DeskThemeId, or the widget-intrinsic default. */
  themeId?: TileSkinId
  /** Edit mode: change palette (right-click or palette button). */
  onThemeChange?: (themeId: DeskThemeId) => void
  onMoveStart?: (e: REPointerEvent<HTMLElement>) => void
  onResizeStart?: (e: REPointerEvent<HTMLElement>) => void
  onMoveKey?: (e: KeyboardEvent<HTMLButtonElement>) => void
  onResizeKey?: (e: KeyboardEvent<HTMLButtonElement>) => void
}

/**
 * Board card (C03). Owns the interactive chrome (read marks, theme menu,
 * drag/resize wiring) and composes the generic CardShell with a
 * ResourceBody; the shell surface, radius, padding and hover stay owned
 * by the shell CSS — no body branch re-decides them.
 */
export const SourceCard = memo(function SourceCard({
  resource,
  layout,
  editable = false,
  stackLocked = false,
  selected,
  moving,
  resizing,
  onSelect,
  onToggleLock,
  onRemove,
  themeId,
  onThemeChange,
  onMoveStart,
  onResizeStart,
  onMoveKey,
  onResizeKey,
}: Props) {
  const [isRead, setIsRead] = useState(() => loadReadIds().has(resource.id))
  const themeBtnRef = useRef<HTMLButtonElement>(null)
  const themeMenu = useAnchoredMenu({ exemptRefs: [themeBtnRef] })
  // Exit phase: the theme menu pops out at the fast tier; the last anchor
  // point is kept so the closing frame does not jump.
  const { mounted: themeMenuMounted, closing: themeMenuClosing } = useExitAnimation(
    themeMenu.pos !== null,
    EXIT_DURATION_FAST_MS,
  )
  const lastThemeMenuRef = useRef<{ x: number; y: number } | null>(null)
  if (themeMenu.pos) lastThemeMenuRef.current = themeMenu.pos
  const themeMenuPos = themeMenu.pos ?? lastThemeMenuRef.current
  const isVideo = isVideoSource(resource.type)
  const activeTheme = themeId ?? defaultThemeForType(resource.type)
  const themeOptions = themesForType(resource.type)

  // layout = content box; edit chrome expands the shell upward so content
  // stays on the same grid in Board and Focus / fullscreen.
  const shell = shellFromContent(layout, editable, CARD_CHROME_H)
  const style = {
    '--x': `${shell.x}px`,
    '--y': `${shell.y}px`,
    '--w': `${shell.w}px`,
    '--h': `${shell.h}px`,
    '--card-chrome-h': `${CARD_CHROME_H}px`,
    zIndex: layout.z,
  } as CSSProperties

  useEffect(() => {
    setIsRead(loadReadIds().has(resource.id))
  }, [resource.id])

  useEffect(() => {
    const sync = () => setIsRead(loadReadIds().has(resource.id))
    window.addEventListener('storage', sync)
    window.addEventListener('known-resource-marks', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('known-resource-marks', sync)
    }
  }, [resource.id])

  const openThemeMenu = (clientX: number, clientY: number) => {
    if (!onThemeChange || !themeOptions.length) return
    themeMenu.openAt(clientX, clientY, {
      width: 200,
      height: Math.min(320, 48 + themeOptions.length * 40),
    })
  }

  const className = [
    'tile',
    `tile-${resource.type}`,
    themeClass(activeTheme),
    isVideo ? 'video' : '',
    stackLocked ? 'is-stack-locked' : '',
    selected ? 'is-selected' : '',
    moving ? 'is-moving' : '',
    resizing ? 'is-resizing' : '',
    editable ? 'is-editable' : '',
    isRead ? 'is-read' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Badge reports the content box (what snaps to the grid), not the chrome shell.
  const badge = selected
    ? `${Math.round(layout.w)} × ${Math.round(layout.h)} · ${Math.round(layout.x)},${Math.round(layout.y)}`
    : `${Math.round(layout.w)} × ${Math.round(layout.h)}`

  const isFillContent = isWidgetResource(resource)
  const isTool = isToolType(resource.type)
  const label =
    resource.type === 'collectionlist'
      ? resource.title || sourceLabel.collectionlist
      : sourceLabel[resource.type] ?? resource.host

  const themeMenuUi =
    themeMenuMounted &&
    themeMenuPos &&
    onThemeChange &&
    createPortal(
      <CardThemeMenu
        menuRef={themeMenu.menuRef}
        closing={themeMenuClosing}
        x={themeMenuPos.x}
        y={themeMenuPos.y}
        options={themeOptions}
        activeTheme={activeTheme}
        onPick={(t) => {
          onThemeChange(t)
          themeMenu.close()
        }}
      />,
      document.body,
    )

  return (
    <>
      <CardShell
        className={className}
        style={style}
        dataId={resource.id}
        dataTheme={activeTheme}
        contentFill={isFillContent}
        contentNoHead={!editable}
        editable={editable}
        stackLocked={stackLocked}
        selected={selected}
        badge={badge}
        label={label}
        onSelect={onSelect}
        onContextMenu={(e) => {
          if (!editable || !onThemeChange) return
          // Let collection-list density menu own its surface
          const t = e.target as HTMLElement | null
          if (t?.closest?.('.collist')) return
          e.preventDefault()
          e.stopPropagation()
          openThemeMenu(e.clientX, e.clientY)
        }}
        onResizeStart={onResizeStart}
        onResizeKey={onResizeKey}
        head={
          editable ? (
            <CardHead
              type={resource.type}
              label={label}
              plainLabel={isTool || resource.type === 'collectionlist'}
              stackLocked={stackLocked}
              isTool={isTool}
              resourceId={resource.id}
              resourceTitle={resource.title}
              onMoveStart={onMoveStart}
              onMoveKey={onMoveKey}
              onToggleLock={onToggleLock}
              onThemeChange={onThemeChange}
              themeMenuOpen={Boolean(themeMenu.pos)}
              themeBtnRef={themeBtnRef}
              onOpenThemeMenu={(anchor) => openThemeMenu(anchor.left, anchor.bottom)}
              onRemove={onRemove}
            />
          ) : undefined
        }
      >
        <ResourceBody resource={resource} isVideo={isVideo} editable={editable} />
      </CardShell>
      {themeMenuUi}
    </>
  )
})
