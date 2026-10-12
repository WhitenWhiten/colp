import { isBookmarkHostAllowedForAutoUpload } from './favicon-host.js';
import { FAVICON_SIDECAR_TTL_MS, type createFaviconSidecarStore } from './favicon-sidecar-store.js';
import {
  captureExtensionFavicon,
  FaviconHelperHttpError,
  fetchExtensionFaviconPolicy,
  fetchExtensionFaviconSource,
  policyAllowsAutomaticCapture,
  policyRevisionOf,
  sourceAllowsAutomaticCapture,
  type ExtensionFaviconPolicyRead,
  type IconPolicyDto,
} from './favicon-helper-client.js';

export const FAVICON_HELPER_MAX_ATTEMPTS = 3;

export interface DrainFaviconSidecarsInput {
  readonly sidecar: ReturnType<typeof createFaviconSidecarStore>;
  readonly lookupNodeId: (nativeId: string) => Promise<string | null>;
  readonly bookmarkUrl: (nativeId: string) => Promise<string | null>;
  readonly accessToken: string; readonly origin: string; readonly serverOrigin: string;
  readonly collectionId: string; readonly fetch?: typeof fetch; readonly now?: () => number;
  readonly schedule?: (delayMilliseconds: number) => void;
  readonly randomUUID?: () => string;
  readonly dispatch?: (nativeId:string,send:()=>Promise<Response>)=>Promise<Response>;
  /** `false` when Manifest `features.cloud` is off. */
  readonly cloudEnabled?: boolean;
}

export interface DrainFaviconSidecarsResult {
  readonly posted: number; readonly discarded: number; readonly deferred: number;
}

/** Legacy helper URL kept for callers/tests; the FO-04 drain uses the typed client. */
export function helperFaviconUrl(serverOrigin: string, collectionId: string, nodeId: string): string {
  const origin = serverOrigin.replace(/\/$/u, '');
  return `${origin}/colp/v0.1/sync/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/favicon`;
}

/**
 * FO-04 policy-aware sidecar drain. Every capture is rebuilt from the current
 * server policy + per-node source: the account policy is read once per drain
 * (per active account/scope), each row re-reads its node source, and only a
 * capturable state is posted with the current If-Match +
 * Known-Favicon-Policy-Revision. Legacy queue rows (old bytes, old command
 * ids) are migrated the same way: missing validators are never sent blind — a
 * stale source read (412) rebuilds user intent under the fresh source ETag
 * with a NEW command id, and protected states (uploaded/none/force-online)
 * discard the old bytes. URL identity is enforced before any post AND before
 * every rebuild: bytes whose recorded capture page no longer matches the
 * bookmark URL are dropped, so a URL edit can never bind the old site's icon
 * to the new site. Offline/policy-unavailable rows stay locally stashed and
 * are re-evaluated on the next drain until the sidecar TTL bounds them (never
 * infinite retries). Icon failures never affect the bookmark save because
 * this drain is already fire-and-forget from the save path.
 *
 * The drain is single-flight per collection: the service-worker alarm, the
 * `known.favicon.drain` message and engine wakes can overlap, and two
 * concurrent drains must never mint different command ids for the same row's
 * 412 rebuild. A second invocation while one drain is active chains ONE
 * trailing re-run (so state changes made mid-drain are still re-evaluated);
 * further overlapping invocations are skipped outright.
 */
export async function drainFaviconSidecars(options: DrainFaviconSidecarsInput): Promise<DrainFaviconSidecarsResult | 'unsupported'> {
  if (options.cloudEnabled === false) return 'unsupported';
  const key = options.collectionId;
  const existing = inFlightDrains.get(key);
  if (existing === undefined) {
    const promise = drainFaviconSidecarsInner(options).finally(() => {
      if (inFlightDrains.get(key)?.promise === promise) inFlightDrains.delete(key);
    });
    inFlightDrains.set(key, { promise, trailing: false });
    return promise;
  }
  if (existing.trailing) {
    // A trailing re-run is already queued behind the active drain: skip this
    // invocation (two concurrent drains would race the same rows' rebuilds).
    return { posted: 0, discarded: 0, deferred: 0 };
  }
  const trailingPromise = existing.promise
    .catch(() => undefined)
    .then(() => drainFaviconSidecarsInner(options))
    .finally(() => {
      if (inFlightDrains.get(key)?.promise === trailingPromise) inFlightDrains.delete(key);
    });
  inFlightDrains.set(key, { promise: trailingPromise, trailing: true });
  return trailingPromise;
}

