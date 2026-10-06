/**
 * Golden Sync contract scenarios shared with browser-extension end-to-end suites.
 * Fixture: fixtures/kns-00-contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  SYNC_CREATE_FOLDER_ROLE_ALLOW_LIST,
  SYNC_CREATE_FOLDER_ROLE_CAPABILITY_GATED,
  SYNC_CREATE_FOLDER_ROLE_FORBIDDEN,
  SYNC_CREATE_FOLDER_ROLE_UNIQUE_LIVE,
  SYNC_RECOVERED_UNIQUE_BY_PARENT,
} from '../../src/sync/folder-role-contract.js';
import {
  fixtureIdentities,
  liveAndTombstoneOverlap,
  loadKns00FailClosedFixtures,
  loadKns00GoldenFixtures,
  loadKns00Index,
  type Kns00Fixture,
} from './kns-00-contract-loader.js';

const colpRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRED_GOLDEN_SCENARIOS = [
  'empty-collection',
  'existing-remote-tree',
  'both-sides-fork',
  'same-url-different-parent',
  'delete-plus-update',
  'parent-deleted',
  'two-root-mounts',
  'unselected-range',
  'server-receipt-loss',
  'node-restored',
  'two-mount-recovered',
  'concurrent-recovered-same-parent',
  'concurrent-same-role-mount',
  'native-create-after-scan',
  'native-rename-after-scan',
  'native-delete-after-scan',
  'remote-create-after-snapshot',
] as const;
const F15_REGISTRY_CODES = [
  'node_ancestry_unresolved',
  'dependency_failed',
  'revision_conflict',
  'sync_cursor_expired',
  'snapshot_expired',
  'payload_too_large',
  'rate_limited',
  'stale_replica',
  'replica_retired',
  'resource_purged',
  'node_read_only',
  'invalid_node_constraints',
  'invalid_document',
  'unsupported_operation',
] as const;

const evidence = '[evidence:sync.authoritative-pull-effects]';
const bootstrapEvidence = '[evidence:sync.session-bootstrap]';
const registry = createValidatorRegistry();

function exportRoundTrip(fixture: Kns00Fixture): Kns00Fixture {
  return JSON.parse(JSON.stringify(fixture)) as Kns00Fixture;
}

describe(`KNS-00 golden fixtures ${evidence}`, () => {
  const golden = loadKns00GoldenFixtures();
  const index = loadKns00Index();

  it(`exports JSON consumers can load without a parallel database ${evidence}`, () => {
    expect(index.contract).toBe('kns-00');
    expect(index.sessionBinding).toEqual({
      browserProfileId: 'profile-1',
      mountMode: 'whole-profile',
      mountNativeId: null,
      generation: '1',
    });
    expect(index.files).toEqual(['golden-scenarios.json', 'fail-closed.json']);
    const scenarios = golden.map((fixture) => fixture.scenario);
    expect(scenarios).toEqual(expect.arrayContaining([...REQUIRED_GOLDEN_SCENARIOS]));
    expect(JSON.stringify(golden)).not.toMatch(/nativeId/);
  });

  it.each(golden.map((fixture) => [fixture.fixtureId, fixture] as const))(
    'locks %s operation kind, identity, and terminal state after JSON round-trip',
    (_id, fixture) => {
      const decoded = exportRoundTrip(fixture);
      expect(decoded.operations.map((operation) => operation.type)).toEqual([...fixture.expectedOperationKinds]);
      expect([...fixtureIdentities(decoded)].sort()).toEqual([...fixture.expectedIdentities].sort());
      expect(decoded.terminal).toEqual(fixture.terminal);
      expect(liveAndTombstoneOverlap(decoded)).toEqual([]);
    },
  );

  it(`never auto-merges the same URL under different parents ${evidence}`, () => {
    const fixture = golden.find((row) => row.scenario === 'same-url-different-parent');
    expect(fixture).toBeDefined();
    expect(fixture!.invariants).toContain('same-url-different-parent-never-auto-merge');
    expect(fixture!.expectedOperationKinds.every((kind) => kind !== 'merge_node')).toBe(true);
    expect(fixture!.terminal.liveNodes).toHaveLength(2);
    expect(new Set(fixture!.terminal.liveNodes.map((node) => node.parentId)).size).toBe(2);
    expect(fixture!.terminal.localMatchReport?.candidates[0]?.kind).toBe('duplicate_candidate');
  });

  it(`keeps exactly one live folder per special role on concurrent mount create ${evidence}`, () => {
    const fixture = golden.find((row) => row.scenario === 'concurrent-same-role-mount');
    expect(fixture).toBeDefined();
    const liveBars = fixture!.terminal.liveNodes.filter((node) => node.folderRole === 'bookmarks-bar');
    expect(liveBars).toHaveLength(1);
    expect(fixture!.receipts?.[1]).toMatchObject({
      status: 'rebased',
      nodeId: liveBars[0]!.id,
      code: 'invalid_node_constraints',
    });
  });

  it(`does not upload reorder_children or expand it into move_node ${evidence}`, () => {
    const fixture = golden.find((row) => row.scenario === 'local-reorder-no-upload');
    expect(fixture).toBeDefined();
    expect(fixture!.operations).toHaveLength(0);
    expect(fixture!.expectedOperationKinds).toEqual([]);
    expect(fixture!.terminal.localDiagnostics?.some((row) => row.code === 'reorder_children_local_only')).toBe(true);
  });

  it(`treats unselected range as zero operations ${evidence}`, () => {
    const fixture = golden.find((row) => row.scenario === 'unselected-range');
    expect(fixture).toBeDefined();
    expect(fixture!.operations).toHaveLength(0);
    expect(fixture!.expectedOperationKinds).toEqual([]);
  });
});

describe(`KNS-00 restore / recovered / purge semantics ${evidence}`, () => {
  const golden = loadKns00GoldenFixtures();

  it('keeps the original id, issues a new revision, and excludes the tombstone', () => {
    const fixture = golden.find((row) => row.scenario === 'node-restored')!;
    const node = fixture.terminal.liveNodes.find((row) => row.id === 'bookmark-restored')!;
    expect(fixture.operations[0]?.type).toBe('restore_node');
    expect(fixture.operations[0]?.targetId).toBe('bookmark-restored');
    expect(node.revision).toBe('rev-restored-2');
    expect(node.revision).not.toBe('delete-rev-1');
    expect(fixture.terminal.tombstones).toEqual([]);
    expect(liveAndTombstoneOverlap(fixture)).toEqual([]);
    expect(fixture.effects?.[0]).toMatchObject({ kind: 'node_restored', nodeId: 'bookmark-restored' });
  });

  it('places restore into recovered when the original parent is gone [evidence:sync.restore-recovered-placement]', () => {
    const fixture = golden.find((row) => row.scenario === 'node-restored-recovered')!;
    const recovered = fixture.terminal.liveNodes.find((row) => row.folderRole === 'recovered');
    const restored = fixture.terminal.liveNodes.find((row) => row.id === 'bookmark-was-orphan');
    const bookmarksBar = fixture.terminal.liveNodes.find((row) => row.folderRole === 'bookmarks-bar');
    expect(recovered).toBeDefined();
    expect(restored?.parentId).toBe(recovered?.id);
    expect(restored?.parentId).not.toBe(bookmarksBar?.id);
  });

  it('keeps recovered unique per parent mount, not collection-wide [evidence:sync.recovered-unique-per-parent]', () => {
    const fixture = golden.find((row) => row.scenario === 'two-mount-recovered')!;
    const recovered = fixture.terminal.liveNodes.filter((row) => row.folderRole === 'recovered');
    expect(recovered).toHaveLength(2);
    expect(new Set(recovered.map((row) => row.parentId)).size).toBe(2);
    const conflict = golden.find((row) => row.scenario === 'concurrent-recovered-same-parent')!;
    const live = conflict.terminal.liveNodes.filter((row) => row.folderRole === 'recovered');
    expect(live).toHaveLength(1);
    expect(conflict.receipts?.[1]).toMatchObject({
      status: 'rebased',
      nodeId: live[0]!.id,
      code: 'invalid_node_constraints',
    });
  });

  it('maps purged restore to resource_purged', () => {
    const fixture = golden.find((row) => row.scenario === 'node-restored-purged')!;
    expect(fixture.terminal.problemCode).toBe('resource_purged');
    expect(fixture.receipts?.[0]).toMatchObject({ status: 'rejected', code: 'resource_purged' });
    expect(fixture.terminal.liveNodes).toEqual([]);
    expect(fixture.terminal.tombstones).toEqual([]);
  });

  it('Delete Dominates: live node is absent and the update is conflicted', () => {
    const fixture = golden.find((row) => row.scenario === 'delete-plus-update')!;
    expect(fixture.terminal.liveNodes).toEqual([]);
    expect(fixture.terminal.tombstones.map((row) => row.targetId)).toEqual(['bookmark-gone']);
    expect(fixture.receipts?.some((row) => row.status === 'conflicted' && row.code === 'revision_conflict')).toBe(true);
  });
});

describe(`KNS-00 bootstrapMode and folderRole contract ${bootstrapEvidence}`, () => {
  it('accepts the closed bootstrapMode enum and treats merge as client-driven', () => {
    const replica = {
      replicaId: 'replica-chrome-1',
      name: 'Chrome on Alice laptop',
      kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: {
        read: true, write: true, events: true, separator: false, alias: false,
        annotations: 'sidecar', maxBatchOperations: 200,
      },
      binding: {
        browserProfileId: 'profile-hmac-1',
        mountMode: 'whole-profile',
        mountNativeId: null,
        generation: 'generation-7',
      },
    };
    for (const bootstrapMode of ['download', 'upload', 'merge', 'mirror'] as const) {
      expect(registry.validate('syncSessionRequest', {
        protocolVersion: '0.1', replica,
        scope: 'collection',
        collection: { collectionId: 'collection-1', lastCursor: null, lastRevision: null, bootstrapMode },
        clientTime: '2026-07-27T00:00:00Z',
      }).valid).toBe(true);
    }
    expect(registry.validate('syncSessionRequest', {
      protocolVersion: '0.1', replica,
      scope: 'collection',
      collection: { collectionId: 'collection-1', lastCursor: null, lastRevision: null, bootstrapMode: 'invented' },
      clientTime: '2026-07-27T00:00:00Z',
    }).valid).toBe(false);
    const mergeFixture = loadKns00GoldenFixtures().find((row) => row.scenario === 'bootstrap-merge-client-driven')!;
    expect(mergeFixture.bootstrapMode).toBe('merge');
    expect(mergeFixture.expectedOperationKinds).toEqual(['create_node']);
  });

  it('freezes the Sync create folderRole allow-list spellings', () => {
    expect([...SYNC_CREATE_FOLDER_ROLE_ALLOW_LIST]).toEqual([
      'bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks', 'custom', 'recovered',
    ]);
    expect([...SYNC_CREATE_FOLDER_ROLE_CAPABILITY_GATED]).toEqual(['managed-bookmarks']);
    expect([...SYNC_CREATE_FOLDER_ROLE_FORBIDDEN]).toEqual(['root', 'archive', 'inbox']);
    expect([...SYNC_CREATE_FOLDER_ROLE_UNIQUE_LIVE]).toEqual([
      'bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks',
    ]);
    expect(SYNC_RECOVERED_UNIQUE_BY_PARENT).toBe(true);
  });

  it('keeps node_restored in the generated 0.2 effect union', () => {
    const generated = readFileSync(join(colpRoot, 'src/types/generated.ts'), 'utf8');
    expect(generated).toMatch(/kind: 'node_restored'/);
    expect(generated).toMatch(/SubtreeDeletedEffect \| NodeRestoredEffect/);
    expect(generated).toMatch(/type: 'restore_node'/);
  });

  it('maps KNS-00 scenarios only onto existing 09-problem-registry codes', () => {
    const registry = readFileSync(
      join(colpRoot, '../../protocol/docs/09-problem-registry.md'),
      'utf8',
    );
    for (const code of F15_REGISTRY_CODES) {
      expect(registry).toContain(`\`${code}\``);
    }
    expect(registry).not.toContain('`duplicate_candidate`');
    expect(registry).not.toContain('`reorder_children_local_only`');
  });
});

describe(`KNS-00 fail-closed contract ${evidence}`, () => {
  it.each(loadKns00FailClosedFixtures().map((fixture) => [fixture.scenario, fixture] as const))(
    'rejects %s without applying a live mutation',
    (_scenario, fixture) => {
      expect(fixture.terminal.liveNodes).toEqual([]);
      expect(fixture.terminal.problemCode).toBeDefined();
      expect(fixture.invariants).toContain('fail-closed');
      if (fixture.scenario === 'unknown-kind') {
        expect(registry.validate('operation', fixture.operations[0]).valid).toBe(false);
      }
      if (fixture.scenario === 'missing-fields') {
        expect(registry.validate('operation', fixture.operations[0]).valid).toBe(false);
      }
      expect(['invalid_document', 'unsupported_operation', 'sync_cursor_expired', 'stale_replica'])
        .toContain(fixture.terminal.problemCode);
    },
  );
});
