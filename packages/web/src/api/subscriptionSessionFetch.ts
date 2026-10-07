import { apiUrl } from './config'
import { getSessionSnapshot, privateSessionIdentity } from './sessionStore'

// Abort semantics prevent the generic mutation client from refreshing/retrying an
// intent under a cookie identity which no longer belongs to this page.
export class SubscriptionSessionChanged extends DOMException {
  readonly status = 401
  constructor() { super('Your session changed. Sign in and review this request again.', 'AbortError') }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
async function sessionJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || Number(response.headers.get('content-length')) > 65536) throw new SubscriptionSessionChanged()
  const reader = response.body?.getReader(); if (!reader) throw new SubscriptionSessionChanged()
  const chunks: Uint8Array[] = []; let size = 0
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 65536) { await reader.cancel(); throw new SubscriptionSessionChanged() } chunks.push(chunk.value) } } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { throw new SubscriptionSessionChanged() }
}
const authUserFor = new Map<string, string>()
const normalEmail = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
/**
 * The Product account id is opaque (`acc-…`) and never equals the Better Auth
 * user id, so the BA user is bound to the page actor by its verified email
 * (when the account has one) and pinned per account for the page lifetime.
 */
function authUserBelongsTo(accountId: string, accountEmail: unknown, user: Record<string, unknown>): boolean {
  if (typeof user.id !== 'string' || !user.id) return false
  const expected = normalEmail(accountEmail)
  if (expected && normalEmail(user.email) !== expected) return false
  const pinned = authUserFor.get(accountId)
  if (pinned && pinned !== user.id) return false
  authUserFor.set(accountId, user.id)
  return true
}
/** Private subscription responses belong to the page actor AND an exact BA session. */
export const subscriptionSessionFetch: typeof fetch = async (input, init = {}) => {
  const me = getSessionSnapshot().me, accountId = me?.account.id, accountEmail = (me?.account as { email?: unknown } | undefined)?.email, identity = privateSessionIdentity()
  const assertCurrent = () => {
    const current = getSessionSnapshot()
    if (!accountId || !current.authenticated || current.me?.account.id !== accountId || privateSessionIdentity() !== identity) throw new SubscriptionSessionChanged()
    init.signal?.throwIfAborted()
  }
  assertCurrent()
  const authResponse = await globalThis.fetch(apiUrl('/api/v1/auth/get-session'), { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: init.signal, headers: { Accept: 'application/json' } })
  assertCurrent()
  const auth = await sessionJson(authResponse)
  assertCurrent()
  if (!accountId || !record(auth) || !record(auth.user) || !record(auth.session) || auth.session.userId !== auth.user.id || !authUserBelongsTo(accountId, accountEmail, auth.user) || typeof auth.session.id !== 'string' || !auth.session.id || auth.session.id.length > 256) throw new SubscriptionSessionChanged()
  const response = await globalThis.fetch(input, { ...init, credentials: 'include', cache: 'no-store', redirect: 'error' })
  assertCurrent()
  const responseSession = response.headers.get('Known-Subscription-Session')
  // Errors lacking authenticated session metadata may still explain a denial.
  // Success, empty success, conditional reads and all identified errors must bind.
  if ((response.ok || response.status === 304 || responseSession !== null) && responseSession !== auth.session.id) {
    void response.body?.cancel().catch(() => undefined)
    throw new SubscriptionSessionChanged()
  }
  return response
}
