import type { EditorSnapshot } from '../../api'
import { FilterRail } from '../../components/FilterRail'
import { suggestPublicationSlug } from '../../lib/publicationSlug'
import type { CollectionEditorMutations } from './mutations'

const VISIBILITY_STATUS: Record<string, string> = {
  private: 'Only you can open it.',
  protected: 'Visible to authorized members',
  unlisted: 'Anyone with the link can open it. It is not listed.',
  public: 'Anyone can open it, and it is listed on this server.',
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
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    /* The sheet's own frame holds the form; a panel inside it drew a second box.
       noValidate: the address error is the field's, not the browser's bubble. */
    <form className="edit-form" noValidate onSubmit={(e) => void onSaveMeta(e)}>
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
      {caps?.managePublication && !collection.library && (
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
              // A first share starts from the title's address; the owner can change it before saving.
              if (value !== 'private' && !collection.publicationSlug && !publicationSlug.trim()) {
                setPublicationSlug(suggestPublicationSlug(title))
              }
            }}
          />
          <p className="publication-status" role="status">
            {VISIBILITY_STATUS[visibility] ?? VISIBILITY_STATUS.private}
          </p>
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
                maxLength={63}
                autoComplete="off"
                spellCheck={false}
                placeholder="reading-list"
                aria-invalid={publicationSlugError ? true : undefined}
                aria-describedby={publicationSlugError ? 'ce-publication-slug-error' : 'ce-publication-slug-hint'}
              />
              {publicationSlugError && (
                <p id="ce-publication-slug-error" role="alert" className="field-error">
                  {publicationSlugError}
                </p>
              )}
              {collection.publicationSlug ? (
                <span className="field-hint" id="ce-publication-slug-hint">The address can't be changed once it is reserved.</span>
              ) : (visibility === 'public' || visibility === 'unlisted') ? (
                <span className="field-hint" id="ce-publication-slug-hint">
                  Lowercase letters, digits, and hyphens. Will be live at {origin}/c/{publicationSlug || 'your-address'} after you save.
                </span>
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
        </fieldset>
      )}
      <div className="row-end edit-form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!caps?.updateCollection || busy}
        >
          {busy ? 'Saving…' : 'Save collection'}
        </button>
      </div>
    </form>
  )
}
