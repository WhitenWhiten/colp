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
 * Unified page shell. Replaces .miss-page / .p0-page / .sync-inner /
 * .classify-page / .write-approvals-page wrappers.
 *
 * Variants:
 * - shell: default reading width (--shell = 90rem)
 * - grid: dense workbench width (--shell-grid = 96rem)
 * - narrow: single-column centered (--measure-wide = 46rem)
 * - bare: outer page padding only, no inner track — for workbench routes
 *   whose children own their own tracks (Explore's .collection-grid,
 *   Library's .library-desk/.library-layout)
 *
 * Shell migration inventory (C1, 2026-09). Migrated: Explore, Library
 * (unavailable state), LibraryDesk (+ desk view states), LegacyLibrary,
 * DemoHub — and earlier Sync, write-approvals, Classify, Today and the
 * TrustDocument family. Remaining custom shells, by disposition:
 * - Shared specialty shells, keep: .auth-page (Login/Register/
 *   PasswordReset/AuthRecovery/Onboarding/EmailVerification/Consent —
 *   centered card + hero wash), .ext-popup-page (centered stage demo).
 * - Full-bleed product surfaces, keep: Dashboard canvas, Graph canvas,
 *   Collection masthead article, Profile journal/masthead, LibraryDesk
 *   sidebar grid (the desk itself, not its page padding).
 * - Marketing/share chrome, keep: Landing, ProductShare, CollectionShare
 *   (custom heroes; share has its own dark embed palette).
 * When migrating a page here, delete the old shell's padding rules and
 * move its entry to the migrated list.
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