interface InFlightDrain {
  readonly promise: Promise<DrainFaviconSidecarsResult | 'unsupported'>;
  /** A trailing re-run is already chained behind the active drain. */
  readonly trailing: boolean;
}
const inFlightDrains = new Map<string, InFlightDrain>();

async function drainFaviconSidecarsInner(options: DrainFaviconSidecarsInput): Promise<DrainFaviconSidecarsResult | 'unsupported'> {
  const rawFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? (() => crypto.randomUUID());
  let posted = 0; let discarded = 0; let deferred = 0;
  let policy: IconPolicyDto | null | undefined = undefined;
  for (const row of await options.sidecar.list(options.collectionId)) {
    const fetcher:typeof fetch=(input,init)=>options.dispatch?options.dispatch(row.nativeId,()=>rawFetch(input,init)):rawFetch(input,init);
    const t = now();
    if (t - row.createdAt > FAVICON_SIDECAR_TTL_MS) {
      await options.sidecar.discard(row.nativeId); discarded += 1; continue;
    }
    if (row.notBefore > t) {
      deferred += 1; options.schedule?.(row.notBefore - t); continue;
    }
    const nodeId = await options.lookupNodeId(row.nativeId);
    if (!nodeId || nodeId.startsWith('pending-')) {
      deferred += 1;
      options.schedule?.(Math.min(5_000, Math.max(1_000, FAVICON_SIDECAR_TTL_MS - (t - row.createdAt))));
      continue;
    }
    if (!(await pageUrlIdentityAllows(options, row))) {
      await options.sidecar.discard(row.nativeId); discarded += 1; continue;
    }
    const credentials = { accessToken: options.accessToken, origin: options.origin };
    if (policy === undefined) {
      try {
        policy = (await fetchExtensionFaviconPolicy({
          ...credentials, serverOrigin: options.serverOrigin, fetch: fetcher,
        })).policy;
      } catch (error) {
        // The helper route 404s when favicon upload is not on this server.
        if (error instanceof FaviconHelperHttpError && error.status === 404) return 'unsupported';
        policy = null;
      }
    }
    if (policy === null) {
      // Policy unavailable (offline/5xx): conservative delay, keep the bytes.
      const attempts = row.attempts + 1;
      if (t - row.createdAt > FAVICON_SIDECAR_TTL_MS) {
        await options.sidecar.discard(row.nativeId); discarded += 1; continue;
      }
      const delay = Math.min(30_000, 1_000 * (2 ** (Math.max(attempts - 1, 0))));
      await options.sidecar.markAttempt(row.nativeId, attempts, t + delay);
      deferred += 1; options.schedule?.(delay);
      continue;
    }
    if (!policyAllowsAutomaticCapture(policy)) {
      // newDefault none or force-online: the server policy never wants
      // automatic captured bytes right now; drop the queued bytes.
      await options.sidecar.discard(row.nativeId); discarded += 1; continue;
    }
    const outcome = await postOneCapture(options, credentials, policy, row, nodeId, fetcher, uuid);
    if (outcome === 'posted') { posted += 1; continue; }
    if (outcome === 'discarded') { discarded += 1; continue; }
    if (outcome === 'deferred') {
      const attempts = row.attempts + 1;
      if (attempts >= FAVICON_HELPER_MAX_ATTEMPTS || t - row.createdAt > FAVICON_SIDECAR_TTL_MS) {
        await options.sidecar.discard(row.nativeId); discarded += 1; continue;
      }
      const delay = Math.min(30_000, 1_000 * (2 ** (attempts - 1)));
      await options.sidecar.markAttempt(row.nativeId, attempts, t + delay);
      deferred += 1; options.schedule?.(delay);
    }
  }
  return { posted, discarded, deferred };
}

