import { useEffect, useRef } from 'react'
import { useAuth } from '../auth/AuthContext'
import { productName } from '../lib/edition'
import { useToast } from './AppToast'

type Connection = 'ok' | 'offline' | 'unreachable'

const MESSAGES: Readonly<Record<Exclude<Connection, 'ok'>, { lost: () => string; back: () => string }>> = {
  offline: {
    lost: () => 'You’re offline. Saving is paused until you reconnect.',
    back: () => 'You’re back online.',
  },
  unreachable: {
    lost: () => `Can't reach ${productName()}. Retrying…`,
    back: () => `${productName()} is reachable again.`,
  },
}

/**
 * Connection changes as toasts rather than a band above the page: the browser
 * going offline, and (R15-23) the browser online while the session read keeps
 * failing, which AuthProvider retries. Each change toasts once; recovering
 * from a toasted state says so. A page that loads while already connected
 * shows nothing.
 */
export function ConnectionToasts({ online }: { readonly online: boolean }) {
  const { sessionState } = useAuth()
  const { warning, success } = useToast()
  const connection: Connection = !online ? 'offline' : sessionState === 'offline' ? 'unreachable' : 'ok'
  const previous = useRef<Connection>('ok')
  useEffect(() => {
    const before = previous.current
    if (before === connection) return
    previous.current = connection
    if (connection !== 'ok') warning(MESSAGES[connection].lost())
    else if (before !== 'ok') success(MESSAGES[before].back())
  }, [connection, success, warning])
  return null
}
