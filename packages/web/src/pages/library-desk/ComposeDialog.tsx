import { useMemo, useRef } from 'react'
import type { EditorSnapshot } from '../../api'
import { Modal } from '../../components/Modal'
import { importFolderOptions } from '../../lib/bookmarkImport'
import { rootTitle } from '../../lib/libraryTree'
import type { ComposeKind, LibraryDeskMutations } from './mutations'

/** The host an empty bookmark title falls back to (onCreate does the same). */
function siteName(raw: string): string {
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

/**
 * New folder / Add bookmark: one dialog for both, opened from the page head,
 * the rail, Get started and empty folders. It starts in the folder on screen
 * and can file the item anywhere in the tree; validation stays inline under
 * the field it is about.
 */
export function ComposeDialog({ snap, mutations }: {
  snap: EditorSnapshot | null
  mutations: LibraryDeskMutations
}) {
  const {
    compose,
    setCompose,
    busy,
    createTitle,
    setCreateTitle,
    createUrl,
    setCreateUrl,
    createUrlError,
    setCreateUrlError,
    createTitleError,
    setCreateTitleError,
    createParentId,
    setCreateParentId,
    createParentError,
    setCreateParentError,
    onCreate,
  } = mutations

  // The exit beat keeps painting the last kind after `compose` clears.
  const kindRef = useRef<ComposeKind>('bookmark')
  if (compose) kindRef.current = compose
  const kind = kindRef.current
  const isBookmark = kind === 'bookmark'

  // Full paths, as the rule editor's folder picker shows them, so the closed
  // select still says where the item goes ("Bookmarks bar › Reading").
  const folders = useMemo(() => {
    const trail: string[] = []
    return (snap ? importFolderOptions(snap) : []).map((option) => {
      trail.length = option.depth
      trail.push(option.title)
      return { id: option.id, path: trail.join(' › ') }
    })
  }, [snap])
  // A shared collection's root takes items; the library root holds only the browser folders.
  const rootOption = snap && !snap.collection.library ? { id: snap.root.id, title: rootTitle(snap.collection) } : null
  const site = siteName(createUrl)
  const close = () => { if (!busy) setCompose(null) }

  return (
    <Modal
      open={compose !== null && snap !== null}
      onClose={close}
      title={isBookmark ? 'Add bookmark' : 'New folder'}
      label={isBookmark ? 'Add bookmark' : 'New folder'}
      initialFocus={isBookmark ? '#lc-url' : '#lc-title'}
      panelClassName="library-compose-dialog"
    >
      <form
        className="edit-form library-compose"
        data-testid="library-compose"
        noValidate
        aria-busy={busy || undefined}
        onSubmit={(event) => void onCreate(event)}
      >
        {isBookmark && (
          <div className="field">
            <label htmlFor="lc-url">URL</label>
            <input
              id="lc-url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              value={createUrl}
              onChange={(event) => {
                setCreateUrl(event.target.value)
                setCreateUrlError(null)
              }}
              disabled={busy}
              maxLength={4096}
              aria-invalid={createUrlError ? true : undefined}
              aria-describedby={createUrlError ? 'lc-url-error' : undefined}
            />
            {createUrlError && (
              <p id="lc-url-error" className="field-error" role="alert">{createUrlError}</p>
            )}
          </div>
        )}
        <div className="field">
          <label htmlFor="lc-title">{isBookmark ? 'Title (optional)' : 'Title'}</label>
          <input
            id="lc-title"
            value={createTitle}
            // An empty bookmark title falls back to the site name; say which.
            placeholder={isBookmark ? site || 'The site name, if left empty' : 'Reading list, Recipes…'}
            onChange={(event) => {
              setCreateTitle(event.target.value)
              setCreateTitleError(null)
            }}
            disabled={busy}
            maxLength={512}
            aria-invalid={createTitleError ? true : undefined}
            aria-describedby={createTitleError ? 'lc-title-error' : undefined}
          />
          {createTitleError && (
            <p id="lc-title-error" className="field-error" role="alert">{createTitleError}</p>
          )}
        </div>
        <div className="field">
          <label htmlFor="lc-parent">In folder</label>
          <select
            id="lc-parent"
            value={createParentId}
            onChange={(event) => {
              setCreateParentId(event.target.value)
              setCreateParentError(null)
            }}
            disabled={busy}
            aria-invalid={createParentError ? true : undefined}
            aria-describedby={createParentError ? 'lc-parent-error' : undefined}
          >
            {!createParentId && <option value="">Choose a folder</option>}
            {rootOption && <option value={rootOption.id}>{rootOption.title}</option>}
            {folders.map((option) => (
              <option key={option.id} value={option.id}>{option.path}</option>
            ))}
          </select>
          {createParentError && (
            <p id="lc-parent-error" className="field-error" role="alert">{createParentError}</p>
          )}
        </div>
        <div className="row-end edit-form-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {busy ? (isBookmark ? 'Adding…' : 'Creating…') : isBookmark ? 'Add bookmark' : 'Create folder'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
