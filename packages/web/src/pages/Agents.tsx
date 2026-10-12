import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  agentConnectCopy,
  agentsApi,
  type AgentPolicy,
  type AgentSummary,
  type AgentsApi,
  type IssuedAgentKey,
} from '../api/agentsClient'
import { ProductApiError } from '../api/errors'
import { useAuth } from '../auth/AuthContext'
import { useToast } from '../components/AppToast'
import { CommandBlock } from '../components/CommandBlock'
import { useConfirm } from '../components/ConfirmModal'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { loginPath } from '../lib/chrome'
import { plural } from '../lib/plural'
import { AgentCard, type AgentActivity } from './agents/AgentCard'
import { ConnectGuide } from './agents/ConnectGuide'
import '../styles/agents.css'

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ProductApiError ? error.message : fallback
}

const RULES: ReadonlyArray<{ icon: 'lock' | 'check' | 'refresh'; title: string; body: string }> = [
  {
    icon: 'lock',
    title: 'Manual, by default',
    body: 'A new agent proposes a plan. Nothing in your library changes until you approve it on Approvals.',
  },
  {
    icon: 'check',
    title: 'Trusted, if you choose',
    body: 'Moves apply right away. Deletes and publishing still wait for you, whatever the policy.',
  },
  {
    icon: 'refresh',
    title: 'Always reversible',
    body: 'Every applied plan saves a version in the collection’s History, and moves can be undone from Approvals.',
  },
]

