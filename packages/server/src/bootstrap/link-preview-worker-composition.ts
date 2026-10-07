/**
 * LP-03 link preview worker composition. Kept out of worker.ts (at its size
 * cap): the process composes the store once, the runtime owns and closes it.
 */
import type { AppConfig } from './config.js';
import type { DatabaseRuntime } from '../infrastructure/database/index.js';
import type { HardenedEgressConnector, HardenedEgressResolver } from '../infrastructure/egress/index.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import {
  createLinkPreviewWorkerRuntime,
  linkPreviewEgressFromEnv,
  createPostgresLinkPreviewRepository,
  type LinkPreviewWorkerLogger,
  type LinkPreviewWorkerLoop,
} from '../infrastructure/collections/index.js';
import type { BookmarkFaviconObjectStore } from '../modules/collections/index.js';
import { composeLinkPreviewObjectStore, type FaviconSecretResolver } from './favicon-object-storage-composition.js';

/** Test seam: an in-memory store and egress fakes so tests never open a socket or an R2 client. */
export interface LinkPreviewWorkerSeam {
  readonly store?: BookmarkFaviconObjectStore;
  readonly resolve?: HardenedEgressResolver;
  readonly connect?: HardenedEgressConnector;
}

export interface ComposedLinkPreviewWorker {
  readonly loop: LinkPreviewWorkerLoop;
  /** Stops the loop, then releases the store's clients. */
  stop(): Promise<void>;
}

/** Process-level store; enabled without storage fails closed at startup. */
export async function composeLinkPreviewWorkerStore(
  config: AppConfig,
  resolveSecret: FaviconSecretResolver,
): Promise<BookmarkFaviconObjectStore | undefined> {
  if (!config.linkPreview.enabled) return undefined;
  const store = await composeLinkPreviewObjectStore(config, resolveSecret);
  if (store === undefined) {
    throw new Error('worker composition refused: KNOWN_FEATURE_LINK_PREVIEW enabled requires link preview object storage');
  }
  return store;
}

export function composeLinkPreviewWorker(input: {
  readonly config: AppConfig;
  readonly database: DatabaseRuntime | undefined;
  readonly metrics: Metrics;
  readonly logger: LinkPreviewWorkerLogger;
  readonly seam?: LinkPreviewWorkerSeam;
}): ComposedLinkPreviewWorker | undefined {
  const { config, database, seam } = input;
  if (database === undefined || !config.linkPreview.enabled) return undefined;
  const store = seam?.store;
  if (store === undefined) {
    throw new Error('worker composition refused: KNOWN_FEATURE_LINK_PREVIEW enabled requires a link preview object store');
  }
  // Test seams win; otherwise a non-production run may point at a fixture file.
  const egress = seam?.resolve !== undefined || seam?.connect !== undefined
    ? seam
    : linkPreviewEgressFromEnv(process.env, config.nodeEnv);
  const { loop } = createLinkPreviewWorkerRuntime({
    repository: createPostgresLinkPreviewRepository(database.pool, {
      cancelBackend: database.cancelBackend,
    }),
    store,
    logger: input.logger,
    metrics: input.metrics,
    retentionSeconds: config.linkPreview.retentionSeconds,
    concurrency: config.linkPreview.workerConcurrency,
    perHostGapMs: config.linkPreview.perHostGapMs,
    ...(egress?.resolve === undefined ? {} : { resolve: egress.resolve }),
    ...(egress?.connect === undefined ? {} : { connect: egress.connect }),
  });
  return Object.freeze({
    loop,
    async stop() {
      try {
        await loop.stop();
      } finally {
        await store.close?.();
      }
    },
  });
}
