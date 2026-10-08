import { useEffect, useState } from 'react'
import { getExploreCollections } from '../api'
import { mapExploreItem, type ExploreCard } from './mapExploreItem'

export function useExplorePreview(limit: number) {
  const [items, setItems] = useState<ExploreCard[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    void getExploreCollections({ limit }, { signal: controller.signal }).then(
      (page) => {
        if (controller.signal.aborted) return
        setItems(page.items.map(mapExploreItem))
        setStatus('ready')
      },
      () => {
        if (controller.signal.aborted) return
        setItems([])
        setStatus('error')
      },
    )
    return () => controller.abort()
  }, [limit])

  return { items, status }
}
