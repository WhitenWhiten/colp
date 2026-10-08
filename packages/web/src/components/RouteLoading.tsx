import { useLocation } from 'react-router-dom'
import { CollectionSkeleton } from './CollectionSkeleton'

/**
 * Route-level loading skeletons (the Suspense fallback in Layout).
 *
 * A skeleton earns its keep only when the page lands on top of it without a
 * jump, so every placeholder here is drawn on the page's own chrome: the
 * real `.page-shell` padding and track width, the real `.page-head` layout
 * modifiers, and a body shaped like the surface the route renders (the
 * library desk's rail + rows, Explore's card grid, the feed's card stream,
 * a reader's paragraphs…). Pages that replace themselves with a full-page
 * loading state reuse the same component through `PageSkeleton`, so the
 * fallback and the page's own first paint are one continuous placeholder.
 *
 * Every leaf is a `.skeleton-block` bone — the one shimmer in the app.
 */

type Shell = 'shell' | 'grid' | 'narrow'

type Head = {
  layout: 'stack' | 'split' | 'masthead'
  /** Compact sans head (PageHead variant="workbench"). */
  workbench?: boolean
  crumb?: boolean
  eyebrow?: boolean
  lede?: boolean
  action?: boolean
}

type Body = 'rows' | 'cards' | 'stream' | 'today' | 'search' | 'inbox' | 'form' | 'reader' | 'canvas' | 'ledger'

type Spec = { shell: Shell; head: Head; body: Body }

export type SkeletonLayout =
  | Spec
  | 'desk'
  | 'collection'
  | 'profile'
  | 'auth'
  | 'reading'
  | 'resource'

const workbench = (head: Partial<Head> = {}): Head => ({ layout: 'split', workbench: true, lede: true, ...head })

const DEFAULT: Spec = { shell: 'shell', head: { layout: 'stack', eyebrow: true, lede: true }, body: 'rows' }

/** Most specific patterns first; the first match wins. */
const ROUTES: Array<[RegExp, SkeletonLayout]> = [
  // Library family
  [/^\/library\/new\/?$/u, { shell: 'narrow', head: workbench({ layout: 'stack', crumb: true }), body: 'form' }],
  [/^\/library\/health\/?$/u, { shell: 'grid', head: workbench({ crumb: true, action: true }), body: 'rows' }],
  [/^\/library\/digests\/[^/]+(\/issues\/[^/]+)?\/read\/?$/u, 'reading'],
  [/^\/library\/digests(\/[^/]+)?\/?$/u, { shell: 'grid', head: workbench({ crumb: true, action: true }), body: 'rows' }],
  [/^\/library\/[^/]+\/(history|collaborators)\/?$/u, { shell: 'grid', head: workbench({ crumb: true, action: true }), body: 'rows' }],
  [/^\/library(\/.*)?$/u, 'desk'],

  // Discovery and reading
  [/^\/explore\/?$/u, { shell: 'grid', head: { layout: 'split', action: true }, body: 'cards' }],
  [/^\/reports\/?$/u, { shell: 'grid', head: { layout: 'stack', lede: true }, body: 'cards' }],
  [/^\/reports\/[^/]+\/issues\/[^/]+\/?$/u, { shell: 'grid', head: { layout: 'masthead', crumb: true, lede: true }, body: 'reader' }],
  [/^\/reports\/[^/]+\/?$/u, { shell: 'grid', head: { layout: 'masthead', crumb: true, lede: true }, body: 'rows' }],
  [/^\/c\/[^/]+/u, 'collection'],
  [/^\/(u|profile)\/[^/]+/u, 'profile'],
  [/^\/read\/[^/]+/u, 'reading'],
  [/^\/path\/[^/]+/u, 'reading'],
  [/^\/r\/[^/]+/u, 'resource'],
  [/^\/graph\/[^/]+/u, { shell: 'grid', head: { layout: 'stack', crumb: true, eyebrow: true, lede: true }, body: 'canvas' }],
  [/^\/feed\/?$/u, { shell: 'grid', head: { layout: 'stack', eyebrow: true, lede: true }, body: 'stream' }],
  [/^\/today\/?$/u, { shell: 'grid', head: { layout: 'split', eyebrow: true, lede: true }, body: 'today' }],
  [/^\/search\/?$/u, { shell: 'shell', head: { layout: 'stack', eyebrow: true }, body: 'search' }],
  [/^\/notifications\/?$/u, { shell: 'grid', head: { layout: 'split', eyebrow: true, lede: true, action: true }, body: 'inbox' }],
  [/^\/demos\/?$/u, { shell: 'shell', head: { layout: 'stack', eyebrow: true, lede: true }, body: 'cards' }],

  // Account and auth
  [/^\/(login|register|reset-password|verify-email|auth\/recovery|consent)\/?$/u, 'auth'],
  [/^\/onboarding\/?$/u, { shell: 'narrow', head: { layout: 'stack', eyebrow: true, lede: true }, body: 'form' }],

  // Workbench tools
  [/^\/export\/?$/u, { shell: 'grid', head: workbench({ layout: 'stack', crumb: true }), body: 'rows' }],
  [/^\/import\/?$/u, { shell: 'grid', head: workbench({ layout: 'stack', crumb: true }), body: 'rows' }],
  [/^\/creator\/?$/u, { shell: 'grid', head: workbench({ eyebrow: true, action: true }), body: 'ledger' }],
  [/^\/credits\/?$/u, { shell: 'grid', head: workbench({ eyebrow: true, action: true }), body: 'ledger' }],
  [/^\/sync\/?$/u, { shell: 'grid', head: workbench({ eyebrow: true, action: true }), body: 'rows' }],
  [/^\/classify\/batch\/?$/u, { shell: 'shell', head: workbench({ crumb: true }), body: 'rows' }],
  [/^\/classify\/?$/u, { shell: 'grid', head: workbench({ crumb: true }), body: 'rows' }],
  [/^\/approvals(\/[^/]+)?\/?$/u, { shell: 'shell', head: workbench({ eyebrow: true, action: true }), body: 'rows' }],
  [/^\/agents\/?$/u, { shell: 'shell', head: workbench({ eyebrow: true, lede: true }), body: 'rows' }],
  [/^\/ai\/organize\/?$/u, { shell: 'grid', head: workbench({ layout: 'stack', crumb: true }), body: 'rows' }],
]

