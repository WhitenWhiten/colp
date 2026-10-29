import { useEffect, useMemo, useRef, useState } from 'react'
import { productClient, type EditorSnapshot } from '../../api'
import { BookmarkIcon } from '../../components/BookmarkIcon'
import { FolderPicker } from '../../components/FolderPicker'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { TagInput } from '../../components/TagInput'
import { importFolderOptions } from '../../lib/bookmarkImport'
import { providerFaviconSrc } from '../../lib/bookmarkIcon'
import { readFolderRecents } from '../../lib/folderRecents'
import { countTags } from '../../lib/libraryTags'
import { displayHost, hostInitial, rootTitle } from '../../lib/libraryTree'
import { NODE_DESCRIPTION_MAX } from './nodeEditDrawer'
import type { ComposeKind, LibraryDeskMutations } from './mutations'

/** The host an empty bookmark title falls back to (onCreate does the same). */
function siteName(raw: string): string {
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? displayHost(url.hostname) : ''
  } catch {
    return ''
  }
}

/**
 * The account's provider template while Settings › Favicon fetches icons
 * online (new bookmarks default to online, or every icon is forced online);
 * null otherwise. The server sends these hosts to that provider anyway, so
 * the preview asks it for nothing the account has not already chosen to.
 */
function useOnlineFaviconTemplate(enabled: boolean): string | null {
  const [template, setTemplate] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    productClient.getMyFaviconPolicy({ signal: controller.signal, maxRetries: 0 })
      .then((policy) => {
        if (controller.signal.aborted) return
        setTemplate(policy.newDefault === 'online' || policy.forceAllOnline ? policy.providerTemplate : null)
      })
      // Favicon settings off on this server, or unreadable: letters only.
      .catch(() => { if (!controller.signal.aborted) setTemplate(null) })
    return () => controller.abort()
  }, [enabled])
  return template
}

/** `value` once it has stopped changing for `ms`, so typing a URL does not
    ask the icon provider about every partial host. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
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
    createDescription,
    setCreateDescription,
    createTags,
    setCreateTags,
    createTagDraft,
    setCreateTagDraft,
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

  // The library root holds only the browser folders; a shared collection's
  // root takes items, so its folders nest under it.
  const folders = useMemo(() => {
    if (!snap) return []
    const nested = snap.collection.library ? 0 : 1
    const tree = importFolderOptions(snap).map((folder) => ({ ...folder, depth: folder.depth + nested }))
    return nested ? [{ id: snap.root.id, title: rootTitle(snap.collection), depth: 0 }, ...tree] : tree
  }, [snap])
  // Read when the dialog opens; a create records its folder (mutations.onCreate).
  const collectionId = snap?.collection.id
  const recentIds = useMemo(() => (compose && collectionId ? readFolderRecents(collectionId) : []), [compose, collectionId])
  // The tags already in use, offered while typing so one tag keeps one spelling.
  const tagVocabulary = useMemo(
    () => countTags((snap?.nodes ?? []).filter((node) => node.kind === 'bookmark')),
    [snap],
  )
  const site = siteName(createUrl)
  const onlineTemplate = useOnlineFaviconTemplate(compose === 'bookmark')
  const settledUrl = useSettled(createUrl.trim(), 400)
  const iconSrc = onlineTemplate && site && siteName(settledUrl) === site
    ? providerFaviconSrc(onlineTemplate, settledUrl)
    : null
  // What the new row will show: the provider's icon, else the site's letter.
  const letter = site
    ? <span className="library-host-letter">{hostInitial(site)}</span>
    : <Icon name="link" />
  const mark = iconSrc
    ? <BookmarkIcon icon={{ kind: 'cdn', src: iconSrc }} className="library-host-favicon" letter={letter} />
    : letter
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
            <div className="library-compose-url">
              <span className="library-compose-icon" aria-hidden data-testid="library-compose-icon">{mark}</span>
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
            </div>
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
          <label htmlFor="lc-description">Description</label>
          <textarea
            id="lc-description"
            rows={2}
            maxLength={NODE_DESCRIPTION_MAX}
            placeholder={isBookmark ? 'What this link is, in one line…' : 'What goes in this folder…'}
            value={createDescription}
            onChange={(event) => setCreateDescription(event.target.value)}
            disabled={busy}
          />
        </div>
        {isBookmark && (
          <div className="field">
            <label htmlFor="lc-tags">Tags</label>
            <TagInput
              id="lc-tags"
              tags={createTags}
              onTagsChange={setCreateTags}
              draft={createTagDraft}
              onDraftChange={setCreateTagDraft}
              vocabulary={tagVocabulary}
              disabled={busy}
            />
          </div>
        )}
        <div className="field">
          <label id="lc-parent-label" htmlFor="lc-parent">In folder</label>
          <FolderPicker
            id="lc-parent"
            labelledBy="lc-parent-label"
            folders={folders}
            recentIds={recentIds}
            value={createParentId}
            onChange={(id) => {
              setCreateParentId(id)
              setCreateParentError(null)
            }}
            disabled={busy}
            invalid={Boolean(createParentError)}
            describedBy={createParentError ? 'lc-parent-error' : undefined}
          />
          {createParentError && (
            <p id="lc-parent-error" className="field-error" role="alert">{createParentError}</p>
          )}
        </div>
        <div className="row-end edit-form-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? (isBookmark ? 'Adding…' : 'Creating…') : isBookmark ? 'Add bookmark' : 'Create folder'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
