import { useState } from 'react'
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
  hasCatalog,
  originHint,
  pairingRefusal,
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
    if (unpairs && affected > 0) {
      const accepted = await confirm({
        title: `Unpair ${plural(affected, 'worker')}?`,
        body: `Changing this unpairs the ${plural(affected, 'worker')} using “${configuration.name}”. Their waiting work stays queued; pair them again to continue.`,
        confirmLabel: 'Change and unpair',
      })
      if (!accepted) return
    }
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

function PairingGrant({ issued, origin, onDone, onAgain, busy }: {
  issued: IssuedGrant
  origin: string
  onDone: () => void
  onAgain: () => void
  busy: boolean
}) {
  const { grant } = issued
  if (grant.code === null) {
    return (
      <div className="agents-secret agents-worker-grant" role="status" data-testid="worker-grant">
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
  ].join('\n')
  return (
    <div className="agents-secret agents-worker-grant" role="status" data-testid="worker-grant">
      <p className="agents-secret-head">
        <Icon name="alert" />
        <span>
          <strong>Copy this now.</strong> The code works once and expires at{' '}
          <time dateTime={grant.expiresAt}>{formatDateTime(grant.expiresAt)}</time>. It is not shown again or saved anywhere.
        </span>
      </p>
      <CommandBlock label="Pairing settings for the worker" command={env} />
      <p className="agents-note">
        Give these to the worker as environment variables, with its own access token. Keep them out of shell history and logs.
      </p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>Done, hide it</button>
    </div>
  )
}

function wakeLine(target: AutomationTarget): string {
  if (target.wakeMode === 'poll') {
    const every = target.pollIntervalMinutes ? ` every ${plural(target.pollIntervalMinutes, 'minute')}` : ''
    return `Checks for work${every}. That timing is the worker’s own; COLP doesn’t start it.`
  }
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
}: {
  target: AutomationTarget
  profileName: string | null
  grant: IssuedGrant | null
  origin: string
  workers: AutomationWorkers
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
    <article className="agent-card" data-target-id={target.id} data-readiness={target.wakeReadiness} aria-labelledby={`worker-${target.id}`}>
      <header className="agent-card-head">
        <span className="agent-card-icon" aria-hidden><Icon name="bolt" /></span>
        <div className="agent-card-title">
          <h3 id={`worker-${target.id}`}>{configuration.name}</h3>
          <p className="agent-card-meta">
            {configuration.providerLabel}
            {profileName ? <> · through {profileName}</> : null}
          </p>
        </div>
        <StatusBadge tone={readiness.tone} className="agents-worker-badge" data-testid="worker-readiness">{readiness.label}</StatusBadge>
      </header>

      <p className="agents-worker-reason" data-testid="worker-reason">{readinessReason(target.wakeReason)}</p>
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
          busy={busy}
          onDone={workers.clearGrant}
          onAgain={() => void pair(false)}
        />
      )}

      {!revoked && (
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
          <button type="button" className="btn btn-danger-ghost btn-sm" disabled={busy} onClick={() => void revoke()}>
            Revoke
          </button>
        </div>
      )}
    </article>
  )
}

