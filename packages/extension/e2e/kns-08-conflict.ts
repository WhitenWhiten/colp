import { expect, type Page } from '@playwright/test';
import { evidence } from './kns-08-harness.js';

interface ConflictFacts {
  readonly receipts: ReadonlyArray<{ readonly result?: { readonly results?: ReadonlyArray<{ readonly conflictId?: string }> } }>;
  readonly queue: ReadonlyArray<{ readonly status: string; readonly recovery?: { readonly code?: string } }>;
}

/** Make an explicit user decision through the real COLP HTTP route. */
export async function resolveIncomingConflict(pages: readonly Page[]): Promise<number> {
  async function observed() {
    for (const [index, page] of pages.entries()) {
      const facts = await evidence<ConflictFacts>(page, 'exportOutboundPushEvidence');
      const conflictId = facts.receipts.flatMap((row) => row.result?.results ?? [])
        .find((result) => typeof result.conflictId === 'string')?.conflictId;
      if (conflictId) return { index, page, conflictId, facts };
    }
    return null;
  }
  await expect.poll(async () => Boolean(await observed()), { timeout: 60_000 }).toBe(true);
  const conflict = await observed();
  if (!conflict) throw new Error('conflict_receipt_missing');
  expect(conflict.facts.queue.some((row) => row.status === 'blocked'
    && row.recovery?.code === 'conflict_pending')).toBe(true);
  // The credential and session record live in `chrome.storage.session`, pinned to
  // TRUSTED_CONTEXTS so an extension page cannot read them — which is exactly why
  // this helper can no longer read them either. It asks the worker for the identity
  // fields through the evidence channel and takes the bearer from the browser's
  // COOKIE JAR, which is how production obtains it. Reading the token out of a page
  // would have meant copying the session record back into a page-readable area and
  // undoing the split.
  const found = await evidence<{ sessionId?: string; collectionId?: string; replicaId?: string } | null>(
    conflict.page, 'exportAuthorityIdentity');
  if (found?.sessionId === undefined || found.collectionId === undefined
      || found.replicaId === undefined) {
    throw new Error('conflict_authority_missing');
  }
  const identity = { sessionId: found.sessionId, collectionId: found.collectionId,
    replicaId: found.replicaId };
  const result = await conflict.page.evaluate(async ({ conflictId, identity: who }) => {
    // The token is the session cookie's value; the server origin is public state.
    const snapshot = (await chrome.storage.local.get('known.auth.snapshot.v1'))['known.auth.snapshot.v1'] as
      { serverOrigin?: string } | undefined;
    if (typeof snapshot?.serverOrigin !== 'string') throw new Error('conflict_authority_missing');
    const cookie = await chrome.cookies.get({ url: snapshot.serverOrigin, name: '__Host-known_session' });
    if (!cookie?.value) throw new Error('conflict_authority_missing');
    const token = decodeURIComponent(cookie.value);
    const session = { sessionId: who.sessionId, collection: { collectionId: who.collectionId } };
    const binding = { replicaId: who.replicaId };
    const credential = { accessToken: token };
    const config = await (await fetch(chrome.runtime.getURL('generated-config.json'))).json() as { manifestUrl: string };
    const manifestResponse = await fetch(config.manifestUrl, { headers: {
      Accept: 'application/vnd.collection-protocol.manifest+json;version=0.2', 'Collection-Protocol-Version': '0.2' } });
    if (!manifestResponse.ok) throw new Error('conflict_manifest_unavailable');
    const manifest = await manifestResponse.json() as { mounts: Array<{ endpoints?: { syncConflict?: string } }> };
    const templates = manifest.mounts.flatMap((mount) => mount.endpoints?.syncConflict ? [mount.endpoints.syncConflict] : []);
    if (templates.length !== 1) throw new Error('conflict_endpoint_ambiguous');
    const url = new URL(templates[0]!.replace('{conflictId}', encodeURIComponent(conflictId)));
    url.searchParams.set('sessionId', session.sessionId); url.searchParams.set('replicaId', binding.replicaId);
    url.searchParams.set('collectionId', session.collection.collectionId);
    const response = await fetch(url, { method: 'POST', headers: {
      Authorization: `Bearer ${credential.accessToken}`, 'Collection-Protocol-Version': '0.2',
      'Content-Type': 'application/json', 'If-Match': '"conflict-r1"', 'Idempotency-Key': crypto.randomUUID(),
    }, body: JSON.stringify({ resolution: 'incoming', baseConflictRevision: 'conflict-r1' }) });
    const body = await response.json() as { code?: string };
    return { status: response.status, code: body.code ?? null };
  }, { conflictId: conflict.conflictId, identity });
  expect(result).toEqual({ status: 200, code: null });
  return conflict.index;
}
