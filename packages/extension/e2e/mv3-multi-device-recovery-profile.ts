import type { Page } from '@playwright/test';
import { cp, rm } from 'node:fs/promises';

export async function probeRetiredReplicaSession(page: Page) {
  return page.evaluate(async () => {
    const keys = ['known.auth.credential.v1', 'known.auth.binding.v1', 'known.sync.collection.v1'];
    const stored = {
      ...(await chrome.storage.local.get(keys)),
      ...(await chrome.storage.session.get(keys)),
    } as Record<string, unknown>;
    const credential = stored[keys[0]!] as { accessToken?: unknown } | undefined;
    const binding = stored[keys[1]!] as { replicaId?: unknown; browserProfileId?: unknown; generation?: unknown } | undefined;
    const collectionId = stored[keys[2]!] as unknown;
    if (typeof credential?.accessToken !== 'string' || typeof binding?.replicaId !== 'string'
        || typeof binding.browserProfileId !== 'string' || typeof binding.generation !== 'string'
        || typeof collectionId !== 'string') throw new Error('retired_probe_authority_missing');
    const configResponse = await fetch(chrome.runtime.getURL('generated-config.json'), { cache: 'no-store' });
    const config = await configResponse.json() as { manifestUrl?: unknown };
    if (typeof config.manifestUrl !== 'string') throw new Error('retired_probe_config_invalid');
    const manifestResponse = await fetch(config.manifestUrl, { redirect: 'error', cache: 'no-store', headers: {
      Accept: 'application/vnd.collection-protocol.manifest+json;version=0.2', 'Collection-Protocol-Version': '0.2' } });
    const manifest = await manifestResponse.json() as { mounts?: Array<{ endpoints?: { syncSessions?: unknown } }> };
    const candidates = (manifest.mounts ?? []).map((mount) => mount.endpoints?.syncSessions)
      .filter((endpoint): endpoint is string => typeof endpoint === 'string');
    if (manifestResponse.status !== 200 || candidates.length !== 1) throw new Error('retired_probe_manifest_invalid');
    const request = { protocolVersion: '0.2', replica: { replicaId: binding.replicaId, name: 'Chromium',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: false, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 }, binding: { browserProfileId: binding.browserProfileId,
        mountMode: 'whole-profile', mountNativeId: null, generation: binding.generation }, extensions: {} },
      scope: 'collection', collection: { collectionId, lastCursor: null, lastRevision: null,
        bootstrapMode: 'download' }, clientTime: new Date().toISOString() };
    const response = await fetch(candidates[0]!, { method: 'POST', redirect: 'error', cache: 'no-store', headers: {
      Accept: 'application/problem+json', Authorization: `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json', 'Collection-Protocol-Version': '0.2',
      'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(request) });
    const problem = await response.json().catch(() => null) as { code?: unknown } | null;
    return { status: response.status, code: typeof problem?.code === 'string' ? problem.code : 'invalid_problem',
      contentType: response.headers.get('content-type') ?? '' };
  });
}
export async function copyProfileSnapshot(source: string, destination: string) {
  const deadline = Date.now() + 30_000;
  let complete = false;
  try {
    let lastError: unknown;
    while (Date.now() < deadline) {
      await rm(destination, { recursive: true, force: true });
      try { await cp(source, destination, { recursive: true, force: false }); complete = true; return; }
      catch (error) {
        lastError = error;
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    throw new Error(`profile_snapshot_locked:${String((lastError as { code?: unknown } | undefined)?.code ?? 'unknown')}`);
  } finally {
    if (!complete) await rm(destination, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function remoteCollectionIdentity(page: Page) {
  return page.evaluate(async () => {
    const secrets = await chrome.storage.session.get([
      'known.auth.credential.v1', 'known.auth.session.v1']);
    const durable = await chrome.storage.local.get(['known.sync.collection.v1']);
    const credential = secrets['known.auth.credential.v1'] as { subject?: unknown } | undefined;
    const session = secrets['known.auth.session.v1'] as { collection?: { collectionId?: unknown } } | undefined;
    const selectedCollection = durable['known.sync.collection.v1'];
    const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (typeof credential?.subject !== 'string' || typeof session?.collection?.collectionId !== 'string'
        || typeof selectedCollection !== 'string') {
      throw new Error('remote_collection_identity_missing');
    }
    return { accountDigest: await hash(credential.subject), selectedCollectionDigest: await hash(selectedCollection),
      remoteCollectionDigest: await hash(session.collection.collectionId) };
  });
}
