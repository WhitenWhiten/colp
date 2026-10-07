/**
 * P4A-I06 bootstrap composition: construct the R2 generation-store adapter
 * from the parsed `attachments` module config.
 *
 * The adapter itself must not depend on the `attachments` module (see
 * `scripts/check-import-boundaries.mjs` — `infrastructureModuleEdges['object-storage']`
 * is empty), so this bootstrap helper owns the mapping from the module-owned
 * config (endpoint/bucket/prefixes/secret references/ceilings) to the
 * adapter's plain options, resolving the RW/RO credentials by their secret
 * references through the injected resolver.
 *
 * No HTTP route is wired here (I06 scope: no routes); this is the documented
 * composition entrypoint for later consumers (I08/I09/I14).
 */
import type { AttachmentsFeatureConfig } from '../modules/attachments/index.js';
import { createR2GenerationStore } from '../infrastructure/object-storage/index.js';
import type { BlobStorePort } from '../infrastructure/object-storage/index.js';

export interface ResolvedR2Secret {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type R2SecretResolver = (secretRef: string) => Promise<ResolvedR2Secret>;

export async function composeAttachmentsObjectStorage(
  config: AttachmentsFeatureConfig,
  resolveSecret: R2SecretResolver,
): Promise<BlobStorePort> {
  const [rwCredential, roCredential] = await Promise.all([
    resolveSecret(config.r2.rwSecretRef),
    resolveSecret(config.r2.roSecretRef),
  ]);
  return createR2GenerationStore({
    endpoint: config.r2.endpoint,
    region: config.r2.region,
    bucket: config.r2.bucket,
    livePrefix: config.r2.livePrefix,
    probePrefix: config.r2.probePrefix,
    rwCredential,
    roCredential,
    grantTtlSeconds: config.grantTtlSeconds,
    singlePutMaxBytes: config.singlePutMaxBytes,
  });
}
