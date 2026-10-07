/** Self-hosted web edition (`VITE_EDITION=self-hosted`). Unset keeps the copied Know-N UI. */
export function isSelfHostedEdition(): boolean {
  return import.meta.env.VITE_EDITION === 'self-hosted'
}

/**
 * First path segments the self-hosted edition does not mount.
 * Activity lives on Today and public profiles; comments and votes are the
 * community surfaces. Follow is `/library/following` plus the follow flags.
 */
const REMOVED_EXACT_OR_CHILD = [
  '/today',
  '/updates',
  '/explore',
  '/feed',
  '/reports',
  '/path',
  '/share',
  '/u',
  '/profile',
  '/community',
  '/classify',
  '/notifications',
  '/credits',
  '/moderation',
  '/admin',
  '/ai',
  '/developers',
  '/demo',
  '/demos',
  '/dashboard',
  '/creator',
] as const

const REMOVED_LIBRARY = ['/library/digests', '/library/following'] as const

function pathOnly(to: string): string {
  const path = to.split('?')[0] ?? to
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1)
  return path
}

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** False when the self-hosted edition must not link to or mount `to`. */
export function isSelfHostedPathEnabled(to: string): boolean {
  if (!isSelfHostedEdition()) return true
  const path = pathOnly(to)
  if (REMOVED_LIBRARY.some((prefix) => matchesPrefix(path, prefix))) return false
  return !REMOVED_EXACT_OR_CHILD.some((prefix) => matchesPrefix(path, prefix))
}

export type RegistrationReason = 'first-run' | 'invite' | 'closed'

export type RegistrationState = {
  readonly open: boolean
  readonly reason: RegistrationReason
}

export type RegistrationView = 'owner' | 'invite' | 'closed'

/**
 * Sign-up is shown only when `open` is true.
 * `first-run` is the owner form; `invite` is the invite form; anything else is closed.
 */
export function registrationView(state: RegistrationState): RegistrationView {
  if (state.open !== true) return 'closed'
  if (state.reason === 'first-run') return 'owner'
  if (state.reason === 'invite') return 'invite'
  return 'closed'
}

const REGISTRATION_REASONS = new Set<RegistrationReason>(['first-run', 'invite', 'closed'])

export function parseRegistrationState(body: unknown): RegistrationState {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Registration state was not understood.')
  }
  const record = body as { open?: unknown; reason?: unknown }
  if (typeof record.open !== 'boolean' || typeof record.reason !== 'string' || !REGISTRATION_REASONS.has(record.reason as RegistrationReason)) {
    throw new Error('Registration state was not understood.')
  }
  return { open: record.open, reason: record.reason as RegistrationReason }
}

/** Cloud capabilities forced off in the self-hosted edition. Kept flags stay as configured. */
export const SELF_HOSTED_CLOUD_FLAGS = [
  'profilePublic',
  'follow',
  'collectionFollow',
  'explore',
  'feed',
  'notifications',
  'classify',
  'classification',
  'classificationBatch',
  'aiOrganize',
  'share',
  'reports',
  'community',
  'contentGovernance',
  'email',
  'creator',
  'readingProgress',
  'savedResources',
  'linkPreview',
  'exportJobs',
  'readableReplica',
] as const

export function featureFlagsForEdition<T extends Record<string, boolean>>(
  flags: T,
  edition: string | undefined,
): T {
  if (edition !== 'self-hosted') return flags
  const next: Record<string, boolean> = { ...flags }
  for (const flag of SELF_HOSTED_CLOUD_FLAGS) {
    if (flag in next) next[flag] = false
  }
  return next as T
}
