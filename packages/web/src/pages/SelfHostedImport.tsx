import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { productClient, type EditorSnapshot, type OwnedCollectionListItem } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useToast } from '../components/AppToast'
import { Breadcrumb } from '../components/Breadcrumb'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { ProgressBar } from '../components/ProgressBar'
import { plural } from '../lib/plural'
import '../styles/import.css'
import { BOOKMARK_IMPORT_MAX_BYTES, bookmarkImportAttempt, importBookmarks, importFolderOptions, previewBookmarkImport } from '../lib/bookmarkImport'

type Preview = ReturnType<typeof previewBookmarkImport>

/** Where each browser keeps its bookmarks export. */
const BROWSER_EXPORTS: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'Chrome', path: 'Bookmark manager (Ctrl+Shift+O) → ⋮ → Export bookmarks' },
  { name: 'Edge', path: 'Favorites (Ctrl+Shift+O) → ⋯ → Export favorites' },
  { name: 'Firefox', path: 'Manage bookmarks (Ctrl+Shift+O) → Import and Backup → Export Bookmarks to HTML' },
  { name: 'Safari', path: 'File → Export → Bookmarks' },
]
type Progress = { done: number; total: number }

/** Nested folders are indented so the flat <select> reads as a tree. */
export function folderOptionText(depth: number, title: string): string {
  return depth === 0 ? title : `${'\u00a0\u00a0\u00a0'.repeat(depth)}↳ ${title}`
}