export function layoutForPath(pathname: string): SkeletonLayout {
  for (const [pattern, layout] of ROUTES) if (pattern.test(pathname)) return layout
  return DEFAULT
}

function Bone({ className }: { className: string }) {
  return <span className={`skeleton-block ${className}`} />
}

function HeadBones({ head }: { head: Head }) {
  const classes = ['page-head', 'skeleton-head']
  if (head.layout === 'split') classes.push('page-head--split')
  if (head.layout === 'masthead') classes.push('page-head--masthead', 'page-head--no-avatar')
  if (head.workbench) classes.push('page-head--workbench')
  return (
    <div className={classes.join(' ')} data-testid="skeleton-head">
      <div className="page-head-copy skeleton-stack">
        {head.crumb && <Bone className="skeleton-text skeleton-text--crumb" />}
        {head.eyebrow && <Bone className="skeleton-text skeleton-text--eyebrow" />}
        <Bone className="skeleton-text skeleton-text--title" />
        {head.lede && <Bone className="skeleton-text skeleton-text--lede" />}
      </div>
      {head.action && (
        <div className="page-head-actions">
          <Bone className="skeleton-button" />
        </div>
      )}
    </div>
  )
}

function Rows({ count = 5 }: { count?: number }) {
  return (
    <div className="skeleton-list">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row" data-testid="skeleton-row">
          <div className="skeleton-stack">
            <Bone className="skeleton-text skeleton-text--row-title" />
            <Bone className="skeleton-text skeleton-text--meta" />
          </div>
          <Bone className="skeleton-text skeleton-text--row-meta" />
        </div>
      ))}
    </div>
  )
}

function Chips({ count = 4 }: { count?: number }) {
  return (
    <div className="skeleton-chips">
      {Array.from({ length: count }, (_, i) => <Bone key={i} className="skeleton-chip" />)}
    </div>
  )
}

function Tabs() {
  return (
    <div className="skeleton-tabs">
      <Bone className="skeleton-text skeleton-text--tab" />
      <Bone className="skeleton-text skeleton-text--tab" />
      <Bone className="skeleton-text skeleton-text--tab" />
    </div>
  )
}

/** The card-grid skeleton, shared with in-page loading states (R15-14). */
export function SkeletonCardGrid() {
  return (
    <div className="route-loading-grid" data-testid="route-loading-grid">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="route-loading-card" data-testid="route-loading-card">
          <Bone className="skeleton-card-chip" />
          <Bone className="skeleton-text skeleton-text--card-title" />
          <div className="skeleton-stack">
            <Bone className="skeleton-text skeleton-text--copy" />
            <Bone className="skeleton-text skeleton-text--copy skeleton-text--short" />
          </div>
          <div className="skeleton-card-footer">
            <Bone className="skeleton-avatar" />
            <Bone className="skeleton-text skeleton-text--meta" />
          </div>
        </div>
      ))}
    </div>
  )
}

