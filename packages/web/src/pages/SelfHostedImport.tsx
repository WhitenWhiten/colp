import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import { productClient, type EditorSnapshot, type OwnedCollectionListItem } from '../api'
import { useAuth } from '../auth/AuthContext'
import { Breadcrumb } from '../components/Breadcrumb'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { BOOKMARK_IMPORT_MAX_BYTES, bookmarkImportAttempt, importBookmarks, previewBookmarkImport } from '../lib/bookmarkImport'

type Preview = ReturnType<typeof previewBookmarkImport>

export function SelfHostedImport() {
  const { isLoggedIn, bootstrapping, user } = useAuth()
  const [collections, setCollections] = useState<OwnedCollectionListItem[]>([])
  const [collectionId, setCollectionId] = useState('')
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null)
  const [parentId, setParentId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const attempt = useRef(bookmarkImportAttempt())
  const active = useRef<AbortController | null>(null)
  const fileGeneration = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    setCollections([]); setCollectionId(''); setSnapshot(null); setPreview(null); setStatus(''); setBusy(false)
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
    setPreview(null); setError(null); setStatus(''); attempt.current = bookmarkImportAttempt()
    if (!file) return
    try {
      if (file.size > BOOKMARK_IMPORT_MAX_BYTES) throw new Error('Choose a bookmark HTML file smaller than 8 MiB.')
      const html = await file.text()
      if (generation === fileGeneration.current) setPreview(previewBookmarkImport(html))
    } catch (cause) { if (generation === fileGeneration.current) setError(message(cause)) }
  }
  const run = async () => {
    if (!snapshot || !preview || !parentId || busy) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError(null); setStatus('Preparing import…')
    try {
      const fresh = await productClient.loadEditorSnapshot(collectionId, { signal: controller.signal })
      const result = await importBookmarks({ snapshot: fresh, parentId, items: preview.items, skipDuplicates,
        intentFor: attempt.current, signal: controller.signal,
        onProgress: (created, skipped) => setStatus(`Imported ${created} items; skipped ${skipped}.`),
      })
      if (!controller.signal.aborted) {
        setStatus(`Import complete: ${result.created} items added; ${result.skipped} duplicates skipped.`)
        attempt.current = bookmarkImportAttempt()
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(`${message(cause)} Completed items are saved. Retry to continue.`)
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const changeDestination = () => { attempt.current = bookmarkImportAttempt(); setStatus(''); setError(null) }
  return (
    <PageShell variant="grid">
      <div className="import-handoff">
        <PageHead variant="workbench" breadcrumb={<Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'Import' }]} />}
          title="Import bookmarks" documentTitle="Import" lede="Choose a bookmark HTML file, preview it, and import it into a collection." />
        {bootstrapping ? <p role="status">Checking your session…</p> : !isLoggedIn ? <p><Link to="/login?returnTo=%2Fimport">Sign in to import bookmarks</Link></p> : (
          <form className="edit-form panel panel-pad" onSubmit={event => { event.preventDefault(); void run() }}>
            <div className="field"><label htmlFor="import-collection">Collection</label>
              <select id="import-collection" value={collectionId} disabled={busy} onChange={event => { changeDestination(); setCollectionId(event.target.value) }}>
                <option value="" disabled>Choose a collection</option>
                {collections.map(row => <option key={row.collection.id} value={row.collection.id}>{row.collection.title}</option>)}
              </select></div>
            {!collections.length && <p><Link to="/library/new">Create a collection</Link> to import into.</p>}
            <div className="field"><label htmlFor="import-folder">Destination folder</label>
              <select id="import-folder" value={parentId} disabled={busy || !snapshot} onChange={event => { changeDestination(); setParentId(event.target.value) }}>
                {snapshot && <option value={snapshot.root.id}>Collection root</option>}
                {snapshot?.nodes.filter(node => node.kind === 'folder').map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
              </select></div>
            <div className="field"><label htmlFor="import-file">Bookmarks HTML file</label>
              <input id="import-file" type="file" accept=".html,.htm,text/html" disabled={busy} onChange={event => { void readFile(event) }} /></div>
            <label className="option-row"><input type="checkbox" checked={skipDuplicates} disabled={busy} onChange={event => { changeDestination(); setSkipDuplicates(event.target.checked) }} />
              Skip duplicates (same URL in the same folder; reuse folders with the same name)</label>
            {preview && <p role="status">Preview: {preview.folders} folders, {preview.bookmarks} bookmarks.</p>}
            <button type="submit" className="btn btn-primary" disabled={busy || !snapshot || !parentId || !preview}>{busy ? 'Importing…' : 'Confirm import'}</button>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        {status.startsWith('Import complete:') && <Link className="btn btn-secondary" to={`/library/${collectionId}`}>View collection</Link>}
      </div>
    </PageShell>
  )
}

function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Import failed. Try again.' }
