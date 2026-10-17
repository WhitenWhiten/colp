import { ProductApiError, wrapProductError } from './errors'
import {
  createMutationCall,
  createRequireCsrf,
  withSameRequestRetry,
  type MutationCall,
  type MutationOptions,
  type ReadOptions,
} from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import { applyMeView, applySessionView, clearSession, getCsrfToken } from './sessionStore'
import type { MeView, SessionView, UpdateMeRequest } from './types'

function isMockSessionEnabled(): boolean {
  try {
    return String(import.meta.env?.VITE_MOCK_SESSION).toLowerCase() === 'true'
  } catch {
    return false
  }
}

const MOCK_SESSION_VIEW: SessionView = {
  authenticated: true,
  csrfToken: 'mock-csrf-token',
  idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
} as SessionView

const MOCK_ME_VIEW: MeView = {
  account: { id: 'mock-account-1', email: 'dev@known.local' },
  profile: {
    id: 'mock-profile-1',
    handle: 'dev',
    displayName: 'Dev User',
    avatarUrl: null,
    about: '',
  },
} as MeView

export function createProductSessionClient(transport: ProductTransport): {
  getSession: (options?: ReadOptions) => Promise<SessionView>
  getMe: (options?: ReadOptions) => Promise<MeView>
  bootstrapSession: (options?: ReadOptions) => Promise<{ session: SessionView; me: MeView | null }>
  deleteSession: (options?: ReadOptions) => Promise<void>
  updateMe: (body: UpdateMeRequest, options: MutationOptions) => Promise<MeView>
  uploadAvatar: (file: File, options: MutationOptions) => Promise<MeView>
  mutationCall: MutationCall
  requireCsrf: () => Promise<string>
} {
  /**
   * (epoch, generation) per view. `getSession` and `getMe` are independent
   * reads that callers interleave — the session read is a prerequisite of the
   * me read — so one shared counter let whichever started later cancel the
   * other's write, leaving the session view on 'loading' with a null user until
   * the next refresh. Each read owns its own generation; the epoch is what a
   * composite operation (bootstrap) increments to supersede both.
   */
  let sessionEpoch = 0
  let sessionOperationGeneration = 0
  let meEpoch = 0
  let meOperationGeneration = 0

  function assertCurrentSessionOperation(epoch: number, operation: number, signal?: AbortSignal): void {
    if (signal?.aborted || epoch !== sessionEpoch || operation !== sessionOperationGeneration) {
      throw new DOMException('Session operation superseded', 'AbortError')
    }
  }

  function assertCurrentMeOperation(epoch: number, operation: number, signal?: AbortSignal): void {
    if (signal?.aborted || epoch !== meEpoch || operation !== meOperationGeneration) {
      throw new DOMException('Session operation superseded', 'AbortError')
    }
  }

  async function getSessionForOperation(epoch: number, operation: number,
    options?: ReadOptions): Promise<SessionView> {
    if (isMockSessionEnabled()) {
      assertCurrentSessionOperation(epoch, operation, options?.signal)
      applySessionView(MOCK_SESSION_VIEW)
      return MOCK_SESSION_VIEW
    }
    return withSameRequestRetry(async () => {
      let view: SessionView
      try {
        view = await transport.getSession({ signal: options?.signal })
      } catch (err) {
        throw wrapProductError(err)
      }
      assertCurrentSessionOperation(epoch, operation, options?.signal)
      applySessionView(view)
      return view
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getSession(options?: ReadOptions): Promise<SessionView> {
    sessionEpoch += 1
    return getSessionForOperation(sessionEpoch, ++sessionOperationGeneration, options)
  }

  async function getMeForOperation(epoch: number, operation: number, options?: ReadOptions): Promise<MeView> {
    if (isMockSessionEnabled()) {
      assertCurrentMeOperation(epoch, operation, options?.signal)
      applyMeView(MOCK_ME_VIEW)
      return MOCK_ME_VIEW
    }
    return withSameRequestRetry(async () => {
      let me: MeView
      try {
        me = await transport.getMe({ signal: options?.signal })
      } catch (err) {
        throw wrapProductError(err)
      }
      assertCurrentMeOperation(epoch, operation, options?.signal)
      applyMeView(me)
      return me
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getMe(options?: ReadOptions): Promise<MeView> {
    meEpoch += 1
    return getMeForOperation(meEpoch, ++meOperationGeneration, options)
  }

  async function bootstrapSession(options?: ReadOptions): Promise<{
    session: SessionView
    me: MeView | null
  }> {
    // One epoch supersedes both halves of the startup read.
    const epoch = ++sessionEpoch
    meEpoch = epoch
    const sessionOperation = ++sessionOperationGeneration
    const meOperation = ++meOperationGeneration
    const session = await getSessionForOperation(epoch, sessionOperation, options)
    if (!session.authenticated) {
      applyMeView(null)
      return { session, me: null }
    }
    try {
      const me = await getMeForOperation(epoch, meOperation, options)
      return { session, me }
    } catch (err) {
      if (err instanceof ProductApiError && err.isAuthRequired) {
        clearSession()
        const unauth = await getSessionForOperation(epoch, sessionOperation, options)
        return { session: unauth, me: null }
      }
      throw err
    }
  }

  async function deleteSession(options?: ReadOptions): Promise<void> {
    // Logging out supersedes both views: an in-flight `/me` from an abandoned
    // bootstrap must not resolve into the signed-out snapshot.
    sessionOperationGeneration += 1
    meOperationGeneration += 1
    sessionEpoch += 1
    meEpoch = sessionEpoch
    if (isMockSessionEnabled()) {
      clearSession()
      return
    }
    const remembered = getCsrfToken()
    clearSession()
    // R15-21: the server session is what matters. With no token in memory
    // (a failed bootstrap) or a stale one (CSRF 403), re-read the session
    // once instead of assuming it is gone. 401 means it already is.
    const readToken = async (): Promise<string | null> => {
      try {
        const view = await transport.getSession({ signal: options?.signal })
        return view.authenticated ? view.csrfToken : null
      } catch (err) {
        throw wrapProductError(err)
      }
    }
    const send = async (csrfToken: string, retryOnCsrf: boolean): Promise<void> => {
      try {
        await transport.deleteSession({ csrfToken, signal: options?.signal })
      } catch (err) {
        const apiErr = wrapProductError(err)
        if (apiErr.status === 401) return
        if (!apiErr.isCsrfFailed || !retryOnCsrf) throw apiErr
        const fresh = await readToken()
        if (fresh) await send(fresh, false)
      }
    }
    const csrf = remembered ?? await readToken()
    if (csrf) await send(csrf, true)
  }

  const requireCsrf = createRequireCsrf(getSession)
  const mutationCall = createMutationCall(getSession, requireCsrf)

  async function updateMe(body: UpdateMeRequest, options: MutationOptions): Promise<MeView> {
    const updated = await mutationCall(
      (csrf, commandIntentId) => transport.updateMe(body, {
        csrfToken: csrf,
        commandIntentId,
        signal: options.signal,
      }),
      options,
    )
    applyMeView(updated)
    return updated
  }

  async function uploadAvatar(file: File, options: MutationOptions): Promise<MeView> {
    const updated = await mutationCall(
      (csrf, commandIntentId) => transport.uploadAvatar(file, {
        csrfToken: csrf,
        commandIntentId,
        signal: options.signal,
      }),
      options,
    )
    applyMeView(updated)
    return updated
  }

  return {
    getSession,
    getMe,
    bootstrapSession,
    deleteSession,
    updateMe,
    uploadAvatar,
    mutationCall,
    requireCsrf,
  }
}