function Stream() {
  return (
    <div className="skeleton-stream">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="skeleton-panel skeleton-stream-card">
          <div className="skeleton-card-footer skeleton-card-footer--head">
            <Bone className="skeleton-avatar" />
            <Bone className="skeleton-text skeleton-text--meta" />
          </div>
          <Bone className="skeleton-text skeleton-text--row-title" />
          <Bone className="skeleton-text skeleton-text--copy skeleton-text--short" />
        </div>
      ))}
    </div>
  )
}

function Paragraphs({ count = 4 }: { count?: number }) {
  return (
    <div className="skeleton-prose">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-stack">
          <Bone className="skeleton-text skeleton-text--prose" />
          <Bone className="skeleton-text skeleton-text--prose" />
          <Bone className="skeleton-text skeleton-text--prose skeleton-text--short" />
        </div>
      ))}
    </div>
  )
}

function Fields() {
  return (
    <div className="skeleton-panel skeleton-form">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="skeleton-stack">
          <Bone className="skeleton-text skeleton-text--label" />
          <Bone className="skeleton-input" />
        </div>
      ))}
      <Bone className="skeleton-button skeleton-button--end" />
    </div>
  )
}

function Stats() {
  return (
    <div className="skeleton-stats">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="skeleton-stack">
          <Bone className="skeleton-text skeleton-text--meta" />
          <Bone className="skeleton-text skeleton-text--stat" />
        </div>
      ))}
    </div>
  )
}

function SpecBody({ body }: { body: Body }) {
  switch (body) {
    case 'cards':
      return <SkeletonCardGrid />
    case 'stream':
      return <Stream />
    case 'today':
      return (
        <div className="skeleton-split">
          <div className="skeleton-stack">
            <Bone className="skeleton-text skeleton-text--section" />
            <Rows count={3} />
          </div>
          <Rows count={4} />
        </div>
      )
    case 'search':
      return (
        <>
          <Bone className="skeleton-input skeleton-input--search" />
          <Chips count={5} />
          <Rows />
        </>
      )
    case 'inbox':
      return (
        <>
          <Tabs />
          <Chips />
          <Rows />
        </>
      )
    case 'ledger':
      return (
        <>
          <Stats />
          <Chips count={6} />
          <Rows count={4} />
        </>
      )
    case 'form':
      return <Fields />
    case 'reader':
      return <Paragraphs />
    case 'canvas':
      return <Bone className="skeleton-canvas" />
    case 'rows':
      return <Rows />
  }
}

const SHELL_CLASS: Record<Shell, string> = {
  shell: 'page-shell',
  grid: 'page-shell page-shell--grid',
  narrow: 'page-shell page-shell--narrow',
}

/** The product library desk: collections rail, divider track, head, meta row and bookmark rows. */
function DeskBones() {
  return (
    <div className="page-shell">
      <div className="skeleton-desk">
        <div className="skeleton-desk-nav" data-testid="skeleton-desk-nav">
          <div className="skeleton-desk-nav-head">
            <Bone className="skeleton-desk-mark" />
            <Bone className="skeleton-text skeleton-text--nav-title" />
          </div>
          <div className="skeleton-stack skeleton-desk-nav-group">
            <Bone className="skeleton-text skeleton-text--nav" />
            <Bone className="skeleton-text skeleton-text--nav" />
          </div>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton-stack skeleton-desk-nav-group">
              <Bone className="skeleton-text skeleton-text--eyebrow" />
              <Bone className="skeleton-text skeleton-text--nav" />
            </div>
          ))}
        </div>
        <div className="skeleton-desk-main">
          <HeadBones head={{ layout: 'split', workbench: true, eyebrow: true, lede: true, action: true }} />
          <div className="skeleton-desk-meta">
            <Bone className="skeleton-text skeleton-text--count" />
            <Bone className="skeleton-input skeleton-input--desk" />
          </div>
          <Rows count={4} />
        </div>
      </div>
    </div>
  )
}

