import { Fragment, type ReactNode } from 'react'
import { Link, type To } from 'react-router-dom'

export type BreadcrumbItem = {
  label: ReactNode
  /** Linked crumb. Omitted on the current page — it renders as text. */
  to?: To
}

/**
 * The shared breadcrumb strip (R10-35): `A / B / current` — linked crumbs
 * separated by a decorative slash, the current page as trailing text.
 * Chrome lives in .breadcrumb (pages-shared.css); FolderTrail covers the
 * folder drill-down anatomy (back arrow + root→current path) instead.
 */
export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden>/</span>}
          {/* The label span carries the ellipsis: a coarse-pointer crumb link
              is inline-flex (44px target), and flex text cannot ellipsize. */}
          {item.to
            ? <Link to={item.to}><span>{item.label}</span></Link>
            : <span aria-current={i === items.length - 1 ? 'page' : undefined}>{item.label}</span>}
        </Fragment>
      ))}
    </nav>
  )
}
