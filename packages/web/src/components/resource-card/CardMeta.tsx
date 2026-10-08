import type { ReactNode } from 'react'

/**
 * Shared meta row for resource card bodies (C03).
 * `.meta-row` supplies the host · path · date anatomy; `.card-meta` keeps
 * the card-specific floor pinning (cards-ui.css).
 */
export function CardMeta({ children }: { children: ReactNode }) {
  return <div className="card-meta meta-row" data-testid="card-meta">{children}</div>
}
