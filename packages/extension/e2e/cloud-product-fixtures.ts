/**
 * Know-N-only product fixtures: capture, classification and credits.
 *
 * COLP Server does not ship these routes. `classification-product-stack.ts` and
 * `capture-product-stack.ts` import Know-N backend modules that exist only when
 * `scripts/with-know-n-backend.mjs` maps `packages/server` to a Know-N checkout, so
 * both files are left out of `npm run typecheck`. Specs see the interfaces below.
 */
import type { FastifyInstance } from '../../server/node_modules/fastify/fastify.js';
import type { DatabaseRuntime } from '../../server/src/infrastructure/database/index.js';
import type { BrowserSessionAuthority } from '../../server/src/modules/auth/index.js';

/** Set by `scripts/with-know-n-backend.mjs`; unset when the harness runs COLP Server. */
export const knowNBackendRoot = process.env.KNOWN_E2E_BACKEND_ROOT;
export const KNOW_N_BACKEND_ONLY = 'Needs the Know-N backend: run through scripts/with-know-n-backend.mjs';

export interface ClassificationProductObservation {
  readonly path: string;
  readonly origin: string | null;
  readonly cookie: boolean;
  readonly bearer: boolean;
  readonly csrf: boolean;
  readonly status: number;
}

export interface CaptureProductFacts {
  readonly decisions: readonly {
    readonly id: string; readonly capture_id: string; readonly node_id: string; readonly status: string;
    readonly execution_id: string | null; readonly applied_at: Date | null;
  }[];
  readonly events: readonly { readonly kind: string; readonly learning_eligible: boolean; readonly evidence_generation: number | null }[];
  readonly charges: readonly { readonly id: string; readonly state: string }[];
}

export interface CaptureProductFixture {
  facts(): Promise<CaptureProductFacts>;
}

export interface ClassificationProductFixture {
  readonly capture: CaptureProductFixture;
  holdNextProvider(): void;
  providerHeld(): boolean;
  releaseProvider(): void;
  holdNextCaptureApply(): void;
  captureApplyHeld(): boolean;
  releaseCaptureApply(): void;
  providerInputHashes(): string[];
  providerCallCount(): number;
  localCalls(): { host: string; cookie: boolean; input: unknown }[];
  observations(): ClassificationProductObservation[];
  setProviderAvailable(): void;
  seedTags(collectionId: string): Promise<void>;
  editBookmark(url: string, tags: readonly string[], description: string): Promise<unknown>;
  enableAutoTags(collectionId: string): Promise<void>;
  drainAutoTags(): Promise<boolean>;
  readTags(url: string): Promise<{ tags: string[] }[]>;
  ageSessions(): Promise<void>;
  fundClassification(collectionId: string): Promise<void>;
  seedCreditLedger(collectionId: string): Promise<{ accountId: string; chargeId: string; entryIds: string[]; entryCount: number }>;
  expireAllCredits(collectionId: string): Promise<string>;
}

export type MountClassificationProductFixture = (
  app: FastifyInstance,
  database: DatabaseRuntime,
  authority: BrowserSessionAuthority,
  extensionOrigin: string,
  syntheticCapture?: boolean,
) => ClassificationProductFixture;

/** A variable specifier keeps tsc from following the import into Know-N-only modules. */
export async function loadClassificationProductStack(): Promise<{ mountClassificationProductFixture: MountClassificationProductFixture }> {
  if (!knowNBackendRoot) throw new Error(KNOW_N_BACKEND_ONLY);
  const specifier = './classification-product-stack.js';
  return await import(specifier) as { mountClassificationProductFixture: MountClassificationProductFixture };
}

/** Know-N report reader routes; COLP Server has no reports. */
export async function loadReportReaderRoutes(): Promise<{ registerReportReaderRoutes(app: FastifyInstance, deps: object): void }> {
  if (!knowNBackendRoot) throw new Error(KNOW_N_BACKEND_ONLY);
  const specifier = '../../server/src/transport/product/report-reader-routes.js';
  return await import(specifier) as { registerReportReaderRoutes(app: FastifyInstance, deps: object): void };
}
