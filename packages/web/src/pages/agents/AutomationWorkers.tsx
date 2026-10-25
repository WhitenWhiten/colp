import { useEffect, useRef, useState } from 'react'
import type { AgentSummary } from '../../api/agentsClient'
import type {
  AutomationConnectionProfile,
  AutomationConnectionProfileInput,
  AutomationTarget,
  AutomationTargetInput,
} from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import { useToast } from '../../components/AppToast'
import { CommandBlock } from '../../components/CommandBlock'
import { useConfirm } from '../../components/ConfirmModal'
import { EmptyState, LoadingState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { StatusBadge } from '../../components/StatusBadge'
import { formatDateTime } from '../../lib/formatDate'
import { plural } from '../../lib/plural'
import {
  canDoRuleWork,
  defaultWorkerName,
  hasCatalog,
  originHint,
  pairingRefusal,
  pairsBySignIn,
  READINESS,
  readinessReason,
  withCatalog,
  type AutomationWorkers,
  type IssuedGrant,
} from './automationWorkers'

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ProductApiError && error.message ? error.message : fallback
}

/** Workers that would lose their pairing if this agent's automation opt-ins change. */
function pairedWorkers(profile: AutomationConnectionProfile, targets: readonly AutomationTarget[]): number {
  return targets.filter((target) => target.configuration.connectionProfileId === profile.id
    && target.wakeReadiness !== 'waitingForPairing' && target.wakeReadiness !== 'disabled').length
}

function unpairQuestion(count: number, profileName: string, confirmLabel: string) {
  return {
    title: `Unpair ${plural(count, 'worker')}?`,
    body: `Changing this unpairs the ${plural(count, 'worker')} using “${profileName}”. Their waiting work stays queued; pair them again to continue.`,
    confirmLabel,
  }
}

