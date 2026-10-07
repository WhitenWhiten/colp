import type { ReactNode } from 'react'

/**
 * The one social-action cluster every followable / votable masthead
 * renders (collection, digest series, digest issue): Follow first, the
 * community vote pill second, then any quiet secondary links. Order and
 * geometry are fixed here so the three surfaces cannot drift apart —
 * layout lives in page-layouts.css (.social-actions).
 */
export function SocialActions({ follow, vote, links, className }: {
  follow?: ReactNode
  vote?: ReactNode
  /** Quiet trailing links (Graph / Path / Report …), rendered as ghost buttons. */
  links?: ReactNode
  className?: string
}) {
  if (!follow && !vote && !links) return null
  return (
    <div className={`social-actions${className ? ` ${className}` : ''}`} data-testid="social-actions">
      {follow}
      {vote}
      {links ? <span className="social-actions-links">{links}</span> : null}
    </div>
  )
}
