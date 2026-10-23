import type { Environment, PublicAuthState, UiStatus } from './types.js';

export const AUTH_SNAPSHOT = 'known.auth.snapshot.v1';

const STATUSES: readonly UiStatus[] = ['signed_out', 'connecting', 'connected', 'refreshing', 'offline',
  'policy_blocked', 'error'];
const ENVIRONMENTS: readonly Environment[] = ['development', 'staging', 'production'];

/**
 * Public view of the last known auth relationship (never tokens). The popup
 * paints from this snapshot before the service worker answers, so a cold
 * worker or a dead network cannot delay or blank the first frame.
 */
export function parseAuthSnapshot(value: unknown): PublicAuthState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!STATUSES.includes(record.status as UiStatus)) return undefined;
  if (!ENVIRONMENTS.includes(record.environment as Environment)) return undefined;
  if (typeof record.serverOrigin !== 'string') return undefined;
  if (record.accountLabel !== undefined && typeof record.accountLabel !== 'string') return undefined;
  if (record.avatarUrl !== undefined && typeof record.avatarUrl !== 'string') return undefined;
  if (record.sessionExpiresAt !== undefined && typeof record.sessionExpiresAt !== 'string') return undefined;
  if (record.errorCode !== undefined && typeof record.errorCode !== 'string') return undefined;
  return {
    status: record.status as UiStatus,
    environment: record.environment as Environment,
    serverOrigin: record.serverOrigin,
    ...(typeof record.accountLabel === 'string' ? { accountLabel: record.accountLabel } : {}),
    ...(typeof record.avatarUrl === 'string' ? { avatarUrl: record.avatarUrl } : {}),
    ...(typeof record.sessionExpiresAt === 'string' ? { sessionExpiresAt: record.sessionExpiresAt } : {}),
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
  };
}

export async function writeAuthSnapshot(state: PublicAuthState): Promise<void> {
  await chrome.storage.local.set({ [AUTH_SNAPSHOT]: {
    status: state.status, environment: state.environment, serverOrigin: state.serverOrigin,
    ...(state.accountLabel ? { accountLabel: state.accountLabel } : {}),
    ...(state.avatarUrl ? { avatarUrl: state.avatarUrl } : {}),
    ...(state.sessionExpiresAt ? { sessionExpiresAt: state.sessionExpiresAt } : {}),
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    updatedAt: Date.now(),
  } });
}
