import { apiUrl } from './config'
import { allocateCommandId, clearCommandId } from './commandId'
import { ProductApiError } from './errors'
import { parseProductError } from './product-error'
import { getCsrfToken } from './sessionStore'

/**
 * Owner agent directory and approval undo.
 *
 * E5 lists, audits, and revokes. E4 reads and writes policy and undoes a
 * policy-approved plan. Issuing a key is not in that fragment: the owner
 * session posts `{ name }` to `/api/v1/me/agents/keys` and the secret is
 * returned once.
 *
 * GETs no-op under Vitest unless a fetch implementation is passed, so a
 * page mount does not trip the suite's undeclared-fetch guard.
 */

const AGENT_ID = /^[A-Za-z0-9._~-]{1,256}$/u
const PLAN_ID = /^[A-Za-z0-9._~-]{1,128}$/u

export type AgentKind = 'oauth_client' | 'api_key'
export type AgentPolicy = 'manual' | 'trusted'
export type AgentAuditKind = 'plan' | 'direct_write'

export type AgentSummary = {
  id: string
  name: string
  kind: AgentKind
  scopes: string[]
  createdAt: string
  lastSeenAt: string | null
  policy: AgentPolicy
}

export type AgentListResponse = { agents: AgentSummary[] }

export type AgentAuditRecord = {
  id: string
  kind: AgentAuditKind
  createdAt: string
  summary: string | null
  outcome: string
  versionId: string | null
  /** Present when the server includes it; the audit schema does not require it. */
  collectionId: string | null
}

export type AgentAuditResponse = { records: AgentAuditRecord[] }

export type AgentRevokeResponse = {
  id: string
  revoked: boolean
  cancelledPlanCount: number
}

export type AgentPolicyView = {
  clientId: string
  policy: AgentPolicy
}

export type IssuedAgentKey = {
  id: string
  name: string
  secret: string
}

export type UndoApprovalResult = {
  planId: string
  versionId: string | null
  restored: boolean
  noop: boolean
}

export type AgentConnectCopy = {
  origin: string
  strictUrl: string
  compatUrl: string
  claude: string
  codex: string
  curl: string
}

type FetchLike = typeof fetch

type CallOptions = {
  signal?: AbortSignal
  fetch?: FetchLike
  intentId?: string
}

export interface AgentsApi {
  listAgents(signal?: AbortSignal): Promise<AgentListResponse>
  listAgentAudit(id: string, signal?: AbortSignal): Promise<AgentAuditResponse>
  getAgentPolicy(clientId: string, signal?: AbortSignal): Promise<AgentPolicyView>
  putAgentPolicy(clientId: string, policy: AgentPolicy): Promise<AgentPolicyView>
  revokeAgent(id: string): Promise<AgentRevokeResponse>
  issueAgentKey(name: string, options?: { intentId?: string }): Promise<IssuedAgentKey>
  undoApproval(planId: string, options?: { force?: boolean; intentId?: string }): Promise<UndoApprovalResult>
}

export function agentConnectCopy(origin: string): AgentConnectCopy {
  const base = origin.replace(/\/$/, '')
  const strictUrl = `${base}/collections/-/mcp`
  const compatUrl = `${base}/collections/-/mcp-compat`
  return {
    origin: base,
    strictUrl,
    compatUrl,
    claude: `claude mcp add --transport http colp "${compatUrl}"`,
    codex: strictUrl,
    curl: [
      'curl -H "Authorization: Bearer $KEY" -H "MCP-Protocol-Version: 2026-07-28" \\',
      '  -H "Accept: application/json, text/event-stream" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\' \\',
      `  "${strictUrl}"`,
    ].join('\n'),
  }
}

function loaderSkipped(fetchImpl: FetchLike | undefined): boolean {
  return import.meta.env.MODE === 'test' && fetchImpl === undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function invalidRequest(message: string): ProductApiError {
  return new ProductApiError({
    status: 400,
    code: 'invalid_request',
    message,
    recovery: 'user_action',
  })
}

function assertAgentId(id: string): string {
  if (!AGENT_ID.test(id)) throw invalidRequest('That agent id is not valid.')
  return id
}

function assertPlanId(id: string): string {
  if (!PLAN_ID.test(id)) throw invalidRequest('That plan id is not valid.')
  return id
}

function assertKeyName(name: string): string {
  const normalized = name.trim().normalize('NFC')
  if (normalized.length < 1 || normalized.length > 80) {
    throw invalidRequest('Name the key with 1 to 80 characters.')
  }
  return normalized
}

function browserOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const origin = window.location?.origin
  if (!origin || origin === 'null') return undefined
  return origin
}

