import { isWidgetResource, type Resource } from '../../types/catalog'
import { BookmarkBody } from './BookmarkBody'
import { WidgetBody } from './WidgetBody'

type ResourceBodyProps = {
  resource: Resource
  isVideo: boolean
  editable: boolean
}

/**
 * Body dispatcher (C03). The source type branch only decides *body*
 * content; the shell (surface / radius / padding / hover) is owned by
 * CardShell + cards.css. Widgets go to WidgetBody; everything else is a
 * bookmark (unknown bookmark types fall through to GenericBody).
 */
export function ResourceBody({ resource, isVideo, editable }: ResourceBodyProps) {
  if (isWidgetResource(resource)) {
    return <WidgetBody resource={resource} editable={editable} />
  }
  return <BookmarkBody resource={resource} isVideo={isVideo} />
}
