import { ICON_STROKE_WIDTH, ICON_VIEW_BOX, READ_CHECK_PATH, SHARED_ICON_PATHS, isFilledIcon, type IconName } from './icon-paths'

export { ICON_NAMES, type IconName } from './icon-paths'

const frame = {
  viewBox: ICON_VIEW_BOX,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: ICON_STROKE_WIDTH,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
  width: '1.25em',
  height: '1.25em',
} as const

/** Decorative by design: the containing control owns the accessible name. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  const filled = isFilledIcon(name)
  return (
    <svg {...frame} data-icon={name} className={className}>
      <path d={SHARED_ICON_PATHS[name]} data-fill={filled ? '' : undefined}
        fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : undefined} />
    </svg>
  )
}

/** Preserve CSS state/animation hooks while using the shared geometry. */
export function ReadMarkGlyph() {
  return (
    <svg {...frame} data-testid="read-mark">
      <circle className="read-ring" cx="12" cy="12" r="8.5" />
      <path className="read-check" d={READ_CHECK_PATH} fill="none" />
    </svg>
  )
}

export function SaveMarkGlyph() {
  return (
    <svg {...frame} data-testid="save-mark">
      <path className="bookmark-fill" d={SHARED_ICON_PATHS.bookmark} />
    </svg>
  )
}

export function LibraryNavMark() {
  return <Icon name="library" />
}
