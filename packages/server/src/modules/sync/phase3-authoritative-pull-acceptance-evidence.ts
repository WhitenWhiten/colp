/**
 * P3-32C authoritative-pull acceptance evidence types and validators.
 * Owned here so `modules/sync` does not import acceptance runners.
 * `scripts/acceptance` re-exports this file for existing script/test importers.
 */
import { createHash } from 'node:crypto';

export const PHASE3_AUTHORITATIVE_PULL_ACCEPTANCE_FORMAT =
  'known.phase3.authoritative-pull-acceptance.v1' as const;

export const P3_32C_REQUIRED_EFFECTS = Object.freeze([
  'create', 'clean_update', 'rebased_update', 'same_parent_move',
  'cross_parent_move', 'single_delete', 'inline_subtree_delete',
  'paged_subtree_delete', 'conflict_not_applied', 'snapshot_cutover',
  'protocol_0_1_compatibility',
] as const);

export const P3_32C_NEGATIVE_CONTROLS = Object.freeze([
  'missing_kind', 'wrong_status', 'wrong_op_id', 'wrong_replica_id',
  'wrong_sequence', 'wrong_collection_id', 'wrong_target', 'wrong_revision',
  'missing_content', 'wrong_placement', 'wrong_parent_revision',
  'wrong_member_count', 'wrong_member_digest', 'wrong_page_digest',
  'wrong_page_chain', 'cross_collection', 'cross_replica', 'cross_account',
  'expired_session', 'wrong_session', 'wrong_credential', 'wrong_origin',
  'non_tls', 'effect_page_404', 'effect_page_401',
  'duplicate_event', 'out_of_order_event', 'truncated_page',
  'oversize_page', 'tampered_effect', 'private_conflict_redaction',
  'credential_redaction', 'internal_error_redaction', 'tenant_redaction',
] as const);

export type Phase3AuthoritativePullEffectScenario = typeof P3_32C_REQUIRED_EFFECTS[number];
export type Phase3AuthoritativePullNegativeControl = typeof P3_32C_NEGATIVE_CONTROLS[number];

export interface Phase3AuthoritativePullHttpProof {
  readonly transport: 'https';
  readonly requestOrdinal: number;
  readonly method: 'GET' | 'POST';
  readonly urlDigest: string;
  readonly requestHeadersDigest: string;
  readonly requestBodyDigest: string;
  readonly clientOutcome: 'rejected';
  readonly response: {
    readonly status: number;
    readonly headersDigest: string;
    readonly bodyDigest: string;
  };
}

export interface Phase3AuthoritativePullEvidence {
  readonly format: typeof PHASE3_AUTHORITATIVE_PULL_ACCEPTANCE_FORMAT;
  readonly schemaVersion: 1;
  readonly accepted: true;
  readonly profileClaimed: false;
  readonly deploymentProven: false;
  readonly protocolVersions: readonly ['0.1', '0.2'];
  readonly transport: 'tls';
  readonly replicas: readonly [
    { readonly replicaIdDigest: string; readonly clientStateDigest: string },
    { readonly replicaIdDigest: string; readonly clientStateDigest: string },
  ];
  readonly effects: readonly {
    readonly scenario: Phase3AuthoritativePullEffectScenario;
    readonly eventCount: number;
    readonly pageCount: number;
    readonly publicProjectionDigest: string;
    readonly publicSnapshotDigest: string;
    readonly matched: true;
  }[];
  readonly negativeControls: readonly {
    readonly id: Phase3AuthoritativePullNegativeControl;
    readonly outcome: 'failed_closed';
    readonly preparation: 'none' | 'fixture_seed' | 'fault_injection' | 'tamper_injection' | 'mutation_count';
    readonly proof: Phase3AuthoritativePullHttpProof;
  }[];
  readonly immutableDelete: {
    readonly effectDigest: string;
    readonly receiverEventCursorsDiffer: true;
    readonly receiverOneVerified: true;
    readonly receiverTwoVerified: true;
    readonly deleteCursorStable: true;
  };
  readonly ordering: {
    readonly stable: true;
    readonly paged: true;
    readonly cursorContinued: true;
    readonly byteAware: true;
  };
  readonly redaction: { readonly leaks: 0 };
  readonly projectionDigest: string;
}

export interface Phase3AuthoritativePullAcceptanceProbe {
  readonly run: () => Promise<Phase3AuthoritativePullEvidence>;
}

export function createPhase3AuthoritativePullAcceptanceProbe(
  run: () => Promise<Phase3AuthoritativePullEvidence>,
): Phase3AuthoritativePullAcceptanceProbe {
  if (typeof run !== 'function') throw new TypeError('P3-32C probe must be callable');
  return Object.freeze({ run });
}

export async function runPhase3AuthoritativePullAcceptance(
  probe: Phase3AuthoritativePullAcceptanceProbe,
): Promise<Phase3AuthoritativePullEvidence> {
  if (typeof probe?.run !== 'function') throw new TypeError('P3-32C probe is unavailable');
  return validatePhase3AuthoritativePullEvidence(await probe.run());
}

export function canonicalPhase3AuthoritativePullProjectionDigest(
  value: Omit<Phase3AuthoritativePullEvidence, 'projectionDigest'>,
): string {
  return createHash('sha256')
    .update('known.p3-32c.public-projection.v1\0')
    .update(canonicalJson(value))
    .digest('hex');
}

