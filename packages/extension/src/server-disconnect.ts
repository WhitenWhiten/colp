import { managedServerOrigin } from './managed-policy.js';
import { releaseServerOriginPermission } from './server-origin-permission.js';
import { httpOriginConfirmation } from './http-origin.js';

export interface ServerDisconnectRequest {
  readonly kind: 'known.server.disconnect';
  readonly userGesture: true;
  readonly nextOrigin?: string;
}

export function validServerDisconnectRequest(value: unknown): value is ServerDisconnectRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind !== 'known.server.disconnect' || request.userGesture !== true) return false;
  if (Object.keys(request).length === 2) return request.nextOrigin === undefined;
  if (Object.keys(request).length !== 3 || typeof request.nextOrigin !== 'string' || request.nextOrigin.length > 2_048) return false;
  try {
    const url = new URL(request.nextOrigin);
    return request.nextOrigin === url.origin && ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && httpOriginConfirmation(url.origin) !== 'refused';
  } catch { return false; }
}

export interface ServerDisconnectPorts {
  stopSyncEngine(): Promise<void>;
  signOut(): Promise<void>;
  clearSession(): Promise<void>;
  readRuntimeOrigin(): Promise<string | undefined>;
  clearRuntimeOrigin(): Promise<void>;
  readManagedPolicy(): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * Forget a self-hosted server: stop sync, sign out, drop the session, the
 * runtime origin, and that origin's optional host permission.
 * Bookmarks are not a port and are never deleted.
 * A managed `serverOrigin` stays; that case only signs out.
 */
export async function disconnectServer(ports: ServerDisconnectPorts, nextOrigin?: string): Promise<void> {
  if (managedServerOrigin(await ports.readManagedPolicy())) {
    await ports.signOut();
    return;
  }
  const origin = await ports.readRuntimeOrigin();
  await ports.stopSyncEngine();
  await ports.signOut();
  await ports.clearSession();
  await ports.clearRuntimeOrigin();
  if (origin && optionalHostOrigin(origin) && !sharesHostPermission(origin, nextOrigin)) await releaseServerOriginPermission(origin);
}

/** Changing a port must retain the host permission just granted for the replacement server. */
function sharesHostPermission(origin: string, nextOrigin?: string): boolean {
  if (!nextOrigin) return false;
  const previous = new URL(origin), next = new URL(nextOrigin);
  return previous.protocol === next.protocol && previous.hostname === next.hostname;
}

function optionalHostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.origin === origin && (url.protocol === 'https:' || url.protocol === 'http:');
  } catch {
    return false;
  }
}
