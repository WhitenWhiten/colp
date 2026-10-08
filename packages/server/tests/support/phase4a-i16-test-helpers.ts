/**
 * Shared helpers for the P4A-I16 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides a deterministic production-shaped AttachmentsFeatureConfig, valid
 * fixed-schema evidence fixtures (binding/scenario/negative-controls/post-run
 * checks), and a `buildI16FixtureEvidence` builder over the runner's public
 * `buildI16Evidence`. The negative controls are the full runner catalog with
 * pass verdicts and an explicit per-control verification source, exactly as a
 * real evidence bundle records them. Every fixture bundle carries a fixed
 * run id and execution receipts produced by the fixed in-run control
 * executor (`I16NegativeControlExecutor`); the migrated real controls
 * `size_digest_mismatch` (R01), `oversize_object` and `provider_throttle_timeout`
 * (R02) use their catalog facts and the rest use synthetic facts, so
 * fixtures exercise the executor state machine on every build.
 */
import { createHash } from 'node:crypto';
import type { AttachmentsFeatureConfig } from '../../src/modules/attachments/index.js';
import {
  I16_MIGRATION_HEAD,
  I16_NEGATIVE_CONTROL_CATALOG,
  I16NegativeControlExecutor,
  buildI16Evidence,
  computeI16ConfigDigest,
  type I16BindingFacts,
  type I16ConfigFacts,
  type I16EvidenceBundle,
  type I16ExecutionEvidence,
  type I16NegativeControlEvidence,
  type I16PostRunChecks,
  type I16ScenarioFacts,
} from '../../scripts/evidence/phase4a-i16-acceptance.js';

/**
 * Frozen reviewed commit for fixture bundles. Must be a real ancestor of
 * HEAD whose last `migrations/\d{12}_*.ts` file equals `I16_MIGRATION_HEAD`
 * (and whose `^{tree}` equals `I16_TEST_TREE`). The runner shape guard pins
 * the current production head; the independent validator CLI in retained
 * mode recomputes the head from git at this revision. Bump both together
 * when the production migration head moves.
 *
 * The pin includes the security-epoch stamp migration. These synthetic
 * fixtures validate source binding; they are not deployment acceptance evidence.
 */
export const I16_TEST_REVISION = '4ae0bb9ab6622995ca8799acd777c137aa6a3496';
export const I16_TEST_TREE = 'c9f4ec3cf24aca7a2a6ec0f349fc13ba59d40863';
export const I16_TEST_NONCE = 'i16-test-nonce-0000000000000000000000000000';
export const I16_TEST_RUN_ID = 'i16-test-run-00000000-0000-4000-8000-000000000000';

/** Fixed in-run facts for the migrated real controls (P4A-R01/R02). */
const REAL_CONTROL_FACTS: Readonly<Record<string, {
  readonly installPoint: string;
  readonly installEvidence: string;
  readonly stableCode: string;
  readonly cleanupReceipt: string;
}>> = {
  size_digest_mismatch: {
    installPoint: 'declared size/digest vs the real R2 bytes at the complete/verify target boundary',
    installEvidence: 'declared_sha256_of_different_same_size_bytes',
    stableCode: 'quarantined',
    cleanupReceipt: 'confirmed_absent',
  },
  oversize_object: {
    installPoint: 'a body over the single-PUT ceiling at the issue/stream target boundary',
    installEvidence: 'declared-size-over-ceiling + over-delivering-bounded-stream',
    stableCode: 'read_exceeds_ceiling',
    cleanupReceipt: 'no_object_created',
  },
  provider_throttle_timeout: {
    installPoint: 'provider 429/timeout/5xx classification at the transport target boundary',
    installEvidence: 'scripted-429-5xx-timeout-drop-denied-notfound-unknown-responses',
    stableCode: 'not_misclassified',
    cleanupReceipt: 'confirmed_absent',
  },
};

