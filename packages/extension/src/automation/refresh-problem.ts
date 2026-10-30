import type { RefreshProblem } from './bundle-store.js';

export function automationRefreshProblem(error: unknown): Exclude<RefreshProblem, 'rejected'> {
  const code = error instanceof Error ? error.message : '';
  if (code === 'personal_sync_stopped') return 'syncPaused';
  if (['authentication_required', 'credential_revoked', 'session_expired', 'not_connected'].includes(code)) return 'signedOut';
  if (code === 'rate_limited') return 'rateLimited';
  if (code === 'server_configuration_failed' || code === 'permission_required') return 'permission';
  if (code === 'offline' || code === 'network_unavailable' || error instanceof TypeError
    || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return 'offline';
  return navigator.onLine === false ? 'offline' : 'server';
}
