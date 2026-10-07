import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export type StatusTone = 'neutral' | 'muted' | 'success' | 'warning' | 'danger' | 'accent'

type StatusBadgeProps = {
  tone?: StatusTone
  children: ReactNode
} & ComponentPropsWithoutRef<'span'>

/**
 * The one status-badge anatomy (R10-09): `.badge` chrome plus a `.badge--tone`
 * color recipe, replacing per-surface `.health-status` / `.replica-state` /
 * `.write-approval-*` / `.change-kind` families.
 */
export function StatusBadge({ tone = 'neutral', className, children, ...rest }: StatusBadgeProps) {
  return (
    <span className={`badge badge--${tone}${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </span>
  )
}
