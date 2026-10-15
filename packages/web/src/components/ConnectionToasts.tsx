import { useEffect, useRef } from 'react'
import { useAuth } from '../auth/AuthContext'
import { productName } from '../lib/edition'
import { serverBusyLine } from '../lib/sessionCopy'
import { useToast } from './AppToast'

type Connection = 'ok' | 'offline' | 'unreachable' | 'busy'

const MESSAGES: Readonly<Record<Exclude<Connection, 'ok'>, { lost: (busySeconds: number) => string; back: () => string }>> = {
  offline: {
    lost: () => 'You’re offline. Saving is paused until you reconnect.',
    back: () => 'You’re back online.',
  },
  unreachable: {
    lost: () => `Can't reach ${productName()}. Retrying…`,
    back: () => `${productName()} is reachable again.`,
  },
  /* The server answered with 429: it is up and asked this browser to wait. */
  busy: {
    lost: serverBusyLine,
    back: () => `${productName()} is answering again.`,
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
  const { sessionState, serverBusySeconds } = useAuth()
  const { warning, success } = useToast()
  const connection: Connection = !online ? 'offline'
    : sessionState !== 'offline' ? 'ok'
    : serverBusySeconds !== null ? 'busy' : 'unreachable'
  const previous = useRef<Connection>('ok')
  useEffect(() => {
    const before = previous.current
    if (before === connection) return
    previous.current = connection
    if (connection !== 'ok') warning(MESSAGES[connection].lost(serverBusySeconds ?? 0))
    else if (before !== 'ok') success(MESSAGES[before].back())
  }, [connection, serverBusySeconds, success, warning])
  return null
}
