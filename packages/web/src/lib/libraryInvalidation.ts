import { getMe, privateSessionIdentity } from '../api/sessionStore'
type Invalidation = { accountId: string; collectionId: string; kind: 'content' }
const listeners = new Set<(event: Invalidation) => void>()
const name = 'known.library.content.v1'
let channel: BroadcastChannel | undefined
function receive(event: Invalidation) {
  if (!event || event.kind !== 'content' || typeof event.collectionId !== 'string' || event.collectionId.length > 128
    || !event.accountId || event.accountId !== getMe()?.account.id) return
  for (const listener of listeners) listener(event)
}
export function subscribeLibraryInvalidation(listener: (event: Invalidation) => void) {
  listeners.add(listener)
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(name); channel.onmessage = event => receive(event.data as Invalidation)
  }
  return () => { listeners.delete(listener); if (!listeners.size) { channel?.close(); channel = undefined } }
}
/** Called only after a successful mutation response and with its originating identity. */
export function publishLibraryMutation(path: string, identity: string) {
  if (identity !== privateSessionIdentity()) return
  const match = /^\/api\/v1\/collections\/([^/]+)(?:\/|$)/u.exec(path), accountId = getMe()?.account.id
  if (!match || !accountId) return
  const event: Invalidation = { accountId, collectionId: decodeURIComponent(match[1]!), kind: 'content' }
  receive(event)
  try {
    const sender = channel ?? (typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : undefined)
    sender?.postMessage(event); if (sender !== channel) sender?.close()
  } catch { /* Focus and mount always revalidate if cross-tab delivery is unavailable. */ }
}
