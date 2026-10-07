import { useEffect, useState } from 'react'
import { isLive, productClient, type PublicCollectionSnapshot } from '../../api'
import { useAuth } from '../../auth/AuthContext'

/** Ask the editor contract for capability, never infer write access from login alone. */
export function useGraphEditAccess(snapshot: PublicCollectionSnapshot | null) {
  const collectionId = snapshot?.collection.id
  const { user, isLoggedIn, bootstrapping } = useAuth()
  const key = JSON.stringify([collectionId, user?.profileId, isLoggedIn, bootstrapping])
  const [grant, setGrant] = useState<{ key: string; snapshot: PublicCollectionSnapshot } | null>(null)
  useEffect(() => {
    if (!snapshot || !collectionId || !isLoggedIn || bootstrapping || !isLive('relations')) return
    const controller = new AbortController()
    void productClient.getCollectionEditorPage(collectionId, { limit: 1 }, { signal: controller.signal, maxRetries: 0 })
      .then((page) => {
        if (!controller.signal.aborted) setGrant(page.capabilities.updateNode ? { key, snapshot } : null)
      }).catch(() => { if (!controller.signal.aborted) setGrant(null) })
    return () => controller.abort()
  }, [collectionId, isLoggedIn, bootstrapping, key, snapshot])
  return snapshot !== null && grant?.key === key && grant.snapshot === snapshot
}
