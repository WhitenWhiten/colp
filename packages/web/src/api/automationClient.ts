import { apiUrl } from './config'
import { allocateCommandId, clearCommandId } from './commandId'
import { ProductApiError } from './errors'
import { parseProductError } from './product-error'
import { getCsrfToken } from './sessionStore'
import type {
  AutomationBindingSet,
  AutomationBindingSetInput,
  AutomationCapabilities,
  AutomationChangeInput,
  AutomationDecisionInput,
  AutomationDependencyReport,
  AutomationExport,
  AutomationHealthIncident,
  AutomationHealthReport,
  AutomationJob,
  AutomationLifecycleInput,
  AutomationPage,
  AutomationPauseState,
  AutomationPreviewInput,
  AutomationPreviewResult,
  AutomationRule,
  AutomationRuleInput,
  AutomationRun,
  AutomationSubmissionResult,
  AutomationUndoInput,
} from './automationTypes'

/**
 * Owner automation API (`/api/v1/me/automations`).
 *
 * Reads send the session cookie. Every write sends the CSRF header, a
 * Known-Command-Id kept per user intent (a lost response replays the same
 * command), and, for existing configuration, If-Match with the revision the
 * backend returned. The client validates nothing the server decides.
 */

const BASE = '/api/v1/me/automations'
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u

type FetchLike = typeof fetch

export type RunQuery = {
  cursor?: string | null
  /** Page size, 1–100; the server defaults to 50. */
  limit?: number
  /** Bookmark history: both or neither. */
  collectionId?: string
  nodeId?: string
}

export interface AutomationApi {
  getCapabilities(signal?: AbortSignal): Promise<AutomationCapabilities>
  getPause(signal?: AbortSignal): Promise<AutomationPauseState>
  setPause(paused: boolean, revision: string): Promise<AutomationPauseState>
  listRules(cursor?: string | null, signal?: AbortSignal): Promise<AutomationPage<AutomationRule>>
  getRule(id: string, signal?: AbortSignal): Promise<AutomationRule>
  createRule(input: AutomationRuleInput): Promise<AutomationRule>
  replaceRule(id: string, input: AutomationChangeInput, revision: string): Promise<AutomationRule>
  setRuleLifecycle(id: string, input: AutomationLifecycleInput, revision: string): Promise<AutomationRule>
  archiveRule(id: string, revision: string): Promise<AutomationRule>
  previewRule(input: AutomationPreviewInput): Promise<AutomationPreviewResult>
  listBindingSets(cursor?: string | null, signal?: AbortSignal): Promise<AutomationPage<AutomationBindingSet>>
  getBindingSet(id: string, signal?: AbortSignal): Promise<AutomationBindingSet>
  createBindingSet(input: AutomationBindingSetInput): Promise<AutomationBindingSet>
  replaceBindingSet(id: string, input: AutomationBindingSetInput, revision: string): Promise<AutomationBindingSet>
  /** Only a set no rule revision ever referenced can be deleted. */
  deleteBindingSet(id: string, revision: string): Promise<void>
  getRuleHealth(id: string, signal?: AbortSignal): Promise<AutomationHealthReport>
  getRuleDependencies(id: string, signal?: AbortSignal): Promise<AutomationDependencyReport>
  revalidateRule(id: string, revision: string): Promise<AutomationHealthReport>
  listIncidents(cursor?: string | null, signal?: AbortSignal): Promise<AutomationPage<AutomationHealthIncident>>
  acknowledgeIncident(id: string): Promise<AutomationHealthIncident>
  listRuns(query?: RunQuery, signal?: AbortSignal): Promise<AutomationPage<AutomationRun>>
  getRun(id: string, signal?: AbortSignal): Promise<AutomationRun>
  undoRunEffect(runId: string, input: AutomationUndoInput, revision: string): Promise<AutomationRun>
  /** Stops remaining work; completed effects stay. */
  cancelRun(runId: string, revision: string): Promise<AutomationRun>
  getJob(id: string, signal?: AbortSignal): Promise<AutomationJob>
  /** The server decides whether the work is eligible (uncertain, no proposal, calls left). */
  retryJob(id: string, revision: string): Promise<AutomationJob>
  /** Approve or reject the exact proposal (its digest) through the existing Approvals ledger. */
  decideJob(id: string, input: AutomationDecisionInput, revision: string): Promise<AutomationSubmissionResult>
  exportAutomations(signal?: AbortSignal): Promise<AutomationExport>
}

