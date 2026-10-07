import { useRef, type ReactNode } from 'react'
import { useExitAnimation } from '../lib/useExitAnimation'

/**
 * Vertical expand/collapse with height motion (M03 gap: accordions used to
 * snap). The body stays conditionally mounted: opening plays a grid
 * 0fr→1fr keyframe, closing holds the subtree one beat (useExitAnimation)
 * while the reverse plays, then unmounts — collapsed content never lingers
 * in the accessibility tree or tab order.
 */
export function Collapse({
  open,
  id,
  className,
  role,
  children,
}: {
  open: boolean
  /** id/className/role land on the inner body element (the old direct div). */
  id?: string
  className?: string
  role?: string
  children: ReactNode
}) {
  const { mounted, closing } = useExitAnimation(open)

  // The expand keyframe is for user toggles only. Route changes remount the
  // whole page (<main key>), and replaying every initially-open section's
  // 0fr→1fr on top of the page entrance makes sidebars visibly "unsquash".
  const hasToggledRef = useRef(false)
  const initialOpenRef = useRef(open)
  if (open !== initialOpenRef.current) hasToggledRef.current = true
  const settled = open && !hasToggledRef.current

  if (!mounted) return null
  return (
    <div
      className={`collapse-vert${closing ? ' is-closing' : ''}${settled ? ' is-settled' : ''}`}
      inert={closing || undefined}
    >
      <div
        id={id}
        role={role}
        className={className ? `collapse-vert-inner ${className}` : 'collapse-vert-inner'}
      >
        {children}
      </div>
    </div>
  )
}
