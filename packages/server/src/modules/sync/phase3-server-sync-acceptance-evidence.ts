/**
 * P3-26 server-sync acceptance evidence types and validators.
 * Owned here so `modules/sync` does not import `bootstrap` (claim-gate
 * consumers live on the production module graph). `scripts/acceptance`
 * re-exports this file for existing script/test importers.
 */
import { createHash } from 'node:crypto';
import { problemRegistry } from '@know-n/colp/server';

export const PHASE3_SERVER_SYNC_ACCEPTANCE_FORMAT = 'known.phase3.server-sync-acceptance.v2';
export const PHASE3_SERVER_SYNC_SCHEMA_VERSION = 2 as const;
export const PHASE3_SERVER_SYNC_RUNNER_VERSION = '2.0.0';
export const PHASE3_SERVER_SYNC_PROBE_VERSION = '2.0.0';
export const P3_26_PRODUCTION_MIGRATIONS = Object.freeze([
  '202607220900_phase1_schema.ts', '202607221200_versioned_outbox_worker.ts',
  '202607221500_product_command_receipt_hardening.ts', '202607221600_authority_repair.ts',
  '202607221700_identity_lifecycle.ts', '202607221800_collection_summary.ts',
  '202607221900_node_visibility.ts', '202607222000_publisher_idempotency.ts',
  '202607222100_oidc_transaction_protected_secrets.ts', '202607222200_oidc_transaction_secrets_contract.ts',
  '202607222300_accounts_email_unique.ts', '202607222400_session_rotation_single_winner.ts',
  '202607222500_collection_mutation_projection.ts', '202607222600_canonical_resource_payloads.ts',
  '202607222700_projection_watermarks_per_resource.ts', '202607222800_live_editor_keyset_index.ts',
  '202607222900_publisher_receipt_retention.ts', '202607240100_publication_locators.ts',
  '202607242000_publication_snapshot_cursor_locator.ts', '202607242100_publication_directory_indexes.ts',
  '202607242200_public_profile_projection.ts', '202607250100_annotations.ts',
  '202607250200_annotation_product_read.ts', '202607250300_publication_annotation_projection.ts',
  '202607250400_relations.ts', '202607250500_relation_mutation_cascade.ts',
  '202607250600_relation_product_read.ts', '202607250700_publication_relation_projection.ts',
  '202607250800_saved_resources.ts', '202607250900_reading_progress.ts',
  '202607251000_postgres_search_baseline.ts', '202607251100_profile_annotation_search.ts',
  '202607251200_sync_replica_facts.ts', '202607251300_sync_replica_lifecycle.ts',
  '202607251400_sync_sessions.ts', '202607251500_sync_bootstrap_snapshots.ts',
  '202607251600_sync_sequence_lanes.ts', '202607251700_sync_node_create.ts',
  '202607251800_sync_node_revision_history.ts', '202607251900_sync_node_tombstones.ts',
  '202607252000_sync_conflicts.ts', '202607252100_sync_conflict_resolution.ts',
  '202607252200_sync_pull_stream.ts', '202607252300_sync_acknowledgements.ts',
  '202607252400_sync_tombstone_purge.ts', '202607252500_sync_snapshot_recovery.ts',
  '202607252600_sync_replica_retirement.ts',
  '202607252700_sync_operation_effects.ts',
] as const);
export const P3_26_REQUIRED_ROUTES = Object.freeze([
  'manifest', 'syncSessions', 'syncSnapshot', 'syncPush', 'syncConflict', 'syncPull', 'syncAck', 'syncRetire',
] as const);
export const P3_26_REQUIRED_PORTS = Object.freeze([
  'credentialVerifier', 'session', 'snapshot', 'sequence', 'canonicalMutation', 'conflict', 'pull', 'ack',
  'tombstonePurge', 'recovery', 'retire',
] as const);
export const P3_26_REQUIRED_PROBES = Object.freeze([
  'postgresConnectivity', 'productionMigrations', 'manifestDiscovery', 'runtimeComposition',
  'credentialAdapter', 'colpConformance', 'telemetryRedaction', 'artifactAtomicWrite',
] as const);
export const P3_26_SERVER_SYNC_SCENARIOS = Object.freeze([
  'manifest_session_snapshot', 'two_replica_concurrent_edit', 'offline_exact_retry_response_loss_restart',
  'sequence_gap_deferred', 'canonical_create_update_move_delete', 'typed_merge_open_conflict',
  'conflict_resolution_variants', 'pull_tuple_pagination_exact_retry', 'ack_monotonic',
  'tombstone_retention_ack_purge', 'stale_recovery_snapshot_bootstrap_ack',
  'retired_all_surfaces_rejected', 'unknown_extension_round_trip', 'managed_bookmark_role',
  'mounted_root_binding_isolation', 'registered_problem_internal_timeout_abort_retry_replay_concurrency',
  'telemetry_sentinel_redaction', 'manifest_sync_unclaimed',
] as const);
export const P3_26_TELEMETRY_ENDPOINTS = Object.freeze([
  'manifest', 'session', 'snapshot', 'push', 'conflict', 'pull', 'ack', 'purge', 'recovery', 'retire',
] as const);
export const P3_26_TELEMETRY_OUTCOMES = Object.freeze([
  'success', 'problem', 'internal', 'timeout', 'abort', 'retry', 'replay', 'concurrency',
] as const);

