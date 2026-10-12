import { createMetadataSyncPolicyStore, type MetadataPolicyScope, type MetadataPolicyStorage } from './metadata-sync-policy.js';

export type MetadataPolicyStatus = { readonly ok: true; readonly collectionId: string;
  readonly mode: 'sync' | 'local-only'; readonly consentRequired: boolean };
export function validMetadataPolicyStatusRequest(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && (value as { kind?: unknown }).kind === 'known.metadataSync.status');
}

/** Resolve identity in the worker. Callers cannot inspect another account's policy. */
export async function readMetadataPolicyStatus(storage: MetadataPolicyStorage, identity: MetadataPolicyScope,
  livePolicy = createMetadataSyncPolicyStore(storage)): Promise<MetadataPolicyStatus> {
  const policy = await livePolicy.read(identity);
  return { ok: true, collectionId: identity.collectionId, mode: policy.mode,
    consentRequired: policy.revision === 'unconfigured' || policy.revision === 'invalid' };
}
