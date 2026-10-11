/** The name the visible UI uses for this service (D15). Wire names stay Know-N's. */
export function productName(): string {
  return 'COLP Server'
}

/** Tab title: `{title} — {productName}`, or the name alone. */
export function brandedTitle(title: string): string {
  return title ? `${title} — ${productName()}` : productName()
}

/**
 * D8 turns this on. Until then the public collection page does not offer
 * "Subscribe in browser".
 */
export const subscribeInBrowserEnabled = false

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