export function Agents({
  api = agentsApi,
  origin,
}: {
  api?: AgentsApi
  origin?: string
} = {}) {
  const pageOrigin = origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  const connect = agentConnectCopy(pageOrigin)
  const { isLoggedIn, bootstrapping, user } = useAuth()
  const accountId = isLoggedIn ? user?.accountId ?? null : null
  const confirm = useConfirm()
  const { success, error: toastError } = useToast()
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [activity, setActivity] = useState<AgentActivity>({ status: 'closed' })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [keyName, setKeyName] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [issued, setIssued] = useState<IssuedAgentKey | null>(null)
  const issueIntent = useRef<string | null>(null)
  const secretRef = useRef<HTMLDivElement>(null)
  /* Set once a key is issued and the list has refreshed: the new agent card
     lands above the guide and pushes the one-time secret down the page. */
  const revealSecret = useRef(false)
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
    if (!revealSecret.current || issuing) return
    const block = secretRef.current
    if (!block) return
    revealSecret.current = false
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true
    block.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    // Copy is the next thing to do; focus it instead of leaving focus on the page.
    block.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [agents, issued, issuing])

  useEffect(() => {
    setAgents([])
    setLoading(false)
    setLoadError(null)
    setOpenId(null)
    setActivity({ status: 'closed' })
    setBusyId(null)
    setKeyName('')
    setKeyError(null)
    setIssuing(false)
    setIssued(null)
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

  async function reload(signal?: AbortSignal) {
    const identityAtStart = accountId
    const page = await api.listAgents(signal)
    if (mounted.current && identityRef.current === identityAtStart) setAgents(page.agents)
  }

  async function retryLoad() {
    setLoadError(null)
    setLoading(true)
    try {
      await reload()
    } catch (error) {
      if (mounted.current) setLoadError(messageOf(error, 'Could not load agents.'))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  async function setPolicy(agent: AgentSummary, policy: AgentPolicy) {
    if (agent.policy === policy || busyId) return
    const identityAtStart = accountId
    const previous = agent.policy
    setBusyId(agent.id)
    setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, policy } : item))
    try {
      const next = await api.putAgentPolicy(agent.id, policy)
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, policy: next.policy } : item))
    } catch (error) {
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, policy: previous } : item))
      toastError(messageOf(error, `Could not change the policy for ${agent.name}.`))
    } finally {
      if (mounted.current && identityRef.current === identityAtStart) setBusyId(null)
    }
  }

  async function toggleActivity(agent: AgentSummary) {
    if (openId === agent.id) {
      setOpenId(null)
      setActivity({ status: 'closed' })
      return
    }
    const identityAtStart = accountId
    setOpenId(agent.id)
    setActivity({ status: 'loading' })
    try {
      const [records, policy] = await Promise.all([
        api.listAgentAudit(agent.id),
        api.getAgentPolicy(agent.id),
      ])
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setActivity({ status: 'ready', records: records.records })
      setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, policy: policy.policy } : item))
    } catch (error) {
      if (!mounted.current || identityRef.current !== identityAtStart) return
      setActivity({ status: 'error', message: messageOf(error, 'Could not load this agent’s activity.') })
    }
  }

  async function revoke(agent: AgentSummary) {
    const accepted = await confirm({
      title: agent.kind === 'api_key' ? `Revoke the key “${agent.name}”?` : `Revoke ${agent.name}?`,
      body: 'Its next request fails, and any plans still waiting on Approvals are cancelled. To use it again, connect it again.',
      confirmLabel: 'Revoke agent',
    })
    if (!accepted || !mounted.current) return
    const identityAtStart = accountId
    setBusyId(agent.id)
    try {
      const result = await api.revokeAgent(agent.id)
      if (!mounted.current || identityRef.current !== identityAtStart) return
      if (openId === agent.id) {
        setOpenId(null)
        setActivity({ status: 'closed' })
      }
      success(result.cancelledPlanCount > 0
        ? `${agent.name} is revoked. ${plural(result.cancelledPlanCount, 'pending plan')} cancelled.`
        : `${agent.name} is revoked.`)
      await reload()
    } catch (error) {
      if (!mounted.current || identityRef.current !== identityAtStart) return
      toastError(messageOf(error, `Could not revoke ${agent.name}.`))
    } finally {
      if (mounted.current && identityRef.current === identityAtStart) setBusyId(null)
    }
  }

  async function issueKey() {
    const name = keyName.trim()
    if (!name) {
      setKeyError('Name the key so you can tell it apart later.')
      document.getElementById('agents-key-name')?.focus()
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
      // The key is issued either way; a failed refresh shows the card on the next load.
      await reload().catch(() => undefined)
      revealSecret.current = true
    } catch (error) {
      if (!mounted.current || identityRef.current !== identityAtStart) return
      toastError(messageOf(error, 'Could not issue a key.'))
    } finally {
      if (mounted.current && identityRef.current === identityAtStart) setIssuing(false)
    }
  }

  const keyPanel = isLoggedIn ? (
    <div className="agents-key-issue">
      <form
        className="agents-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void issueKey()
        }}
      >
        <div className="field">
          <label htmlFor="agents-key-name">Key name</label>
          <input
            id="agents-key-name"
            name="keyName"
            value={keyName}
            maxLength={80}
            autoComplete="off"
            placeholder="Backup script"
            aria-invalid={keyError ? true : undefined}
            aria-describedby={keyError ? 'agents-key-name-error' : undefined}
            onChange={(event) => {
              setKeyName(event.target.value)
              setKeyError(null)
            }}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={issuing}>
          {issuing ? 'Issuing…' : 'Issue key'}
        </button>
      </form>
      {keyError && <p id="agents-key-name-error" className="field-error" role="alert">{keyError}</p>}
      {issued && (
        <div className="agents-secret" role="status" ref={secretRef}>
          <p className="agents-secret-head">
            <Icon name="alert" />
            <span><strong>Copy “{issued.name}” now.</strong> It will not be shown again.</span>
          </p>
          <CommandBlock label="API key" command={issued.secret} />
          <p className="agents-note">Use it as <code>KEY</code> in the curl example below.</p>
        </div>
      )}
    </div>
  ) : (
    <p className="agents-note">
      <Link to={loginPath('/agents')}>Sign in</Link> to issue a key.
    </p>
  )

  return (
    <PageShell className="agents-page" data-testid="agents-page">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        eyebrow="Connect"
        title="Agents"
        documentTitle="Agents"
        lede="Let AI agents read and organize your library over MCP. You approve what they change."
      />

      <div className="agents-layout">
        <div className="agents-main">
          {bootstrapping && <LoadingState label="Checking your session…" />}

          {!bootstrapping && !isLoggedIn && (
            <EmptyState
              icon="alert"
              className="agents-signed-out"
              title="Sign in to manage agents"
              description="The instructions below already point at this server. Sign in to see connected agents, set their policy, and issue keys."
              action={<Link to={loginPath('/agents')} className="btn btn-primary btn-sm">Sign in</Link>}
            />
          )}

          {isLoggedIn && (
            <section className="agents-section" aria-labelledby="agents-list">
              <div className="agents-section-head">
                <h2 id="agents-list">Connected agents</h2>
                {agents.length > 0 && <span className="agents-count">{agents.length}</span>}
              </div>
              {loading && agents.length === 0 && <LoadingState label="Loading agents…" />}
              {loadError && (
                <EmptyState
                  role="alert"
                  icon="alert"
                  title="Could not load agents"
                  description={loadError}
                  action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void retryLoad()}>Try again</button>}
                />
              )}
              {!loading && !loadError && agents.length === 0 && (
                <EmptyState
                  icon="compass"
                  className="empty-state--compact agents-empty"
                  title="No agents yet"
                  description="Connect Claude Code or Codex below, or issue a key for a script. Each agent shows up here with its own approval policy."
                />
              )}
              {agents.length > 0 && (
                <ul className="agents-list">
                  {agents.map((agent) => (
                    <li key={agent.id}>
                      <AgentCard
                        agent={agent}
                        busy={busyId === agent.id}
                        activity={openId === agent.id ? activity : { status: 'closed' }}
                        onPolicy={(policy) => void setPolicy(agent, policy)}
                        onToggleActivity={() => void toggleActivity(agent)}
                        onRevoke={() => void revoke(agent)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="agents-section" aria-labelledby="agents-connect">
            <div className="agents-section-head">
              <h2 id="agents-connect">Connect an agent</h2>
            </div>
            <ConnectGuide connect={connect} keyPanel={keyPanel} />
          </section>
        </div>

        <aside className="agents-aside" aria-labelledby="agents-rules">
          <h2 id="agents-rules">How approvals work</h2>
          <ul className="agents-rules">
            {RULES.map((rule) => (
              <li key={rule.title}>
                <span className="agents-rule-icon" aria-hidden><Icon name={rule.icon} /></span>
                <div>
                  <h3>{rule.title}</h3>
                  <p>{rule.body}</p>
                </div>
              </li>
            ))}
          </ul>
          {isLoggedIn && (
            <Link to="/approvals" className="agents-aside-link">
              Review plans on Approvals
              <Icon name="arrow-right" />
            </Link>
          )}
        </aside>
      </div>
    </PageShell>
  )
}