/**
 * URL identity gate shared by the main drain path AND every rebuild path.
 * Non-import bytes are only posted when the bookmark still lives at the
 * recorded capture page. A row with NO recorded page URL (a pre-upgrade
 * legacy row) can never prove which page its bytes came from: posting it
 * would risk binding the old site's icon to the current URL after an edit, so
 * those rows are conservatively dropped too. Import rows are the user's own
 * exported bytes and carry no captured page.
 */
async function pageUrlIdentityAllows(
  options: DrainFaviconSidecarsInput,
  row: Awaited<ReturnType<typeof options.sidecar.list>>[number],
): Promise<boolean> {
  if (row.origin === 'import') return true;
  const pageUrl = await options.bookmarkUrl(row.nativeId);
  if (!pageUrl || !isBookmarkHostAllowedForAutoUpload(pageUrl)) return false;
  if (row.pageUrl === undefined) return false;
  if (row.pageUrl !== pageUrl) return false;
  return true;
}

type CaptureOutcome = 'posted' | 'discarded' | 'deferred';

async function postOneCapture(
  options: DrainFaviconSidecarsInput,
  credentials: { readonly accessToken: string; readonly origin: string },
  policy: IconPolicyDto,
  row: Awaited<ReturnType<typeof options.sidecar.list>>[number],
  nodeId: string,
  fetcher: typeof fetch,
  uuid: () => string,
): Promise<CaptureOutcome> {
  let sourceRead;
  try {
    sourceRead = await fetchExtensionFaviconSource({
      ...credentials, serverOrigin: options.serverOrigin, fetch: fetcher,
    }, row.collectionId, nodeId);
  } catch (error) {
    if (error instanceof FaviconHelperHttpError && error.status === 404) {
      // Node vanished / concealed: drop the stale bytes.
      await options.sidecar.discard(row.nativeId);
      return 'discarded';
    }
    return 'deferred';
  }
  if (!sourceAllowsAutomaticCapture(sourceRead.source)) {
    await options.sidecar.discard(row.nativeId);
    return 'discarded';
  }
  let status: number;
  try {
    const result = await captureExtensionFavicon({
      credentials, serverOrigin: options.serverOrigin, collectionId: row.collectionId, nodeId,
      commandId: row.commandId, ifMatch: sourceRead.etag,
      policyRevision: policyRevisionOf(policy), contentType: row.contentType,
      bytes: new Uint8Array(row.bytes), fetch: fetcher,
    });
    status = result.status;
  } catch (error) {
    status = error instanceof FaviconHelperHttpError ? error.status : 0;
  }
  if (status >= 200 && status < 300) {
    await options.sidecar.discard(row.nativeId);
    return 'posted';
  }
  if (status === 412 || status === 428) {
    return rebuildAfterPreconditionFailure(options, credentials, policy, row, nodeId, fetcher, uuid, status);
  }
  if (status === 429 || status === 0 || status === 503) return 'deferred';
  // Every other 4xx (403/404/409/410/413/415) is permanent for these bytes.
  await options.sidecar.discard(row.nativeId);
  return 'discarded';
}

/**
 * One refresh budget after the server refused the row with 412
 * (precondition_failed) or 428 (precondition_required). The bytes are never
 * blind-replayed:
 *
 * - the pageUrl identity gate is re-run: a URL edit between the read and the
 *   POST discards instead of re-posting the old page's bytes;
 * - the source is re-read, and protected states (uploaded/none) still drop
 *   the old bytes;
 * - on 412 the account policy is re-fetched whenever the fresh source reports
 *   a policy revision newer than the one this drain opened with — a mid-drain
 *   policy change must not cost the queued bytes, so the rebuild runs under
 *   the FRESH revision (or defers when the refreshed policy no longer wants
 *   automatic captures — never a silent discard);
 * - on 428 the policy is always re-fetched (the server demanded validators)
 *   and the rebuild sends a fresh command id under the fresh validators,
 *   discarding only when the refreshed state no longer allows capture;
 * - a rebuild that races again (412) or hits a transient status defers to the
 *   next drain; a second 428 is permanent for these bytes.
 */
