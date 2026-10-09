import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  agentConnectCopy,
  agentsApi,
  type AgentAuditRecord,
  type AgentPolicy,
  type AgentSummary,
  type AgentsApi,
  type IssuedAgentKey,
} from '../api/agentsClient'
import { ProductApiError } from '../api/errors'
import { useAuth } from '../auth/AuthContext'
import { useConfirm } from '../components/ConfirmModal'
import { EmptyState } from '../components/EmptyState'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { formatDateTime } from '../lib/formatDate'
import { isSelfHostedEdition } from '../lib/edition'
import { loginPath } from '../lib/chrome'
import mcpMarkdown from '../../content/agent-public/mcp.md?raw'
import { TrustDocument } from './TrustDocument'
import '../styles/agents.css'

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ProductApiError ? error.message : fallback
}

function versionHref(record: AgentAuditRecord): string | null {
  if (!record.versionId) return null
  if (record.collectionId) return `/library/${encodeURIComponent(record.collectionId)}/history`
  if (record.kind === 'plan') {
    return `/approvals/${encodeURIComponent(record.id)}#version-${encodeURIComponent(record.versionId)}`
  }
  return null
}

function kindLabel(kind: AgentSummary['kind']): string {
  return kind === 'api_key' ? 'API key' : 'OAuth client'
}

export function Agents({
  api = agentsApi,
  origin,
}: {
  api?: AgentsApi
  origin?: string
} = {}) {
  if (!isSelfHostedEdition()) {
    return (
      <TrustDocument
        markdown={mcpMarkdown}
        eyebrow="Agents"
        documentTitle="MCP"
      />
    )
  }
  return <AgentsPage api={api} origin={origin} />
}