export function validatePhase3AuthoritativePullEvidence(
  candidate: Phase3AuthoritativePullEvidence,
): Phase3AuthoritativePullEvidence {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('P3-32C evidence must be an object');
  }
  if (candidate.format !== PHASE3_AUTHORITATIVE_PULL_ACCEPTANCE_FORMAT
      || candidate.schemaVersion !== 1 || candidate.accepted !== true
      || candidate.profileClaimed !== false || candidate.deploymentProven !== false) {
    throw new TypeError('P3-32C evidence identity or claim is invalid');
  }
  if (candidate.transport !== 'tls'
      || candidate.protocolVersions.length !== 2
      || candidate.protocolVersions[0] !== '0.1'
      || candidate.protocolVersions[1] !== '0.2') {
    throw new TypeError('P3-32C requires TLS and exact N/N-1 protocol evidence');
  }
  if (candidate.replicas.length !== 2
      || candidate.replicas[0].replicaIdDigest === candidate.replicas[1].replicaIdDigest
      || candidate.replicas[0].clientStateDigest === candidate.replicas[1].clientStateDigest) {
    throw new TypeError('P3-32C requires two genuinely independent Replica clients');
  }
  for (const replica of candidate.replicas) {
    assertDigest(replica.replicaIdDigest, 'Replica identity');
    assertDigest(replica.clientStateDigest, 'Replica client state');
  }
  assertExactOrderedSet(candidate.effects.map((effect) => effect.scenario), P3_32C_REQUIRED_EFFECTS, 'effect scenario');
  for (const effect of candidate.effects) {
    if (!Number.isSafeInteger(effect.eventCount) || effect.eventCount < 1
        || !Number.isSafeInteger(effect.pageCount) || effect.pageCount < 0
        || effect.matched !== true) throw new TypeError(`P3-32C effect ${effect.scenario} is incomplete`);
    assertDigest(effect.publicProjectionDigest, `${effect.scenario} projection`);
    assertDigest(effect.publicSnapshotDigest, `${effect.scenario} Snapshot`);
  }
  const pagedSubtree = candidate.effects.find((effect) => effect.scenario === 'paged_subtree_delete');
  if (!pagedSubtree || pagedSubtree.pageCount < 2) {
    throw new TypeError('P3-32C paged subtree evidence did not traverse multiple effect pages');
  }
  assertExactOrderedSet(candidate.negativeControls.map((control) => control.id), P3_32C_NEGATIVE_CONTROLS, 'negative control');
  if (candidate.negativeControls.some((control) => control.outcome !== 'failed_closed')) {
    throw new TypeError('P3-32C negative control did not fail closed');
  }
  let previousRequestOrdinal = 0;
  for (const control of candidate.negativeControls) {
    if (!['none', 'fixture_seed', 'fault_injection', 'tamper_injection', 'mutation_count']
      .includes(control.preparation)) {
      throw new TypeError(`P3-32C negative control ${control.id} uses an undeclared database oracle preparation`);
    }
    const proof = control.proof;
    if (proof?.transport !== 'https' || !Number.isSafeInteger(proof.requestOrdinal)
        || proof.requestOrdinal < 1 || !['GET', 'POST'].includes(proof.method)
        || proof.clientOutcome !== 'rejected'
        || !Number.isSafeInteger(proof.response?.status)
        || (proof.response.status !== 0 && (proof.response.status < 100 || proof.response.status > 599))) {
      throw new TypeError(`P3-32C negative control ${control.id} lacks a failed HTTPS request/response proof`);
    }
    if (proof.requestOrdinal <= previousRequestOrdinal) {
      throw new TypeError('P3-32C negative-control HTTP proofs are duplicated or reordered');
    }
    previousRequestOrdinal = proof.requestOrdinal;
    for (const [value, label] of [[proof.urlDigest, 'URL'],
      [proof.requestHeadersDigest, 'request headers'], [proof.requestBodyDigest, 'request body'],
      [proof.response.headersDigest, 'response headers'], [proof.response.bodyDigest, 'response body']] as const) {
      assertDigest(value, `${control.id} ${label}`);
    }
  }
  assertDigest(candidate.immutableDelete.effectDigest, 'immutable delete effect');
  if (!candidate.immutableDelete.receiverEventCursorsDiffer
      || !candidate.immutableDelete.receiverOneVerified
      || !candidate.immutableDelete.receiverTwoVerified
      || !candidate.immutableDelete.deleteCursorStable) {
    throw new TypeError('P3-32C immutable delete cursor evidence is invalid');
  }
  if (!candidate.ordering.stable || !candidate.ordering.paged
      || !candidate.ordering.cursorContinued || !candidate.ordering.byteAware) {
    throw new TypeError('P3-32C ordering/page evidence is incomplete');
  }
  if (candidate.redaction.leaks !== 0) throw new TypeError('P3-32C evidence contains a leak');
  const { projectionDigest, ...unsigned } = candidate;
  assertDigest(projectionDigest, 'P3-32C projection');
  if (projectionDigest !== canonicalPhase3AuthoritativePullProjectionDigest(unsigned)) {
    throw new TypeError('P3-32C projection digest is stale or forged');
  }
  return Object.freeze(candidate);
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${label} digest is invalid`);
}

function assertExactOrderedSet(
  actual: readonly string[], expected: readonly string[], label: string,
): void {
  if (actual.length !== expected.length
      || actual.some((value, index) => value !== expected[index])) {
    throw new TypeError(`P3-32C ${label} evidence is missing, reordered, or duplicated`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('P3-32C evidence contains non-JSON data');
  return encoded;
}
