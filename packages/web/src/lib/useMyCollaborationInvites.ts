import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient } from '../api'
import { getSessionSnapshot, privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { readRouteCache, writeRouteCache } from './routeCache'

type LoadState = 'loading' | 'ready' | 'error'
type InviteItem = Awaited<ReturnType<typeof productClient.listMyCollaborationInvites>>['items'][number]
type MembershipResult = Awaited<ReturnType<typeof productClient.acceptCollaborationInvite>>

function identity() {
  const snapshot = getSessionSnapshot()
  const emailGate = snapshot.me && !snapshot.me.account.email ? 'no-email' : 'ok'
  return `${privateSessionIdentity(snapshot)}:${emailGate}`
}

function usePrivateIdentity() {
  const [value, setValue] = useState(identity)
  useEffect(() => subscribeSession(() => setValue(identity())), [])
  return value
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isVerifiedEmailRequired(error: unknown) {
  return isProductApiError(error) && /verified email is required/i.test(error.message)
}

type CachedInvites = { items: InviteItem[]; message: string }

const CACHE_KEY = 'collaboration-invites'

export function useMyCollaborationInvites() {
  const privateIdentity = usePrivateIdentity()
  const restored = readRouteCache<CachedInvites>(CACHE_KEY)
  const [items, setItems] = useState<InviteItem[]>(restored?.items ?? [])
  const [state, setState] = useState<LoadState>(restored ? 'ready' : 'loading')
  const [message, setMessage] = useState(restored?.message ?? 'Loading invitations')
  const [pendingInviteId, setPendingInviteId] = useState<string | null>(null)
  const generation = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const itemsRef = useRef<InviteItem[]>(restored?.items ?? [])
  const lastIdentityRef = useRef(privateIdentity)
  const renderedIdentityRef = useRef(privateIdentity)

  const replaceItems = useCallback((next: InviteItem[], nextMessage: string) => {
    itemsRef.current = next
    setItems(next)
    setMessage(nextMessage)
    writeRouteCache<CachedInvites>(CACHE_KEY, { items: next, message: nextMessage })
  }, [])

  const load = useCallback(async () => {
    const snapshot = getSessionSnapshot()
    controllerRef.current?.abort()
    controllerRef.current = null
    const requestGeneration = ++generation.current
    const requestedIdentity = identity()
    // The desk hides this section while it is empty, so wiping before the
    // refetch made "Invitations" vanish on every remount and after every
    // accept/decline. Keep the rows and revalidate behind them.
    const revalidating = itemsRef.current.length > 0
    if (!revalidating) replaceItems([], 'Loading invitations')
    if (!snapshot.authenticated) {
      setState('ready')
      replaceItems([], 'Sign in to view invitations')
      return
    }
    if (snapshot.me && !snapshot.me.account.email) {
      setState('ready')
      replaceItems([], 'No invitations')
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    if (!revalidating) setState('loading')
    try {
      const page = await productClient.listMyCollaborationInvites({
        signal: controller.signal,
        maxRetries: 0,
      })
      if (controller.signal.aborted || requestGeneration !== generation.current || requestedIdentity !== identity()) return
      setState('ready')
      replaceItems(
        page.items.map((item) => ({
          inviteId: item.inviteId,
          collectionId: item.collectionId,
          collectionTitle: item.collectionTitle,
          role: item.role,
          email: item.email,
          expiresAt: item.expiresAt,
          invitedAt: item.invitedAt,
        })),
        page.items.length === 0 ? 'No invitations' : `${page.items.length} invitations`,
      )
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || requestedIdentity !== identity() || isAbort(error)) return
      if (isVerifiedEmailRequired(error)) {
        setState('ready')
        replaceItems([], 'No invitations')
        return
      }
      setState('error')
      replaceItems(
        [],
        isProductApiError(error) && error.isAuthRequired
          ? 'Sign in to view invitations'
          : isProductApiError(error) ? error.recoveryHint : "Couldn't load invitations",
      )
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [replaceItems])

  useEffect(() => {
    renderedIdentityRef.current = privateIdentity
    if (lastIdentityRef.current !== privateIdentity) {
      lastIdentityRef.current = privateIdentity
      itemsRef.current = []
      setItems([])
      setState('loading')
      setMessage('Loading invitations')
      setPendingInviteId(null)
    }
    void load()
    return () => {
      controllerRef.current?.abort()
      generation.current += 1
    }
  }, [load, privateIdentity])

  const accept = useCallback(async (inviteId: string): Promise<MembershipResult> => {
    const requestIdentity = privateIdentity
    setPendingInviteId(inviteId)
    try {
      const result = await productClient.acceptCollaborationInvite(inviteId, {
        intentId: productClient.mutationIntentKey(
          `accept-collaboration-invite:${inviteId}`,
          productClient.newCommandId(),
        ),
      })
      await load()
      if (identity() !== requestIdentity) return result
      return result
    } finally {
      if (identity() === requestIdentity) setPendingInviteId((current) => current === inviteId ? null : current)
    }
  }, [load])

  const decline = useCallback(async (inviteId: string): Promise<void> => {
    const requestIdentity = privateIdentity
    setPendingInviteId(inviteId)
    try {
      await productClient.declineCollaborationInvite(inviteId, {
        intentId: productClient.mutationIntentKey(
          `decline-collaboration-invite:${inviteId}`,
          productClient.newCommandId(),
        ),
      })
      await load()
    } finally {
      if (identity() === requestIdentity) setPendingInviteId((current) => current === inviteId ? null : current)
    }
  }, [load])

  const identityReady = renderedIdentityRef.current === privateIdentity
  return {
    items: identityReady ? items : [],
    state: identityReady ? state : 'loading',
    message: identityReady ? message : 'Loading invitations',
    pendingInviteId: identityReady ? pendingInviteId : null,
    reload: load,
    accept,
    decline,
  }
}
