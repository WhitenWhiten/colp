import { useCallback, useEffect, useRef, useState } from 'react'
import { automationApi, type AutomationApi } from '../../api/automationClient'
import type {
  AutomationCapabilities,
  AutomationConnectionProfile,
  AutomationConnectionProfileInput,
  AutomationPairingGrant,
  AutomationTarget,
  AutomationTargetInput,
} from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import type { StatusTone } from '../../components/StatusBadge'

/* AU-21/AU-26: the agents that do rule work. A connection profile is the
   Owner's opt-in for one agent (its own catalogs: manage rules, do rule
   work); a target is one worker paired to that connection. Readiness and
   its reason are the server's; a selected wake mode is a choice, not proof
   that anything is listening. The pairing code lives in memory only. */

export type WorkersData = {
  status: 'loading' | 'ready' | 'error'
  error: unknown
  profiles: AutomationConnectionProfile[]
  targets: AutomationTarget[]
  eventsEnabled: boolean
}

export type IssuedGrant = { targetId: string; grant: AutomationPairingGrant }

const MAX_PAGES = 5

async function all<T>(read: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await read(cursor)
    items.push(...result.items)
    cursor = result.nextCursor
    if (!cursor) break
  }
  return items
}

export function useAutomationWorkers(enabled: boolean, api: AutomationApi = automationApi) {
  const [data, setData] = useState<WorkersData>({ status: 'loading', error: null, profiles: [], targets: [], eventsEnabled: false })
  const [version, setVersion] = useState(0)
  const [grant, setGrant] = useState<IssuedGrant | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    void Promise.all([
      all((cursor) => api.listConnectionProfiles(cursor, controller.signal)),
      all((cursor) => api.listTargets(cursor, controller.signal)),
      api.getCapabilities(controller.signal).catch((): Pick<AutomationCapabilities, 'eventsEnabled'> => ({ eventsEnabled: false })),
    ]).then(([profiles, targets, capabilities]) => {
      if (!controller.signal.aborted) setData({ status: 'ready', error: null, profiles, targets, eventsEnabled: capabilities.eventsEnabled })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setData((current) => ({ ...current, status: 'error', error }))
    })
    return () => controller.abort()
  }, [api, enabled, version])

  // The code is useless after it expires; drop it then instead of leaving it on screen.
  useEffect(() => {
    if (!grant) return
    const left = Date.parse(grant.grant.expiresAt) - Date.now()
    const timer = setTimeout(() => { if (mounted.current) setGrant(null) }, Math.max(0, Math.min(left, 2_147_000_000)))
    return () => clearTimeout(timer)
  }, [grant])

  const reload = useCallback(() => setVersion((value) => value + 1), [])

  return {
    data,
    grant,
    clearGrant: () => setGrant(null),
    reload,
    async saveProfile(profile: AutomationConnectionProfile, configuration: AutomationConnectionProfileInput) {
      await api.replaceConnectionProfile(profile.id, configuration, profile.revision)
      reload()
    },
    async createTarget(input: AutomationTargetInput) {
      const created = await api.createTarget(input)
      reload()
      return created
    },
    async saveTarget(target: AutomationTarget, configuration: AutomationTargetInput) {
      await api.replaceTarget(target.id, configuration, target.revision)
      reload()
    },
    async pair(target: AutomationTarget) {
      const issued = await api.issuePairing(target.id, target.revision)
      if (mounted.current) setGrant({ targetId: target.id, grant: issued })
      reload()
    },
    async revoke(target: AutomationTarget) {
      await api.revokeTarget(target.id, target.revision)
      if (mounted.current) setGrant((current) => (current?.targetId === target.id ? null : current))
      reload()
    },
  }
}

export type AutomationWorkers = ReturnType<typeof useAutomationWorkers>

export const READINESS: Record<AutomationTarget['wakeReadiness'], { label: string; tone: StatusTone }> = {
  waitingForPairing: { label: 'Not paired', tone: 'neutral' },
  waitingForSubscription: { label: 'Waiting for events', tone: 'warning' },
  active: { label: 'Ready', tone: 'success' },
  blocked: { label: 'Blocked', tone: 'danger' },
  disabled: { label: 'Revoked', tone: 'muted' },
}

/* The server's readiness reasons, in the owner's words; unknown ones verbatim. */
const REASONS: Record<string, string> = {
  'Target authorization was revoked.': 'You revoked this worker.',
  'Owner revoked this target.': 'You revoked this worker.',
  'Redeem a short-lived Owner pairing grant.': 'Pair it with a one-use code to start.',
  'Owner pairing has not completed.': 'Pair it with a one-use code to start.',
  'Automation worker catalog is disabled on the connection profile.': 'Its agent isn’t allowed to do rule work. Turn on “Do rule work” for it, then pair again.',
  'Current credential authority is unavailable; reconnect or re-pair.': 'Its credential is no longer valid. Reconnect the agent, then pair again.',
  'Restricted work requires a verified dedicated credential binding.': 'Restricted rules need a worker with its own credential that no other worker uses.',
  'The paired worker may poll the durable queue; the server does not schedule the worker.': 'Paired. It picks up work whenever it checks; COLP doesn’t start it.',
  'A paired worker may poll the durable queue.': 'Paired. It picks up work whenever it checks; COLP doesn’t start it.',
  'Polling interval is informational; the server does not schedule the worker.': 'Paired. It picks up work whenever it checks; COLP doesn’t start it.',
  'A verified current subscription is required; reconcile the durable queue on reconnect.': 'Paired, but no event subscription is active yet. It still catches up on waiting work when it connects.',
  'Events delivery is disabled on this server.': 'Events are off on this server, so nothing can wake it. Switch it to checking for work.',
  'Verified subscription available; receipt and job execution are separate.': 'Woken by events. A wake-up only says there is work; it isn’t finished work.',
}

export function readinessReason(reason: string): string {
  return REASONS[reason] ?? reason
}

/** A refused pairing usually means the agent's connection does not allow rule work. */
export function pairingRefusal(error: unknown): string {
  if (error instanceof ProductApiError && (error.status === 404 || error.code === 'resource_not_found')) {
    return 'This worker can’t be paired: turn on “Use for automations” and “Do rule work” for its agent first.'
  }
  return error instanceof ProductApiError && error.message ? error.message : 'Could not make a pairing code.'
}

export type OriginHint = 'public' | 'local'

const LOCAL_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.lan|.*\.internal|.*\.home\.arpa|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/iu

/**
 * Setup hint only (design 05): whether this server's own address looks
 * reachable from the internet. The server alone decides readiness.
 */
export function originHint(origin: string): OriginHint {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && !LOCAL_HOST.test(url.hostname) ? 'public' : 'local'
  } catch {
    return 'local'
  }
}

export function hasCatalog(profile: AutomationConnectionProfile, catalog: AutomationConnectionProfileInput['catalogs'][number]): boolean {
  return profile.configuration.catalogs.includes(catalog)
}

/** Opting in or out keeps the other catalogs exactly as they were. */
export function withCatalog(
  configuration: AutomationConnectionProfileInput,
  catalog: AutomationConnectionProfileInput['catalogs'][number],
  on: boolean,
): AutomationConnectionProfileInput {
  const rest = configuration.catalogs.filter((item) => item !== catalog)
  return { ...configuration, catalogs: on ? [...rest, catalog] : rest }
}
