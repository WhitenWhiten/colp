import type { SavedResourceType } from '../api'
import { useSavedResource } from '../lib/useSavedResource'
import { Icon } from './Icon'

export function SavedResourceButton({ resourceType, resourceId }: { resourceType: SavedResourceType; resourceId: string }) {
  const saved = useSavedResource({ resourceType, resourceId })
  return <span className="saved-resource-control">
    <button type="button" className="btn btn-secondary" aria-pressed={saved.saved} aria-label={saved.label} disabled={saved.pending || saved.state === 'loading'} onClick={saved.toggle}><Icon name="bookmark" /><span className="saved-resource-label">{saved.label}</span></button>
    {saved.state === 'unknown' && <button type="button" className="btn btn-ghost btn-sm" onClick={saved.retry}>Retry</button>}
    {saved.state === 'error' && <><span className="saved-resource-error" role="alert">{saved.message}</span><button type="button" className="btn btn-ghost btn-sm" onClick={saved.reload}>Retry saved state</button></>}
    {saved.state !== 'error' && <span className="visually-hidden" role="status" aria-live="polite">{saved.message}</span>}
  </span>
}