function Switch({
  id,
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  detail: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="toggle-row agent-automation-row">
      <div>
        <strong id={`${id}-label`}>{label}</strong>
        <span className="agent-card-meta" id={`${id}-detail`}>{detail}</span>
      </div>
      <button
        type="button"
        role="switch"
        className="toggle"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-detail`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  )
}

/**
 * One agent's automation opt-ins (AU-21): automations on or off, and the two
 * catalogs, each its own choice. Standard tools never turn automation on.
 */
export function AgentAutomationOptIns({
  profile,
  workers,
  showName,
}: {
  profile: AutomationConnectionProfile
  workers: AutomationWorkers
  showName: boolean
}) {
  const confirm = useConfirm()
  const { success, error: toastError } = useToast()
  const [busy, setBusy] = useState(false)
  const configuration = profile.configuration
  const enabled = configuration.automationEnabled
  const affected = pairedWorkers(profile, workers.data.targets)

  async function save(next: AutomationConnectionProfileInput, unpairs: boolean) {
    if (unpairs && affected > 0 && !await confirm(unpairQuestion(affected, configuration.name, 'Change and unpair'))) return
    setBusy(true)
    try {
      await workers.saveProfile(profile, next)
      success(`Saved automation settings for “${configuration.name}”.`)
    } catch (error) {
      toastError(messageOf(error, 'Could not change these automation settings.'))
    } finally {
      setBusy(false)
    }
  }

  const id = `agent-automation-${profile.id}`
  return (
    <section className="agent-automation" aria-labelledby={`${id}-heading`} data-profile-id={profile.id}>
      <h4 id={`${id}-heading`}>
        <Icon name="bolt" />
        Automations{showName ? ` · ${configuration.name}` : ''}
      </h4>
      <Switch
        id={`${id}-enabled`}
        label="Use for automations"
        detail="Off stops all rule work through this agent, without revoking it."
        checked={enabled}
        disabled={busy}
        onChange={(next) => void save({ ...configuration, automationEnabled: next }, true)}
      />
      <Switch
        id={`${id}-manager`}
        label="Manage rules"
        detail="It may read, check and save rules. Needs the automation:manage permission."
        checked={hasCatalog(profile, 'automationManager')}
        disabled={busy}
        onChange={(next) => void save(withCatalog(configuration, 'automationManager', next), false)}
      />
      <Switch
        id={`${id}-worker`}
        label="Do rule work"
        detail="It may pick up and finish rule tasks, such as summaries. Needs the automation:work permission."
        checked={hasCatalog(profile, 'automationWorker')}
        disabled={busy}
        onChange={(next) => void save(withCatalog(configuration, 'automationWorker', next), true)}
      />
    </section>
  )
}

function PairingGrant({ issued, origin, agentName, onDone, onAgain, busy }: {
  issued: IssuedGrant
  origin: string
  agentName: string | null
  onDone: () => void
  onAgain: () => void
  busy: boolean
}) {
  const { grant } = issued
  const ref = useRef<HTMLDivElement>(null)

  // A new code is the next thing to act on: bring it into view with its first button focused.
  useEffect(() => {
    const block = ref.current
    if (!block) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true
    block.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    block.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [issued])

  if (grant.code === null) {
    return (
      <div className="agents-secret agents-worker-grant" role="status" data-testid="worker-grant" ref={ref}>
        <p className="agents-secret-head">
          <Icon name="alert" />
          <span>This code was already shown once, so it can’t be shown again. Make a new one.</span>
        </p>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onAgain}>Make a new code</button>
      </div>
    )
  }
  const env = [
    `export COLP_ORIGIN=${origin}`,
    `export COLP_TARGET_ID=${grant.targetId}`,
    `export COLP_PAIRING_ID=${grant.pairingId}`,
    `export COLP_PAIRING_CODE=${grant.code}`,
    `export COLP_PAIRING_COMMAND_ID=${issued.commandId}`,
  ].join('\n')
  return (
    <div className="agents-secret agents-worker-grant" role="status" data-testid="worker-grant" ref={ref}>
      <p className="agents-secret-head">
        <Icon name="alert" />
        <span>
          <strong>Copy this now.</strong> The code works once and expires at{' '}
          <time dateTime={grant.expiresAt}>{formatDateTime(grant.expiresAt)}</time>. It is not shown again or saved anywhere.
        </span>
      </p>
      <CommandBlock label="Pairing settings for the worker" command={env} />
      <p className="agents-note">
        Set these in the worker’s environment, next to {agentName ? <>an access token of <strong>{agentName}</strong></> : 'its own access token'} with
        the <code>automation:work</code> permission (<code>COLP_ACCESS_TOKEN</code>), then start it. Keep them out of shell history and logs.
      </p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>Done, hide it</button>
    </div>
  )
}

function checksEvery(minutes: number | undefined): string {
  if (!minutes) return 'Checks for work'
  return minutes === 1 ? 'Checks for work every minute' : `Checks for work every ${minutes} minutes`
}

function wakeLine(target: AutomationTarget): string {
  if (target.wakeMode === 'poll') return `${checksEvery(target.pollIntervalMinutes)}. That timing is the worker’s own; COLP doesn’t start it.`
  return target.wakeReadiness === 'active'
    ? 'Woken by events when work is ready.'
    : 'Woken by events, once a subscription is verified. Chosen, not active yet.'
}

function WorkerCard({
  target,
  profileName,
  grant,
  origin,
  workers,
  selfPairing,
}: {
  target: AutomationTarget
  profileName: string | null
  grant: IssuedGrant | null
  origin: string
  workers: AutomationWorkers
  /** Its agent allowed rule work at sign-in, so it pairs on its own next call. */
  selfPairing: boolean
}) {
  const confirm = useConfirm()
  const { success, error: toastError } = useToast()
  const [busy, setBusy] = useState(false)
  const readiness = READINESS[target.wakeReadiness]
  const revoked = target.wakeReadiness === 'disabled'
  const unpaired = target.wakeReadiness === 'waitingForPairing'
  const configuration = target.configuration

  async function pair(again: boolean) {
    if (again) {
      const accepted = await confirm({
        title: `Pair “${configuration.name}” again?`,
        body: 'Its current pairing stops working. The worker continues once it redeems the new code.',
        confirmLabel: 'Pair again',
      })
      if (!accepted) return
    }
    setBusy(true)
    try {
      await workers.pair(target)
    } catch (error) {
      toastError(pairingRefusal(error))
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    const accepted = await confirm({
      title: `Revoke “${configuration.name}”?`,
      body: 'It can’t pick up or finish rule work any more. To use it again, add it as a new worker and pair it.',
      confirmLabel: 'Revoke worker',
    })
    if (!accepted) return
    setBusy(true)
    try {
      await workers.revoke(target)
      success(`“${configuration.name}” is revoked.`)
    } catch (error) {
      toastError(messageOf(error, 'Could not revoke this worker.'))
    } finally {
      setBusy(false)
    }
  }

  async function switchMode(next: AutomationTarget['wakeMode']) {
    setBusy(true)
    try {
      await workers.saveTarget(target, { ...configuration, wakeMode: next })
      success(next === 'poll' ? 'It now checks for work.' : 'It will be woken by events once a subscription is verified.')
    } catch (error) {
      toastError(messageOf(error, 'Could not change how it learns about work.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="agent-card agents-worker" data-target-id={target.id} data-readiness={target.wakeReadiness} aria-labelledby={`worker-${target.id}`}>
      <header className="agent-card-head">
        <span className="agent-card-icon" aria-hidden><Icon name="bolt" /></span>
        <div className="agent-card-title">
          <h3 id={`worker-${target.id}`}>{configuration.name}</h3>
          <p className="agent-card-meta">
            {[profileName ? `Runs as ${profileName}` : null, configuration.providerLabel || null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="agents-worker-head-end">
          <StatusBadge tone={readiness.tone} data-testid="worker-readiness">{readiness.label}</StatusBadge>
          {!revoked && (
            <button type="button" className="btn btn-danger-ghost btn-sm" disabled={busy} onClick={() => void revoke()}>
              Revoke
            </button>
          )}
        </div>
      </header>

      <p className="agents-worker-reason" data-testid="worker-reason">
        {unpaired && grant?.grant.code ? 'Waiting for the worker to use the code below.'
          : unpaired && selfPairing ? `Waiting for ${profileName ?? 'its agent'} to connect. It pairs by itself the next time it talks to this server.`
          : readinessReason(target.wakeReason)}
      </p>
      <dl className="agents-worker-facts">
        <div><dt>Learns about work</dt><dd>{wakeLine(target)}</dd></div>
        <div>
          <dt>Credential</dt>
          <dd>
            {target.isolation === 'dedicatedCredential'
              ? 'Its own, used by no other worker'
              : 'Shared with other workers or tools; fine for standard rules, not for restricted ones'}
          </dd>
        </div>
        <div><dt>Rules it can serve</dt><dd>{configuration.privacy === 'restricted' ? 'Restricted and standard' : 'Standard'}</dd></div>
      </dl>

      {grant && (
        <PairingGrant
          issued={grant}
          origin={origin}
          agentName={profileName}
          busy={busy}
          onDone={workers.clearGrant}
          onAgain={() => void pair(false)}
        />
      )}

      {!revoked && ((unpaired && !grant) || target.wakeReadiness === 'blocked' || target.wakeMode === 'events' || workers.data.eventsEnabled) && (
        <div className="agent-card-foot agents-worker-actions">
          {unpaired && !grant && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void pair(false)}>
              Pair
            </button>
          )}
          {target.wakeReadiness === 'blocked' && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void pair(true)}>
              Pair again
            </button>
          )}
          {(target.wakeMode === 'events' || workers.data.eventsEnabled) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => void switchMode(target.wakeMode === 'poll' ? 'events' : 'poll')}
            >
              {target.wakeMode === 'poll' ? 'Use events instead' : 'Check for work instead'}
            </button>
          )}
        </div>
      )}
    </article>
  )
}

/** What a worker can run as: an agent's automation connection, or a connected agent with none yet. */
type RunsAs = { key: string; name: string; agentId: string; profile: AutomationConnectionProfile | null }

/**
 * Connections that may already do rule work come first, since choosing one
 * changes nothing else; then agents with no connection yet, keys before
 * sign-ins because a worker script runs on a key; then connections turned off.
 */
function runsAsChoices(profiles: readonly AutomationConnectionProfile[], agents: readonly AgentSummary[]): RunsAs[] {
  const connected = new Set(profiles.map((profile) => profile.configuration.authorizedClientId))
  const ofProfile = (profile: AutomationConnectionProfile): RunsAs => ({
    key: `profile:${profile.id}`, name: profile.configuration.name, agentId: profile.configuration.authorizedClientId, profile,
  })
  const fresh = agents.filter((agent) => !connected.has(agent.id))
    .sort((a, b) => Number(b.kind === 'api_key') - Number(a.kind === 'api_key'))
    .map((agent): RunsAs => ({ key: `agent:${agent.id}`, name: agent.name, agentId: agent.id, profile: null }))
  return [...profiles.filter(canDoRuleWork).map(ofProfile), ...fresh, ...profiles.filter((profile) => !canDoRuleWork(profile)).map(ofProfile)]
}

/**
 * Adding a worker is one press: a name nobody has to type, the agent picked
 * for you when there is only one, and the defaults that suit the reference
 * worker (it checks for work every minute; standard rules). Adding also pairs
 * it, and lets its agent do rule work when it can't yet. For an agent with no
 * automation connection, the worker's first pairing confirms its credential.
 */
function NewWorker({ workers, profiles, agents, originLocal, onCreated, onShowSteps }: {
  workers: AutomationWorkers
  profiles: readonly AutomationConnectionProfile[]
  agents: readonly AgentSummary[]
  originLocal: boolean
  onCreated: () => void
  onShowSteps: () => void
}) {
  const confirm = useConfirm()
  const { success, error: toastError } = useToast()
  const candidates = runsAsChoices(profiles, agents)
  const [name, setName] = useState(() => defaultWorkerName(workers.data.targets))
  // By agent too: once its connection exists, the same agent is still the choice.
  const [choice, setChoice] = useState({ key: candidates[0]?.key ?? '', agentId: candidates[0]?.agentId ?? '' })
  // Stands in for the credential until the first pairing confirms it; one per form, so a retry repeats the same request.
  const [pendingBinding] = useState(() => `pending-${crypto.randomUUID()}`)
  const [provider, setProvider] = useState('')
  const [privacy, setPrivacy] = useState<AutomationTargetInput['privacy']>('standard')
  const [wakeMode, setWakeMode] = useState<NonNullable<AutomationTargetInput['wakeMode']>>('poll')
  const [pollMinutes, setPollMinutes] = useState('1')
  const [moreOpen, setMoreOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const runsAs = candidates.find((item) => item.key === choice.key)
    ?? candidates.find((item) => item.agentId === choice.agentId)
    ?? candidates[0]
  if (!runsAs) {
    return (
      <div className="agents-worker-blocked" data-testid="worker-no-connection">
        <p className="agents-note">A worker runs as one of your agents, and none is connected yet. Issue it an API key first.</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onShowSteps}>Show the worker steps</button>
      </div>
    )
  }

  const agentName = runsAs.name
  const turnsOn = !runsAs.profile || !canDoRuleWork(runsAs.profile)
  const selfPairs = pairsBySignIn(agents.find((item) => item.id === runsAs.agentId))
  const minutes = Number(pollMinutes)
  const minutesValid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
  const chosen = [
    wakeMode === 'events' ? 'Woken by events' : checksEvery(minutesValid ? minutes : undefined),
    privacy === 'restricted' ? 'restricted and standard rules' : 'standard rules',
  ].join(' · ')

  // An arrow, not a hoisted function, so `runsAs` stays narrowed.
  const submit = async () => {
    const workerName = name.trim()
    if (!workerName) {
      setError('Name the worker so you can tell it apart later.')
      document.getElementById('worker-name')?.focus()
      return
    }
    if (wakeMode === 'poll' && !minutesValid) {
      setMoreOpen(true)
      setError('Check interval is a whole number of minutes, from 1 to 1440.')
      return
    }
    const existing = runsAs.profile
    const affected = existing && turnsOn ? pairedWorkers(existing, workers.data.targets) : 0
    if (affected > 0 && !await confirm(unpairQuestion(affected, agentName, 'Add and unpair'))) return
    setError(null)
    setBusy(true)
    try {
      let profile = existing
      if (!profile) {
        // Standard stays in the catalogs, so the agent's other tools keep working once it pairs.
        profile = await workers.createProfile({
          name: agentName.slice(0, 200),
          automationEnabled: true,
          authorizedClientId: runsAs.agentId,
          credentialBindingId: pendingBinding,
          catalogs: ['standard', 'automationWorker'],
        })
      } else if (turnsOn) {
        await workers.saveProfile(profile, { ...withCatalog(profile.configuration, 'automationWorker', true), automationEnabled: true })
      }
      const { pairingError } = await workers.addWorker({
        name: workerName,
        providerLabel: provider.trim(),
        broadcastOptIn: false,
        privacy,
        connectionProfileId: profile.id,
        wakeMode,
        ...(wakeMode === 'poll' ? { pollIntervalMinutes: minutes } : {}),
      }, { pair: !selfPairs })
      if (pairingError) toastError(`Added “${workerName}”, but it isn’t paired yet. ${pairingRefusal(pairingError)}`)
      else if (selfPairs) success(`Added “${workerName}”. It pairs by itself the next time ${agentName} talks to this server.`)
      else success(`Added “${workerName}”. Copy its pairing settings now.`)
      onCreated()
    } catch (failure) {
      toastError(messageOf(failure, 'Could not add this worker.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="agents-worker-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="agents-worker-form-main">
        <div className="field">
          <label htmlFor="worker-name">Name</label>
          <input
            id="worker-name"
            value={name}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
          />
        </div>
        {candidates.length > 1 && (
          <div className="field">
            <label htmlFor="worker-profile">Runs as</label>
            <select
              id="worker-profile"
              value={runsAs.key}
              onChange={(event) => {
                const next = candidates.find((item) => item.key === event.target.value)
                if (next) setChoice({ key: next.key, agentId: next.agentId })
              }}
            >
              {candidates.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
            </select>
          </div>
        )}
      </div>
      <p className="agents-note" data-testid="worker-agent-note">
        {candidates.length === 1 && <>Runs as <strong>{agentName}</strong>. </>}
        {selfPairs
          ? <>It pairs by itself the next time {candidates.length === 1 ? 'this agent' : <strong>{agentName}</strong>} talks to this server; there is no code to copy.</>
          : turnsOn
            ? <>Adding it also lets {candidates.length === 1 ? 'this agent' : <strong>{agentName}</strong>} do rule work.</>
            : 'You get its one-use pairing code straight away.'}
      </p>

      <details
        className="agents-worker-more"
        open={moreOpen}
        onToggle={(event) => setMoreOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>
          <Icon name="chevron-right" className="agents-worker-more-chevron" />
          More options
          <span className="agents-worker-more-note" data-testid="worker-more-note">{chosen}</span>
        </summary>
        <div className="agents-worker-options">
          <div className="field">
            <label htmlFor="worker-provider">Where it runs (optional)</label>
            <input id="worker-provider" value={provider} maxLength={100} autoComplete="off" placeholder="Script on my laptop" onChange={(event) => setProvider(event.target.value)} />
          </div>
          <fieldset className="option-group">
            <legend>How it learns about work</legend>
            <label className="option-row">
              <input type="radio" name="worker-wake" checked={wakeMode === 'poll'} onChange={() => setWakeMode('poll')} />
              <span>
                <strong>It checks for work</strong>
                <span className="agent-card-meta">Works anywhere it can reach this server, including a home server. Its own schedule decides how fresh it is.</span>
              </span>
            </label>
            <label className="option-row">
              <input
                type="radio"
                name="worker-wake"
                checked={wakeMode === 'events'}
                disabled={!workers.data.eventsEnabled}
                onChange={() => setWakeMode('events')}
              />
              <span>
                <strong>Wake it with events</strong>
                <span className="agent-card-meta">
                  {workers.data.eventsEnabled
                    ? 'For hosted agents. Needs this server at a public HTTPS address and a subscription the server verifies.'
                    : 'Events are off on this server.'}
                </span>
              </span>
            </label>
          </fieldset>
          {wakeMode === 'events' && originLocal && (
            <p className="agents-note agents-worker-hint" role="status" data-testid="worker-origin-hint">
              This server’s address isn’t a public HTTPS address, so hosted agents probably can’t reach it. Choose checking for work, or serve it over public HTTPS.
            </p>
          )}
          {wakeMode === 'poll' && (
            <div className="field">
              <label htmlFor="worker-interval">Check interval, in minutes</label>
              <input
                id="worker-interval"
                type="number"
                inputMode="numeric"
                min={1}
                max={1440}
                value={pollMinutes}
                onChange={(event) => {
                  setPollMinutes(event.target.value)
                  setError(null)
                }}
              />
              <p className="field-hint">Match the worker’s own schedule, so rule pages can say how fresh results are. The reference worker checks every minute.</p>
            </div>
          )}
          <fieldset className="option-group">
            <legend>Rules it can serve</legend>
            <label className="option-row">
              <input type="radio" name="worker-privacy" checked={privacy === 'standard'} onChange={() => setPrivacy('standard')} />
              <span><strong>Standard</strong></span>
            </label>
            <label className="option-row">
              <input type="radio" name="worker-privacy" checked={privacy === 'restricted'} onChange={() => setPrivacy('restricted')} />
              <span>
                <strong>Restricted and standard</strong>
                <span className="agent-card-meta">Only with a credential that no other worker or tool uses; otherwise it stays blocked.</span>
              </span>
            </label>
          </fieldset>
        </div>
      </details>

      {error && <p className="field-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : selfPairs ? 'Add' : 'Add and pair'}</button>
    </form>
  )
}

/**
 * The workers that do rule work (AU-26): each one's readiness as the server
 * reports it, the one-use pairing code shown once, and how it learns about
 * new work. Opt-ins for agents without a card here live on their agent card.
 */
export function AutomationWorkersSection({
  workers,
  agents,
  origin,
  onShowWorkerSteps,
}: {
  workers: AutomationWorkers
  agents: readonly AgentSummary[]
  origin: string
  /** Opens the connect guide on its worker tab. */
  onShowWorkerSteps: () => void
}) {
  const [adding, setAdding] = useState(false)
  const { data } = workers
  const profileName = (id: string) => data.profiles.find((profile) => profile.id === id)?.configuration.name ?? null
  const agentOf = (profileId: string) => agents.find((agent) => agent.id === data.profiles.find((profile) => profile.id === profileId)?.configuration.authorizedClientId)
  const agentIds = new Set(agents.map((agent) => agent.id))
  const orphans = data.profiles.filter((profile) => !agentIds.has(profile.configuration.authorizedClientId))
  const active = data.targets.filter((target) => target.wakeReadiness !== 'disabled')
  const revoked = data.targets.length - active.length
  const local = originHint(origin) === 'local'

  return (
    <section className="agents-section" aria-labelledby="agents-workers" data-testid="automation-workers">
      <div className="agents-section-head">
        <h2 id="agents-workers">Automation workers</h2>
        {active.length > 0 && <span className="count-pill">{active.length}</span>}
        {data.status === 'ready' && !adding && (
          <button type="button" className="btn btn-secondary btn-sm agents-section-action" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            Add worker
          </button>
        )}
      </div>
      <p className="agents-note">
        Agents that do the work your rules ask for, such as summaries or tags. An agent that allowed “Do rule work” when it
        signed in becomes a worker on its own; a script on an API key pairs once with a one-use code.
        Your bookmarks are still filed when no worker is running; their tasks wait.
      </p>

      {data.status === 'loading' && <LoadingState label="Loading workers…" />}
      {data.status === 'error' && (
        <EmptyState
          role="alert"
          icon="alert"
          className="empty-state--compact"
          title="Could not load workers"
          description={messageOf(data.error, 'Check your connection and try again.')}
          action={<button type="button" className="btn btn-secondary btn-sm" onClick={workers.reload}>Try again</button>}
        />
      )}

      {data.status === 'ready' && adding && (
        <div className="agents-worker-new">
          <div className="agents-worker-new-head">
            <h3>Add a worker</h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
          <NewWorker
            workers={workers}
            profiles={data.profiles}
            agents={agents}
            originLocal={local}
            onCreated={() => setAdding(false)}
            onShowSteps={onShowWorkerSteps}
          />
        </div>
      )}

      {/* A worker just added is on its way in with its pairing code: no empty state in between. */}
      {data.status === 'ready' && active.length === 0 && !adding && !workers.grant && (
        <EmptyState
          icon="bolt"
          className="empty-state--compact empty-state--slot"
          title={revoked > 0 ? 'No active workers' : 'No workers yet'}
          description="Only rules that summarize or tag need one."
        />
      )}

      {active.length > 0 && (
        <ul className="agents-list agents-worker-list">
          {active.map((target) => (
            <li key={target.id}>
              <WorkerCard
                target={target}
                profileName={profileName(target.configuration.connectionProfileId)}
                grant={workers.grant?.targetId === target.id ? workers.grant : null}
                origin={origin}
                workers={workers}
                selfPairing={pairsBySignIn(agentOf(target.configuration.connectionProfileId))}
              />
            </li>
          ))}
        </ul>
      )}
      {revoked > 0 && <p className="agents-note">{plural(revoked, 'revoked worker')} not shown.</p>}

      {orphans.length > 0 && (
        <div className="agents-worker-orphans">
          <h3>Other automation connections</h3>
          <p className="agents-note">Their agent isn’t connected any more. Turn automations off here, or reconnect the agent.</p>
          {orphans.map((profile) => (
            <AgentAutomationOptIns key={profile.id} profile={profile} workers={workers} showName />
          ))}
        </div>
      )}
    </section>
  )
}
