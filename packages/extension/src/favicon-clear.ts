import {
  clearExtensionCapturedFavicon,
  FaviconHelperHttpError,
  fetchExtensionFaviconPolicy,
  fetchExtensionFaviconSource,
  policyRevisionOf,
  sourceAllowsAutomaticCapture,
  type ExtensionFaviconPolicyRead,
  type ExtensionFaviconSourceRead,
} from './favicon-helper-client.js';
import type { createFaviconSidecarStore } from './favicon-sidecar-store.js';

export type ClearFaviconOutcome =
  /** The DELETE succeeded and any queued sidecar bytes for the bookmark are gone. */
  | { readonly status: 'cleared' }
  /** The bookmark's source/policy refuses clearing (uploaded / none / force-online). */
  | { readonly status: 'protected' }
  /** Nothing to clear (the node carries no helper source — 404). */
  | { readonly status: 'noop' }
  /** Offline, or the server refused after a fresh-validator retry. */
  | { readonly status: 'unavailable' };

export interface ClearCapturedFaviconInput {
  readonly sidecar: ReturnType<typeof createFaviconSidecarStore>;
  readonly collectionId: string;
  readonly nativeId: string;
  readonly nodeId: string;
  readonly accessToken: string;
  readonly origin: string;
  readonly serverOrigin: string;
  readonly fetch?: typeof fetch;
  readonly randomUUID?: () => string;
}

/**
 * FO-04 honest consumer for clearExtensionCapturedFavicon (DELETE) — the
 * operation must have a real call site, not just a typed client. The flow
 * mirrors the drain: read the account policy, read the per-node source, gate
 * on the same server refusal list the capture uses (uploaded / none /
 * force-online are never cleared), then DELETE with If-Match +
 * Known-Favicon-Policy-Revision + a fresh canonical Known-Command-Id. On
 * success the queued sidecar bytes for the bookmark are discarded so the
 * later drain never replays the icon the user just cleared. A 412 refreshes
 * the source + policy once and retries with the fresh validators; it is never
 * surfaced as a failure to the UI without that retry.
 */
export async function clearCapturedFavicon(input: ClearCapturedFaviconInput): Promise<ClearFaviconOutcome> {
  const fetcher = input.fetch ?? fetch;
  const uuid = input.randomUUID ?? (() => crypto.randomUUID());
  const credentials = { accessToken: input.accessToken, origin: input.origin };
  const base = { serverOrigin: input.serverOrigin, fetch: fetcher };

  let policyRead: ExtensionFaviconPolicyRead;
  try {
    policyRead = await fetchExtensionFaviconPolicy({ ...credentials, ...base });
  } catch {
    return { status: 'unavailable' };
  }
  if (policyRead.policy.forceAllOnline) return { status: 'protected' };

  let sourceRead: ExtensionFaviconSourceRead;
  try {
    sourceRead = await fetchExtensionFaviconSource({ ...credentials, ...base }, input.collectionId, input.nodeId);
  } catch (error) {
    if (error instanceof FaviconHelperHttpError && error.status === 404) return { status: 'noop' };
    return { status: 'unavailable' };
  }
  if (!sourceAllowsAutomaticCapture(sourceRead.source)) return { status: 'protected' };

  // One refresh budget on 412 (source ETag or policy revision moved between
  // the reads and the DELETE), mirroring the drain's rebuild semantics.
  let currentPolicy = policyRead;
  let currentSource = sourceRead;
  for (let attempt = 0; ; attempt += 1) {
    const commandId = uuid().toLowerCase();
    try {
      const result = await clearExtensionCapturedFavicon({
        credentials, serverOrigin: input.serverOrigin, collectionId: input.collectionId, nodeId: input.nodeId,
        commandId, ifMatch: currentSource.etag, policyRevision: policyRevisionOf(currentPolicy.policy), fetch: fetcher,
      });
      if (result.status >= 200 && result.status < 300) {
        // Never let the drain replay the cleared bytes.
        await input.sidecar.discard(input.nativeId).catch(() => undefined);
        return { status: 'cleared' };
      }
      return { status: 'unavailable' };
    } catch (error) {
      const status = error instanceof FaviconHelperHttpError ? error.status : 0;
      if (status !== 412 || attempt >= 1) return { status: 'unavailable' };
      try {
        currentSource = await fetchExtensionFaviconSource({ ...credentials, ...base }, input.collectionId, input.nodeId);
        currentPolicy = await fetchExtensionFaviconPolicy({ ...credentials, ...base });
      } catch {
        return { status: 'unavailable' };
      }
      if (!sourceAllowsAutomaticCapture(currentSource.source)) return { status: 'protected' };
      if (currentPolicy.policy.forceAllOnline) return { status: 'protected' };
    }
  }
}