import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../../migrations/202607251500_sync_bootstrap_snapshots.ts', import.meta.url), 'utf8');
const pagedMigration = readFileSync(new URL('../../../migrations/202608100100_sync_bootstrap_snapshot_nodes.ts', import.meta.url), 'utf8');

describe('P3-09 bootstrap Snapshot migration', () => {
  it('persists immutable identity, revision/policy/generation fence, payload and Ack cursor', () => {
    for (const token of ['sync_bootstrap_snapshots', 'snapshot_id', 'content_revision', 'policy_revision', 'lease_generation', 'binding_root_node_id', 'snapshot_json', 'bootstrap_cursor', 'cursor_key_id']) expect(migration).toContain(token);
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE/i);
    expect(migration).toMatch(/UNIQUE \(session_id, content_revision, policy_revision/i);
  });
});

describe('FIX-M-014 paged Snapshot storage migration', () => {
  it('expands Snapshot storage to a versioned header plus numbered immutable node rows', () => {
    for (const token of ['sync_bootstrap_snapshot_nodes', 'node_index', 'node_json', 'storage_version', 'node_count']) {
      expect(pagedMigration).toContain(token);
    }
    expect(pagedMigration).toMatch(/storage_version smallint NOT NULL DEFAULT 1/u);
    expect(pagedMigration).toMatch(/storage_version IN \(1,2\)/u);
    expect(pagedMigration).toMatch(/ON DELETE CASCADE/u);
    expect(pagedMigration).toMatch(/PRIMARY KEY \(snapshot_id, node_index\)/u);
  });

  it('keeps rows immutable while live and allows expiry-only cleanup', () => {
    expect(pagedMigration).toMatch(/CREATE OR REPLACE FUNCTION forbid_sync_bootstrap_snapshot_mutation/u);
    expect(pagedMigration).toMatch(/TG_OP = 'DELETE' AND OLD\.expires_at <= current_timestamp/u);
    // The BEFORE UPDATE OR DELETE trigger is attached once by the original Snapshot
    // migration; CREATE OR REPLACE swaps the function body the existing trigger
    // executes (re-attaching it here would fail as a duplicate trigger).
    expect(migration).toMatch(/CREATE TRIGGER sync_bootstrap_snapshots_immutable BEFORE UPDATE OR DELETE/u);
  });
});
