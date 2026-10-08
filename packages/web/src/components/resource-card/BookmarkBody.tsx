import type { BookmarkResource } from '../../types/catalog'
import { resolveSourceBody } from './source-bodies/registry'

type BookmarkBodyProps = {
  resource: BookmarkResource
  isVideo: boolean
}

/**
 * Bookmark / media body renderer (C03). Looks up `sourceBodyRegistry`
 * by `resource.type` (video / news clusters share one renderer each);
 * unknown bookmark types fall back to a generic title / summary / meta
 * body so the CardShell never breaks. Widget types cannot be looked up.
 */
export function BookmarkBody({ resource, isVideo }: BookmarkBodyProps) {
  const Body = resolveSourceBody(resource.type, isVideo)
  return <Body resource={resource} isVideo={isVideo} />
}
