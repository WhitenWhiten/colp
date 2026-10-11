import type { ReactNode } from 'react'

/**
 * The masthead action cluster on a collection page: quiet secondary links
 * rendered as ghost buttons. Layout lives in page-layouts.css
 * (.social-actions).
 */
export function SocialActions({ links, className }: {
  /** Quiet trailing links (Subscribe / Export / Graph …), rendered as ghost buttons. */
  links?: ReactNode
  className?: string
}) {
  if (!links) return null
  return (
    <div className={`social-actions${className ? ` ${className}` : ''}`} data-testid="social-actions">
      <span className="social-actions-links">{links}</span>
    </div>
  )
}
