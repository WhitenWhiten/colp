import { useState } from 'react'
import type { PublicCollectionResource } from '../../lib/publicCollectionTree'

export function GraphNodeList({ resources, selectedId, select }: {
  resources: PublicCollectionResource[]; selectedId: string; select: (id: string) => void
}) {
  const [page, setPage] = useState(0)
  const lastPage = Math.max(0, Math.ceil(resources.length / 50) - 1)
  const current = Math.min(page, lastPage)
  return (
    <details className="graph-resource-list">
      <summary>Browse bookmarks ({resources.length})</summary>
      <ul className="graph-neighbor-list" aria-label="Graph bookmarks">
        {resources.slice(current * 50, (current + 1) * 50).map((resource) => (
          <li key={resource.node.id}>
            <button type="button" aria-pressed={selectedId === resource.node.id} onClick={() => select(resource.node.id)}>
              <span>{resource.node.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {lastPage > 0 && <div className="graph-side-actions" role="group" aria-label="Bookmark list pages">
        <button type="button" className="btn btn-secondary btn-sm" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
        <span className="meta">{current + 1} / {lastPage + 1}</span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={current === lastPage} onClick={() => setPage(current + 1)}>Next</button>
      </div>}
    </details>
  )
}