export function AgentsPage({
  api = agentsApi,
  origin,
}: {
  api?: AgentsApi
  origin?: string
}) {
  const pageOrigin = origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  const connect = agentConnectCopy(pageOrigin)
  const { isLoggedIn, bootstrapping, user } = useAuth()
  const accountId = isLoggedIn ? user?.accountId ?? null : null
  const confirm = useConfirm()
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [audit, setAudit] = useState<AgentAuditRecord[]>([])
  const [auditError, setAuditError] = useState<string | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [keyName, setKeyName] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [issued, setIssued] = useState<IssuedAgentKey | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const issueIntent = useRef<string | null>(null)
  const mounted = useRef(true)
  const identityRef = useRef<string | null>(accountId)
  // Keep async completions from an earlier account from repopulating this
  // page after logout or account switching.
  identityRef.current = accountId

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setAgents([])
    setLoading(false)
    setLoadError(null)
    setOpenId(null)
    setAudit([])
    setAuditError(null)
    setAuditLoading(false)
    setRowError({})
    setBusyId(null)
    setKeyName('')
    setKeyError(null)
    setIssuing(false)
    setIssued(null)
    setCopied(null)
    issueIntent.current = null
  }, [accountId])

  useEffect(() => {
    if (bootstrapping || !isLoggedIn) {
      setLoading(false)
      return
    }
    // Vitest replaces fetch with a guard. The default loader must not call it.
    if (import.meta.env.MODE === 'test' && api === agentsApi) {
      setLoading(false)
      setAgents([])
      return
    }
    const controller = new AbortController()
    const identityAtStart = accountId
    setLoading(true)
    setLoadError(null)
    void api.listAgents(controller.signal)
      .then((page) => {
        if (!controller.signal.aborted && mounted.current && identityRef.current === identityAtStart) {
          setAgents(page.agents)
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !mounted.current || identityRef.current !== identityAtStart) return
        setLoadError(messageOf(error, 'Could not load agents.'))
      })
      .finally(() => {
        if (!controller.signal.aborted && mounted.current && identityRef.current === identityAtStart) setLoading(false)
      })
    return () => controller.abort()
  }, [api, accountId, bootstrapping, isLoggedIn])

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(value)
    } catch {
      setCopied(null)
    }
  }

  async function reload(signal?: AbortSignal) {
    const identityAtStart = accountId
    const page = await api.listAgents(signal)
    if (mounted.current && identityRef.current === identityAtStart) setAgents(page.agents)
  }

  async function setPolicy(agent: AgentSummary, policy: AgentPolicy) {
    if (agent.policy === policy || busyId) return
    const identityAtStart = accountId
    const previous = agent.policy
    setBusyId(agent.id)
    setRowError((current) => ({ ...current, [agent.id]: '' }))
    setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, policy } : item))
    try {
      const next = await api.putAgentPolicy(agent.id, policy)
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, policy: next.policy } : item))
    } catch (error) {
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, policy: previous } : item))
      setRowError((current) => ({ ...current, [agent.id]: messageOf(error, 'Could not update the policy.') }))
    } finally {
      if (mounted.current && identityRef.current === identityAtStart) setBusyId(null)
    }
  }

  async function openAudit(agent: AgentSummary) {
    if (openId === agent.id) {
      setOpenId(null)
      return
    }
    const identityAtStart = accountId
    setOpenId(agent.id)
    setAudit([])
    setAuditError(null)
    setAuditLoading(true)
    try {
      const [records, policy] = await Promise.all([
        api.listAgentAudit(agent.id),
        api.getAgentPolicy(agent.id),
      ])
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setAudit(records.records)
      setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, policy: policy.policy } : item))
    } catch (error) {
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setAuditError(messageOf(error, 'Could not load the audit.'))
    } finally {
      if (mounted.current && identityRef.current === identityAtStart) setAuditLoading(false)
    }
  }

  async function revoke(agent: AgentSummary) {
    const accepted = await confirm({
      title: agent.kind === 'api_key' ? 'Revoke this API key?' : 'Revoke this agent?',
      body: 'The next request fails, and pending plans are cancelled.',
      confirmLabel: 'Revoke agent',
    })
    if (!accepted || !mounted.current) return
    const identityAtStart = accountId
    setBusyId(agent.id)
    setRowError((current) => ({ ...current, [agent.id]: '' }))
    try {
      await api.revokeAgent(agent.id)
      if (!mounted.current || identityRef.current !== identityAtStart) return
      if (openId === agent.id) setOpenId(null)
      await reload()
    } catch (error) {
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setRowError((current) => ({ ...current, [agent.id]: messageOf(error, 'Could not revoke this agent.') }))
    } finally {
      if (mounted.current && identityRef.current === identityAtStart) setBusyId(null)
    }
  }

  async function issueKey() {
    const name = keyName.trim()
    if (!name) {
      setKeyError('Name the key.')
      return
    }
    if (!issueIntent.current) issueIntent.current = `agent-key:${crypto.randomUUID()}`
    const identityAtStart = accountId
    setIssuing(true)
    setKeyError(null)
    try {
      const next = await api.issueAgentKey(name, { intentId: issueIntent.current })
      if (!mounted.current || identityRef.current !== identityAtStart) return
      issueIntent.current = null
      setIssued(next)
      setKeyName('')
      await reload()
    } catch (error) {
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setKeyError(messageOf(error, 'Could not issue a key.'))
    } finally {
      if (mounted.current && identityRef.current === identityAtStart) setIssuing(false)
    }
  }

  return (
    <PageShell className="agents-page" data-testid="agents-page">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        eyebrow="Connect"
        title="Agents"
        documentTitle="Agents"
        lede="Copy the MCP endpoint, connect Claude Code or Codex, or issue an API key. Trusted agents commit reversible plans without a click. Undo those plans on Approvals."
      />

      <div className="agents-stack">
        <section className="agents-block" aria-labelledby="agents-endpoint">
          <h2 id="agents-endpoint">Endpoint</h2>
          <p className="agents-meta">
            Hosted agents and OAuth clients need HTTPS. Local API-key scripts also work on explicitly acknowledged HTTP. Clients that speak MCP 2025-11-25 use the compatibility endpoint. Clients that speak MCP 2026-07-28 use the strict endpoint.
          </p>
          <h3>Claude Code</h3>
          <p className="agents-meta">OAuth. The browser opens this server&apos;s consent page. MCP 2025-11-25 uses the compatibility URL.</p>
          <pre className="agents-code">{connect.claude}</pre>
          <div className="agents-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyText(connect.claude)}>
              {copied === connect.claude ? 'Copied' : 'Copy Claude Code command'}
            </button>
          </div>
          <h3>Codex</h3>
          <p className="agents-meta">Codex and other clients that speak MCP 2026-07-28 use the strict endpoint.</p>
          <pre className="agents-code">{connect.codex}</pre>
          <div className="agents-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyText(connect.strictUrl)}>
              {copied === connect.strictUrl ? 'Copied' : 'Copy strict endpoint'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyText(connect.compatUrl)}>
              {copied === connect.compatUrl ? 'Copied' : 'Copy compatibility endpoint'}
            </button>
          </div>
          <h3>API key</h3>
          <p className="agents-meta">
            For a script that cannot do OAuth. Issue a named key below, copy it once, exchange it for an access token, and send the token to MCP. The same call fails after revoke.
          </p>
          <pre className="agents-code">{connect.curl}</pre>
        </section>

        {!bootstrapping && !isLoggedIn && (
          <EmptyState
            icon="alert"
            title="Sign in to manage agents"
            description="The endpoint above is this server. Sign in to see clients, change policy, and issue keys."
            action={<Link to={loginPath('/agents')} className="btn btn-primary btn-sm">Sign in</Link>}
          />
        )}

        {bootstrapping && <p className="agents-meta" role="status">Checking your session…</p>}

        {isLoggedIn && (
          <section className="agents-block" aria-labelledby="agents-keys">
            <h2 id="agents-keys">Issue a key</h2>
            <form
              className="agents-form"
              onSubmit={(event) => {
                event.preventDefault()
                void issueKey()
              }}
            >
              <label className="field">
                <span>Key name</span>
                <input
                  name="keyName"
                  value={keyName}
                  maxLength={80}
                  autoComplete="off"
                  onChange={(event) => setKeyName(event.target.value)}
                />
              </label>
              <button type="submit" className="btn btn-primary btn-sm" disabled={issuing}>
                {issuing ? 'Issuing…' : 'Issue key'}
              </button>
            </form>
            {keyError && <p className="field-error" role="alert">{keyError}</p>}
            {issued && (
              <div className="agents-secret" role="status">
                <p>Copy this key now. It will not be shown again.</p>
                <pre className="agents-code">{issued.secret}</pre>
                <div className="agents-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyText(issued.secret)}>
                    {copied === issued.secret ? 'Copied' : 'Copy key'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {isLoggedIn && (
          <section className="agents-block" aria-labelledby="agents-list">
            <h2 id="agents-list">Clients</h2>
            {loading && <p className="agents-meta" role="status">Loading agents…</p>}
            {loadError && (
              <p className="field-error" role="alert">
                {loadError}{' '}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void reload()}>Try again</button>
              </p>
            )}
            {!loading && !loadError && agents.length === 0 && (
              <p className="agents-meta">No agents yet. Connect a client or issue a key.</p>
            )}
            <div className="agents-clients">
              {agents.map((agent) => (
                <article className="agents-client" key={agent.id} data-agent-id={agent.id}>
                  <div className="agents-client-head">
                    <h3>{agent.name}</h3>
                    <p className="agents-meta">{kindLabel(agent.kind)}</p>
                  </div>
                  <p className="agents-meta">
                    Connected {formatDateTime(agent.createdAt)}
                    {' · '}
                    {agent.lastSeenAt ? `Last seen ${formatDateTime(agent.lastSeenAt)}` : 'Never seen'}
                  </p>
                  <p className="agents-meta">
                    Scopes {agent.scopes.length > 0 ? agent.scopes.join(', ') : 'none'}
                  </p>
                  <div className="agents-policy" role="group" aria-label={`Approval policy for ${agent.name}`}>
                    <button
                      type="button"
                      className={`btn btn-secondary btn-sm${agent.policy === 'manual' ? ' is-active' : ''}`}
                      aria-pressed={agent.policy === 'manual'}
                      disabled={busyId === agent.id}
                      onClick={() => void setPolicy(agent, 'manual')}
                    >
                      Manual
                    </button>
                    <button
                      type="button"
                      className={`btn btn-secondary btn-sm${agent.policy === 'trusted' ? ' is-active' : ''}`}
                      aria-pressed={agent.policy === 'trusted'}
                      disabled={busyId === agent.id}
                      onClick={() => void setPolicy(agent, 'trusted')}
                    >
                      Trusted
                    </button>
                  </div>
                  <div className="agents-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openAudit(agent)}>
                      {openId === agent.id ? 'Hide audit' : 'Audit'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger-ghost btn-sm"
                      disabled={busyId === agent.id}
                      onClick={() => void revoke(agent)}
                    >
                      Revoke
                    </button>
                  </div>
                  {rowError[agent.id] ? <p className="field-error" role="alert">{rowError[agent.id]}</p> : null}
                  {openId === agent.id && (
                    <div>
                      {auditLoading && <p className="agents-meta" role="status">Loading audit…</p>}
                      {auditError && <p className="field-error" role="alert">{auditError}</p>}
                      {!auditLoading && !auditError && audit.length === 0 && (
                        <p className="agents-meta">No recent plans or direct writes.</p>
                      )}
                      {audit.length > 0 && (
                        <ul className="agents-audit">
                          {audit.map((record) => {
                            const href = versionHref(record)
                            return (
                              <li key={record.id}>
                                <p className="agents-meta">
                                  {record.kind === 'plan' ? 'Plan' : 'Direct write'}
                                  {' · '}
                                  {formatDateTime(record.createdAt)}
                                  {' · '}
                                  {record.outcome}
                                </p>
                                {record.summary ? <p>{record.summary}</p> : null}
                                {record.versionId && href ? (
                                  <Link to={href}>Collection version {record.versionId}</Link>
                                ) : record.versionId ? (
                                  <p className="agents-meta">Collection version <code>{record.versionId}</code></p>
                                ) : (
                                  <p className="agents-meta">No collection version</p>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </PageShell>
  )
}
