import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { useToast } from '../components/AppToast'
import { LoadingState } from '../components/EmptyState'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { useAuth } from '../auth/AuthContext'
import { useAutoSaveDraft, mergeDraft, readAutoSaveDraft } from '../lib/useAutoSaveDraft'
import {
  FEATURE_FLAGS,
  isProductApiError,
  productClient,
} from '../api'
import type { CollectionKind } from '../api'

const KIND_OPTIONS: { value: CollectionKind; label: string; hint: string }[] = [
  { value: 'bookmarks', label: 'Bookmarks', hint: 'A folder tree of links. The default.' },
  { value: 'reading_path', label: 'Reading path', hint: 'An ordered list to read from start to finish.' },
  { value: 'knowledge_collection', label: 'Knowledge collection', hint: 'A topic library where links relate to each other.' },
  { value: 'mixed', label: 'Mixed', hint: 'Folders and ordered paths together.' },
]

const createDefaults = { title: '', summary: '', kind: 'bookmarks' as CollectionKind }
const CREATE_COLLECTION_PATH = '/library/new'
const CREATE_DRAFT_KEY = 'create-collection'

/** Null while the session has not identified an account or a signed-out visitor. */
export function createCollectionDraftPartition(
  bootstrapping: boolean,
  isLoggedIn: boolean,
  accountId: string | null,
): string | null {
  if (bootstrapping) return null
  if (!isLoggedIn) return 'anonymous'
  if (!accountId) return null
  return `account:${accountId}`
}

function valuesForPartition(partition: string | null): typeof createDefaults {
  if (partition === null) return createDefaults
  return mergeDraft(
    createDefaults,
    readAutoSaveDraft<typeof createDefaults>(CREATE_DRAFT_KEY, partition),
  )
}

export function CreateCollection() {
  const { isLoggedIn, bootstrapping, refreshSession, user } = useAuth()
  const partition = createCollectionDraftPartition(bootstrapping, isLoggedIn, user?.accountId ?? null)
  const [seenPartition, setSeenPartition] = useState(partition)
  const [values, setValues] = useState(() => valuesForPartition(partition))
  const [busy, setBusy] = useState(false)
  const [titleError, setTitleError] = useState<string | null>(null)
  if (seenPartition !== partition) {
    setSeenPartition(partition)
    setValues(valuesForPartition(partition))
    setTitleError(null)
    setBusy(false)
  }
  const { title, summary, kind } = values
  const { clearDraft } = useAutoSaveDraft(CREATE_DRAFT_KEY, values, partition)
  const navigate = useNavigate()
  const { toast, success, error } = useToast()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!FEATURE_FLAGS.createCollection) {
      // Demo mode - use mock data (not implemented yet, flag is true).
      return
    }
    if (bootstrapping) return
    if (!isLoggedIn) {
      // F3 legacy cleanup: the legacy OIDC entry is gone; the login page
      // carries the same-origin returnTo instead.
      navigate(`/login?returnTo=${encodeURIComponent(CREATE_COLLECTION_PATH)}`)
      return
    }
    const t = title.trim()
    if (!t) {
      setTitleError('Enter a title')
      return
    }
    setBusy(true)
    try {
      const intentId = productClient.mutationIntentKey(
        'create-collection',
        productClient.newCommandId(),
      )
      const result = await productClient.createCollection(
        {
          kind,
          title: t,
          summary: summary.trim() ? summary.trim() : null,
        },
        { intentId },
      )
      success(`Created “${result.collection.title}”`)
      clearDraft()
      /* R7-05: land on the desk (where Add bookmark is the primary action),
         not the tree editor — new users should paste a link, not learn a tree. */
      navigate(`/library/${result.collection.id}`)
    } catch (err) {
      if (isProductApiError(err)) {
        if (err.isAuthRequired) {
          toast('Sign in required')
          navigate(`/login?returnTo=${encodeURIComponent(CREATE_COLLECTION_PATH)}`)
        } else if (err.isCsrfFailed) {
          await refreshSession()
          toast('Your session was refreshed. Try again.')
        } else {
          error(err.recoveryHint)
        }
      } else {
        error('Create failed')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell variant="narrow">
      <div>
        <PageHead
            variant="workbench"
            breadcrumb={
              <Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'New collection' }]} />
            }
            title="Create collection"
            documentTitle="New collection"
            lede="Create a private collection you can reopen from your library."
          />
          {bootstrapping ? (
            <LoadingState label="Checking your session…" />
          ) : !isLoggedIn ? (
            <RouteState
              kind="auth"
              icon="collection"
              description="You need to be signed in to create a collection."
              returnTo={CREATE_COLLECTION_PATH}
            />
          ) : (
          <form className="edit-form panel panel-pad cc-form" onSubmit={(e) => void submit(e)}>
            {/* R7-05: title leads; kind is a defaulted refinement, not the
                first decision a new user has to make. */}
            <div className="field">
              <label htmlFor="cc-title">Title</label>
              <input
                id="cc-title"
                value={title}
                onChange={(e) => {
                  setTitleError(null)
                  setValues((current) => ({ ...current, title: e.target.value }))
                }}
                maxLength={512}
                disabled={busy}
                autoFocus
                aria-invalid={titleError ? true : undefined}
                aria-describedby={titleError ? 'cc-title-error' : undefined}
              />
              {titleError && <p id="cc-title-error" className="field-error" role="alert">{titleError}</p>}
            </div>
            <div className="field">
              <label htmlFor="cc-summary">Summary (optional)</label>
              <textarea
                id="cc-summary"
                value={summary}
                onChange={(e) => setValues((current) => ({ ...current, summary: e.target.value }))}
                rows={3}
                maxLength={2000}
                disabled={busy}
              />
            </div>
            {/* R10-27: this field now uses radio rows, not the shared segment rail. */}
            <fieldset className="option-group cc-kind" data-testid="cc-kind" disabled={busy}>
              <legend>Kind</legend>
              {KIND_OPTIONS.map((option) => (
                <label key={option.value} className="option-row">
                  <input
                    type="radio"
                    name="cc-kind"
                    value={option.value}
                    checked={kind === option.value}
                    onChange={() => setValues((current) => ({
                      ...current,
                      kind: option.value,
                    }))}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.hint}</small>
                  </span>
                </label>
              ))}
              <span className="field-hint">You can't change the kind after the collection is created.</span>
            </fieldset>
            <div className="row-end">
              <Link to="/library" className="btn btn-ghost">
                Cancel
              </Link>
              <button type="submit" className="btn btn-primary" disabled={busy || bootstrapping}>
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
          )}
      </div>
    </PageShell>
  )
}
