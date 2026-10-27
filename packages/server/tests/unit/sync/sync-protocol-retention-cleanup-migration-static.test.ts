import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const source = readFileSync(new URL(
  '../../../migrations/202611030400_sync_protocol_retirement_cleanup.ts', import.meta.url), 'utf8');

test('protocol retirement cleanup is fenced by retired Replicas and archived history floors', () => {
  expect(source).toContain("replica.status = 'retired'");
  expect(source).toContain('floor.archive_segment_id IS NOT NULL');
  expect(source).toContain('OLD.commit_ordinal < floor.floor_commit_ordinal');
  expect(source).toContain('sync_sequence_claims_replica_cleanup_idx');
  expect(source).toContain('sync_node_revision_history_commit_cleanup_idx');
  expect(source).toContain("RAISE EXCEPTION 'Sequence lanes are retained for the Replica lifetime'");
});
