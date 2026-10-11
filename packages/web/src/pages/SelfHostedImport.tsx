import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import { productClient, type EditorSnapshot, type OwnedCollectionListItem } from '../api'
import { useAuth } from '../auth/AuthContext'
import { Breadcrumb } from '../components/Breadcrumb'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import '../styles/import.css'
import { BOOKMARK_IMPORT_MAX_BYTES, bookmarkImportAttempt, importBookmarks, importFolderOptions, previewBookmarkImport } from '../lib/bookmarkImport'

type Preview = ReturnType<typeof previewBookmarkImport>
type Done = { created: number; skipped: number; collectionId: string }

/** Nested folders are indented so the flat <select> reads as a tree. */
export function folderOptionText(depth: number, title: string): string {
  return depth === 0 ? title : `${'\u00a0\u00a0\u00a0'.repeat(depth)}↳ ${title}`
}

export function SelfHostedImport() {
  const { isLoggedIn, bootstrapping, user } = useAuth()
  const [collections, setCollections] = useState<OwnedCollectionListItem[]>([])
  const [collectionId, setCollectionId] = useState('')
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null)
  const [parentId, setParentId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [fileName, setFileName] = useState('')
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [done, setDone] = useState<Done | null>(null)
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
    setCollections([]); setCollectionId(''); setSnapshot(null); setPreview(null); setFileName(''); setStatus(''); setDone(null); setBusy(false)
    active.current?.abort()
    fileGeneration.current += 1
    if (isLoggedIn) void productClient.loadOwnedCollections({}, { signal: controller.signal })
      .then(rows => { if (!controller.signal.aborted) { setCollections(rows); setCollectionId(rows[0]?.collection.id ?? '') } })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)) })
    return () => { controller.abort(); active.current?.abort(); fileGeneration.current += 1 }
  }, [isLoggedIn, user?.accountId])
  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(null); setParentId(''); setStatus('')
    attempt.current = bookmarkImportAttempt()
    if (collectionId) void productClient.loadEditorSnapshot(collectionId, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setSnapshot(value); setParentId(value.root.id) } })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)) })
    return () => controller.abort()
  }, [collectionId])
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const generation = ++fileGeneration.current
    setPreview(null); setFileName(''); setError(null); setStatus(''); setDone(null); attempt.current = bookmarkImportAttempt()
    if (!file) return
    try {
      if (file.size > BOOKMARK_IMPORT_MAX_BYTES) throw new Error('Choose a bookmark HTML file smaller than 8 MiB.')
      const html = await file.text()
      if (generation === fileGeneration.current) { setPreview(previewBookmarkImport(html)); setFileName(file.name) }
    } catch (cause) { if (generation === fileGeneration.current) setError(message(cause)) }
  }
  const run = async () => {
    if (!snapshot || !preview || !parentId || busy) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError(null); setDone(null); setStatus('Preparing import…')
    try {
      const fresh = await productClient.loadEditorSnapshot(collectionId, { signal: controller.signal })
      const result = await importBookmarks({ snapshot: fresh, parentId, items: preview.items, skipDuplicates,
        intentFor: attempt.current, signal: controller.signal,
        onProgress: (created, skipped) => setStatus(`Imported ${created} items; skipped ${skipped}.`),
      })
      if (!controller.signal.aborted) {
        // The file is consumed: a second Confirm would re-import the same
        // bookmarks into the same folder, so the picker is cleared.
        setStatus('')
        setDone({ created: result.created, skipped: result.skipped, collectionId })
        clearFile()
        attempt.current = bookmarkImportAttempt()
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(`${message(cause)} Completed items are saved. Retry to continue.`)
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const changeDestination = () => { attempt.current = bookmarkImportAttempt(); setStatus(''); setError(null) }
  const folders = snapshot ? importFolderOptions(snapshot) : []
  return (
    <PageShell variant="grid">
      <PageHead variant="workbench" breadcrumb={<Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'Import' }]} />}
        title="Import bookmarks" documentTitle="Import" lede="Choose a bookmark HTML file exported from a browser, preview it, and import it into a collection." />
      {bootstrapping ? <p role="status">Checking your session…</p> : !isLoggedIn ? <p><Link to="/login?returnTo=%2Fimport">Sign in to import bookmarks</Link></p> : (
        <form className="edit-form panel panel-pad import-form" onSubmit={event => { event.preventDefault(); void run() }}>
          <div className="field"><label htmlFor="import-collection">Collection</label>
            <select id="import-collection" value={collectionId} disabled={busy} onChange={event => { changeDestination(); setCollectionId(event.target.value) }}>
              <option value="" disabled>Choose a collection</option>
              {collections.map(row => <option key={row.collection.id} value={row.collection.id}>{row.collection.title}</option>)}
            </select></div>
          {!collections.length && <p className="field-hint"><Link to="/library/new">Create a collection</Link> to import into.</p>}
          <div className="field"><label htmlFor="import-folder">Destination folder</label>
            <select id="import-folder" value={parentId} disabled={busy || !snapshot} onChange={event => { changeDestination(); setParentId(event.target.value) }}>
              {snapshot && <option value={snapshot.root.id}>Collection root</option>}
              {folders.map(option => <option key={option.id} value={option.id} title={option.label}>{folderOptionText(option.depth, option.title)}</option>)}
            </select>
            <span className="field-hint">Folders in the file are created under this folder; existing folders with the same name are reused.</span></div>
          <div className="field"><label htmlFor="import-file">Bookmarks HTML file</label>
            <input id="import-file" ref={fileInput} type="file" accept=".html,.htm,text/html" disabled={busy} onChange={event => { void readFile(event) }} />
            <span className="field-hint">Chrome, Firefox, Safari, and Edge export this format from their bookmark manager. Up to 8 MiB.</span></div>
          <label className="option-row"><input type="checkbox" checked={skipDuplicates} disabled={busy} onChange={event => { changeDestination(); setSkipDuplicates(event.target.checked) }} />
            Skip duplicates (same URL in the same folder; reuse folders with the same name)</label>
          {preview && (
            <p className="import-preview" role="status" data-testid="import-preview">
              <strong>{fileName || 'Selected file'}</strong>: {preview.folders} {preview.folders === 1 ? 'folder' : 'folders'}, {preview.bookmarks} {preview.bookmarks === 1 ? 'bookmark' : 'bookmarks'}.
            </p>
          )}
          {error && <p className="field-error import-error" role="alert" data-testid="import-error">{error}</p>}
          {status && <p className="field-hint" role="status">{status}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy || !snapshot || !parentId || !preview}>{busy ? 'Importing…' : 'Confirm import'}</button>
        </form>
      )}
      {!isLoggedIn && !bootstrapping && error && <p className="field-error import-error" role="alert" data-testid="import-error">{error}</p>}
      {done && (
        <div className="panel panel-pad import-done" role="status" data-testid="import-done">
          <p className="import-done-title">Import complete</p>
          <p className="import-done-text">{done.created} {done.created === 1 ? 'item' : 'items'} added; {done.skipped} {done.skipped === 1 ? 'duplicate' : 'duplicates'} skipped. Pick another file to import again.</p>
          <div className="import-done-actions">
            <Link className="btn btn-primary btn-sm" to={`/library/${done.collectionId}`}>View collection</Link>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setDone(null); fileInput.current?.focus() }}>Import another file</button>
          </div>
        </div>
      )}
    </PageShell>
  )
}

function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Import failed. Try again.' }