/** The strong entity tag the backend issues for a revision. */
export function automationEtag(revision: string): string {
  return `"${revision}"`
}

function invalidRequest(message: string): ProductApiError {
  return new ProductApiError({ status: 400, code: 'invalid_request', message, recovery: 'user_action' })
}

function badResponse(message: string): ProductApiError {
  return new ProductApiError({
    status: 502,
    code: 'invalid_document',
    message,
    recovery: 'same_request',
    sameRequestRetrySafe: true,
  })
}

function opaqueId(value: string, what: string): string {
  if (!OPAQUE_ID.test(value)) throw invalidRequest(`That ${what} id is not valid.`)
  return encodeURIComponent(value)
}

function csrfToken(): string {
  const token = getCsrfToken()
  if (!token) {
    throw new ProductApiError({
      status: 401,
      code: 'authentication_required',
      message: 'Sign in again before changing automations.',
      recovery: 'user_action',
    })
  }
  return token
}

function browserOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const origin = window.location?.origin
  return origin && origin !== 'null' ? origin : undefined
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => { out[key] = value })
  return out
}

/** Small stable digest so an identical retry keeps its command and a changed body gets a new one. */
function bodyKey(body: unknown): string {
  const text = JSON.stringify(body) ?? ''
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** An unknown outcome (no answer, a server failure, a throttle) may still have committed: keep the command. */
function outcomeUnknown(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false
  if (!(error instanceof ProductApiError)) return true
  return error.status === 0 || error.status >= 500 || error.status === 429 || error.status === 408
}

export function createAutomationApi(fetchImpl?: FetchLike): AutomationApi {
  const doFetch: FetchLike = (input, init) => (fetchImpl ?? globalThis.fetch)(input, init)

  async function send(path: string, init: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await doFetch(apiUrl(path), { credentials: 'include', cache: 'no-store', ...init })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ProductApiError({
        status: 0,
        code: 'transport_error',
        message: 'The server could not be reached.',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
      })
    }
    if (response.status === 204) return null
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = { raw: text }
      }
    }
    if (!response.ok) throw new ProductApiError(parseProductError(response.status, body, headerRecord(response.headers)))
    return body
  }

  function read<T>(path: string, signal?: AbortSignal): Promise<T> {
    return send(path, { method: 'GET', signal, headers: { Accept: 'application/json' } }) as Promise<T>
  }

  async function write<T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { body?: unknown; revision?: string; intent: string },
  ): Promise<T> {
    const intent = `automation:${method}:${path}:${options.revision ?? ''}:${bodyKey(options.body ?? null)}:${options.intent}`
    const commandId = allocateCommandId(intent)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-CSRF-Token': csrfToken(),
      'Known-Command-Id': commandId,
    }
    const origin = browserOrigin()
    if (origin) headers.Origin = origin
    if (options.revision !== undefined) headers['If-Match'] = automationEtag(options.revision)
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      const result = await send(path, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      })
      clearCommandId(intent)
      return result as T
    } catch (error) {
      if (!outcomeUnknown(error)) clearCommandId(intent)
      throw error
    }
  }

  function page<T>(value: unknown, what: string): AutomationPage<T> {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) {
      throw badResponse(`The ${what} list was not understood.`)
    }
    const { items, nextCursor } = value as { items: T[]; nextCursor?: unknown }
    return { items, nextCursor: typeof nextCursor === 'string' && nextCursor ? nextCursor : null }
  }

  function query(values: Record<string, string | null | undefined>): string {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(values)) if (value) params.set(key, value)
    const text = params.toString()
    return text ? `?${text}` : ''
  }

  return {
    getCapabilities: async (signal) => read(`${BASE}/capabilities`, signal),
    getPause: async (signal) => read(`${BASE}/pause`, signal),
    setPause: async (paused, revision) => write('POST', `${BASE}/pause`, {
      body: paused ? { paused, reason: 'Owner paused all automations.' } : { paused, reason: 'Owner resumed automations.' },
      revision,
      intent: paused ? 'pause' : 'resume',
    }),
    listRules: async (cursor, signal) => page<AutomationRule>(await read(`${BASE}/rules${query({ cursor })}`, signal), 'rule'),
    getRule: async (id, signal) => read(`${BASE}/rules/${opaqueId(id, 'rule')}`, signal),
    createRule: async (input) => write('POST', `${BASE}/rules`, { body: input, intent: 'create' }),
    replaceRule: async (id, input, revision) => write('PUT', `${BASE}/rules/${opaqueId(id, 'rule')}`, { body: input, revision, intent: 'replace' }),
    setRuleLifecycle: async (id, input, revision) => write('POST', `${BASE}/rules/${opaqueId(id, 'rule')}/lifecycle`, {
      body: input,
      revision,
      intent: input.state,
    }),
    archiveRule: async (id, revision) => write('DELETE', `${BASE}/rules/${opaqueId(id, 'rule')}`, { revision, intent: 'archive' }),
    previewRule: async (input) => write('POST', `${BASE}/rules/preview`, { body: input, intent: 'preview' }),
    listBindingSets: async (cursor, signal) => page<AutomationBindingSet>(
      await read(`${BASE}/binding-sets${query({ cursor })}`, signal),
      'binding set',
    ),
    getBindingSet: async (id, signal) => read(`${BASE}/binding-sets/${opaqueId(id, 'binding set')}`, signal),
    createBindingSet: async (input) => write('POST', `${BASE}/binding-sets`, { body: input, intent: 'create' }),
    replaceBindingSet: async (id, input, revision) => write('PUT', `${BASE}/binding-sets/${opaqueId(id, 'binding set')}`, {
      body: input,
      revision,
      intent: 'replace',
    }),
    deleteBindingSet: async (id, revision) => {
      await write('DELETE', `${BASE}/binding-sets/${opaqueId(id, 'binding set')}`, { revision, intent: 'delete' })
    },
    getRuleHealth: async (id, signal) => read(`${BASE}/rules/${opaqueId(id, 'rule')}/health`, signal),
    getRuleDependencies: async (id, signal) => read(`${BASE}/rules/${opaqueId(id, 'rule')}/dependencies`, signal),
    revalidateRule: async (id, revision) => write('POST', `${BASE}/rules/${opaqueId(id, 'rule')}/revalidate`, {
      body: { reason: 'Owner asked to check the rule again.' },
      revision,
      intent: 'revalidate',
    }),
    listIncidents: async (cursor, signal) => page<AutomationHealthIncident>(
      await read(`${BASE}/incidents${query({ cursor })}`, signal),
      'notice',
    ),
    acknowledgeIncident: async (id) => write('POST', `${BASE}/incidents/${opaqueId(id, 'notice')}/acknowledge`, {
      body: { reason: 'Owner dismissed the notice.' },
      intent: 'acknowledge',
    }),
    listRuns: async (runQuery = {}, signal) => page<AutomationRun>(
      await read(`${BASE}/runs${query({
        cursor: runQuery.cursor,
        limit: runQuery.limit === undefined ? undefined : String(runQuery.limit),
        collectionId: runQuery.collectionId,
        nodeId: runQuery.nodeId,
      })}`, signal),
      'run',
    ),
    getRun: async (id, signal) => read(`${BASE}/runs/${opaqueId(id, 'run')}`, signal),
    undoRunEffect: async (runId, input, revision) => write('POST', `${BASE}/runs/${opaqueId(runId, 'run')}/undo`, {
      body: input,
      revision,
      intent: `undo:${input.effectReceiptId}`,
    }),
    cancelRun: async (runId, revision) => write('POST', `${BASE}/runs/${opaqueId(runId, 'run')}/cancel`, {
      body: { reason: 'Owner cancelled the remaining work of this run.' },
      revision,
      intent: 'cancel',
    }),
    getJob: async (id, signal) => read(`${BASE}/jobs/${opaqueId(id, 'job')}`, signal),
    retryJob: async (id, revision) => write('POST', `${BASE}/jobs/${opaqueId(id, 'job')}/retry`, {
      body: { reason: 'Owner asked to try the uncertain work again.' },
      revision,
      intent: 'retry',
    }),
    decideJob: async (id, input, revision) => write('POST', `${BASE}/jobs/${opaqueId(id, 'job')}/decision`, {
      body: input,
      revision,
      intent: `decide:${input.decision}`,
    }),
    exportAutomations: async (signal) => read(`${BASE}/export`, signal),
  }
}

export const automationApi: AutomationApi = createAutomationApi()
