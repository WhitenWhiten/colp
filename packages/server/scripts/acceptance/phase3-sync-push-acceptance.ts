import { createHash } from 'node:crypto';

export const P3_16_PUSH_ACCEPTANCE_SCENARIOS = Object.freeze([
  'create_folder', 'create_bookmark', 'create_separator', 'typed_update', 'move', 'delete',
  'terminal_exact_replay', 'deferred_exact_replay', 'deferred_recovery',
  'deferred_digest_reuse_rejected', 'sequence_gap', 'sequence_blocked',
  'receipt_missing_fail_closed', 'restart_replay', 'independent_replica_scope',
  'cross_scope_op_id_rejected', 'database_timeout', 'database_deadlock',
  'commit_outcome_unknown_same_request', 'field_exact_replay',
  'single_sequence_owner', 'manifest_sync_unclaimed',
] as const);

export type Phase3SyncPushAcceptanceScenario =
  (typeof P3_16_PUSH_ACCEPTANCE_SCENARIOS)[number];

export interface Phase3SyncPushAcceptanceCandidate {
  readonly sourceCommit: string;
  readonly sourceTreeDigest: string;
  readonly migration: string;
  readonly profileClaimed: false;
  readonly deploymentProven: false;
  readonly runtimeRouteDiscovered: boolean;
  readonly sequenceOwner?: 'sequence';
  readonly maxBatchOperations?: 1;
  readonly scenarios: Readonly<Partial<Record<Phase3SyncPushAcceptanceScenario, boolean>>>;
}

export interface Phase3SyncPushAcceptanceEvidence extends Phase3SyncPushAcceptanceCandidate {
  readonly accepted: true;
  readonly sequenceOwner: 'sequence';
  readonly maxBatchOperations: 1;
  readonly scenarios: Readonly<Record<Phase3SyncPushAcceptanceScenario, true>>;
  readonly evidenceDigest: string;
}

export interface Phase3SyncPushAcceptanceProbe {
  run(): Promise<Phase3SyncPushAcceptanceCandidate>;
}

export interface Phase3SyncPushScenarioRecord {
  readonly scenario: Phase3SyncPushAcceptanceScenario;
  readonly nonce: string;
  readonly boundary: 'real_http_postgres';
}

const issuedProbes = new WeakSet<object>();

export function createPhase3SyncPushAcceptanceProbe(
  run: () => Promise<Phase3SyncPushAcceptanceCandidate>,
): Phase3SyncPushAcceptanceProbe {
  if (typeof run !== 'function') throw new TypeError('P3-16 acceptance probe requires a runner');
  const probe = Object.freeze({ run });
  issuedProbes.add(probe);
  return probe;
}

export function validatePhase3SyncPushAcceptanceEvidence(
  candidate: Phase3SyncPushAcceptanceCandidate,
): Omit<Phase3SyncPushAcceptanceEvidence, 'accepted' | 'evidenceDigest'> {
  if (!candidate || typeof candidate !== 'object') throw new TypeError('P3-16 evidence is missing');
  if (!/^[0-9a-f]{40}$/u.test(candidate.sourceCommit)) {
    throw new TypeError('P3-16 evidence source commit is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(candidate.sourceTreeDigest)) {
    throw new TypeError('P3-16 evidence source tree digest is invalid');
  }
  if (candidate.migration !== '202607251900_sync_node_tombstones') {
    throw new TypeError('P3-16 production migration evidence is missing');
  }
  if (candidate.profileClaimed !== false || candidate.deploymentProven !== false) {
    throw new TypeError('P3-16 cannot claim sync or Deployment-proven');
  }
  if (candidate.runtimeRouteDiscovered !== true) {
    throw new TypeError('P3-16 mounted runtime route evidence is missing');
  }
  if (candidate.sequenceOwner !== 'sequence' || candidate.maxBatchOperations !== 1) {
    throw new TypeError('P3-16 unique Sequence ownership evidence is missing');
  }
  const scenarios = Object.fromEntries(P3_16_PUSH_ACCEPTANCE_SCENARIOS.map((scenario) => {
    if (candidate.scenarios[scenario] !== true) {
      throw new TypeError(`P3-16 scenario ${scenario} is missing or failed`);
    }
    return [scenario, true] as const;
  })) as Record<Phase3SyncPushAcceptanceScenario, true>;
  return deepFreeze({
    sourceCommit: candidate.sourceCommit,
    sourceTreeDigest: candidate.sourceTreeDigest,
    migration: candidate.migration,
    profileClaimed: false as const,
    deploymentProven: false as const,
    runtimeRouteDiscovered: true,
    sequenceOwner: 'sequence' as const,
    maxBatchOperations: 1 as const,
    scenarios,
  });
}

export function collectPhase3SyncPushScenarioEvidence(
  records: readonly Phase3SyncPushScenarioRecord[],
  nonce: string,
): Readonly<Record<Phase3SyncPushAcceptanceScenario, true>> {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
    throw new TypeError('P3-16 scenario evidence nonce is invalid');
  }
  const observed = new Set<Phase3SyncPushAcceptanceScenario>();
  for (const record of records) {
    if (record.nonce !== nonce) throw new TypeError('P3-16 scenario evidence nonce mismatch');
    if (record.boundary !== 'real_http_postgres') {
      throw new TypeError('P3-16 scenario evidence boundary is not real HTTP/PostgreSQL');
    }
    if (!P3_16_PUSH_ACCEPTANCE_SCENARIOS.includes(record.scenario)) {
      throw new TypeError('P3-16 scenario evidence contains an unknown scenario');
    }
    observed.add(record.scenario);
  }
  return deepFreeze(Object.fromEntries(P3_16_PUSH_ACCEPTANCE_SCENARIOS.map((scenario) => {
    if (!observed.has(scenario)) throw new TypeError(`P3-16 scenario ${scenario} evidence is missing`);
    return [scenario, true] as const;
  })) as Record<Phase3SyncPushAcceptanceScenario, true>);
}

export async function runPhase3SyncPushAcceptance(
  probe: Phase3SyncPushAcceptanceProbe,
): Promise<Phase3SyncPushAcceptanceEvidence> {
  if (!probe || typeof probe !== 'object' || !issuedProbes.has(probe)) {
    throw new TypeError('formal P3-16 acceptance requires the repo-owned probe constructor');
  }
  const validated = validatePhase3SyncPushAcceptanceEvidence(await probe.run());
  const unsigned = { accepted: true as const, ...validated };
  return deepFreeze({
    ...unsigned,
    evidenceDigest: createHash('sha256').update(JSON.stringify(unsigned)).digest('base64url'),
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
