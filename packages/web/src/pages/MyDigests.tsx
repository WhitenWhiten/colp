import { SharedDigests } from '../components/bookmark-subscriptions/SharedDigests'
import { useEffect, useState } from 'react'
import { canonicalSiteOrigin } from '../lib/chrome'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { isProductApiError, productClient, type ReportSeriesCreate } from '../api'
import { isReportsExposureEnabled } from '../api'
import { useAuth } from '../auth/AuthContext'
import { Breadcrumb } from '../components/Breadcrumb'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { Modal } from '../components/Modal'
import { PageHead } from '../components/PageHead'
import { RouteState } from '../components/RouteState'
import { PageShell } from '../components/PageShell'
import { StatusBadge } from '../components/StatusBadge'
import { DIGEST_VISIBILITIES, digestVisibilityLabel, digestVisibilityTone, type DigestVisibility } from '../lib/digestManage'
import { notifyMyReportsChanged, useMyReports } from '../lib/useMyReports'
import '../styles/digest-manage.css'

function NewDigestModal({ busy, error, onClose, onCreate }: {
  busy: boolean
  error: string | null
  onClose: () => void
  onCreate: (body: ReportSeriesCreate) => void
}) {
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [slug, setSlug] = useState('')
  const [visibility, setVisibility] = useState<DigestVisibility>('private')
  const [titleError, setTitleError] = useState<string | null>(null)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    if (!trimmedTitle) { setTitleError('A digest needs a title.'); return }
    onCreate({
      title: trimmedTitle,
      ...(summary.trim() ? { summary: summary.trim() } : {}),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      visibility,
      allowSearchIndexing: false,
    })
  }

  return (
    <Modal open onClose={onClose} label="New digest" title="New digest" size="sm">
      <form className="edit-form" onSubmit={submit} data-testid="new-digest-form">
        <p className="digest-note">
          A digest is a publication you curate. After creating it, you add issues from your collections and publish them.
        </p>
        <div className="field">
          <label htmlFor="nd-title">Title</label>
          <input
            id="nd-title"
            value={title}
            onChange={(event) => { setTitleError(null); setTitle(event.target.value) }}
            maxLength={512}
            disabled={busy}
            autoFocus
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? 'nd-title-error' : undefined}
          />
          {titleError && <p id="nd-title-error" className="field-error" role="alert">{titleError}</p>}
        </div>
        <div className="field">
          <label htmlFor="nd-summary">Summary (optional)</label>
          <textarea id="nd-summary" value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} maxLength={2000} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="nd-slug">Public address (optional)</label>
          <input id="nd-slug" value={slug} onChange={(event) => setSlug(event.target.value)} maxLength={128} disabled={busy} />
          <span className="field-hint">Lowercase letters, numbers and dashes — becomes the public address /reports/&lt;slug&gt;.</span>
        </div>
        <div className="field">
          <label htmlFor="nd-visibility">Visibility</label>
          <select id="nd-visibility" value={visibility} onChange={(event) => setVisibility(event.target.value as DigestVisibility)} disabled={busy}>
            {DIGEST_VISIBILITIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span className="field-hint">{DIGEST_VISIBILITIES.find((option) => option.value === visibility)?.hint}</span>
        </div>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="row-end">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create digest'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** /library/digests — the curator's own digest board: every owned or shared
    series as a nameplate row, plus the New digest entry the sidebar points
    at (?new=1 opens the create dialog directly). */
export function MyDigests() {
  // Same wording as the collection publication row ("Published at …").
  const publicHost = new URL(canonicalSiteOrigin()).host
  const { isLoggedIn, bootstrapping } = useAuth()
  const exposed = isReportsExposureEnabled() && isLoggedIn
  const mine = useMyReports(exposed)
  const [searchParams, setSearchParams] = useSearchParams()
  const [creating, setCreating] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (searchParams.get('new')) {
      setCreating(true)
      const next = new URLSearchParams(searchParams)
      next.delete('new')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const create = async (body: ReportSeriesCreate) => {
    setCreateBusy(true)
    setCreateError(null)
    try {
      const created = await productClient.createReport(body, {
        intentId: productClient.mutationIntentKey('create-report', productClient.newCommandId()),
        maxRetries: 0,
      })
      notifyMyReportsChanged()
      setCreating(false)
      navigate(`/library/digests/${encodeURIComponent(created.id)}`)
    } catch (error) {
      setCreateError(isProductApiError(error) ? error.recoveryHint : 'The digest could not be created')
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <PageShell variant="grid">
      <div className="digest-manage-page" data-testid="my-digests-page">
        <PageHead
          layout="split"
          variant="workbench"
          breadcrumb={
            <Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'Digests' }]} />
          }
          title="My digests"
          documentTitle="My digests"
          lede="Digests you curate — attach a collection as an issue, publish, and schedule."
          actions={isLoggedIn ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              New digest
            </button>
          ) : undefined}
        />

        {bootstrapping ? (
          <LoadingState label="Checking session…" />
        ) : !isLoggedIn ? (
          <RouteState
            kind="auth"
            icon="link"
            title="Sign in to curate digests"
            description="Sign in to create and manage your digest series."
            returnTo="/library/digests"
          />
        ) : !exposed || mine.status === 'unavailable' ? (
          <EmptyState
            icon="book"
            title="Digests are not available yet"
            description="Digests will appear here when they are ready."
          />
        ) : mine.status === 'loading' ? (
          <LoadingState label="Loading digests…" />
        ) : mine.status === 'error' ? (
          <EmptyState
            role="alert"
            icon="alert"
            title="Couldn't load your digests"
            action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void mine.loadFirstPage()}>Try again</button>}
          />
        ) : mine.items.length === 0 ? (
          <EmptyState
            icon="book"
            title="No digests yet"
            description="Create your first digest to publish a collection as a recurring issue."
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>New digest</button>}
          />
        ) : (
          <ul className="my-digest-list" data-testid="my-digest-list">
            {mine.items.map((series) => (
              <li key={series.id}>
                <Link className="result-card result-card--digest my-digest-card" to={`/library/digests/${encodeURIComponent(series.id)}`} data-testid="my-digest-card">
                  <div className="my-digest-card-kicker">
                    <StatusBadge tone={digestVisibilityTone(series)}>
                      {digestVisibilityLabel(series)}
                    </StatusBadge>
                    {series.slug && (series.visibility === 'public' || series.visibility === 'unlisted') ? (
                      <span className="my-digest-slug">Published at {publicHost}/reports/{series.slug}</span>
                    ) : null}
                  </div>
                  <h3 className="result-card-title">{series.title}</h3>
                  {series.summary ? <p className="result-card-desc">{series.summary}</p> : null}
                  <div className="my-digest-card-foot meta-row">
                    <span>Manage</span>
                    <Icon name="arrow-right" />
                  </div>
                </Link>
              </li>
            ))}
            {mine.nextCursor ? (
              <li className="my-digest-more">
                <LoadMoreButton
                  loading={mine.loadingMore}
                  onClick={() => void mine.loadMore()}
                />
                {mine.moreError ? <p className="field-error" role="alert">Couldn't load more digests. Try again.</p> : null}
              </li>
            ) : null}
          </ul>
        )}

        {/* Digests other curators shared with you come after your own:
            the page is "My digests", so its first list is the one you
            curate, not a secondary membership list (or its load error). */}
        {isLoggedIn && !bootstrapping && <SharedDigests />}

        {creating ? (
          <NewDigestModal
            busy={createBusy}
            error={createError}
            onClose={() => { setCreating(false); setCreateError(null) }}
            onCreate={(body) => void create(body)}
          />
        ) : null}
      </div>
    </PageShell>
  )
}
