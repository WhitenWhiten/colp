import type { HTMLAttributes, ReactNode } from 'react'

type PageShellVariant = 'shell' | 'grid' | 'narrow' | 'bare'

type PageShellProps = {
  variant?: PageShellVariant
  children: ReactNode
  className?: string
  /** Children are already `PageSection` nodes (multiple inners). */
  sections?: boolean
} & Omit<HTMLAttributes<HTMLDivElement>, 'className'>

/**
 * Unified page shell.
 *
 * Variants:
 * - shell: default reading width (--shell = 90rem)
 * - grid: dense workbench width (--shell-grid = 96rem)
 * - narrow: single-column centered (--measure-wide = 46rem)
 * - bare: outer page padding only, no inner track — for workbench routes
 *   whose children own their own tracks (Library's .library-desk)
 *
 * Pages that keep a custom shell: the auth card (.auth-page: sign-in,
 * register, recovery, consent), the Graph canvas, the public Collection
 * masthead article, and the LibraryDesk sidebar grid (the desk itself, not
 * its page padding). When moving a page here, delete the old shell's padding
 * rules.
 */
export function PageShell({
  variant = 'shell',
  children,
  className,
  sections = false,
  ...rest
}: PageShellProps) {
  const classes = ['page-shell']
  if (variant === 'grid') classes.push('page-shell--grid')
  if (variant === 'narrow') classes.push('page-shell--narrow')
  if (className) classes.push(className)

  if (variant === 'bare') {
    return (
      <div className={classes.join(' ')} {...rest}>
        {children}
      </div>
    )
  }

  return (
    <div className={classes.join(' ')} {...rest}>
      {sections ? children : <div className="page-shell-inner">{children}</div>}
    </div>
  )
}

export function PageSection({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={['page-shell-inner', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  )
}