function NewWorker({ workers, profiles, originLocal, onCreated }: {
  workers: AutomationWorkers
  profiles: readonly AutomationConnectionProfile[]
  originLocal: boolean
  onCreated: () => void
}) {
  const { success, error: toastError } = useToast()
  const usable = profiles.filter((profile) => profile.configuration.automationEnabled && hasCatalog(profile, 'automationWorker'))
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('')
  const [profileId, setProfileId] = useState(usable[0]?.id ?? '')
  const [privacy, setPrivacy] = useState<AutomationTargetInput['privacy']>('standard')
  const [wakeMode, setWakeMode] = useState<NonNullable<AutomationTargetInput['wakeMode']>>('poll')
  const [pollMinutes, setPollMinutes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (usable.length === 0) {
    return (
      <p className="agents-note" data-testid="worker-no-connection">
        To add a worker, first turn on <strong>Use for automations</strong> and <strong>Do rule work</strong> for its agent above.
        The steps are under Connect an agent › Automation worker.
      </p>
    )
  }

  async function submit() {
    const minutes = pollMinutes.trim() ? Number(pollMinutes) : undefined
    if (!name.trim() || !provider.trim()) {
      setError('Name the worker and say where it runs.')
      return
    }
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
      setError('Check interval is a whole number of minutes, from 1 to 1440.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      await workers.createTarget({
        name: name.trim(),
        providerLabel: provider.trim(),
        broadcastOptIn: false,
        privacy,
        connectionProfileId: profileId,
        wakeMode,
        ...(wakeMode === 'poll' && minutes !== undefined ? { pollIntervalMinutes: minutes } : {}),
      })
      success(`Added “${name.trim()}”. Pair it to start.`)
      onCreated()
    } catch (failure) {
      toastError(messageOf(failure, 'Could not add this worker.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="agents-form agents-worker-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="field">
        <label htmlFor="worker-name">Name</label>
        <input id="worker-name" value={name} maxLength={200} autoComplete="off" placeholder="Paper summaries" onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="worker-provider">Where it runs</label>
        <input id="worker-provider" value={provider} maxLength={100} autoComplete="off" placeholder="Script on my laptop" onChange={(event) => setProvider(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="worker-profile">Agent</label>
        <select id="worker-profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
          {usable.map((profile) => <option key={profile.id} value={profile.id}>{profile.configuration.name}</option>)}
        </select>
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
          <label htmlFor="worker-interval">Check interval, in minutes (optional)</label>
          <input id="worker-interval" type="number" inputMode="numeric" min={1} max={1440} value={pollMinutes} onChange={(event) => setPollMinutes(event.target.value)} />
          <p className="field-hint">Set it to match the worker, so rule pages can say how fresh results are.</p>
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
      {error && <p className="field-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add worker'}</button>
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
}: {
  workers: AutomationWorkers
  agents: readonly AgentSummary[]
  origin: string
}) {
  const [adding, setAdding] = useState(false)
  const { data } = workers
  const profileName = (id: string) => data.profiles.find((profile) => profile.id === id)?.configuration.name ?? null
  const agentIds = new Set(agents.map((agent) => agent.id))
  const orphans = data.profiles.filter((profile) => !agentIds.has(profile.configuration.authorizedClientId))
  const active = data.targets.filter((target) => target.wakeReadiness !== 'disabled')
  const revoked = data.targets.length - active.length
  const local = originHint(origin) === 'local'

  return (
    <section className="agents-section" aria-labelledby="agents-workers" data-testid="automation-workers">
      <div className="agents-section-head">
        <h2 id="agents-workers">Automation workers</h2>
        {active.length > 0 && <span className="agents-count">{active.length}</span>}
        {data.status === 'ready' && !adding && (
          <button type="button" className="btn btn-secondary btn-sm agents-section-action" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            Add worker
          </button>
        )}
      </div>
      <p className="agents-note">
        Agents that do the work your rules ask for, such as summaries or tags. Each worker pairs once with a one-use code.
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
          <NewWorker workers={workers} profiles={data.profiles} originLocal={local} onCreated={() => setAdding(false)} />
        </div>
      )}

      {data.status === 'ready' && active.length === 0 && !adding && (
        <EmptyState
          icon="bolt"
          className="empty-state--compact agents-empty"
          title={revoked > 0 ? 'No active workers' : 'No workers yet'}
          description="Rules that only file bookmarks need no worker. Add one when a rule asks an agent to summarize or tag."
        />
      )}

      {active.length > 0 && (
        <ul className="agents-list">
          {active.map((target) => (
            <li key={target.id}>
              <WorkerCard
                target={target}
                profileName={profileName(target.configuration.connectionProfileId)}
                grant={workers.grant?.targetId === target.id ? workers.grant : null}
                origin={origin}
                workers={workers}
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
