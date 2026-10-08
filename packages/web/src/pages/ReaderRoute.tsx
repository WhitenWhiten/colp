import { Navigate, useLocation, useParams } from 'react-router-dom'
import { isReadableReplicaExposureEnabled } from '../api/featureFlags'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { Reader } from './Reader'

/** Keep old Reader bookmarks useful while the Reader release gate is closed. */
export function ReaderRoute() {
  const { resourceId = '' } = useParams()
  const { search, hash } = useLocation()
  useDocumentTitle('Reader')
  if (!isReadableReplicaExposureEnabled()) {
    return <Navigate to={`/r/${encodeURIComponent(resourceId)}${search}${hash}`} replace />
  }
  return <Reader />
}
