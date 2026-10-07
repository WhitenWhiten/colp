import type { CSSProperties, ComponentPropsWithoutRef, ReactNode } from 'react'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { usePageMeta, type PageMeta } from '../lib/usePageMeta'
import { isLongDisplayTitle } from '../lib/displayTitle'

type PageHeadProps = {
  eyebrow?: ReactNode
  title: ReactNode
  lede?: ReactNode
  breadcrumb?: ReactNode
  actions?: ReactNode
  /** Masthead leading column: avatar / monogram / cover (R10-03). */
  avatar?: ReactNode
  /** Quiet line between title and lede — @handle, byline, counts (R10-03). */
  afterTitle?: ReactNode
  /** Masthead stats strip: spans the copy + actions columns between fading
      hairlines (e.g. `<ul className="stat-row">`) (R10-03). */
  stats?: ReactNode
  children?: ReactNode
  /** Split layout: copy on the left, actions on the right (Today / Export / History).
      Masthead layout: avatar | copy | actions grid + stats strip (R10-03). */
  layout?: 'stack' | 'split' | 'masthead'
  /** Register: editorial = serif display (reading/discovery); workbench =
      compact sans head with no dither bloom or fading hairline (R10-16).
      Both map to a .page-head--* modifier in page-chrome.css. */
  variant?: 'editorial' | 'workbench'
  as?: 'div' | 'header'
  /** Tab title segment; rendered as `{documentTitle} — Know-N`. Required so a new PageHead cannot ship a silent “Know-N” tab. */
  documentTitle: string
  className?: string
  style?: CSSProperties
  /** Runtime search metadata for public SPA routes. */
  meta?: PageMeta
} & Omit<ComponentPropsWithoutRef<'header'>, 'title' | 'children' | 'className' | 'style'>

/* Editorial page head: eyebrow → title → lede, with optional breadcrumb and
   action row. Typography is owned by .page-head in page-chrome.css; the
   masthead variant's grid is .page-head--masthead there. */
export function PageHead({
  eyebrow,
  title,
  lede,
  breadcrumb,
  actions,
  avatar,
  afterTitle,
  stats,
  children,
  layout = 'stack',
  variant,
  as: Tag = 'div',
  documentTitle,
  className,
  style,
  meta,
  ...rest
}: PageHeadProps) {
  useDocumentTitle(documentTitle)

  const layoutClass =
    layout === 'split' ? ' page-head--split'
      : layout === 'masthead' ? ` page-head--masthead${avatar == null ? ' page-head--no-avatar' : ''}`
        : ''
  const variantClass = variant ? ` page-head--${variant}` : ''
  const extra = className ? ` ${className}` : ''

  const copy = (
    <div className="page-head-copy">
      {breadcrumb}
      {eyebrow != null && <p className="eyebrow">{eyebrow}</p>}
      <h1 className={`display display-md${isLongDisplayTitle(title) ? ' display--long' : ''}`}>{title}</h1>
      {afterTitle != null && <div className="page-head-aftertitle">{afterTitle}</div>}
      {lede != null && <p className="lede">{lede}</p>}
      {children}
    </div>
  )

  return (
    <Tag className={`page-head${layoutClass}${variantClass}${extra}`} style={style} {...rest}>
      {meta ? <PageMetaRuntime meta={meta} documentTitle={documentTitle} /> : null}
      {avatar != null && <div className="page-head-avatar">{avatar}</div>}
      {copy}
      {actions != null && <div className="page-head-actions">{actions}</div>}
      {stats != null && <div className="page-head-stats">{stats}</div>}
    </Tag>
  )
}

function PageMetaRuntime({ meta, documentTitle }: { meta: PageMeta; documentTitle: string }) {
  usePageMeta(meta, documentTitle ? `${documentTitle} — Know-N` : 'Know-N')
  return null
}
