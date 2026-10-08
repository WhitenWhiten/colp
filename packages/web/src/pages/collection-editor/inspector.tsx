import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isProductApiError, isReportsExposureEnabled, productClient, type EditorSnapshot, type ReportSeries } from '../../api'
import { useToast } from '../../components/AppToast'
import { FilterRail } from '../../components/FilterRail'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { isAbort } from '../../lib/libraryTree'
import { notifyMyReportsChanged } from '../../lib/useMyReports'
import type { CollectionEditorMutations } from './mutations'
import { CatalogFields, type CatalogCommit } from './CatalogFields'
import { childrenOf } from './treeModel'

/** Default issue key — the current ISO week, e.g. 2026-W38. */
function isoWeekKey(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Editor → digest bridge (R10-05/36): attach the collection being edited as
    the next issue of one of the curator's digest series — the most natural
    creation entry, straight from the workbench's Publication block. */
function PublishAsIssueModal({ collectionId, collectionTitle, onClose, success, error }: {
  collectionId: string
  collectionTitle: string
  onClose: () => void
  success: (message: string) => void
  error: (message: string) => void
}) {
  const [series, setSeries] = useState<ReportSeries[] | null>(null)
  const [seriesError, setSeriesError] = useState<string | null>(null)
  const [seriesId, setSeriesId] = useState('')
  const [issueKey, setIssueKey] = useState(isoWeekKey())
  const [title, setTitle] = useState(collectionTitle)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    productClient.listMyReports({ limit: 50 }, { signal: controller.signal, maxRetries: 0 })
      .then((page) => {
        if (controller.signal.aborted) return
        const attachable = page.items.filter((item) => item.state === 'active')
        setSeries(attachable)
        if (attachable.length === 1) setSeriesId(attachable[0]!.id)
      })
      .catch((err) => {
        if (!controller.signal.aborted && !isAbort(err)) {
          setSeriesError(isProductApiError(err) ? err.recoveryHint : "Couldn't load your digests")
        }
      })
    return () => controller.abort()
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!seriesId || !issueKey.trim() || !title.trim() || busy) return
    setBusy(true)
    try {
      await productClient.createReportIssue(
        seriesId,
        { collectionId, issueKey: issueKey.trim(), title: title.trim() },
        {
          intentId: productClient.mutationIntentKey('attach-report-issue', productClient.newCommandId()),
          maxRetries: 0,
        },
      )
      notifyMyReportsChanged()
      success('Issue attached as a draft — publish it from the digest page.')
      onClose()
    } catch (err) {
      error(isProductApiError(err) ? err.recoveryHint : 'The issue could not be attached')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} label="Publish as digest issue" title="Publish as digest issue" size="sm">
      <form className="edit-form" onSubmit={(event) => void submit(event)} data-testid="publish-as-issue-form">
        <p className="publication-note">
          “{collectionTitle}” becomes the next issue of the chosen digest — it starts as a draft.
        </p>
        {seriesError ? <p className="field-error" role="alert">{seriesError}</p> : null}
        <div className="field">
          <label htmlFor="pai-series">Digest</label>
          <select
            id="pai-series"
            value={seriesId}
            onChange={(event) => setSeriesId(event.target.value)}
            disabled={busy || series === null}
          >
            <option value="" disabled>
              {series === null ? 'Loading digests…' : 'Pick a digest'}
            </option>
            {(series ?? []).map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
          {series !== null && series.length === 0 ? (
            <span className="field-hint">No digest yet — create one from Library → Digests → New digest.</span>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="pai-key">Issue key</label>
          <input
            id="pai-key"
            value={issueKey}
            onChange={(event) => setIssueKey(event.target.value)}
            maxLength={128}
            disabled={busy}
          />
          <span className="field-hint">Unique inside the digest — prefilled with the current week.</span>
        </div>
        <div className="field">
          <label htmlFor="pai-title">Issue title</label>
          <input
            id="pai-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={512}
            disabled={busy}
          />
        </div>
        <div className="row-end">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !seriesId || !issueKey.trim() || !title.trim()}>
            {busy ? 'Attaching…' : 'Attach as draft'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function CollectionMetaForm({
  snap,
  mutations,
}: {
  snap: EditorSnapshot
  mutations: CollectionEditorMutations
}) {
  const { collection } = snap
  const {
    caps,
    busy,
    title,
    setTitle,
    summary,
    setSummary,
    visibility,
    setVisibility,
    publicationSlug,
    setPublicationSlug,
    setPublicationDirty,
    publicationSlugError,
    setPublicationSlugError,
    titleError,
    setTitleError,
    publicationSlugRef,
    onSaveMeta,
  } = mutations
  const { success, error } = useToast()
  const [attaching, setAttaching] = useState(false)
  const reportsExposed = isReportsExposureEnabled()
  // Tags and language commit with the collection: one Save for the form.
  const catalogCommit = useRef<CatalogCommit | null>(null)
  const onSubmit = async (event: FormEvent) => {
    if (await onSaveMeta(event)) await catalogCommit.current?.()
  }

  return (
    <>
    <form className="edit-form panel panel-pad" onSubmit={(e) => void onSubmit(e)}>
      <div className="field">
        <label htmlFor="ce-title">Title</label>
        <input
          id="ce-title"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setTitleError(null) }}
          disabled={!caps?.updateCollection || busy}
          maxLength={512}
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? 'ce-title-error' : undefined}
        />
        {titleError && <p id="ce-title-error" className="field-error" role="alert">{titleError}</p>}
      </div>
      <div className="field">
        <label htmlFor="ce-summary">Summary</label>
        <textarea
          id="ce-summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          disabled={!caps?.updateCollection || busy}
          maxLength={2000}
        />
      </div>
      <CatalogFields
        kind="collection"
        resourceId={collection.id}
        disabled={!caps?.updateCollection || busy}
        commitRef={catalogCommit}
      />
      {caps?.managePublication && (
        <fieldset className="publication-controls">
          <legend>Publication</legend>
          <FilterRail
            className="publication-visibility view-switch"
            variant="segments"
            label="Collection visibility"
            value={visibility}
            options={([
              ['private', 'Private'],
              ['unlisted', 'Unlisted'],
              ['public', 'Public'],
            ] as const).map(([value, label]) => ({ value, label, disabled: busy }))}
            onChange={(value) => {
              setVisibility(value)
              setPublicationDirty(true)
              setPublicationSlugError(null)
            }}
          />
          {visibility !== 'private' && (
            <div className="field publication-slug-field">
              <label htmlFor="ce-publication-slug">Public address</label>
              <input
                id="ce-publication-slug"
                ref={publicationSlugRef}
                value={publicationSlug}
                onChange={(e) => {
                  setPublicationSlug(e.target.value.toLowerCase())
                  setPublicationSlugError(null)
                }}
                disabled={busy || Boolean(collection.publicationSlug)}
                required={visibility === 'public' || visibility === 'unlisted'}
                minLength={3}
                maxLength={63}
                pattern="[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])"
                autoComplete="off"
                placeholder="research-notes"
                aria-invalid={publicationSlugError ? true : undefined}
                aria-describedby={publicationSlugError ? 'ce-publication-slug-error' : undefined}
              />
              {publicationSlugError && (
                <p id="ce-publication-slug-error" role="alert" className="field-error">
                  {publicationSlugError}
                </p>
              )}
              {collection.publicationSlug ? (
                <span className="field-hint">The address can't be changed once it is reserved.</span>
              ) : (visibility === 'public' || visibility === 'unlisted') ? (
                <span className="field-hint">Will be live at /c/{publicationSlug || 'your-address'} after you save.</span>
              ) : null}
            </div>
          )}
          {collection.publicationSlug
            && collection.publishedAt
            && (collection.visibility === 'public' || collection.visibility === 'unlisted') && (
            <p className="publication-canonical" data-testid="publication-canonical">
              <span>Published at</span>
              <a
                href={`/c/${encodeURIComponent(collection.publicationSlug)}`}
                target="_blank"
                rel="noreferrer"
              >
                {`${window.location.origin}/c/${collection.publicationSlug}`}
              </a>
            </p>
          )}
          {collection.publicationSlug
            && collection.visibility !== 'public'
            && collection.visibility !== 'unlisted' && (
            <p className="publication-canonical" role="status" data-testid="publication-canonical">
              <span>Published at (currently private)</span>
              <code>{`${window.location.origin}/c/${collection.publicationSlug}`}</code>
            </p>
          )}
          <p className="publication-status" role="status">
            {visibility === 'private'
              ? 'Not publicly accessible'
              : visibility === 'protected'
                ? 'Visible to authorized members'
                : visibility === 'unlisted'
                  ? 'Available by direct link'
                  : 'Listed and publicly accessible'}
          </p>
        </fieldset>
      )}
      {caps?.updateCollection && reportsExposed && (
        <div className="publication-digest" data-testid="publication-digest">
          <h3 className="section-label">Digest issue</h3>
          <p className="publication-note">
            Attach this collection to one of your digests as its next issue — it starts as a draft you publish from the digest page.
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => setAttaching(true)}
          >
            Publish as digest issue…
          </button>
        </div>
      )}
      <div className="row-end">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!caps?.updateCollection || busy}
        >
          {busy ? 'Saving…' : 'Save collection'}
        </button>
      </div>
    </form>
    {attaching && (
      <PublishAsIssueModal
        collectionId={collection.id}
        collectionTitle={collection.title}
        onClose={() => setAttaching(false)}
        success={success}
        error={error}
      />
    )}
    </>
  )
}
