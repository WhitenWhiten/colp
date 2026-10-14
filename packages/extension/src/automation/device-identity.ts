import { readBoundedJson } from '../json-response.js';

/**
 * The server's device id for this browser's Sync replica.
 *
 * Bundle acknowledgements and intake receipts name the device the server
 * created for this replica, but neither the Sync session nor the bundle carries
 * it. The account's own Sync status (Product session) lists replicas with
 * their device, so the replica id this browser already holds finds it. When
 * that read is unavailable the caller waits; it never invents an id.
 */
const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;

export async function readReplicaDeviceId(serverOrigin: string, replicaId: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  let response: Response;
  try {
    response = await fetcher(`${serverOrigin.replace(/\/$/u, '')}/api/v1/sync/status`, { credentials: 'include', redirect: 'error',
      cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch { return null; }
  if (!response.ok) return null;
  let body: unknown;
  try { body = await readBoundedJson(response, 512 * 1024, 'sync_status_invalid'); } catch { return null; }
  const replicas = body && typeof body === 'object' ? (body as { replicas?: unknown }).replicas : undefined;
  if (!Array.isArray(replicas)) return null;
  const replica = replicas.find((item): item is { id: string; deviceId: string } => !!item && typeof item === 'object'
    && (item as { id?: unknown }).id === replicaId && typeof (item as { deviceId?: unknown }).deviceId === 'string');
  return replica && OPAQUE.test(replica.deviceId) ? replica.deviceId : null;
}
