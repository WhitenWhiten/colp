import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { isCommunityExposureEnabled, isLive, isReadableReplicaExposureEnabled } from '../api'
import { graphPath } from '../lib/graphNavigation'
import { loginPath } from '../lib/chrome'
import { plural } from '../lib/plural'
import { useAuth } from '../auth/AuthContext'
import { ABSENCE_CORNERS, AbsenceStage } from '../components/AbsenceStage'
import { useToast } from '../components/AppToast'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { EmptyState } from '../components/EmptyState'
import { PageSkeleton } from '../components/RouteLoading'
import { DomainMark } from '../components/DomainMark'
import { ReportButton } from '../components/ReportContentDialog'
import { useAnnotationWorkflow, type AnnotationSubjectLocator } from '../lib/useAnnotationWorkflow'
import { relationEndpointDisambiguator, useRelationWorkflow, type RelationLocator, type RelationNodeOption } from '../lib/useRelationWorkflow'
import {
  resourceBackPath,
  resourceDetailPath,
  resourceNodeEmptyCopy,
  resourceReaderPath,
  useResourceNode,
} from '../lib/useResourceNode'
import { safeExternalUrl } from '../lib/publicCollectionTree'
import type { AnnotationView, RelationType, RelationView, RelationVisibility } from '../api'
import { SavedResourceButton } from '../components/SavedResourceButton'
import { CommunityVoteControl } from '../components/CommunityVoteControl'
import { CommunityComments } from '../components/CommunityComments'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { usePageMeta, type PageMeta } from '../lib/usePageMeta'
import { PAGE_META_DESCRIPTION_MAX, normalizePageMetaText } from '../lib/pageMetaText'
import { AnnotationText } from '../components/annotation-markdown'
// Route-owned stylesheet (see main.tsx); ships with this route chunk.
import '../styles/not-found.css'
import '../styles/resource-detail.css'
import { UGC_REL } from '../lib/ugcRel'
import { brandedTitle, productName } from '../lib/edition'

const RELATION_TYPES: RelationType[] = ['related', 'precedes', 'follows', 'supports', 'contradicts', 'duplicate_of', 'derived_from', 'mentions', 'custom']
const RELATION_TYPE_LABEL: Record<RelationType, string> = {
  related: 'Related', precedes: 'Precedes', follows: 'Follows', supports: 'Supports',
  contradicts: 'Contradicts', duplicate_of: 'Duplicate', derived_from: 'Derived from',
  mentions: 'Mentions', custom: 'Custom',
}
const RELATION_VISIBILITIES: RelationVisibility[] = ['private', 'protected', 'unlisted', 'public']
const RELATION_VISIBILITY_LABEL: Record<RelationVisibility, string> = { private: 'Private', protected: 'Protected', unlisted: 'Unlisted', public: 'Public' }
const RELATION_CREATE_FORM_ID = 'relation-create-form'

function annotationText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function annotationRenderFormat(annotation: AnnotationView | null | undefined): 'plain' | 'markdown' {
  return annotation?.format === 'markdown' && typeof annotation.value === 'string'
    ? 'markdown'
    : 'plain'
}

function annotationBodyText(annotation: AnnotationView): string {
  const { value } = annotation
  if (annotation.type === 'highlight' && value && typeof value === 'object' && 'quote' in value
    && typeof value.quote === 'string') return value.quote
  return annotationText(value)
}

function ResourceStateMeta({ title, meta }: { title: string; meta: PageMeta }) {
  useDocumentTitle(title)
  usePageMeta(meta, brandedTitle(title))
  return null
}

const RESOURCE_DESCRIPTION_PREFIX = 'Read “'
const RESOURCE_DESCRIPTION_SUFFIX = `” in a curated ${productName()} collection.`

function resourcePageDescription(title: string): string {
  const titleMax = PAGE_META_DESCRIPTION_MAX
    - RESOURCE_DESCRIPTION_PREFIX.length
    - RESOURCE_DESCRIPTION_SUFFIX.length
  const normalizedTitle = normalizePageMetaText(title, titleMax)
  return `${RESOURCE_DESCRIPTION_PREFIX}${normalizedTitle}${RESOURCE_DESCRIPTION_SUFFIX}`
}

