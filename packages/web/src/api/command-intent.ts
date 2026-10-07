/**
 * Per-user-intent Known-Command-Id allocation.
 *
 * - New user intent → crypto.randomUUID() (lowercase v4)
 * - Retry of the same intent → reuse stored id
 * - Persistence: sessionStorage (survives refresh; not for CSRF)
 */

const STORAGE_PREFIX = 'known.command-id.v1:'
const fallbackIds = new Map<string, { id: string; persisted: boolean }>()

const COMMAND_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function storageKey(intentKey: string): string {
  return `${STORAGE_PREFIX}${intentKey}`
}

function isCommandId(value: string): boolean {
  return COMMAND_ID_RE.test(value)
}

/** Canonical lowercase UUID v4 via crypto.randomUUID(). */
export function newCommandId(): string {
  return crypto.randomUUID().toLowerCase()
}

/**
 * Get or create a Known-Command-Id for a stable intent key.
 * Call with a new intentKey only when the user starts a distinct action.
 */
export function allocateCommandId(intentKey: string): string {
  if (!intentKey) {
    throw new Error('intentKey is required for command idempotency')
  }
  let readable = true
  try {
    const existing = sessionStorage.getItem(storageKey(intentKey))
    if (existing && isCommandId(existing)) {
      fallbackIds.set(intentKey, { id: existing, persisted: true })
      return existing
    }
    if (fallbackIds.get(intentKey)?.persisted) fallbackIds.delete(intentKey)
  } catch { readable = false }
  const fallback = fallbackIds.get(intentKey)
  if (fallback && (!readable || !fallback.persisted)) {
    if (readable) {
      try { sessionStorage.setItem(storageKey(intentKey), fallback.id); fallback.persisted = true } catch { /* keep the original command */ }
    }
    return fallback.id
  }
  const id = newCommandId()
  let persisted = false
  try { sessionStorage.setItem(storageKey(intentKey), id); persisted = true } catch { /* retain the page-local command */ }
  fallbackIds.set(intentKey, { id, persisted })
  return id
}

/**
 * Whether the intent has no stored command id, which — after a run that clears
 * each intent as it succeeds — means the intent already finished.
 *
 * Storage failures report `false` ("not finished") so an unavailable
 * sessionStorage degrades to retrying the work instead of silently skipping it.
 */
export function isCommandIdCleared(intentKey: string): boolean {
  if (!intentKey) throw new Error('intentKey is required for command idempotency')
  try {
    return sessionStorage.getItem(storageKey(intentKey)) === null && fallbackIds.get(intentKey)?.persisted !== false
  } catch {
    return false
  }
}

/** Drop a stored command id after the intent completed or the user starts over. */
export function clearCommandId(intentKey: string): void {
  fallbackIds.delete(intentKey)
  try {
    sessionStorage.removeItem(storageKey(intentKey))
  } catch {
    /* ignore */
  }
}

/** Replace the stored id (new user intent after command_id_reused / result expired). */
export function rotateCommandId(intentKey: string): string {
  clearCommandId(intentKey)
  return allocateCommandId(intentKey)
}

/**
 * Build a stable intent key for common mutations.
 * Keep intent keys stable across retries of the same user action;
 * include a client-generated action nonce for each discrete click/submit.
 */
export function mutationIntentKey(scope: string, actionNonce: string): string {
  return `${scope}:${actionNonce}`
}

export function isAllocatedCommandId(value: string): boolean {
  return isCommandId(value)
}
