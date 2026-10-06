import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assembleSnapshotPages, validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot, StrictNode } from '../../src/types/index.js';

const deferredContext = { referenceResolution: { mode: 'deferred' as const } };

const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'sync-snapshot.json',
);

async function completeSnapshot(): Promise<Snapshot> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Snapshot;
}

function issueCodes(result: ReturnType<typeof validateSnapshotSemantics>): string[] {
  return result.valid ? [] : result.issues.map((issue) => issue.code);
}

function issuePaths(result: ReturnType<typeof validateSnapshotSemantics>): string[] {
  return result.valid ? [] : result.issues.map((issue) => issue.path);
}

describe('complete Snapshot root contract', () => {
  it('accepts exactly one root identified by collection.rootNodeId [evidence:semantic.snapshot.root]', async () => {
    const snapshot = await completeSnapshot();

    expect(snapshot.nodes.filter((node) => node.kind === 'root')).toHaveLength(1);
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('rejects a complete Snapshot with zero roots [evidence:semantic.snapshot.root]', async () => {
    const snapshot = await completeSnapshot();
    snapshot.nodes = snapshot.nodes.filter((node) => node.kind !== 'root');

    const result = validateSnapshotSemantics(snapshot);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain('invalid_root_count');
    expect(issuePaths(result)).toContain('/nodes');
    expect(issueCodes(result)).not.toContain('root_id_mismatch');
  });

  it('rejects a complete Snapshot with multiple roots [evidence:semantic.snapshot.root]', async () => {
    const snapshot = await completeSnapshot();
    const root = snapshot.nodes.find((node) => node.kind === 'root') as StrictNode;
    snapshot.nodes.push({ ...root, id: 'second-root' });

    const result = validateSnapshotSemantics(snapshot);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain('invalid_root_count');
    expect(issuePaths(result)).toContain('/nodes');
    expect(issueCodes(result)).not.toContain('root_id_mismatch');
  });

  it('rejects collection.rootNodeId targeting a non-root node [evidence:semantic.snapshot.root]', async () => {
    const snapshot = await completeSnapshot();
    const nonRoot = snapshot.nodes.find((node) => node.kind !== 'root');
    if (nonRoot === undefined) throw new Error('fixture must contain a non-root node');
    snapshot.collection.rootNodeId = nonRoot.id;

    const result = validateSnapshotSemantics(snapshot);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain('root_id_mismatch');
    expect(issuePaths(result)).toContain('/collection/rootNodeId');
    expect(issueCodes(result)).not.toContain('invalid_root_count');
  });

  it('rejects collection.rootNodeId targeting a missing node [evidence:semantic.snapshot.root]', async () => {
    const snapshot = await completeSnapshot();
    snapshot.collection.rootNodeId = 'missing-root';

    const result = validateSnapshotSemantics(snapshot);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain('root_id_mismatch');
    expect(issuePaths(result)).toContain('/collection/rootNodeId');
    expect(issueCodes(result)).not.toContain('invalid_root_count');
  });

  it('does not apply the complete root invariant to a cropped Snapshot [evidence:semantic.snapshot.root]', async () => {
    const snapshot = await completeSnapshot();
    const root = snapshot.nodes.find((node) => node.kind === 'root') as StrictNode;
    snapshot.complete = false;
    snapshot.collection.rootNodeId = 'root-outside-crop';
    snapshot.nodes.push({ ...root, id: 'second-root-in-crop' });

    expect(validateSnapshotSemantics(snapshot, deferredContext)).toEqual({ valid: true, issues: [] });
  });

  it('does not require an individual paginated page to contain the root [evidence:semantic.snapshot.root]', async () => {
    const snapshot = await completeSnapshot();
    snapshot.nodes = snapshot.nodes.filter((node) => node.kind !== 'root');
    snapshot.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };

    expect(validateSnapshotSemantics(snapshot, deferredContext)).toEqual({ valid: true, issues: [] });
  });

  it('enforces the root invariant after completed page assembly [evidence:semantic.snapshot.root]', async () => {
    const snapshot = await completeSnapshot();
    const rootlessNodes = snapshot.nodes.filter((node) => node.kind !== 'root');
    const first = structuredClone(snapshot);
    const second = structuredClone(snapshot);
    first.nodes = rootlessNodes;
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = [];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    expect(validateSnapshotSemantics(first, deferredContext)).toEqual({ valid: true, issues: [] });
    expect(validateSnapshotSemantics(second, deferredContext)).toEqual({ valid: true, issues: [] });

    const result = assembleSnapshotPages([first, second]);

    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.issues.map((issue) => issue.code)).toContain(
      'invalid_root_count',
    );
  });
});