export function sha256HexI16(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function i16Config(overrides: Partial<AttachmentsFeatureConfig> = {}): AttachmentsFeatureConfig {
  const base: AttachmentsFeatureConfig = {
    enabled: true,
    r2: {
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'known-i16-production',
      livePrefix: 'attachments/live/',
      probePrefix: 'capability-probes/i16/',
      rwSecretRef: 'known/r2/rw/primary',
      roSecretRef: 'known/r2/ro/primary',
    },
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
    allowedMedia: ['image/png', 'application/pdf', 'text/plain'],
    verification: { leaseMs: 60_000, timeoutMs: 15_000, retryCount: 2 },
    retention: { intentRetentionHours: 24, storedRetentionDays: 30, retiredRetentionDays: 90 },
    cleanupBatchSize: 100,
    cleanup: { leaseMs: 60_000, retryCount: 2 },
    isolatedDeliveryOrigin: 'https://delivery.known.test',
    deliveryCapabilitySecretRef: 'known/delivery/hmac/primary',
    deliveryCapabilityTtlSeconds: 60,
  };
  return Object.freeze({ ...base, ...overrides, r2: { ...base.r2, ...overrides.r2 } });
}

export function i16ConfigFacts(): I16ConfigFacts {
  const { facts } = computeI16ConfigDigest(i16Config());
  return facts;
}

export function i16BindingFacts(overrides: Partial<I16BindingFacts> = {}): I16BindingFacts {
  const { digest, facts } = computeI16ConfigDigest(i16Config());
  return {
    sourceRevision: I16_TEST_REVISION,
    sourceTreeHash: I16_TEST_TREE,
    sourceClean: true,
    migrationHead: I16_MIGRATION_HEAD,
    configDigest: digest,
    configFacts: facts,
    nodeVersion: 'v22.9.0',
    npmVersion: '11.7.0',
    dependencyVersions: {
      '@aws-sdk/client-s3': '3.1095.0',
      playwright: '1.61.1',
      kysely: '0.29.4',
      pg: '8.13.1',
      fastify: '5.2.1',
      vitest: '3.0.6',
    },
    r2Control: {
      attested: true,
      provider: 'cloudflare-r2-direct-object-api',
      accessMode: 'private',
      verdictSource: 'cloudflare-control-api-live-query',
      nonce: I16_TEST_NONCE,
    },
    originBuild: { productionBuild: true, buildHash: sha256HexI16('origin-build'), buildCommand: 'npm run build' },
    negativeControlCatalog: I16_NEGATIVE_CONTROL_CATALOG.map((definition) => ({
      control: definition.control,
      verdict: 'pass' as const,
      verificationSource: definition.primarySource,
      executed: true,
    })),
    ...overrides,
  };
}

export function i16Scenario(overrides: Partial<I16ScenarioFacts> = {}): I16ScenarioFacts {
  return {
    issue: { outcome: 'issued', ledgerBeforeGrant: true },
    put: { method: 'PUT', statusClass: '2xx' },
    complete: { outcome: 'completed', outboxSameCommit: true },
    verify: { outcome: 'stored_private', verifiedSizeMatches: true, mediaCategory: 'allowlisted' },
    deliverOwner: {
      statusClass: '2xx', forcedDownload: true, nosniff: true, noStore: true, noRedirect: true,
    },
    deliverNonOwner: { statusClass: '4xx', bodyBytes: 0, noRedirect: true },
    replacement: { oldGenerationState: 'retired', newGenerationState: 'active', keysDistinct: true },
    finalize: { outcome: 'attached_private', bindingFencedToCurrentGeneration: true },
    rollback: { outcome: 'rolled_back', blobStateAfter: 'stored_private' },
    cleanup: { retiredAbsent: true, activePreserved: true, tombstoneRejectsReissue: true },
    restart: { outcome: 'recovered', bindingPreserved: true },
    ...overrides,
  };
}

export function i16NegativeControls(
  overrides: Partial<I16NegativeControlEvidence>[] = [],
): I16NegativeControlEvidence[] {
  return I16_NEGATIVE_CONTROL_CATALOG.map((definition, index) => ({
    control: definition.control,
    verdict: 'pass' as const,
    outcome: 'expected',
    verificationSource: definition.primarySource,
    executed: true,
    ...(overrides[index] ?? {}),
  }));
}

export function i16PostRunChecks(overrides: Partial<I16PostRunChecks> = {}): I16PostRunChecks {
  return {
    databaseConverged: true,
    probeKeysAbsent: true,
    activeMarkerPreserved: true,
    processesClosed: true,
    residualPrefixClean: true,
    ...overrides,
  };
}

/**
 * Builds a run-scoped executor with one completed control per evidence entry
 * (synthetic facts; the migrated `size_digest_mismatch` control uses its real
 * catalog facts). Any invalid entry (unknown control, forbidden source)
 * fails the executor's `begin` with the stable fail-closed code.
 */
export function i16ExecutionLedger(
  controls: readonly I16NegativeControlEvidence[] = i16NegativeControls(),
  runId: string = I16_TEST_RUN_ID,
): I16NegativeControlExecutor {
  const executor = new I16NegativeControlExecutor(runId);
  for (const entry of controls) {
    const definition = I16_NEGATIVE_CONTROL_CATALOG.find((item) => item.control === entry.control);
    if (!definition) throw new Error(`negative_control_unknown:${entry.control}`);
    const real = REAL_CONTROL_FACTS[entry.control];
    executor.begin({
      control: entry.control,
      installPoint: real?.installPoint ?? `synthetic-boundary:${entry.control}`,
      owningTarget: definition.intendedTarget,
      verificationSource: entry.verificationSource,
    });
    executor.recordInstall(entry.control, real?.installEvidence ?? 'synthetic-install-proof');
    executor.recordTargetHit(entry.control);
    executor.recordStableCode(entry.control, real?.stableCode ?? definition.intendedCode[0]!);
    executor.recordCleanupReceipt(entry.control, real?.cleanupReceipt ?? 'synthetic-cleaned');
    executor.complete(entry.control);
  }
  return executor;
}

/** The run id + receipts half of the evidence gate input for the fixtures. */
export function i16ExecutionEvidence(
  controls: readonly I16NegativeControlEvidence[] = i16NegativeControls(),
  runId: string = I16_TEST_RUN_ID,
): I16ExecutionEvidence {
  const executor = i16ExecutionLedger(controls, runId);
  return { runId: executor.runId, receipts: executor.toEvidenceReceipts() };
}

export function buildI16FixtureEvidence(
  overrides: {
    readonly binding?: Partial<I16BindingFacts>;
    readonly scenario?: Partial<I16ScenarioFacts>;
    readonly negativeControls?: readonly I16NegativeControlEvidence[];
    readonly postRunChecks?: Partial<I16PostRunChecks>;
    readonly forbiddenValues?: readonly string[];
    readonly runId?: string;
  } = {},
): I16EvidenceBundle {
  const controls = overrides.negativeControls ?? i16NegativeControls();
  const execution = i16ExecutionEvidence(controls, overrides.runId);
  return buildI16Evidence({
    binding: i16BindingFacts(overrides.binding),
    scenario: i16Scenario(overrides.scenario),
    negativeControls: controls,
    postRunChecks: i16PostRunChecks(overrides.postRunChecks),
    forbiddenValues: overrides.forbiddenValues,
    runId: execution.runId,
    executionReceipts: execution.receipts,
  });
}
