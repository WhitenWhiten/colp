import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { useToast } from '../components/AppToast'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { plural } from '../lib/plural'
import { editableResourcesSeed, type EditableResource } from '../api/mock-data'

function sortPath(items: EditableResource[]) {
  return [...items].sort((a, b) => {
    if (a.inPath && b.inPath) return (a.pathOrder ?? 99) - (b.pathOrder ?? 99)
    if (a.inPath) return -1
    if (b.inPath) return 1
    return a.title.localeCompare(b.title)
  })
}

export function LibraryEdit() {
  const [isPublic, setIsPublic] = useState(true)
  const [title, setTitle] = useState('Interface Systems')
  const [desc, setDesc] = useState(
    'A curated path into design engineering: layout theory, system primitives, and the open-source tools that make interfaces feel authored.',
  )
  const [resources, setResources] = useState(() => sortPath(editableResourcesSeed))
  const [showDiff, setShowDiff] = useState(false)
  const { toast } = useToast()

  const pathCount = resources.filter((r) => r.inPath).length

  const diffLines = useMemo(
    () => [
      `Title → “${title}”`,
      `Visibility → ${isPublic ? 'Public' : 'Private'}`,
      `Reading path → ${pathCount} steps`,
      'Board layout → unchanged (edit on collection board)',
    ],
    [title, isPublic, pathCount],
  )

  const renumberPath = (list: EditableResource[]) => {
    let n = 1
    return list.map((r) => {
      if (!r.inPath) return { ...r, pathOrder: null }
      return { ...r, pathOrder: n++ }
    })
  }

  const togglePath = (id: string) => {
    setResources((prev) => {
      const next = prev.map((r) => {
        if (r.id !== id) return r
        if (r.inPath) return { ...r, inPath: false, pathOrder: null }
        return { ...r, inPath: true, pathOrder: 999 }
      })
      return renumberPath(sortPath(next))
    })
  }

  const movePath = (id: string, dir: -1 | 1) => {
    setResources((prev) => {
      const path = prev.filter((r) => r.inPath).sort((a, b) => (a.pathOrder ?? 0) - (b.pathOrder ?? 0))
      const i = path.findIndex((r) => r.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= path.length) return prev
      const ids = path.map((r) => r.id)
      const a = ids[i]
      const b = ids[j]
      if (a === undefined || b === undefined) return prev
      ids[i] = b
      ids[j] = a
      const order = new Map(ids.map((x, idx) => [x, idx + 1]))
      return sortPath(
        prev.map((r) => (r.inPath && order.has(r.id) ? { ...r, pathOrder: order.get(r.id)! } : r)),
      )
    })
  }

  const removeResource = (id: string) => {
    setResources((prev) => renumberPath(prev.filter((r) => r.id !== id)))
    toast('Removed from collection (demo)')
  }

  return (
    <PageShell variant="narrow">
      <div>
        <PageHead
            breadcrumb={
              <Breadcrumb items={[{ label: 'Demo library', to: '/demo/library' }, { label: 'Edit collection' }]} />
            }
            title="Edit collection"
            documentTitle="Edit collection"
            lede="Shape public appearance and reading path order."
          />

          <form
            className="edit-form panel panel-pad"
            onSubmit={(e) => {
              e.preventDefault()
              setShowDiff(true)
              toast(`Saved “${title}”`)
            }}
          >
            <div className="field">
              <label htmlFor="title">Title</label>
              <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="desc">Description</label>
              <textarea id="desc" value={desc} onChange={(e) => setDesc(e.target.value)} rows={4} />
            </div>
            <div className="field">
              <label htmlFor="tags">Tags</label>
              <input id="tags" defaultValue="Design, Engineering, Systems" />
            </div>
            <div className="field">
              <label htmlFor="cover">Cover note (shown on public page)</label>
              <input id="cover" defaultValue="Start with the reading path, then open primitives." />
            </div>
            <div className="row row-end">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowDiff((v) => !v)}
              >
                {showDiff ? 'Hide publish preview' : 'Publish preview'}
              </button>
              <Link to="/path/interface-systems" className="btn btn-ghost btn-sm">
                Preview path
              </Link>
              {/* Phase 1: history and collaborators are out of the active Product contract. */}
              <button type="button" className="btn btn-ghost btn-sm" disabled title="Not in Phase 1 Product API">
                Version history
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled title="Not in Phase 1 Product API">
                Collaborators
              </button>
              <Link to="/c/interface-systems" className="btn btn-secondary">
                Preview public
              </Link>
              <button type="submit" className="btn btn-primary" disabled title="Demo shell — use /library/new for real create">
                Save changes (demo)
              </button>
            </div>
            {showDiff && (
              <div className="publish-diff">
                <h3 className="section-label mb-hair-45">
                  Publish diff (demo)
                </h3>
                <ul className="edit-diff-list">
                  {diffLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </form>

          <section className="panel panel-pad edit-resources">
            <div className="row-between row-between--baseline">
              <div>
                <p className="section-label">Resources</p>
                <h2 className="edit-path-title">
                  Reading path
                </h2>
              </div>
              <span className="meta">
                {plural(resources.length, 'link')} · {pathCount} in path
              </span>
            </div>

            <div className="mt-2">
              {resources.map((r) => (
                <div key={r.id} className="edit-res-row">
                  <div>
                    <strong className="edit-resource-title">
                      {r.inPath && r.pathOrder != null ? `${r.pathOrder}. ` : ''}
                      {r.title}
                    </strong>
                    <div className="edit-res-meta">
                      <span className="chip">{r.type}</span>
                      <span className="meta">{r.host}</span>
                      {r.inPath && <span className="chip chip-accent">Path</span>}
                    </div>
                  </div>
                  <div className="edit-res-actions">
                    {r.inPath && (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label="Move up in path"
                          onClick={() => movePath(r.id, -1)}
                        >
                          <Icon name="chevron-up" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label="Move down in path"
                          onClick={() => movePath(r.id, 1)}
                        >
                          <Icon name="chevron-down" />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => togglePath(r.id)}
                    >
                      {r.inPath ? 'Remove path' : 'Add to path'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => removeResource(r.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Former .edit-side rail, folded into the narrow column (R9-04):
              the two side panels are ordinary stacked sections now. */}
          <section className="panel panel-pad mt-3">
            <h3 className="section-label">Visibility</h3>
            <div className="toggle-row">
              <span>Public collection</span>
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={isPublic}
                onClick={() => setIsPublic((v) => !v)}
              />
            </div>
          </section>
          <section className="panel panel-pad mt-3">
            <h3 className="section-label">Performance</h3>
            <p className="meta edit-side-copy">
              Review collection views, preview opens, and top resources after publishing.
            </p>
            <Link to="/creator" className="btn btn-secondary btn-sm mt-hair-85">
              View publishing insights
            </Link>
          </section>
      </div>
    </PageShell>
  )
}
