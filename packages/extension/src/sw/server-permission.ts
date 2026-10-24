import { serverOriginPermissionPattern } from '../server-origin-permission.js';
import { scheduleSyncEngineWake } from './engine.js';
import { loadConfig } from './scope.js';

/**
 * W2B-P2-1: access to the server's address is a browser permission the person can remove (or set to "on click") at any
 * time. Every credentialed request then fails before it leaves with `server_configuration_failed`, which the failure
 * table treats as a wait. Nothing told Sync when access came back, so it sat out its backoff (up to 15 minutes).
 * Granting exactly the configured server's pattern wakes the engine at once. Called from the worker's one
 * `permissions.onAdded` listener; removal needs no event, the next request names the fault.
 */
export async function wakeSyncForServerPermission(change: { readonly origins?: readonly string[] }): Promise<void> {
  if (!change.origins?.length) return;
  try {
    const { serverOrigin } = await loadConfig();
    if (change.origins.includes(serverOriginPermissionPattern(serverOrigin))) scheduleSyncEngineWake('manual');
  } catch { /* no usable configuration: there is no server to look at */ }
}
