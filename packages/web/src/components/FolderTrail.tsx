import { Fragment } from 'react'
import { Link, type To } from 'react-router-dom'
import { Icon } from './Icon'

export type FolderTrailCrumb = {
  id: string
  title: string
  to: To
}

type Props = {
  /** Collection root crumb — always the first link of the strip. */
  rootTitle: string
  rootTo: To
  /** Ancestor folders between the root and the current folder. */
  crumbs: FolderTrailCrumb[]
  /** The folder the visitor stands in (named, never a link). */
  currentTitle: string
  /** Back climbs exactly one level (parent folder or collection root). */
  backTo: To
  className?: string
  testId?: string
  /** Public collection instrumentation (data-collection-trail*). */
  collectionData?: boolean
}

/**
 * Drill-down folder trail shared by the library desk and the public
 * collection page: an explicit back-one-level button, then the path from
 * the collection root to the current folder as one visually joined strip.
 * The current folder carries a glyph and ink weight so the place the
 * visitor stands in is legible at a glance.
 */
export function FolderTrail({
  rootTitle,
  rootTo,
  crumbs,
  currentTitle,
  backTo,
  className,
  testId,
  collectionData,
}: Props) {
  return (
    <nav
      className={className ? `breadcrumb folder-trail ${className}` : 'breadcrumb folder-trail'}
      aria-label="Folder path"
      data-testid={testId}
      data-collection-trail={collectionData ? true : undefined}
    >
      <Link
        className="trail-back"
        to={backTo}
        tabIndex={-1}
        aria-hidden="true"
        data-collection-trail-back={collectionData ? true : undefined}
      >
        <Icon name="arrow-left" />
      </Link>
      <div className="folder-trail-path">
        <Link to={rootTo} title={rootTitle}>{rootTitle}</Link>
        {crumbs.map((crumb) => (
          <Fragment key={crumb.id}>
            <span aria-hidden className="folder-trail-sep"><Icon name="chevron-right" /></span>
            <Link to={crumb.to} title={crumb.title}>{crumb.title}</Link>
          </Fragment>
        ))}
        <span aria-hidden className="folder-trail-sep"><Icon name="chevron-right" /></span>
        <span
          aria-current="location"
          className="folder-trail-current"
          title={currentTitle}
          data-collection-trail-current={collectionData ? true : undefined}
        >
          <Icon name="folder" />
          <span className="folder-trail-current-text">{currentTitle}</span>
        </span>
      </div>
    </nav>
  )
}