function csrfToken(): string {
  const token = getCsrfToken()
  if (!token) {
    throw new ProductApiError({
      status: 401,
      code: 'authentication_required',
      message: 'Sign in again before changing agents.',
      recovery: 'user_action',
    })
  }
  return token
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

async function send(
  path: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<{ status: number; body: unknown }> {
  let response: Response
  try {
    response = await fetchImpl(apiUrl(path), init)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ProductApiError({
      status: 0,
      code: 'transport_error',
      message: error instanceof Error ? error.message : 'Network error',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
    })
  }
  if (response.status === 204) return { status: 204, body: null }
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = { raw: text }
    }
  }
  if (!response.ok) {
    throw new ProductApiError(parseProductError(response.status, body, headersToRecord(response.headers)))
  }
  return { status: response.status, body }
}

function mutationHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-CSRF-Token': csrfToken(),
    ...extra,
  }
  const origin = browserOrigin()
  if (origin) headers.Origin = origin
  return headers
}

function policyName(value: unknown): AgentPolicy {
  if (value === 'manual' || value === 'trusted') return value
  throw badResponse('The agent policy was not understood.')
}

function parseAgent(value: unknown): AgentSummary {
  if (!isRecord(value)) throw badResponse('The agent list was not understood.')
  if (typeof value.id !== 'string' || !AGENT_ID.test(value.id)) throw badResponse('The agent list was not understood.')
  if (typeof value.name !== 'string') throw badResponse('The agent list was not understood.')
  if (value.kind !== 'oauth_client' && value.kind !== 'api_key') throw badResponse('The agent list was not understood.')
  if (!Array.isArray(value.scopes) || value.scopes.some((scope) => typeof scope !== 'string')) {
    throw badResponse('The agent list was not understood.')
  }
  if (typeof value.createdAt !== 'string') throw badResponse('The agent list was not understood.')
  if (value.lastSeenAt !== null && typeof value.lastSeenAt !== 'string') {
    throw badResponse('The agent list was not understood.')
  }
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    scopes: value.scopes,
    createdAt: value.createdAt,
    lastSeenAt: value.lastSeenAt,
    policy: policyName(value.policy),
  }
}

function parseAuditRecord(value: unknown): AgentAuditRecord {
  if (!isRecord(value)) throw badResponse('The agent audit was not understood.')
  if (typeof value.id !== 'string' || value.id.length < 1) throw badResponse('The agent audit was not understood.')
  if (value.kind !== 'plan' && value.kind !== 'direct_write') throw badResponse('The agent audit was not understood.')
  if (typeof value.createdAt !== 'string' || typeof value.outcome !== 'string') {
    throw badResponse('The agent audit was not understood.')
  }
  if (value.versionId !== null && typeof value.versionId !== 'string') {
    throw badResponse('The agent audit was not understood.')
  }
  return {
    id: value.id,
    kind: value.kind,
    createdAt: value.createdAt,
    summary: typeof value.summary === 'string' ? value.summary : null,
    outcome: value.outcome,
    versionId: value.versionId,
    collectionId: typeof value.collectionId === 'string' ? value.collectionId : null,
  }
}

export async function listAgents(options: CallOptions = {}): Promise<AgentListResponse> {
  if (loaderSkipped(options.fetch)) return { agents: [] }
  const { body } = await send('/api/v1/me/agents', {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal,
    headers: { Accept: 'application/json' },
  }, options.fetch ?? globalThis.fetch)
  if (!isRecord(body) || !Array.isArray(body.agents)) throw badResponse('The agent list was not understood.')
  return { agents: body.agents.map(parseAgent) }
}

export async function listAgentAudit(id: string, options: CallOptions = {}): Promise<AgentAuditResponse> {
  if (loaderSkipped(options.fetch)) return { records: [] }
  const agentId = assertAgentId(id)
  const { body } = await send(`/api/v1/me/agents/${encodeURIComponent(agentId)}/audit?limit=50`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal,
    headers: { Accept: 'application/json' },
  }, options.fetch ?? globalThis.fetch)
  if (!isRecord(body) || !Array.isArray(body.records)) throw badResponse('The agent audit was not understood.')
  return { records: body.records.map(parseAuditRecord) }
}