export type Phase3ServerSyncRoute = (typeof P3_26_REQUIRED_ROUTES)[number];
export type Phase3ServerSyncPort = (typeof P3_26_REQUIRED_PORTS)[number];
export type Phase3ServerSyncProbeName = (typeof P3_26_REQUIRED_PROBES)[number];
export type Phase3ServerSyncScenario = (typeof P3_26_SERVER_SYNC_SCENARIOS)[number];
export type Phase3ServerSyncOutcome = (typeof P3_26_TELEMETRY_OUTCOMES)[number];

export interface Phase3ServerSyncStepInput {
  readonly id: string;
  readonly scenario: Phase3ServerSyncScenario;
  readonly endpoint: { readonly key: string; readonly method: 'GET' | 'POST' | 'DELETE' | 'JOB'; readonly routeTemplate: string; readonly uriDigest: string };
  readonly outcome: Phase3ServerSyncOutcome;
  readonly problem: string | null;
  readonly transaction: string;
  readonly generationBefore: string | null;
  readonly generationAfter: string | null;
  readonly boundaryBefore: string | null;
  readonly boundaryAfter: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly counts: Readonly<Record<string, number>>;
}

export interface Phase3ServerSyncStepFact extends Phase3ServerSyncStepInput {
  readonly sequence: number;
  readonly runtimeNonce: string;
  readonly previousDigest: string;
  readonly digest: string;
}