async function rebuildAfterPreconditionFailure(
  options: DrainFaviconSidecarsInput,
  credentials: { readonly accessToken: string; readonly origin: string },
  policy: IconPolicyDto,
  row: Awaited<ReturnType<typeof options.sidecar.list>>[number],
  nodeId: string,
  fetcher: typeof fetch,
  uuid: () => string,
  refusedStatus: 412 | 428,
): Promise<CaptureOutcome> {
  if (!(await pageUrlIdentityAllows(options, row))) {
    // The bookmark URL changed while the capture sat in flight: the old
    // site's bytes are never re-posted to the new URL.
    await options.sidecar.discard(row.nativeId);
    return 'discarded';
  }
  let fresh: Awaited<ReturnType<typeof fetchExtensionFaviconSource>>;
  try {
    fresh = await fetchExtensionFaviconSource({
      ...credentials, serverOrigin: options.serverOrigin, fetch: fetcher,
    }, row.collectionId, nodeId);
  } catch {
    return 'deferred';
  }
  let currentPolicy = policy;
  if (refusedStatus === 428 || fresh.source.policyRevision !== policyRevisionOf(policy)) {
    let freshPolicyRead: ExtensionFaviconPolicyRead | null = null;
    try {
      freshPolicyRead = await fetchExtensionFaviconPolicy({
        ...credentials, serverOrigin: options.serverOrigin, fetch: fetcher,
      });
    } catch {
      // Cannot confirm the current policy: keep the bytes for the next drain.
      return 'deferred';
    }
    currentPolicy = freshPolicyRead.policy;
    if (refusedStatus === 412 && !policyAllowsAutomaticCapture(currentPolicy)) {
      // F1: the policy revision advanced mid-drain to a state that does not
      // want automatic captures. Defers instead of discarding; the next drain
      // re-evaluates under the fresh policy and applies the normal
      // protected-state rules there.
      return 'deferred';
    }
  }
  if (!sourceAllowsAutomaticCapture(fresh.source)) {
    await options.sidecar.discard(row.nativeId);
    return 'discarded';
  }
  if (!policyAllowsAutomaticCapture(currentPolicy)) {
    // F3: after the refresh the policy still does not want automatic
    // captures — the fresh state no longer allows capture, so the old bytes
    // are dropped (the protected states keep discarding).
    await options.sidecar.discard(row.nativeId);
    return 'discarded';
  }
  const commandId = uuid().toLowerCase();
  let status: number;
  try {
    const rebuilt = await captureExtensionFavicon({
      credentials, serverOrigin: options.serverOrigin, collectionId: row.collectionId, nodeId,
      commandId, ifMatch: fresh.etag, policyRevision: policyRevisionOf(currentPolicy),
      contentType: row.contentType, bytes: new Uint8Array(row.bytes), fetch: fetcher,
    });
    if (rebuilt.status >= 200 && rebuilt.status < 300) {
      await options.sidecar.discard(row.nativeId);
      return 'posted';
    }
    status = rebuilt.status;
  } catch (error) {
    status = error instanceof FaviconHelperHttpError ? error.status : 0;
  }
  if (status === 412 || status === 429 || status === 0 || status === 503) {
    // The fresh validators raced again (or the helper is transiently down):
    // defer to a later drain — the next read would post these bytes, so
    // discarding them here would be a silent loss.
    return 'deferred';
  }
  // A second 428 (validators still refused) or any remaining 4xx is permanent.
  await options.sidecar.discard(row.nativeId);
  return 'discarded';
}