export async function getAgentPolicy(clientId: string, options: CallOptions = {}): Promise<AgentPolicyView> {
  const id = assertAgentId(clientId)
  if (loaderSkipped(options.fetch)) return { clientId: id, policy: 'manual' }
  const { body } = await send(`/api/v1/me/agents/${encodeURIComponent(id)}/policy`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal,
    headers: { Accept: 'application/json' },
  }, options.fetch ?? globalThis.fetch)
  if (!isRecord(body) || body.clientId !== id) throw badResponse('The agent policy was not understood.')
  return { clientId: id, policy: policyName(body.policy) }
}

export async function putAgentPolicy(
  clientId: string,
  policy: AgentPolicy,
  options: CallOptions = {},
): Promise<AgentPolicyView> {
  const id = assertAgentId(clientId)
  if (policy !== 'manual' && policy !== 'trusted') throw invalidRequest('Policy must be manual or trusted.')
  const { body } = await send(`/api/v1/me/agents/${encodeURIComponent(id)}/policy`, {
    method: 'PUT',
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal,
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ policy }),
  }, options.fetch ?? globalThis.fetch)
  if (!isRecord(body)) throw badResponse('The agent policy was not understood.')
  return { clientId: typeof body.clientId === 'string' ? body.clientId : id, policy: policyName(body.policy) }
}

export async function revokeAgent(id: string, options: CallOptions = {}): Promise<AgentRevokeResponse> {
  const agentId = assertAgentId(id)
  const { status, body } = await send(`/api/v1/me/agents/${encodeURIComponent(agentId)}/revoke`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal,
    headers: mutationHeaders(),
  }, options.fetch ?? globalThis.fetch)
  if (status === 204) return { id: agentId, revoked: true, cancelledPlanCount: 0 }
  if (!isRecord(body) || body.revoked !== true) throw badResponse('The revoke result was not understood.')
  return {
    id: typeof body.id === 'string' ? body.id : agentId,
    revoked: true,
    cancelledPlanCount: typeof body.cancelledPlanCount === 'number' ? body.cancelledPlanCount : 0,
  }
}

export async function issueAgentKey(name: string, options: CallOptions = {}): Promise<IssuedAgentKey> {
  const label = assertKeyName(name)
  const intentId = options.intentId ?? `agent-key:${label}`
  const commandId = allocateCommandId(intentId)
  try {
    const { body } = await send('/api/v1/me/agents/keys', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      signal: options.signal,
      headers: mutationHeaders({
        'Content-Type': 'application/json',
        'Known-Command-Id': commandId,
      }),
      body: JSON.stringify({ name: label }),
    }, options.fetch ?? globalThis.fetch)
    if (!isRecord(body) || typeof body.secret !== 'string' || body.secret.length < 1) {
      throw badResponse('The issued key was not understood.')
    }
    if (typeof body.id !== 'string' || typeof body.name !== 'string') {
      throw badResponse('The issued key was not understood.')
    }
    clearCommandId(intentId)
    return { id: body.id, name: body.name, secret: body.secret }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') clearCommandId(intentId)
    throw error
  }
}

export async function undoApproval(
  planId: string,
  options: CallOptions & { force?: boolean } = {},
): Promise<UndoApprovalResult> {
  const id = assertPlanId(planId)
  const intentId = options.intentId ?? `mcp-approval-undo:${id}${options.force ? ':force' : ''}`
  const commandId = allocateCommandId(intentId)
  const path = options.force
    ? `/api/v1/mcp/approvals/${encodeURIComponent(id)}/undo?force=true`
    : `/api/v1/mcp/approvals/${encodeURIComponent(id)}/undo`
  try {
    const { body } = await send(path, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      signal: options.signal,
      headers: mutationHeaders({
        'Content-Type': 'application/json',
        'Known-Command-Id': commandId,
      }),
      body: '{}',
    }, options.fetch ?? globalThis.fetch)
    if (!isRecord(body) || body.restored !== true) throw badResponse('The undo result was not understood.')
    clearCommandId(intentId)
    return {
      planId: typeof body.planId === 'string' ? body.planId : id,
      versionId: typeof body.versionId === 'string' ? body.versionId : null,
      restored: true,
      noop: body.noop === true,
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') clearCommandId(intentId)
    throw error
  }
}

export const agentsApi: AgentsApi = {
  listAgents: (signal) => listAgents({ signal }),
  listAgentAudit: (id, signal) => listAgentAudit(id, { signal }),
  getAgentPolicy: (clientId, signal) => getAgentPolicy(clientId, { signal }),
  putAgentPolicy: (clientId, policy) => putAgentPolicy(clientId, policy),
  revokeAgent: (id) => revokeAgent(id),
  issueAgentKey: (name, options) => issueAgentKey(name, options),
  undoApproval: (planId, options) => undoApproval(planId, options),
}