export interface Phase3ServerSyncNegativeFact {
  readonly id: string;
  readonly targetKind: 'route' | 'port' | 'credential' | 'migration' | 'database' | 'artifact' | 'source' | 'colp' | 'config' | 'step';
  readonly target: string;
  readonly injection: string;
  readonly outcome: 'failed_closed';
  readonly observationDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface Phase3ServerSyncAcceptanceCandidate {
  readonly runnerVersion: string;
  readonly probeVersion: string;
  readonly source: { readonly commit: string; readonly treeDigest: string };
  readonly migrations: { readonly latest: string; readonly files: readonly string[]; readonly chainDigest: string };
  readonly colp: { readonly packageVersion: string; readonly packageDigest: string; readonly lockDigest: string; readonly conformanceDigest: string };
  readonly runtime: { readonly engine: 'postgresql'; readonly instanceId: string; readonly nonce: string; readonly configDigest: string; readonly startedAt: string; readonly finishedAt: string };
  readonly routes: readonly { readonly key: Phase3ServerSyncRoute; readonly method: 'GET' | 'POST' | 'DELETE'; readonly routeTemplate: string; readonly uriDigest: string; readonly discoveredAt: string }[];
  readonly ports: readonly { readonly name: Phase3ServerSyncPort; readonly source: 'runtime-composition' | 'database-observation' | 'http-observation'; readonly observationDigest: string; readonly observedAt: string }[];
  readonly probes: readonly { readonly name: Phase3ServerSyncProbeName; readonly outcome: 'passed'; readonly observationDigest: string; readonly startedAt: string; readonly finishedAt: string }[];
  readonly steps: readonly Phase3ServerSyncStepFact[];
  readonly stepCount: number;
  readonly negativeControls: readonly Phase3ServerSyncNegativeFact[];
  readonly telemetry: { readonly endpoints: readonly string[]; readonly outcomes: readonly string[]; readonly surfaces: readonly string[]; readonly sentinelDigest: string; readonly scannedBytes: number; readonly leaks: 0 };
  readonly profileClaimed: false;
  readonly deploymentProven: false;
}

export interface Phase3ServerSyncAcceptanceEvidence extends Phase3ServerSyncAcceptanceCandidate {
  readonly format: typeof PHASE3_SERVER_SYNC_ACCEPTANCE_FORMAT;
  readonly schemaVersion: typeof PHASE3_SERVER_SYNC_SCHEMA_VERSION;
  readonly accepted: true;
  readonly evidenceDigest: string;
}

export interface Phase3ServerSyncAcceptanceProbe { run(): Promise<Phase3ServerSyncAcceptanceCandidate> }
const issuedProbes = new WeakSet<object>();

export function createPhase3ServerSyncAcceptanceProbe(run: () => Promise<Phase3ServerSyncAcceptanceCandidate>): Phase3ServerSyncAcceptanceProbe {
  if (typeof run !== 'function') throw new TypeError('P3-26 acceptance requires a runner');
  const probe = Object.freeze({ run }); issuedProbes.add(probe); return probe;
}

export function appendPhase3ServerSyncStep(
  prior: readonly Phase3ServerSyncStepFact[], runtimeNonce: string, input: Phase3ServerSyncStepInput,
): readonly Phase3ServerSyncStepFact[] {
  requireRuntimeIdentity(runtimeNonce, 'runtime nonce');
  const sequence = prior.length + 1;
  const previousDigest = prior.at(-1)?.digest ?? '0'.repeat(64);
  const unsigned = { ...input, sequence, runtimeNonce, previousDigest };
  const digest = sha256(canonicalJson(unsigned));
  return Object.freeze([...prior, deepFreeze({ ...unsigned, digest })]);
}

export function validatePhase3ServerSyncStepChain(
  steps: readonly Phase3ServerSyncStepFact[], stepCount: number, runtimeNonce: string,
): void {
  validateSteps(steps, stepCount, runtimeNonce);
}

export function validatePhase3ServerSyncAcceptanceEvidence(candidate: Phase3ServerSyncAcceptanceCandidate): Phase3ServerSyncAcceptanceCandidate {
  if (!candidate || typeof candidate !== 'object') throw new TypeError('P3-26 evidence is missing');
  assertExactKeys(candidate, ['runnerVersion', 'probeVersion', 'source', 'migrations', 'colp', 'runtime', 'routes', 'ports', 'probes', 'steps', 'stepCount', 'negativeControls', 'telemetry', 'profileClaimed', 'deploymentProven']);
  if (candidate.runnerVersion !== PHASE3_SERVER_SYNC_RUNNER_VERSION || candidate.probeVersion !== PHASE3_SERVER_SYNC_PROBE_VERSION) throw new TypeError('P3-26 runner/probe version mismatch');
  if (!/^[0-9a-f]{40}$/u.test(candidate.source.commit)) throw new TypeError('P3-26 source commit is invalid');
  requireDigest('source tree', candidate.source.treeDigest);
  validateMigrations(candidate.migrations);
  if (!candidate.colp.packageVersion || candidate.colp.packageVersion.length > 64) throw new TypeError('P3-26 COLP package version is invalid');
  requireDigest('COLP package', candidate.colp.packageDigest); requireDigest('COLP lock', candidate.colp.lockDigest); requireDigest('COLP conformance', candidate.colp.conformanceDigest);
  if (candidate.runtime.engine !== 'postgresql') throw new TypeError('P3-26 requires PostgreSQL');
  requireRuntimeIdentity(candidate.runtime.instanceId, 'runtime instance'); requireRuntimeIdentity(candidate.runtime.nonce, 'runtime nonce'); requireDigest('runtime config', candidate.runtime.configDigest);
  requireTime(candidate.runtime.startedAt); requireTime(candidate.runtime.finishedAt);
  validateNamedFacts('route', P3_26_REQUIRED_ROUTES, candidate.routes, (fact) => fact.key);
  for (const route of candidate.routes) {
    if (route.routeTemplate.startsWith('manifest-discovered:') || route.routeTemplate.includes('{resourceId}')) throw new TypeError('P3-26 route placeholder evidence is forbidden');
    requireDigest(`route ${route.key} URI`, route.uriDigest); requireTime(route.discoveredAt);
  }
  validateNamedFacts('port', P3_26_REQUIRED_PORTS, candidate.ports, (fact) => fact.name);
  for (const port of candidate.ports) { requireDigest(`port ${port.name}`, port.observationDigest); requireTime(port.observedAt); }
  validateNamedFacts('probe', P3_26_REQUIRED_PROBES, candidate.probes, (fact) => fact.name);
  for (const probe of candidate.probes) { if (probe.outcome !== 'passed') throw new TypeError(`P3-26 probe ${probe.name} failed`); requireDigest(`probe ${probe.name}`, probe.observationDigest); requireTime(probe.startedAt); requireTime(probe.finishedAt); }
  validateSteps(candidate.steps, candidate.stepCount, candidate.runtime.nonce);
  validateNegativeControls(candidate.negativeControls, candidate.migrations.files);
  validateTelemetry(candidate.telemetry);
  if (candidate.profileClaimed !== false || candidate.deploymentProven !== false) throw new TypeError('P3-26 cannot claim the Sync Profile or Deployment-proven');
  return deepFreeze(candidate);
}

export async function runPhase3ServerSyncAcceptance(probe: Phase3ServerSyncAcceptanceProbe): Promise<Phase3ServerSyncAcceptanceEvidence> {
  if (!probe || typeof probe !== 'object' || !issuedProbes.has(probe)) throw new TypeError('Formal P3-26 acceptance requires the repository-owned probe constructor');
  const validated = validatePhase3ServerSyncAcceptanceEvidence(await probe.run());
  const unsigned = { format: PHASE3_SERVER_SYNC_ACCEPTANCE_FORMAT, schemaVersion: PHASE3_SERVER_SYNC_SCHEMA_VERSION, accepted: true as const, ...validated } as const;
  return deepFreeze({ ...unsigned, evidenceDigest: createHash('sha256').update(canonicalJson(unsigned)).digest('base64url') });
}

export function validatePhase3ServerSyncAcceptanceArtifact(value: Phase3ServerSyncAcceptanceEvidence): Phase3ServerSyncAcceptanceEvidence {
  if (!value || typeof value !== 'object') throw new TypeError('P3-26 artifact is missing');
  assertExactKeys(value, ['format', 'schemaVersion', 'accepted', 'runnerVersion', 'probeVersion', 'source',
    'migrations', 'colp', 'runtime', 'routes', 'ports', 'probes', 'steps', 'stepCount',
    'negativeControls', 'telemetry', 'profileClaimed', 'deploymentProven', 'evidenceDigest']);
  if (value.format !== PHASE3_SERVER_SYNC_ACCEPTANCE_FORMAT
      || value.schemaVersion !== PHASE3_SERVER_SYNC_SCHEMA_VERSION || value.accepted !== true) {
    throw new TypeError('P3-26 artifact format is invalid');
  }
  const { format, schemaVersion, accepted, evidenceDigest, ...candidate } = value;
  validatePhase3ServerSyncAcceptanceEvidence(candidate);
  const expected = createHash('sha256').update(canonicalJson({ format, schemaVersion, accepted, ...candidate })).digest('base64url');
  if (expected !== evidenceDigest) throw new TypeError('P3-26 evidence digest mismatch');
  return deepFreeze(value);
}

function validateMigrations(value: Phase3ServerSyncAcceptanceCandidate['migrations']): void {
  if (value.files.length < P3_26_PRODUCTION_MIGRATIONS.length
      || P3_26_PRODUCTION_MIGRATIONS.some((file) => !value.files.includes(file))
      || new Set(value.files).size !== value.files.length
      || [...value.files].sort().join('\0') !== value.files.join('\0')
      || value.files.at(-1) !== `${value.latest}.ts`) {
    throw new TypeError('P3-26 production migration list is incomplete or unordered');
  }
  for (const file of value.files) if (!/^\d+_[a-z0-9_]+\.ts$/u.test(file)) throw new TypeError('P3-26 migration filename is invalid');
  requireDigest('migration chain', value.chainDigest);
}

function validateSteps(steps: readonly Phase3ServerSyncStepFact[], count: number, nonce: string): void {
  if (count !== steps.length || count < P3_26_SERVER_SYNC_SCENARIOS.length) throw new TypeError('P3-26 step count is incomplete');
  let previous = '0'.repeat(64); let scenarioIndex = 0;
  for (const [index, step] of steps.entries()) {
    if (step.sequence !== index + 1) throw new TypeError('P3-26 step sequence is not continuous');
    if (step.runtimeNonce !== nonce) throw new TypeError('P3-26 step runtime nonce mismatch');
    if (step.previousDigest !== previous) throw new TypeError('P3-26 step previous digest mismatch');
    const { digest, ...unsigned } = step; requireDigest('step', digest);
    if (sha256(canonicalJson(unsigned)) !== digest) throw new TypeError('P3-26 step digest mismatch');
    requireDigest('step transaction', step.transaction); requireDigest('step URI', step.endpoint.uriDigest); requireTime(step.startedAt); requireTime(step.finishedAt);
    if (step.problem !== null && !Object.hasOwn(problemRegistry, step.problem)) throw new TypeError('P3-26 step problem is not registered');
    for (const value of Object.values(step.counts)) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('P3-26 step count is invalid');
    if (step.scenario === P3_26_SERVER_SYNC_SCENARIOS[scenarioIndex]) scenarioIndex += 1;
    previous = digest;
  }
  if (scenarioIndex !== P3_26_SERVER_SYNC_SCENARIOS.length) throw new TypeError('P3-26 scenario steps are missing or out of order');
}

function validateNegativeControls(controls: readonly Phase3ServerSyncNegativeFact[], migrations: readonly string[]): void {
  if (controls.length < 32) throw new TypeError('P3-26 negative control facts are incomplete');
  const ids = new Set<string>(); const targets = new Set(controls.map((fact) => `${fact.targetKind}:${fact.target}`));
  for (const fact of controls) {
    if (ids.has(fact.id)) throw new TypeError('P3-26 duplicate negative control'); ids.add(fact.id);
    if (fact.outcome !== 'failed_closed' || !fact.injection) throw new TypeError(`P3-26 negative control ${fact.id} did not fail closed`);
    requireDigest(`negative control ${fact.id}`, fact.observationDigest); requireTime(fact.startedAt); requireTime(fact.finishedAt);
  }
  for (const route of P3_26_REQUIRED_ROUTES) if (!targets.has(`route:${route}`)) throw new TypeError(`P3-26 negative control route ${route} is missing`);
  for (const port of P3_26_REQUIRED_PORTS) if (!targets.has(`port:${port}`)) throw new TypeError(`P3-26 negative control port ${port} is missing`);
  for (const migration of migrations) if (!targets.has(`migration:${migration}`)) throw new TypeError(`P3-26 negative control migration ${migration} is missing`);
  for (const [kind, target] of [['credential', 'adapter'], ['database', 'disconnect'], ['artifact', 'unwritable'], ['source', 'digest'], ['colp', 'digest'], ['config', 'digest'], ['step', 'omission']] as const) if (!targets.has(`${kind}:${target}`)) throw new TypeError(`P3-26 negative control ${kind}:${target} is missing`);
}

function validateTelemetry(value: Phase3ServerSyncAcceptanceCandidate['telemetry']): void {
  validateExactSet('telemetry endpoint', P3_26_TELEMETRY_ENDPOINTS, value.endpoints);
  validateExactSet('telemetry outcome', P3_26_TELEMETRY_OUTCOMES, value.outcomes);
  validateExactSet('telemetry scan surface', ['logs', 'traces', 'metrics', 'problems', 'artifact'], value.surfaces);
  requireDigest('telemetry sentinel', value.sentinelDigest);
  if (!Number.isSafeInteger(value.scannedBytes) || value.scannedBytes < 1 || value.leaks !== 0) throw new TypeError('P3-26 telemetry redaction scan found a leak or no scanned data');
}

function validateNamedFacts<Name extends string, Fact>(kind: string, required: readonly Name[], facts: readonly Fact[], name: (fact: Fact) => string): void {
  validateExactSet(kind, required, facts.map(name));
}
function validateExactSet(kind: string, required: readonly string[], actual: readonly string[]): void {
  if (actual.length !== required.length || new Set(actual).size !== actual.length || required.some((name) => !actual.includes(name))) throw new TypeError(`P3-26 ${kind} facts are incomplete`);
}
function assertExactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value); if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) throw new TypeError('P3-26 evidence contains missing or unexpected fields');
}
function requireDigest(name: string, value: string | undefined): void { if (!/^[0-9a-f]{64}$/u.test(value ?? '')) throw new TypeError(`P3-26 ${name} digest is invalid`); }
function requireRuntimeIdentity(value: string, name: string): void { if (!/^[A-Za-z0-9_-]{16,128}$/u.test(value)) throw new TypeError(`P3-26 ${name} is invalid`); }
function requireTime(value: string): void { if (!Number.isFinite(Date.parse(value))) throw new TypeError('P3-26 timestamp is invalid'); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function canonicalPhase3ServerSyncJson(value: unknown): string { return canonicalJson(value); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new TypeError('P3-26 evidence is not canonical JSON'); return encoded;
}
function deepFreeze<Value>(value: Value): Value { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
