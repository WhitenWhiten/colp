import { useEffect } from 'react'
import { brandedTitle, productName } from './edition'

type PublishedTitle = { title: string; seq: number }

let latest: PublishedTitle = { title: '', seq: 0 }
const listeners = new Set<(published: PublishedTitle) => void>()

/** The last title a page set (never a cleanup restore), numbered in order. */
export function latestDocumentTitle(): PublishedTitle {
  return latest
}

/** R15-37: Layout's route announcer listens here instead of reading
    document.title a microtask after navigation, when a lazy route has not
    set its title yet and the old page's cleanup has just restored a stale one. */
export function subscribeDocumentTitle(listener: (published: PublishedTitle) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Sets `document.title` to `{title} — {productName}` (brandedTitle), restoring
    the previous title on cleanup. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title
    document.title = brandedTitle(title)
    latest = { title: title || productName(), seq: latest.seq + 1 }
    for (const listener of listeners) listener(latest)
    return () => {
      document.title = prev
    }
  }, [title])
}