export function SelfHostedImport() {
  const { isLoggedIn, bootstrapping, user } = useAuth()
  const { success, error: toastError } = useToast()
  const [collections, setCollections] = useState<OwnedCollectionListItem[]>([])
  const [collectionId, setCollectionId] = useState('')
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null)
  const [parentId, setParentId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [fileName, setFileName] = useState('')
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  /* Inline only for the file itself (too large, unreadable); failures after
     Confirm and failed loads go to the error toast. */
  const [fileError, setFileError] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [busy, setBusy] = useState(false)
  const attempt = useRef(bookmarkImportAttempt())
  const active = useRef<AbortController | null>(null)
  const fileGeneration = useRef(0)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const clearFile = () => {
    fileGeneration.current += 1
    setPreview(null); setFileName('')
    if (fileInput.current) fileInput.current.value = ''
  }

  useEffect(() => {
    const controller = new AbortController()
    setCollections([]); setCollectionId(''); setSnapshot(null); setPreview(null); setFileName(''); setFileError(null); setProgress(null); setBusy(false)
    active.current?.abort()
    fileGeneration.current += 1
    if (isLoggedIn) void productClient.loadOwnedCollections({}, { signal: controller.signal })
      .then(rows => { if (!controller.signal.aborted) { setCollections(rows); setCollectionId(rows[0]?.collection.id ?? '') } })
      .catch(cause => { if (!controller.signal.aborted) toastError(message(cause)) })
    return () => { controller.abort(); active.current?.abort(); fileGeneration.current += 1 }
  }, [isLoggedIn, user?.accountId, toastError])
  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(null); setParentId('')
    attempt.current = bookmarkImportAttempt()
    if (collectionId) void productClient.loadEditorSnapshot(collectionId, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setSnapshot(value); setParentId(value.root.id) } })
      .catch(cause => { if (!controller.signal.aborted) toastError(message(cause)) })
    return () => controller.abort()
  }, [collectionId, toastError])
  const [dragging, setDragging] = useState(false)
  const readFile = async (file: File | undefined) => {
    const generation = ++fileGeneration.current
    setPreview(null); setFileName(''); setFileError(null); attempt.current = bookmarkImportAttempt()
    if (!file) return
    try {
      if (file.size > BOOKMARK_IMPORT_MAX_BYTES) throw new Error('Choose a bookmark HTML file smaller than 8 MiB.')
      const html = await file.text()
      if (generation === fileGeneration.current) { setPreview(previewBookmarkImport(html)); setFileName(file.name) }
    } catch (cause) { if (generation === fileGeneration.current) setFileError(message(cause)) }
  }
  const run = async () => {
    if (!snapshot || !preview || !parentId || busy) return
    const controller = new AbortController()
    active.current = controller
    const total = preview.folders + preview.bookmarks
    setBusy(true); setProgress({ done: 0, total })
    try {
      const fresh = await productClient.loadEditorSnapshot(collectionId, { signal: controller.signal })
      const result = await importBookmarks({ snapshot: fresh, parentId, items: preview.items, skipDuplicates,
        intentFor: attempt.current, signal: controller.signal,
        onProgress: (created, skipped) => setProgress({ done: created + skipped, total }),
      })
      if (!controller.signal.aborted) {
        // The file is consumed: a second Confirm would re-import the same
        // bookmarks into the same folder, so the picker is cleared.
        success(
          `Imported ${plural(result.created, 'item')}${result.skipped > 0 ? `; skipped ${plural(result.skipped, 'duplicate')}` : ''}. Your browsers pick them up on their next sync.`,
          { action: { label: 'View collection', to: `/library/${collectionId}` } },
        )
        clearFile()
        attempt.current = bookmarkImportAttempt()
      }
    } catch (cause) {
      if (!controller.signal.aborted) toastError(`${message(cause)} Completed items are saved. Retry to continue.`)
    } finally { if (!controller.signal.aborted) { setBusy(false); setProgress(null) } }
  }
  const changeDestination = () => { attempt.current = bookmarkImportAttempt() }
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragging(false)
    if (busy) return
    void readFile(event.dataTransfer.files?.[0])
  }
  const folders = snapshot ? importFolderOptions(snapshot) : []
  return (
    <PageShell variant="grid">
      <PageHead variant="workbench" breadcrumb={<Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'Import' }]} />}
        title="Import bookmarks" documentTitle="Import"
        lede="Bring your bookmarks over from any browser or bookmark tool. Folders come along; nothing leaves this server." />
      {bootstrapping ? <p role="status">Checking your session…</p> : !isLoggedIn ? <p><Link to="/login?returnTo=%2Fimport">Sign in to import bookmarks</Link></p> : (
        <div className="import-layout">
          <form className="edit-form panel panel-pad import-form" onSubmit={event => { event.preventDefault(); void run() }}>
            <ol className="import-steps">
              <li className="import-step">
                <h2>Choose the file</h2>
                <label
                  htmlFor="import-file"
                  className="import-drop"
                  data-dragging={dragging || undefined}
                  data-filled={preview ? true : undefined}
                  onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                >
                  <span className="import-drop-icon" aria-hidden><Icon name={preview ? 'check' : 'file'} /></span>
                  {preview ? (
                    <span className="import-drop-text" role="status" data-testid="import-preview">
                      <strong>{fileName || 'Selected file'}</strong>
                      <span>Preview: {preview.folders} {preview.folders === 1 ? 'folder' : 'folders'}, {preview.bookmarks} {preview.bookmarks === 1 ? 'bookmark' : 'bookmarks'}.</span>
                    </span>
                  ) : (
                    <span className="import-drop-text">
                      <strong>Drop your bookmarks file here</strong>
                      <span>or click to choose one · HTML export, up to 8 MiB</span>
                    </span>
                  )}
                  {preview && <span className="import-drop-change">Choose another</span>}
                  <input id="import-file" ref={fileInput} className="visually-hidden" type="file" accept=".html,.htm,text/html"
                    aria-label="Bookmarks HTML file" disabled={busy} onChange={event => { void readFile(event.target.files?.[0]) }} />
                </label>
                {fileError && <p className="field-error import-error" role="alert" data-testid="import-error">{fileError}</p>}
              </li>
              <li className="import-step">
                <h2>Pick where it goes</h2>
                <div className="import-destination">
                  <div className="field"><label htmlFor="import-collection">Collection</label>
                    <select id="import-collection" value={collectionId} disabled={busy} onChange={event => { changeDestination(); setCollectionId(event.target.value) }}>
                      <option value="" disabled>Choose a collection</option>
                      {collections.map(row => <option key={row.collection.id} value={row.collection.id}>{row.collection.title}</option>)}
                    </select></div>
                  <div className="field"><label htmlFor="import-folder">Destination folder</label>
                    <select id="import-folder" value={parentId} disabled={busy || !snapshot} onChange={event => { changeDestination(); setParentId(event.target.value) }}>
                      {snapshot && <option value={snapshot.root.id}>Collection root</option>}
                      {folders.map(option => <option key={option.id} value={option.id} title={option.label}>{folderOptionText(option.depth, option.title)}</option>)}
                    </select></div>
                </div>
                {!collections.length
                  ? <p className="field-hint"><Link to="/library/new">Create a collection</Link> to import into first.</p>
                  : <p className="field-hint">Folders in the file are created under this folder; existing folders with the same name are reused.</p>}
              </li>
              <li className="import-step">
                <h2>Import</h2>
                <label className="option-row"><input type="checkbox" checked={skipDuplicates} disabled={busy} onChange={event => { changeDestination(); setSkipDuplicates(event.target.checked) }} />
                  Skip duplicates (same URL in the same folder)</label>
                {progress && (
                  <div className="import-progress" role="status" data-testid="import-progress">
                    <ProgressBar value={progress.total ? (progress.done / progress.total) * 100 : 0} label="Import progress" />
                    <span>{progress.done} of {plural(progress.total, 'item')} imported…</span>
                  </div>
                )}
                <button type="submit" className="btn btn-primary import-submit" disabled={busy || !snapshot || !parentId || !preview}>{busy ? 'Importing…' : 'Confirm import'}</button>
              </li>
            </ol>
          </form>
          <aside className="import-aside" aria-labelledby="import-export-heading">
            <h2 id="import-export-heading">Export from your browser</h2>
            <dl className="import-browsers">
              {BROWSER_EXPORTS.map(browser => (
                <div key={browser.name}><dt>{browser.name}</dt><dd>{browser.path}</dd></div>
              ))}
            </dl>
            <p className="field-hint">Raindrop, Pocket, Pinboard, linkding, and most bookmark tools export the same HTML format.</p>
          </aside>
        </div>
      )}
    </PageShell>
  )
}

function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Import failed. Try again.' }
