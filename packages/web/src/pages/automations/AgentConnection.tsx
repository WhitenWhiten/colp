import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { agentsApi } from '../../api/agentsClient'
import type { AutomationAgentSetupResult, AutomationBindingSetInput, AutomationPairingGrant, AutomationRule, AutomationRuleDefinition, AutomationTarget } from '../../api/automationTypes'
import { CommandBlock } from '../../components/CommandBlock'
import { copyTextToClipboard } from '../../lib/clipboard'
import { formatDateTime } from '../../lib/formatDate'
import { originHint, readinessReason, useAutomationWorkers } from '../agents/automationWorkers'
import { AgentTest } from './AgentTest'
import { errorMessage, useAutomationDeps, useLoad } from './shared'

type Props = {
  definition: AutomationRuleDefinition
  initialSetup: AutomationAgentSetupResult | null
  configurationReady: boolean
  bindings: AutomationBindingSetInput | null
  current: AutomationRule | null
  configurationKey: string
  disabled: boolean
  canPrepare: boolean
  onBusy: (busy: boolean) => void
  onPrepared: (result: AutomationAgentSetupResult) => void
  onVerified: () => void
  onSelectionChanged: () => void
}

/** Only the current connection step is expanded. Credentials never enter storage or URLs. */
export function AgentConnection({ definition, bindings, current, configurationKey, initialSetup, configurationReady, disabled, canPrepare, onBusy, onPrepared, onVerified, onSelectionChanged }: Props) {
  const { api, agents = agentsApi } = useAutomationDeps()
  const workers = useAutomationWorkers(true, api)
  const directory = useLoad('agent-directory', signal => agents.listAgents(signal))
  const [choice, setChoice] = useState('')
  const [target, setTarget] = useState<AutomationTarget | null>(initialSetup?.target ?? null)
  const [prepared, setPrepared] = useState<{ key: string; rule: AutomationRule } | null>(initialSetup ? { key: JSON.stringify(initialSetup.rule.definition), rule: initialSetup.rule } : null)
  const [grant, setGrant] = useState<AutomationPairingGrant | null>(initialSetup?.pairing ?? null)
  const [commandId, setCommandId] = useState(() => crypto.randomUUID())
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const targetId = target?.id
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const targets = workers.data.targets.filter(item => item.status !== 'revoked' && item.configuration.privacy === 'standard')
  const connectedClients = new Set(targets.flatMap(item => workers.data.profiles.find(profile => profile.id === item.configuration.connectionProfileId)?.configuration.authorizedClientId ?? []))
  const fresh = directory.state.status === 'ready' ? directory.state.data.agents.filter(agent => agent.kind === 'oauth_client' && !connectedClients.has(agent.id)) : []
  const choices = [...targets.map(item => ({ key: `target:${item.id}`, name: item.configuration.name, targetId: item.id, agent: undefined })),
    ...fresh.map(agent => ({ key: `agent:${agent.id}`, name: agent.name, targetId: undefined, agent }))]
  const chosen = choices.find(item => item.key === choice)
    ?? choices.find(item => item.targetId === definition.route.targetIds?.[0]) ?? choices[0]

  useEffect(() => {
    if (prepared || target || !current || (choice && choice !== `target:${current.definition.route.targetIds?.[0]}`)) return
    const assigned = workers.data.targets.find(item => item.id === current.definition.route.targetIds?.[0] && item.status !== 'revoked')
    if (assigned) {
      setTarget(assigned)
      setChoice(`target:${assigned.id}`)
      setPrepared({ key: JSON.stringify(current.definition), rule: current })
    }
  }, [choice, current, prepared, target, workers.data.targets])

  useEffect(() => {
    if (!grant) return
    const timer = setTimeout(() => setGrant(null), Math.min(2_147_000_000, Math.max(0, Date.parse(grant.expiresAt) - Date.now())))
    return () => clearTimeout(timer)
  }, [grant])

  // Pairing and subscription changes are reported by the server; selection alone proves nothing.
  useEffect(() => {
    if (!targetId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const next = await api.getTarget(targetId, controller.signal)
        if (!controller.signal.aborted) {
          setTarget(next)
          if (next.wakeReadiness !== 'waitingForPairing') setGrant(null)
        }
      } catch (error) {
        if (!controller.signal.aborted) setNotice(errorMessage(error, 'Could not check the connection. Retrying.'))
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3_000)
    }
    timer = setTimeout(() => void refresh(), 1_000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [api, targetId])

  async function prepare() {
    if (!chosen || !bindings) return
    setBusy(true); onBusy(true); setNotice(null)
    try {
      const result = await api.prepareAgent({ definition, bindings,
        ...(chosen.targetId ? { targetId: chosen.targetId } : { agent: { name: chosen.name, clientId: chosen.agent!.id },
          // A local server cannot receive hosted callbacks. The UI explains how a client must continue.
          ...(!workers.data.eventsEnabled || originHint(window.location.origin) === 'local' ? { wakeMode: 'poll' as const } : {}) }),
        ...(current ? { ruleId: current.id, ruleRevision: current.revision } : {}) })
      if (!mounted.current) return
      setTarget(result.target); setChoice(`target:${result.target.id}`)
      setGrant(result.pairing); setCommandId(crypto.randomUUID())
      onPrepared(result)
      // The parent replaces route/binding identities with the saved configuration.
      setPrepared({ key: JSON.stringify(result.rule.definition), rule: result.rule })
      workers.reload()
    } catch (error) {
      if (mounted.current) setNotice(errorMessage(error, 'Could not connect this AI. Your rule has not been enabled.'))
    } finally {
      if (mounted.current) { setBusy(false); onBusy(false) }
    }
  }

  async function newRequest() {
    if (!target) return
    setBusy(true); setNotice(null)
    try {
      const latest = await api.getTarget(target.id)
      const next = await api.issuePairing(latest.id, latest.revision)
      if (mounted.current) { setGrant(next); setCommandId(crypto.randomUUID()) }
    } catch (error) {
      if (mounted.current) setNotice(errorMessage(error, 'Could not make a connection request.'))
    } finally { if (mounted.current) setBusy(false) }
  }

  const request = target ? [
    `Connect to my COLP server at ${window.location.origin} using your authenticated MCP connection with automation:work permission.`,
    ...(grant?.code ? [`Call automation.targets.pair with pairingId=${grant.pairingId}, code=${grant.code}, commandId=${commandId}.`] : []),
    `Use only target ${target.id}. Reconcile work with automation.jobs.list.`,
    target.wakeMode === 'events'
      ? 'If your host supports MCP Events, subscribe and verify its callback so you can receive future tasks. Otherwise explain that background execution is unavailable; do not claim it is enabled.'
      : 'Run the selected test using the automation.jobs tools. Future tasks require a recurring invocation in your host; if unavailable, explain that background execution is unavailable.',
    'Read only the allowed job inputs, submit typed results, and preserve the approval requirement.',
  ].join(' ') : ''
  const preparedCurrent = prepared && prepared.key === JSON.stringify(definition) && configurationReady
  const active = target?.wakeReadiness === 'active'
  const fieldNames = { url: 'links', title: 'titles', description: 'descriptions', note: 'notes', tags: 'tags', metadata: 'metadata', readableText: 'page text', folderDefinitions: 'folder definitions' }
  const sharedFields = [...new Set(definition.tasks.flatMap(task => task.inputFields))].map(field => fieldNames[field]).join(', ')

  return <section className="automation-agent-connection" aria-label="Connect an AI" data-testid="automation-agent-connection">
    <div className="field">
      <label htmlFor="automation-agent">AI to use</label>
      {choices.length > 0 ? <select id="automation-agent" value={chosen?.key ?? ''} disabled={disabled || busy}
        onChange={event => { setChoice(event.target.value); setTarget(null); setPrepared(null); setGrant(null); setNotice(null); onSelectionChanged() }}>
        {choices.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
      </select> : directory.state.status === 'loading' || workers.data.status === 'loading' ? <p className="field-hint">Loading connected AIs…</p>
        : <p className="field-hint"><Link to="/agents" target="_blank" rel="noreferrer">Connect an AI</Link>, then <button type="button" className="btn btn-ghost btn-sm" onClick={() => { directory.reload(); workers.reload() }}>Refresh</button>.</p>}
    </div>
    {(directory.state.status === 'error' || workers.data.status === 'error') && <p role="alert">Could not load AI connections. <button type="button" className="btn btn-ghost btn-sm" onClick={() => { directory.reload(); workers.reload() }}>Try again</button></p>}
    <p className="field-hint">Shares {sharedFields} for this rule. Changes require your approval. Provider charges may apply.</p>
    {(!preparedCurrent || !target) && chosen && <button type="button" className="btn btn-secondary" disabled={disabled || busy || !canPrepare || !bindings} onClick={() => void prepare()}>
      {busy ? 'Connecting…' : 'Connect and test'}
    </button>}
    {target && preparedCurrent && <>
      {!active && <div role="status">
        <p>{target.wakeReadiness === 'waitingForPairing' ? 'Paste the connection request into your AI to continue here.' : readinessReason(target.wakeReason)}</p>
        {['waitingForPairing', 'blocked'].includes(target.wakeReadiness) && !grant?.code
          ? <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void newRequest()}>Make a new connection request</button>
          : <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void copyTextToClipboard(request).then(() => setNotice('Copied. Paste it into your AI.')).catch(() => setNotice('Open the connection request below and copy it manually.'))}>Copy connection request</button>}
        {grant?.code && <p className="field-hint">One use. Expires {formatDateTime(grant.expiresAt)}.</p>}
        {(grant?.code || target.wakeReadiness === 'waitingForSubscription') && <details className="automation-disclosure"><summary>View connection request</summary><CommandBlock label="connection request" command={request} /></details>}
        <p className="field-hint">A connected chat may need a new sign-in for task permission. It must support background execution to keep running future tasks.</p>
      </div>}
      {active && <p role="status">Paired. Run a test to check that this AI can execute tasks.</p>}
      {active && <><button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyTextToClipboard(request).then(() => setNotice('Copied. Paste it into your AI after starting the test.')).catch(() => setNotice('Open the connection request and copy it manually.'))}>Copy task request</button>
        <details className="automation-disclosure"><summary>View task request</summary><CommandBlock label="task request" command={request} /></details>
        {target.wakeMode === 'poll' && <p className="field-hint">Future tasks need a recurring invocation in your AI host. COLP does not start that schedule.</p>}</>}
      {active && <AgentTest key={configurationKey} rule={prepared.rule} connected={active} onVerified={onVerified} />}
    </>}
    {notice && <p className="field-hint" role="status">{notice}</p>}
    <details className="automation-disclosure"><summary>Developer connection</summary><p className="field-hint">For a script you run yourself. <Link to="/agents?connect=worker" target="_blank" rel="noreferrer">Open script setup</Link>.</p></details>
  </section>
}
