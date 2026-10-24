import type { BuildConfig } from './types.js';
import { readBoundedJson } from './json-response.js';
import { statusFailure } from './sync-transport-failure.js';
import { SERVER_VERSION_MISMATCH } from './sync-failure-class.js';

const REQUIRED = ['syncSessions', 'syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] as const;
const RETIRE_NAMESPACE = 'https://known.example/extensions/sync-retire';
/** COLP Server edition metadata (server-edition.ts, cloud-capability.ts). Not a sync boundary. */
const SERVER_NAMESPACE = 'https://know-n.com/colp/extensions/server';
const MANIFEST_RESPONSE_MAX_BYTES = 512 * 1_024;
const REQUEST_TIMEOUT_MS = 15_000;
export type SyncEndpoints = Readonly<Record<(typeof REQUIRED)[number], string> & {
  readonly maxBatchOperations?: number; readonly syncEffectPages: string; readonly effectPageAuthority: string; readonly syncRetire: string }>;

export async function fetchSyncEndpoints(config: BuildConfig, fetcher: typeof fetch = fetch): Promise<SyncEndpoints> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetcher(config.manifestUrl, { redirect: 'error', cache: 'no-store', signal: controller.signal,
    headers: { Accept: 'application/vnd.collection-protocol.manifest+json;version=0.2',
      'Collection-Protocol-Version': '0.2' } }).finally(() => clearTimeout(timeout));
  // Rule A: a gateway hiccup (5xx, 408) is `server_unavailable`, not a verdict on the server; the manifest is public,
  // so a definitive 4xx just means this origin offers no manifest there.
  if (!response.ok) throw statusFailure(response, { authority: 'manifest_unavailable', other: 'manifest_unavailable' }, Date.now());
  return discoverSyncEndpoints(await readBoundedJson(response, MANIFEST_RESPONSE_MAX_BYTES, 'manifest_invalid'), config);
}

export function discoverSyncEndpoints(input: unknown, config: BuildConfig): SyncEndpoints {
  // W2C-12: a manifest that names other protocol versions only is a server this build cannot talk to yet (or any more).
  if (record(input) && Array.isArray(input.protocolVersions) && input.protocolVersions.length > 0
      && input.protocolVersions.every((version) => typeof version === 'string')
      && !input.protocolVersions.includes('0.2')) throw new Error(SERVER_VERSION_MISMATCH);
  if (!record(input) || input.protocol !== 'https://know-n.com/colp/spec/0.2'
      || !Array.isArray(input.protocolVersions) || !input.protocolVersions.includes('0.2')
      || !Array.isArray(input.mounts) || input.mounts.length === 0) throw new Error('manifest_invalid');
  const topLevelKeys = new Set(['protocol', 'protocolVersions', 'serverId', 'serverUuid', 'title', 'mounts', 'syncEffectPages']);
  // W2C-12: a field this build does not know is a newer server, named as such; the validation stays strict.
  if (Object.keys(input).some((key) => !topLevelKeys.has(key))) throw new Error(SERVER_VERSION_MISMATCH);
  if (typeof input.serverId !== 'string'
      || new URL(input.serverId).origin !== config.serverOrigin || typeof input.serverUuid !== 'string'
      || typeof input.title !== 'string') throw new Error('manifest_schema_invalid');
  const candidates = input.mounts.filter(hasRequiredEndpoints);
  if (candidates.length !== 1) throw new Error('manifest_mount_ambiguous');
  const mount = candidates[0];
  if (!record(mount) || typeof mount.id !== 'string' || !Array.isArray(mount.profiles)
      || mount.profiles.includes('sync') || !record(mount.endpoints)
      || typeof mount.baseUrl !== 'string' || !record(mount.auth) || mount.auth.oauth !== true
      || !record(mount.limits) || !record(mount.features)) throw new Error('manifest_boundary_invalid');
  const baseUrl = new URL(mount.baseUrl);
  if (baseUrl.origin !== config.serverOrigin || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('manifest_base_url_invalid');
  }
  const allowedMountKeys = new Set(['id', 'baseUrl', 'profiles', 'endpoints', 'features', 'auth', 'limits', RETIRE_NAMESPACE,
    SERVER_NAMESPACE]);
  if (Object.keys(mount).some((key) => !allowedMountKeys.has(key))) throw new Error(SERVER_VERSION_MISMATCH);
  const result = {} as Record<string, string>;
  for (const key of REQUIRED) {
    const raw = mount.endpoints[key];
    if (typeof raw !== 'string') throw new Error(`manifest_endpoint_missing:${key}`);
    const url = new URL(raw);
    const templateVariables = [...raw.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    const templatedConflict = key === 'syncConflict' && templateVariables.length === 1
      && templateVariables[0] === 'conflictId';
    if (url.origin !== config.serverOrigin || url.username || url.password || url.hash || url.search
        || (key === 'syncConflict' && !templatedConflict) || (key !== 'syncConflict' && templateVariables.length > 0)) {
      throw new Error(`manifest_endpoint_invalid:${key}`);
    }
    result[key] = key === 'syncConflict' ? raw : url.toString();
  }
  if (typeof input.syncEffectPages !== 'string') throw new Error('manifest_endpoint_missing:syncEffectPages');
  const effectVariables = [...input.syncEffectPages.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  const effectProbe = new URL(input.syncEffectPages.replace('{effectId}', 'effect-probe').replace('{pageNumber}', '1'));
  if (effectProbe.origin !== config.serverOrigin || effectProbe.username || effectProbe.password || effectProbe.search
      || effectProbe.hash || effectVariables.join(',') !== 'effectId,pageNumber') {
    throw new Error('manifest_endpoint_invalid:syncEffectPages');
  }
  result.syncEffectPages = input.syncEffectPages;
  result.effectPageAuthority = effectProbe.origin;
  const retire = mount[RETIRE_NAMESPACE];
  const requiredHeaders = record(retire) ? retire.requiredHeaders : undefined;
  const expectedRetireHeaders = ['Authorization', 'Origin', 'Known-Sync-Session', 'Idempotency-Key'];
  if (!record(retire) || retire.method !== 'DELETE' || retire.requestBody !== false || retire.successStatus !== 204
      || !Array.isArray(requiredHeaders) || requiredHeaders.length !== expectedRetireHeaders.length
      || new Set(requiredHeaders).size !== expectedRetireHeaders.length
      || !expectedRetireHeaders.every((header) => requiredHeaders.includes(header))
      || typeof retire.href !== 'string') throw new Error('manifest_retire_contract_invalid');
  const retireUrl = new URL(retire.href);
  if (retireUrl.origin !== config.serverOrigin || retireUrl.username || retireUrl.password || retireUrl.search || retireUrl.hash
      || retire.href.includes('{') || retire.href.includes('}')) {
    throw new Error('manifest_endpoint_invalid:syncRetire');
  }
  result.syncRetire = retireUrl.toString();
  const maximum = mount.limits.maxSyncBatchOperations ?? 1;
  if (!Number.isSafeInteger(maximum) || Number(maximum) < 1 || Number(maximum) > 10_000) {
    throw new Error('manifest_batch_limit_invalid');
  }
  return Object.freeze({ ...result, maxBatchOperations: Math.min(50, Number(maximum)) }) as SyncEndpoints;
}
function hasRequiredEndpoints(candidate: unknown): candidate is Record<string, unknown> {
  if (!record(candidate) || !record(candidate.endpoints) || !record(candidate[RETIRE_NAMESPACE])) return false;
  const endpoints = candidate.endpoints;
  return REQUIRED.every((key) => typeof endpoints[key] === 'string');
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