/** Grammatical "2 notes · 3 highlights" summary for the annotation count slot. */
function annotationSummaryCopy(items: AnnotationView[]): string {
  const notes = items.filter((item) => item.type === 'note').length
  const highlights = items.length - notes
  const parts: string[] = []
  if (notes > 0) parts.push(plural(notes, 'note'))
  if (highlights > 0) parts.push(plural(highlights, 'highlight'))
  return parts.length > 0 ? parts.join(' · ') : 'No notes yet'
}

/** Source line copy: the href without its scheme or a trailing slash. */
function displayUrl(href: string): string {
  return href.replace(/^https?:\/\//u, '').replace(/\/$/u, '')
}

/**
 * Long titles clamp to two lines with an expand toggle. Clamping is pure CSS
 * (full text stays in the DOM for screen readers / find-in-page); overflow
 * is detected by comparing scroll and client heights so the toggle only
 * renders when the title actually truncates. While expanded we skip
 * measuring — the unclamped span would report no overflow and the toggle
 * would collapse itself.
 */
function ClampedResourceTitle({ title }: { title: string }) {
  const textRef = useRef<HTMLSpanElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    if (expanded) return
    const el = textRef.current
    if (!el) return
    const measure = () => {
      setTruncated(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [title, expanded])

  return (
    <span className="resource-title" data-expanded={expanded || undefined}>
      <span ref={textRef} className="resource-title-text" dir="auto">{title}</span>
      {truncated ? (
        <button
          type="button"
          className="resource-title-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show full title'}
        </button>
      ) : null}
    </span>
  )
}

export function ResourceDetail() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const { user, isLoggedIn, bootstrapping } = useAuth()
  // Resource-owned drafts and pending writes never carry into another endpoint or identity.
  const key = JSON.stringify([id, params.get('collectionId'), params.get('slug'), params.get('fromGraph'), user?.profileId, isLoggedIn, bootstrapping])
  return <ResourceDetailContent key={key} />
}

function ResourceDetailContent() {
  const { id = '' } = useParams()
  const [searchParams] = useSearchParams()
  const { isLoggedIn, bootstrapping } = useAuth()
  const allowWrite = isLoggedIn || bootstrapping
  const resolved = useResourceNode(id, searchParams.get('fromGraph') === '1')
  const { toast } = useToast()
  const annotationsEnabled = isLive('annotations')
    || String(import.meta.env?.VITE_ANNOTATIONS_ACCEPTANCE ?? '').toLowerCase() === 'true'
  const collectionId = searchParams.get('collectionId')?.trim() ?? ''
  const resourceType = searchParams.get('subjectType') === 'collection' ? 'collection' : 'node'
  const workspaceQuery = {
    collectionId: searchParams.get('collectionId'),
    subjectType: searchParams.get('subjectType'),
    slug: searchParams.get('slug'),
    fromGraph: searchParams.get('fromGraph') === '1',
  }
  const annotationLocator = useMemo<AnnotationSubjectLocator | null>(() => (
    allowWrite && annotationsEnabled && (collectionId || (resolved.status === 'ready' ? resolved.collectionId : ''))
      ? {
          collectionId: collectionId || (resolved.status === 'ready' ? resolved.collectionId : ''),
          resourceType,
          resourceId: id,
        }
      : null
  ), [allowWrite, annotationsEnabled, collectionId, id, resolved, resourceType])
  const annotation = useAnnotationWorkflow(annotationLocator)
  const relationsEnabled = isLive('relations')
    || String(import.meta.env?.VITE_RELATIONS_ACCEPTANCE ?? '').toLowerCase() === 'true'
  const relationLocator = useMemo<RelationLocator | null>(() => (
    allowWrite && relationsEnabled && collectionId && resourceType === 'node'
      ? { collectionId, nodeId: id }
      : null
  ), [allowWrite, collectionId, id, relationsEnabled, resourceType])
  const [newRelation, setNewRelation] = useState<{ endpointId: string; type: RelationType; label: string; visibility: RelationVisibility }>({ endpointId: '', type: 'related', label: '', visibility: 'private' })
  /* The create form is a disclosure: closed by default so the section reads
     as the bookmark's connections, not as an admin console. Opening moves
     focus into the first field; Cancel hands it back to the disclosure. */
  const [creatingRelation, setCreatingRelation] = useState(false)
  const relationDraftDirty = creatingRelation && Boolean(newRelation.endpointId || newRelation.label || newRelation.type !== 'related' || newRelation.visibility !== 'private')
  const relations = useRelationWorkflow(relationLocator, relationDraftDirty)
  const relationMutationLocked = relations.state === 'loading' || relations.state === 'saving' || relations.state === 'unknown' || relations.state === 'conflict'
  const addRelationButton = useRef<HTMLButtonElement | null>(null)
  const relationEndpointSelect = useRef<HTMLSelectElement | null>(null)
  const lastEditButton = useRef<HTMLButtonElement | null>(null)
  const identityCopy = resourceNodeEmptyCopy(resolved)
  const slug = workspaceQuery.slug?.trim() ?? ''
  const graphReturn = searchParams.get('fromGraph') === '1' && slug ? graphPath(slug, id) : null
  useEffect(() => {
    if (relations.createdCount === 0) return
    setCreatingRelation(false)
    setNewRelation({ endpointId: '', type: 'related', label: '', visibility: 'private' })
  }, [relations.createdCount])

  useEffect(() => {
    if (creatingRelation) relationEndpointSelect.current?.focus()
  }, [creatingRelation])

  /* The scroll manager lands every cross-page push at the top and SPA
     navigations never fire native anchor scroll, so the workspace deep link
     must honor its own hash once the section actually renders. */
  const { hash, pathname, search } = useLocation()
  useEffect(() => {
    if (hash !== '#resource-relations-heading' || resolved.status !== 'ready') return
    document.getElementById('resource-relations-heading')?.scrollIntoView({ block: 'start' })
  }, [hash, resolved.status])

  /* Loading and failure shells keep the same back control as the ready page —
     a dead end with no way back reads as broken, not quiet. */
  const shellBackHref = graphReturn ?? resourceBackPath(workspaceQuery)
  const shellBackLabel = graphReturn ? 'Back to graph' : workspaceQuery.collectionId?.trim() || workspaceQuery.slug?.trim()
    ? 'Back to the collection'
    : 'Back to library'
  const shellTrail = (
    <nav className="breadcrumb resource-back" aria-label="Breadcrumb">
      <Link to={shellBackHref} className="trail-back" tabIndex={-1} aria-hidden>
        <Icon name="arrow-left" />
      </Link>
      <Link to={shellBackHref}>{shellBackLabel}</Link>
    </nav>
  )

  if (resolved.status === 'loading') {
    /* R15-32: continue the route skeleton (same bones) instead of
       skeleton → loading dots → card. */
    return (
      <>
        <ResourceStateMeta title="Bookmark" meta={{}} />
        <PageSkeleton layout="resource" label="Loading bookmark" />
      </>
    )
  }

  if (resolved.status === 'unavailable' && identityCopy) {
    return (
      <>
        <ResourceStateMeta
          title={identityCopy.title}
          meta={{ canonicalPath: null, robots: 'noindex' }}
        />
        <AbsenceStage
          title={identityCopy.title}
          description={identityCopy.description}
          corners={ABSENCE_CORNERS.resource}
          exits={[{ to: shellBackHref, label: shellBackLabel }]}
        />
      </>
    )
  }

  if (resolved.status !== 'ready' || identityCopy) {
    return (
      <PageShell sections>
        <ResourceStateMeta
          title={identityCopy?.title ?? 'Bookmark unavailable'}
          meta={{ canonicalPath: null, robots: 'noindex' }}
        />
        <PageSection className="resource-detail reading-shell">
          {shellTrail}
          <EmptyState
            icon={resolved.status === 'folder' ? 'folder' : resolved.status === 'auth-required' ? 'collection' : 'book'}
            titleAs="h1"
            title={identityCopy?.title ?? 'Bookmark unavailable'}
            description={identityCopy?.description}
            action={identityCopy?.login
              ? <Link to={loginPath(pathname, search)} className="btn btn-secondary">Sign in</Link>
              : resolved.status === 'needs-collection'
                ? <Link to="/library" className="btn btn-secondary">Open library</Link>
                : undefined}
          />
        </PageSection>
      </PageShell>
    )
  }

  const node = resolved.node
  const isContainer = node.kind === 'folder' || node.kind === 'root'
  const originalHref = safeExternalUrl(node.url)
  const publicationSlug = resolved.publicationSlug
  const tldrText = annotation.tldr ? annotationText(annotation.tldr.value).trim() : ''
  const tldrFormat = annotationRenderFormat(annotation.tldr)
  const tldrAi = annotation.tldr?.provenance?.kind === 'ai'
  const readerEnabled = isReadableReplicaExposureEnabled()
  const readerHref = resourceReaderPath(node.id, workspaceQuery)
  const backHref = graphReturn ?? resourceBackPath(workspaceQuery, resolved)
  const hasRelations = relations.outgoing.length > 0 || relations.incoming.length > 0
  const relationsSettled = relations.state !== 'loading' && relations.state !== 'error'
  const onEditRelation = (relation: RelationView, button: HTMLButtonElement) => {
    lastEditButton.current = button
    relations.beginEdit(relation)
  }
  const kindLabel = node.kind === 'root' ? 'Collection' : node.kind === 'folder' ? 'Folder' : 'Bookmark'
  const hostLabel = !isContainer && node.host !== '-' ? node.host : ''
  const votesShown = isCommunityExposureEnabled() && !isContainer && !bootstrapping

  const backLabel = graphReturn ? 'Back to graph' : resolved.collectionTitle
  const showSignIn = !allowWrite && (annotationsEnabled || relationsEnabled)

  return (
    <PageShell>
      <div className="resource-detail">
        <nav className="breadcrumb resource-back" aria-label="Breadcrumb">
          <Link to={backHref} className="trail-back" tabIndex={-1} aria-hidden>
            <Icon name="arrow-left" />
          </Link>
          <Link to={backHref} title={resolved.collectionTitle}>{backLabel}</Link>
        </nav>

        <div className="resource-layout">
          {/* The link card: the bookmark as an object — source identity,
              title, what it is, where it points — with its actions on the
              card's own footer rail. */}
          <PageHead
            as="header"
            className="page-head--editorial resource-head"
            avatar={
              isContainer ? (
                <span className="resource-mark resource-mark--tile">
                  <Icon name={node.kind === 'root' ? 'book' : 'folder'} />
                </span>
              ) : (
                <span className="resource-mark">
                  <DomainMark host={node.host} pageUrl={node.url} iconUrl={node.iconUrl} faviconCdnAllowed={node.faviconCdnAllowed} />
                </span>
              )
            }
            eyebrow={
              <span className="resource-kicker">
                {hostLabel ? <span className="resource-kicker-host">{hostLabel.replace(/^www\./u, '')}</span> : null}
                <span className="chip chip--kind">{kindLabel}</span>
              </span>
            }
            title={<ClampedResourceTitle key={node.id} title={node.title} />}
            documentTitle={node.title}
            meta={{
              description: resourcePageDescription(node.title),
              canonicalPath: slug && !isContainer
                ? `/r/${encodeURIComponent(id)}?slug=${encodeURIComponent(slug)}`
                : null,
              robots: slug && !isContainer ? null : 'noindex',
            }}
            lede={node.description || undefined}
            actions={!isContainer || originalHref ? (
              <>
                {originalHref && (
                  <a
                    className={readerEnabled && !isContainer ? 'btn btn-secondary' : 'btn btn-primary'}
                    href={originalHref}
                    target="_blank"
                    rel={UGC_REL}
                  >
                    Open original
                    <Icon name="arrow-up-right" />
                  </a>
                )}
                {readerEnabled && !isContainer && <Link to={readerHref} className="btn btn-primary">
                  <Icon name="book" />
                  Read in {productName()}
                </Link>}
                {/* R7-04: the flag-off fallback must not claim a library write. */}
                {!isContainer && (isLive('savedResources')
                  ? <SavedResourceButton resourceType={resourceType} resourceId={node.id} />
                  : <button type="button" className="btn btn-secondary" onClick={() => toast('Saving bookmarks is not available yet')}>Save</button>)}
                {/* R15-11: public bookmark pages carry a report path. */}
                {!isContainer && slug ? (
                  <ReportButton
                    target={{ kind: 'bookmark', id: node.id, collectionId: resolved.collectionId }}
                    label="this bookmark"
                    testId="report-bookmark"
                    className="btn btn-ghost"
                  />
                ) : null}
              </>
            ) : undefined}
            stats={votesShown ? (
              /* CS-01: bookmark votes key off the server-minted generation;
                 the control re-resolves on revision_conflict itself. */
              <CommunityVoteControl
                query={{ kind: 'bookmark', id: node.id, collectionId: resolved.collectionId }}
              />
            ) : undefined}
          >
            {/* A bare-domain URL would only repeat the host line. */}
            {originalHref && displayUrl(originalHref).replace(/^www\./u, '') !== hostLabel.replace(/^www\./u, '') ? (
              <a
                className="resource-url"
                href={originalHref}
                target="_blank"
                rel={UGC_REL}
                title={originalHref}
              >
                <Icon name="link" />
                <span>{displayUrl(originalHref)}</span>
              </a>
            ) : null}
          </PageHead>

          <div className="resource-main">
            {tldrText && (
              <section className="resource-tldr panel panel-pad">
                <h2 className="section-label resource-tldr-eyebrow">
                  <Icon name="sparkle" />
                  {tldrAi ? 'AI TL;DR' : 'TL;DR'}
                </h2>
                <div className="resource-tldr-body" data-testid="resource-tldr-body">
                  <AnnotationText value={tldrText} format={tldrFormat} variant="document" />
                </div>
              </section>
            )}

            {/* Guests get one quiet invitation instead of two empty
                sections that each asked them to sign in. */}
            {showSignIn && (
              <section className="resource-signin" aria-labelledby="resource-signin-heading">
                <span className="resource-signin-mark" aria-hidden><Icon name="lock" /></span>
                <div className="resource-signin-copy">
                  <h2 id="resource-signin-heading">Notes and relations</h2>
                  <p>Sign in to see notes, highlights and relations on this bookmark.</p>
                </div>
                <Link to={loginPath(pathname, search)} className="btn btn-secondary btn-sm">Sign in</Link>
              </section>
            )}

            {annotationsEnabled && allowWrite && (
              <section className="resource-section" aria-labelledby="resource-annotation-heading">
                <div className="section-head section-head--split resource-section-head">
                  <h2 id="resource-annotation-heading">Annotations</h2>
                  <p className="resource-section-status" role="status" aria-live="polite"
                    data-error={annotation.state === 'error' ? 'true' : undefined}>
                    {annotation.state === 'loading'
                      ? 'Loading annotations'
                      : annotation.state === 'error'
                        ? annotation.message
                        : annotationSummaryCopy(annotation.annotations)}
                  </p>
                </div>
                {annotation.annotations.length > 0 ? (
                  <div className="resource-annotation-list" data-testid="resource-annotation-list">
                    {annotation.annotations.map((item, index) => (
                      <article className="resource-annotation-item" data-kind={item.type} data-testid="resource-annotation-item" key={item.id}>
                        <h3 className="section-label resource-annotation-kind">{item.type === 'note' ? 'Note' : 'Highlight'}</h3>
                        <blockquote
                          className="resource-annotation-preview"
                          data-testid={index === 0 ? 'resource-annotation-preview' : undefined}
                        >
                          <AnnotationText
                            value={annotationBodyText(item)}
                            format={annotationRenderFormat(item)}
                            variant="document"
                          />
                        </blockquote>
                      </article>
                    ))}
                  </div>
                ) : null}
                {readerEnabled && annotationLocator ? (
                  <Link className="btn btn-secondary btn-sm resource-section-cta" to={readerHref}>
                    Open reading view
                  </Link>
                ) : collectionId ? (
                  <Link
                    className="btn btn-secondary btn-sm resource-section-cta"
                    to={`/library/${encodeURIComponent(collectionId)}?node=${encodeURIComponent(node.id)}`}
                  >
                    Edit details
                  </Link>
                ) : !annotationLocator ? (
                  <p className="meta">Open this bookmark from its collection to see notes.</p>
                ) : null}
              </section>
            )}

            {relationsEnabled && allowWrite ? (
              <section className="resource-section resource-relations" aria-labelledby="resource-relations-heading" data-testid="relation-workspace">
                <div className="section-head section-head--split resource-section-head">
                  <h2 id="resource-relations-heading">Relations</h2>
                  {allowWrite && (
                    <div className="resource-relations-tools">
                      <p className="resource-section-status" role="status" aria-live="polite" data-relation-state={relations.state} data-error={relations.state === 'error' ? 'true' : undefined}>{relations.message}</p>
                      {relationLocator && relations.canEdit && (
                        <button
                          ref={addRelationButton}
                          className="btn btn-secondary btn-sm"
                          type="button"
                          disabled={relationMutationLocked}
                          aria-expanded={creatingRelation}
                          aria-controls={creatingRelation ? RELATION_CREATE_FORM_ID : undefined}
                          onClick={() => setCreatingRelation((open) => !open)}
                        >
                          Add relation
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {!relations.editing && relations.state === 'unknown' && <button className="btn btn-secondary btn-sm relation-recovery" type="button" onClick={relations.retry}>Retry</button>}
                {!relations.editing && relations.state === 'conflict' && <button className="btn btn-secondary btn-sm relation-recovery" type="button" onClick={relations.startNew}>Start new action</button>}
                {relations.state === 'error' && <button className="btn btn-secondary btn-sm relation-recovery" type="button" onClick={() => void relations.reload()}>Refresh relations</button>}

                {allowWrite && relations.canEdit && relationLocator && creatingRelation && (
                  <form id={RELATION_CREATE_FORM_ID} className="relation-form relation-create" onSubmit={(event) => { event.preventDefault(); void relations.create(newRelation) }} aria-label="Create relation">
                    <div className="field"><label htmlFor="relation-new-target">Linked bookmark</label>
                      <select id="relation-new-target" aria-label="Linked bookmark" ref={relationEndpointSelect} value={newRelation.endpointId} disabled={relationMutationLocked} onChange={(event) => setNewRelation((current) => ({ ...current, endpointId: event.target.value }))} required>
                        <option value="">Select a bookmark</option>
                        {relations.nodes.map((nodeOption) => <option key={nodeOption.id} value={nodeOption.id}>{nodeOption.title} ({relationEndpointDisambiguator(nodeOption)})</option>)}
                      </select>
                    </div>
                    <div className="field"><label htmlFor="relation-new-type">Type</label>
                      <select id="relation-new-type" aria-label="New relation type" value={newRelation.type} disabled={relationMutationLocked} onChange={(event) => setNewRelation((current) => ({ ...current, type: event.target.value as RelationType }))}>
                        {RELATION_TYPES.map((type) => <option key={type} value={type}>{RELATION_TYPE_LABEL[type]}</option>)}
                      </select>
                    </div>
                    <div className="field"><label htmlFor="relation-new-label">Label</label>
                      <input id="relation-new-label" aria-label="New relation label" value={newRelation.label} disabled={relationMutationLocked} maxLength={4096} onChange={(event) => setNewRelation((current) => ({ ...current, label: event.target.value }))} />
                    </div>
                    <div className="field"><label htmlFor="relation-new-visibility">Visibility</label>
                      <select id="relation-new-visibility" aria-label="New relation visibility" value={newRelation.visibility} disabled={relationMutationLocked} onChange={(event) => setNewRelation((current) => ({ ...current, visibility: event.target.value as RelationVisibility }))}>
                        {RELATION_VISIBILITIES.map((visibility) => <option key={visibility} value={visibility}>{RELATION_VISIBILITY_LABEL[visibility]}</option>)}
                      </select>
                    </div>
                    <div className="relation-form-actions">
                      <button className="btn btn-primary btn-sm" type="submit" disabled={!newRelation.endpointId || relationMutationLocked}>Create relation</button>
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setCreatingRelation(false); queueMicrotask(() => addRelationButton.current?.focus()) }}>Cancel</button>
                    </div>
                  </form>
                )}

                {allowWrite && relationLocator && !hasRelations && relationsSettled && (
                  <p className="resource-relations-empty">No relations yet.</p>
                )}

                {allowWrite && hasRelations && (
                  <>
                    <RelationDirection title="Outgoing relations" relations={relations.outgoing} nodes={relations.nodes} currentNodeId={id} collectionId={collectionId} graphSlug={graphReturn ? slug : undefined} canEdit={relations.canEdit} disabled={relationMutationLocked} onEdit={onEditRelation} onDelete={relations.remove} />
                    <RelationDirection title="Incoming relations" relations={relations.incoming} nodes={relations.nodes} currentNodeId={id} collectionId={collectionId} graphSlug={graphReturn ? slug : undefined} canEdit={relations.canEdit} disabled={relationMutationLocked} onEdit={onEditRelation} onDelete={relations.remove} />
                  </>
                )}

                {allowWrite && relations.canEdit && relations.editing && (
                  <form className="relation-form relation-editor" aria-label="Edit relation" onSubmit={(event) => { event.preventDefault(); relations.save() }}>
                    <h3>Edit relation</h3>
                    <div className="field"><label htmlFor="relation-edit-label">Label</label><input id="relation-edit-label" aria-label="Relation label" disabled={relationMutationLocked} maxLength={4096} value={relations.editDraft.label} onChange={(event) => relations.setEditDraft((draft) => ({ ...draft, label: event.target.value }))} /></div>
                    <div className="field"><label htmlFor="relation-edit-type">Type</label><select id="relation-edit-type" aria-label="Relation type" disabled={relationMutationLocked} value={relations.editDraft.type} onChange={(event) => relations.setEditDraft((draft) => ({ ...draft, type: event.target.value as RelationType }))}>{RELATION_TYPES.map((type) => <option key={type} value={type}>{RELATION_TYPE_LABEL[type]}</option>)}</select></div>
                    <div className="field"><label htmlFor="relation-edit-visibility">Visibility</label><select id="relation-edit-visibility" aria-label="Relation visibility" disabled={relationMutationLocked} value={relations.editDraft.visibility} onChange={(event) => relations.setEditDraft((draft) => ({ ...draft, visibility: event.target.value as RelationVisibility }))}>{RELATION_VISIBILITIES.map((visibility) => <option key={visibility} value={visibility}>{RELATION_VISIBILITY_LABEL[visibility]}</option>)}</select></div>
                    <div className="relation-replacement">
                      <div className="field"><label htmlFor="relation-edit-replace">Replace with</label><select id="relation-edit-replace" aria-label="Replace with" disabled={relationMutationLocked} value={relations.editDraft.replacementEndpointId} onChange={(event) => relations.setEditDraft((draft) => ({ ...draft, replacementEndpointId: event.target.value }))}><option value="">Select a live bookmark</option>{relations.nodes.map((nodeOption) => <option key={nodeOption.id} value={nodeOption.id}>{nodeOption.title} ({relationEndpointDisambiguator(nodeOption)})</option>)}</select></div>
                      <button className="btn btn-secondary btn-sm" type="button" disabled={!relations.editDraft.replacementEndpointId || relations.editDraft.replacementEndpointId === id || relationMutationLocked} onClick={() => void relations.replaceEndpoint()}>Replace linked bookmark</button>
                    </div>
                    <div className="relation-form-actions">
                      <button className="btn btn-primary btn-sm" type="submit" disabled={relationMutationLocked}>Save relation</button>
                      {relations.state === 'unknown' && <button className="btn btn-secondary btn-sm" type="button" onClick={relations.retry}>Retry save</button>}
                      {relations.state === 'conflict' && <button className="btn btn-secondary btn-sm" type="button" onClick={relations.startNew}>Start new change</button>}
                      <button className="btn btn-ghost btn-sm" type="button" disabled={relationMutationLocked} onClick={() => { relations.cancelEdit(); queueMicrotask(() => lastEditButton.current?.focus()) }}>Cancel relation edit</button>
                    </div>
                  </form>
                )}
              </section>
            ) : null}
          </div>

          {/* R15-33: DOM order is the phone reading order (card, reading
              sections, aside, comments); from 900 px the grid places the
              aside in the second track, so no `order` or display: contents. */}
          <aside className="resource-aside" aria-label="Bookmark details">
            {/* Where it lives: the collection, its board and graph, and the
                way through it — previous / next ride the same card. */}
            <section className="resource-context">
              <h2 className="section-label">From the collection</h2>
              <Link to={backHref} className="resource-context-title">{resolved.collectionTitle}</Link>
              {publicationSlug ? (
                <p className="resource-context-links">
                  <Link to={`/c/${publicationSlug}`}>View on board</Link>
                  <Link to={graphPath(publicationSlug, node.id)}>Graph</Link>
                </p>
              ) : null}
              {(resolved.previous || resolved.next) && (
                <nav className="resource-neighbors" aria-label="More bookmarks in this collection">
                  {resolved.previous ? (
                    <Link className="resource-neighbor" to={resourceDetailPath(resolved.previous.id, workspaceQuery)}>
                      <Icon name="arrow-left" className="resource-neighbor-glyph" />
                      <span className="resource-neighbor-copy">
                        <span className="resource-neighbor-dir">Previous</span>
                        <span className="resource-neighbor-title">{resolved.previous.title}</span>
                      </span>
                    </Link>
                  ) : null}
                  {resolved.next ? (
                    <Link className="resource-neighbor is-next" to={resourceDetailPath(resolved.next.id, workspaceQuery)}>
                      <span className="resource-neighbor-copy">
                        <span className="resource-neighbor-dir">Next</span>
                        <span className="resource-neighbor-title">{resolved.next.title}</span>
                      </span>
                      <Icon name="arrow-right" className="resource-neighbor-glyph" />
                    </Link>
                  ) : null}
                </nav>
              )}
            </section>

            {node.tags.length > 0 && (
              <section className="resource-tags">
                <h2 className="section-label">Tags</h2>
                <div className="resource-tags-list">
                  {node.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
                </div>
              </section>
            )}
          </aside>

          {/* CS-03: bookmark comments key off the same resolved target
              identity (incl. server generation) as the vote control. */}
          {isCommunityExposureEnabled() && !isContainer && !bootstrapping ? (
            <div className="resource-comments">
              <CommunityComments
                query={{ kind: 'bookmark', id: node.id, collectionId: resolved.collectionId }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </PageShell>
  )
}

function RelationDirection({ title, relations, nodes, currentNodeId, collectionId, graphSlug, canEdit, disabled, onEdit, onDelete }: { title: string; relations: RelationView[]; nodes: RelationNodeOption[]; currentNodeId: string; collectionId: string; graphSlug?: string; canEdit: boolean; disabled: boolean; onEdit: (relation: RelationView, button: HTMLButtonElement) => void; onDelete: (relation: RelationView) => Promise<boolean> }) {
  const headingId = `relation-${title.toLowerCase().replaceAll(' ', '-')}`
  return <section className="relation-direction" aria-labelledby={headingId}>
    <h3 id={headingId} className="section-label">{title}</h3>
    {relations.length === 0 ? <p className="resource-relations-empty">No {title.toLowerCase()}.</p> : <ul>
      {relations.map((relation) => {
        const endpointId = relation.fromNodeId === currentNodeId ? relation.toNodeId : relation.fromNodeId
        const endpointNode = nodes.find((node) => node.id === endpointId)
        const endpointTitle = endpointNode?.title ?? 'Linked item'
        const endpointLabel = endpointNode ? `${endpointTitle} (${relationEndpointDisambiguator(endpointNode)})` : endpointTitle
        return <li key={relation.id} className="relation-row">
          <div className="relation-row-content">
            <span className="relation-row-main">
              <Icon
                name={relation.fromNodeId === currentNodeId ? 'arrow-up-right' : 'arrow-left'}
                className="relation-row-dir"
              />
              <Link to={resourceDetailPath(endpointId, { collectionId, subjectType: 'node', ...(graphSlug ? { slug: graphSlug, fromGraph: true } : {}) })} aria-label={endpointLabel}>{endpointTitle}</Link>
              <span className="chip">{RELATION_TYPE_LABEL[relation.type]}</span>
            </span>
            {relation.label && <span className="relation-label">{relation.label}</span>}
          </div>
          {canEdit && <div className="relation-row-actions">
            <button className="btn btn-ghost btn-sm" type="button" disabled={disabled} onClick={(event) => onEdit(relation, event.currentTarget)}>Edit relation</button>
            <button className="btn btn-danger-ghost btn-sm" type="button" disabled={disabled} onClick={() => void onDelete(relation)}>Delete relation</button>
          </div>}
        </li>
      })}
    </ul>}
  </section>
}
