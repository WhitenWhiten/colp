import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { Icon } from './Icon'

interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  icon?: 'alert' | 'book' | 'search' | 'collection' | 'link' | 'folder' | 'bell' | 'compass'
  illustration?: 'books' | 'search' | 'network'
  kicker?: ReactNode
  title: string
  /** Page-level empties (e.g. 404) may need an h1; section empties stay h3 */
  titleAs?: 'h1' | 'h3'
  description?: ReactNode
  action?: ReactNode
  suggestions?: ReactNode
  className?: string
  /** Escape hatch for one-off layout tweaks (width, padding, margin). */
  style?: CSSProperties
  /** Errors announce assertively; everything else stays a polite status. */
  role?: 'status' | 'alert'
}

export function EmptyState({ icon = 'book', illustration, kicker, title, titleAs = 'h3', description, action, suggestions, className, style, role = 'status', ...rest }: EmptyStateProps) {
  const Title = titleAs
  return (
    <div {...rest} className={className ? `empty-state ${className}` : 'empty-state'} role={role} style={style}>
      {illustration ? (
        <div className={`empty-state-illustration empty-state-illustration--${illustration}`} aria-hidden data-testid="empty-state-illustration">
          <div className="empty-state-illustration-shape" data-testid="empty-state-illustration-shape" />
          <div className="empty-state-illustration-shape" data-testid="empty-state-illustration-shape" />
          <div className="empty-state-illustration-shape" data-testid="empty-state-illustration-shape" />
        </div>
      ) : (
        <div className="empty-state-icon" aria-hidden data-testid="empty-state-icon">
          <Icon name={icon} />
        </div>
      )}
      {kicker && <p className="section-label">{kicker}</p>}
      <Title>{title}</Title>
      {description && <p className="empty-state-text">{description}</p>}
      {action && <div className="empty-state-actions">{action}</div>}
      {suggestions && <div className="empty-state-suggestions">{suggestions}</div>}
    </div>
  )
}

/* Inline loading: a quiet pulse in the empty-state chrome, role="status". */
export function LoadingState({ label = 'Loading…', className, ...rest }: { label?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={className ? `empty-state loading-state ${className}` : 'empty-state loading-state'} role="status">
      <span className="loading-state-dot" aria-hidden data-testid="loading-state-dot" />
      <p>{label}</p>
    </div>
  )
}
