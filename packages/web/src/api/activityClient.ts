import { apiUrl } from './config'
import { allocateCommandId, clearCommandId } from './commandId'
import { ProductApiError } from './errors'
import { badResponse, invalidRequest, requestJson, requestOrigin, requireCsrfToken } from './json-request'
import { getSessionSnapshot, privateSessionIdentity } from './sessionStore'
import type { ActivityPage, ActivityReadRequest, ActivityReadResult, ActivitySummary } from './activityTypes'

export type ActivityQuery = { state?: 'all' | 'unread'; cursor?: string | null; limit?: number }
export interface ActivityApi {
  listActivity(query?: ActivityQuery, signal?: AbortSignal): Promise<ActivityPage>
  getActivitySummary(signal?: AbortSignal): Promise<ActivitySummary>
  markActivityRead(request: ActivityReadRequest): Promise<ActivityReadResult>
}

const BASE = '/api/v1/me/activity'
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function isActivityUnavailableError(error: unknown): boolean {
  return error instanceof ProductApiError && error.status === 404
}

export function createActivityApi(fetchImpl?: typeof fetch): ActivityApi {
  async function send(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const identity = privateSessionIdentity()
    const { body } = await requestJson(apiUrl(path), {
      ...init, credentials: getSessionSnapshot().authenticated ? 'include' : 'omit', cache: 'no-store',
    }, {
      fetchImpl,
      assertCurrent: () => {
        if (identity !== privateSessionIdentity()) throw new DOMException('Your session changed.', 'AbortError')
        init.signal?.throwIfAborted()
      },
      strictJson: () => badResponse('The activity response was not valid JSON.'),
    })
    if (!record(body)) throw badResponse('The activity response was not understood.')
    return body
  }

  return {
    async listActivity(query = {}, signal) {
      const params = new URLSearchParams()
      if (query.state) params.set('state', query.state)
      if (query.cursor) params.set('cursor', query.cursor)
      if (query.limit !== undefined) {
        if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw invalidRequest('Choose between 1 and 100 activity items.')
        params.set('limit', String(query.limit))
      }
      const body = await send(`${BASE}${params.size ? `?${params}` : ''}`, { method: 'GET', signal, headers: { Accept: 'application/json' } })
      if (!Array.isArray(body.items) || !count(body.unreadCount) || (body.nextCursor !== null && typeof body.nextCursor !== 'string')) {
        throw badResponse('The activity list was not understood.')
      }
      return body as unknown as ActivityPage
    },
    async getActivitySummary(signal) {
      const body = await send(`${BASE}/summary`, { method: 'GET', signal, headers: { Accept: 'application/json' } })
      if (!count(body.unreadCount) || typeof body.revision !== 'string' || !/^\d+$/u.test(body.revision) || (body.latest !== null && !record(body.latest))) {
        throw badResponse('The activity summary was not understood.')
      }
      return body as unknown as ActivitySummary
    },
    async markActivityRead(request) {
      const intent = `activity:read:${JSON.stringify(request)}`
      const headers: Record<string, string> = {
        Accept: 'application/json', 'Content-Type': 'application/json',
        'X-CSRF-Token': requireCsrfToken('activity'), 'Known-Command-Id': allocateCommandId(intent),
      }
      const origin = requestOrigin()
      if (origin) headers.Origin = origin
      try {
        const body = await send(`${BASE}/read`, { method: 'POST', headers, body: JSON.stringify(request) })
        if (!count(body.readCount) || !count(body.unreadCount)) throw badResponse('The activity read response was not understood.')
        clearCommandId(intent)
        return body as unknown as ActivityReadResult
      } catch (error) {
        if (error instanceof ProductApiError && error.status > 0 && error.status < 500 && ![408, 429].includes(error.status)) clearCommandId(intent)
        throw error
      }
    },
  }
}

export const activityApi = createActivityApi()