/** Public profile: display-mode bar, avatar masthead with stats strip, collection cards. */
function ProfileBones() {
  return (
    <div className="page-shell skeleton-profile-page">
      <div className="page-shell-inner">
        <Bone className="skeleton-chip skeleton-chip--modebar" />
        <div className="page-head page-head--masthead page-head--editorial skeleton-head">
          <div className="page-head-avatar">
            <Bone className="skeleton-avatar skeleton-avatar--profile" />
          </div>
          <div className="page-head-copy skeleton-stack">
            <Bone className="skeleton-text skeleton-text--title" />
            <Bone className="skeleton-text skeleton-text--meta" />
          </div>
          <div className="page-head-actions">
            <Bone className="skeleton-button" />
          </div>
          <div className="page-head-stats skeleton-stats skeleton-stats--strip">
            <Bone className="skeleton-text skeleton-text--meta" />
            <Bone className="skeleton-text skeleton-text--meta" />
            <Bone className="skeleton-text skeleton-text--meta" />
          </div>
        </div>
        <SkeletonCardGrid />
      </div>
    </div>
  )
}

/** Centered auth card (Login / Register / Consent…): heading, fields, submit. */
function AuthBones() {
  return (
    <div className="skeleton-auth">
      <div className="skeleton-panel skeleton-auth-card">
        <Bone className="skeleton-text skeleton-text--eyebrow" />
        <Bone className="skeleton-text skeleton-text--auth-title" />
        <Bone className="skeleton-text skeleton-text--copy" />
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="skeleton-stack">
            <Bone className="skeleton-text skeleton-text--label" />
            <Bone className="skeleton-input" />
          </div>
        ))}
        <Bone className="skeleton-button skeleton-button--block" />
      </div>
    </div>
  )
}

/** Reading column (reader, path reader, member digest): editorial head over prose. */
function ReadingBones() {
  return (
    <div className="page-shell page-shell--narrow">
      <div className="page-shell-inner">
        <HeadBones head={{ layout: 'stack', crumb: true, eyebrow: true, lede: true }} />
        <Paragraphs count={5} />
      </div>
    </div>
  )
}

/** Bookmark detail (R15-32): trail, link card with its mark and action rail,
    the collection aside and the reading column, on the page's own classes. */
function ResourceBones() {
  return (
    <div className="page-shell">
      <div className="page-shell-inner">
        <div className="resource-detail">
          <Bone className="skeleton-text skeleton-text--crumb" />
          <div className="resource-layout">
            <div className="page-head page-head--editorial resource-head skeleton-head">
              <div className="page-head-avatar">
                <Bone className="skeleton-avatar" />
              </div>
              <div className="page-head-copy skeleton-stack">
                <Bone className="skeleton-text skeleton-text--eyebrow" />
                <Bone className="skeleton-text skeleton-text--title" />
                <Bone className="skeleton-text skeleton-text--lede" />
              </div>
              <div className="page-head-actions">
                <Bone className="skeleton-button" />
              </div>
            </div>
            <div className="resource-aside skeleton-stack">
              <Bone className="skeleton-text skeleton-text--eyebrow" />
              <Bone className="skeleton-text skeleton-text--row-title" />
              <Bone className="skeleton-text skeleton-text--meta" />
            </div>
            <div className="resource-main">
              <Paragraphs count={2} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function LayoutBones({ layout }: { layout: SkeletonLayout }) {
  if (layout === 'desk') return <DeskBones />
  if (layout === 'profile') return <ProfileBones />
  if (layout === 'auth') return <AuthBones />
  if (layout === 'reading') return <ReadingBones />
  if (layout === 'resource') return <ResourceBones />
  if (layout === 'collection') return null
  return (
    <div className={SHELL_CLASS[layout.shell]} data-testid="skeleton-shell">
      <div className="page-shell-inner">
        <HeadBones head={layout.head} />
        <SpecBody body={layout.body} />
      </div>
    </div>
  )
}

/**
 * A full-page skeleton for `layout`, announced once as a polite status. Pages
 * whose first load replaces the whole view render this instead of a bare
 * loading dot, so they continue the Suspense fallback rather than blanking it.
 */
export function PageSkeleton({
  layout,
  label = 'Loading page',
  ...rest
}: { layout: SkeletonLayout; label?: string } & { 'data-testid'?: string }) {
  if (layout === 'collection') return <CollectionSkeleton label={label} {...rest} />
  return (
    <div className="route-loading" role="status" aria-live="polite" data-skeleton={typeof layout === 'string' ? layout : layout.body} {...rest}>
      <span className="visually-hidden">{label}</span>
      <div aria-hidden>
        <LayoutBones layout={layout} />
      </div>
    </div>
  )
}

/**
 * The skeleton for the current route. Layout's Suspense fallback renders it
 * bare; a page whose own first load replaces the whole view renders it with
 * its status label, continuing the fallback instead of blanking it.
 */
export function RouteLoading(props: { label?: string; 'data-testid'?: string }) {
  const { pathname } = useLocation()
  return <PageSkeleton layout={layoutForPath(pathname)} {...props} />
}
