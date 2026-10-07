import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { collectionEditorRedirectPath } from '../lib/libraryDesk'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export { etagForDelete, resolveEditableNode } from './collection-editor/treeModel'

/** Silent redirect: collection settings and node editing now live on the desk. */
export function CollectionEditor() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  useDocumentTitle('Edit')
  if (!id) return <Navigate to="/library" replace />
  return <Navigate to={collectionEditorRedirectPath(id, params.get('node'))} replace />
}
