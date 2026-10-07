import { type PublicCollectionSnapshot } from '../../api'
import { formatDate } from '../../lib/formatDate'

export type ViewMode = 'board' | 'gallery' | 'list' | 'compact'

export function isViewMode(value: unknown): value is ViewMode {
  return value === 'board' || value === 'gallery' || value === 'list' || value === 'compact'
}

function viewKey(slug: string): string {
  return `known.collection.view.${slug}.v1`
}

export function loadView(slug: string): ViewMode {
  try {
    const value = window.localStorage.getItem(viewKey(slug))
    if (isViewMode(value)) return value
  } catch {
    /* ignore */
  }
  return 'board'
}

export function saveView(slug: string, view: ViewMode): void {
  try {
    window.localStorage.setItem(viewKey(slug), view)
  } catch {
    /* ignore */
  }
}

export function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return formatDate(value)
}

export function formatCompactCount(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(n)
}

/* R9-31: identical monogram algorithm now lives in lib/initials (shared with
   profile pages and the hover card); re-exported under the curator name. */
export { profileInitials as curatorInitials } from '../../lib/initials'

export function kindLabel(kind: PublicCollectionSnapshot['collection']['kind']): string {
  switch (kind) {
    case 'bookmarks': return 'Bookmarks'
    case 'reading_path': return 'Reading path'
    case 'knowledge_collection': return 'Knowledge collection'
    case 'mixed': return 'Mixed collection'
  }
}
