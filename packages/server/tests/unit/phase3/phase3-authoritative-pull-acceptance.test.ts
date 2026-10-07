import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  P3_32C_NEGATIVE_CONTROLS,
  P3_32C_REQUIRED_EFFECTS,
  canonicalPhase3AuthoritativePullProjectionDigest,
  validatePhase3AuthoritativePullEvidence,
  type Phase3AuthoritativePullEvidence,
} from '../../../scripts/acceptance/phase3-authoritative-pull-acceptance.js';
import { assertProjectionMatchesPublicSnapshot,
  projectionFromPublicSnapshot } from '../../../scripts/phase3-authoritative-pull-client.js';
import { resolvePhase3AuthoritativePullScenarioModule } from '../../../scripts/phase3-authoritative-pull-acceptance-adapter.js';

describe('P3-32C authoritative Pull black-box acceptance contract', () => {
  test('requires every authoritative mutation and recovery path', () => {
    assert.deepEqual(P3_32C_REQUIRED_EFFECTS, [
      'create', 'clean_update', 'rebased_update', 'same_parent_move',
      'cross_parent_move', 'single_delete', 'inline_subtree_delete',
      'paged_subtree_delete', 'conflict_not_applied', 'snapshot_cutover',
      'protocol_0_1_compatibility',
    ]);
  });

  test('requires the complete fail-closed matrix', () => {
    for (const id of [
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
    ]) assert.equal(P3_32C_NEGATIVE_CONTROLS.includes(id), true, id);
  });

  test('rejects missing scenarios, shared Replica identity, cursor coupling and forged facts', () => {
    const valid = candidate();
    assert.doesNotThrow(() => validatePhase3AuthoritativePullEvidence(valid));
    assert.throws(() => validatePhase3AuthoritativePullEvidence({
      ...valid, effects: valid.effects.slice(1),
    }), /effect|scenario/iu);
    assert.throws(() => validatePhase3AuthoritativePullEvidence({
      ...valid, replicas: [valid.replicas[0]!, valid.replicas[0]!],
    }), /Replica/iu);
    assert.throws(() => validatePhase3AuthoritativePullEvidence({
      ...valid, immutableDelete: { ...valid.immutableDelete, receiverEventCursorsDiffer: false },
    }), /cursor/iu);
    assert.throws(() => validatePhase3AuthoritativePullEvidence({
      ...valid,
      effects: valid.effects.map((effect) => effect.scenario === 'paged_subtree_delete'
        ? { ...effect, pageCount: 1 }
        : effect),
    }), /multiple effect pages|paged subtree/iu);
    assert.throws(() => validatePhase3AuthoritativePullEvidence({
      ...valid, projectionDigest: '0'.repeat(64),
    }), /projection/iu);
  });

  test('uses the public Snapshot sync cursor as the projection recovery boundary', () => {
    const projection = projectionFromPublicSnapshot({
      mode: 'sync', collection: { id: 'collection-1' }, nodes: [],
      syncCursor: 'snapshot-cursor-1',
    } as never);
    assert.equal(projection.cursor, 'snapshot-cursor-1');
  });

  test('initializes COLP 0.2 parent revision authority from the public Snapshot', () => {
    const projection = projectionFromPublicSnapshot({
      protocolVersion: '0.2', mode: 'sync', collection: { id: 'collection-1' }, nodes: [],
      parentRevisions: [{ parentId: 'root-1', childrenRevision: 'children-r7' }],
      syncCursor: 'snapshot-cursor-1',
    } as never);
    assert.equal(projection.parentRevisions.get('root-1'), 'children-r7');
  });

  test('compares every reconstructible parent field while excluding its untransmitted timestamp', () => {
    const node = { id: 'root-1', collectionId: 'collection-1', kind: 'root', parentId: null,
      position: null, folderRole: 'root', title: 'Root', createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z', revision: 'root-r1' };
    const projection = { ...projectionFromPublicSnapshot({ mode: 'sync', collection: {
      id: 'collection-1' }, nodes: [node], syncCursor: 'cursor-1' } as never),
    parentRevisions: new Map([['root-1', 'children-r2']]) };
    const changedTimestamp = { mode: 'sync', collection: { id: 'collection-1' },
      nodes: [{ ...node, updatedAt: '2026-07-27T00:00:01.000Z' }] } as never;
    assert.doesNotThrow(() => assertProjectionMatchesPublicSnapshot(projection, changedTimestamp));
    assert.throws(() => assertProjectionMatchesPublicSnapshot(projection, {
      ...changedTimestamp, nodes: [{ ...node, title: 'Changed' }],
    } as never), /does not match/iu);
  });

  test('defaults to the repository-owned production scenario without an environment variable', () => {
    assert.match(resolvePhase3AuthoritativePullScenarioModule({}),
      /phase3-authoritative-pull-production-scenario\.ts$/u);
    assert.throws(() => resolvePhase3AuthoritativePullScenarioModule({
      KNOWN_P3_32C_SCENARIO_MODULE: './fixture.ts',
    }), /explicit fail-closed tests/iu);
    assert.match(resolvePhase3AuthoritativePullScenarioModule({ NODE_ENV: 'test',
      KNOWN_P3_32C_ALLOW_TEST_SCENARIO: 'true',
      KNOWN_P3_32C_SCENARIO_MODULE: './fixture.ts' }), /fixture\.ts$/u);
  });

  test('requires request/response-derived proof and declared database preparation for every control', () => {
    const valid = candidate();
    assert.doesNotThrow(() => validatePhase3AuthoritativePullEvidence(valid));
    assert.throws(() => validatePhase3AuthoritativePullEvidence({
      ...valid,
      negativeControls: valid.negativeControls.map((control, index) => index === 0
        ? { ...control, proof: { ...control.proof, clientOutcome: 'accepted' as never } }
        : control),
    }), /negative control|response/iu);
    assert.throws(() => validatePhase3AuthoritativePullEvidence({
      ...valid,
      negativeControls: valid.negativeControls.map((control, index) => index === 0
        ? { ...control, preparation: 'oracle_read' as never }
        : control),
    }), /preparation|oracle/iu);
    assert.throws(() => validatePhase3AuthoritativePullEvidence({
      ...valid,
      negativeControls: valid.negativeControls.map((control, index) => index === 1
        ? { ...control, proof: { ...control.proof,
          requestOrdinal: valid.negativeControls[0]!.proof.requestOrdinal } }
        : control),
    }), /duplicated|reordered/iu);
  });
});

function candidate(): Phase3AuthoritativePullEvidence {
  const value = {
    format: 'known.phase3.authoritative-pull-acceptance.v1', schemaVersion: 1,
    accepted: true, profileClaimed: false, deploymentProven: false,
    protocolVersions: ['0.1', '0.2'], transport: 'tls',
    replicas: [
      { replicaIdDigest: '1'.repeat(64), clientStateDigest: '2'.repeat(64) },
      { replicaIdDigest: '3'.repeat(64), clientStateDigest: '4'.repeat(64) },
    ],
    effects: P3_32C_REQUIRED_EFFECTS.map((scenario, index) => ({
      scenario, eventCount: 1, pageCount: scenario === 'paged_subtree_delete' ? 2 : 0,
      publicProjectionDigest: String(index + 1).padStart(64, 'a').slice(-64),
      publicSnapshotDigest: String(index + 1).padStart(64, 'b').slice(-64),
      matched: true as const,
    })),
    negativeControls: P3_32C_NEGATIVE_CONTROLS.map((id, index) => ({
      id, outcome: 'failed_closed' as const,
      preparation: 'none' as const,
      proof: {
        transport: 'https' as const, requestOrdinal: index + 1, method: 'GET' as const, clientOutcome: 'rejected' as const,
        urlDigest: '6'.repeat(64), requestHeadersDigest: '7'.repeat(64), requestBodyDigest: '8'.repeat(64),
        response: { status: 400, headersDigest: '9'.repeat(64), bodyDigest: 'a'.repeat(64) },
      },
    })),
    immutableDelete: {
      effectDigest: '5'.repeat(64), receiverEventCursorsDiffer: true,
      receiverOneVerified: true, receiverTwoVerified: true,
      deleteCursorStable: true,
    },
    ordering: { stable: true, paged: true, cursorContinued: true, byteAware: true },
    redaction: { leaks: 0 },
  } as Omit<Phase3AuthoritativePullEvidence, 'projectionDigest'>;
  return { ...value, projectionDigest: canonicalPhase3AuthoritativePullProjectionDigest(value) };
}
