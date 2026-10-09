import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const migrationUrl = new URL(
  '../../../migrations/202610010100_ledger_archive_segments.ts',
  import.meta.url,
);
const repositoryUrl = new URL(
  '../../../src/infrastructure/database/ledger-archive-segment-repository.ts',
  import.meta.url,
);

describe('ledger archive control-plane static contract', () => {
  test('migration is additive and owns a monotonic fail-closed state machine', async () => {
    const source = await readFile(migrationUrl, 'utf8');

    assert.match(source, /CREATE TABLE ledger_archive_segments/i);
    assert.match(source, /source_key_bounds int8range NOT NULL/i);
    assert.match(source, /source_scope text NOT NULL/i);
    assert.match(source, /source_key_kind = 'bigint'/i);
    assert.match(source, /source_key_comparator = 'signed-bigint-ascending-v1'/i);
    assert.match(source, /EXCLUDE USING gist/i);
    assert.match(source, /source_scope WITH =/i);
    assert.match(source, /source_key_bounds WITH &&/i);
    assert.match(source, /'open'.*'sealed'.*'exported'.*'verified'.*'reader_cutover'/su);
    assert.match(source, /'reader_cutover'.*'detached'.*'deletable'.*'deleted'/su);
    assert.match(source, /ledger_archive_segments_manifest_immutable/);
    assert.match(source, /ledger_archive_segments_legal_hold_guard/);
    assert.match(source, /ledger_archive_segments_delete_after_guard/);
    assert.match(source, /ledger_archive_segments_evidence_guard/);
    assert.match(source, /ledger_archive_segments_delete_guard/);
    assert.match(source, /ledger_archive_segments_truncate_guard/);
    assert.match(source, /BEFORE INSERT OR UPDATE OR DELETE ON ledger_archive_segments/i);
    assert.match(source, /BEFORE TRUNCATE ON ledger_archive_segments\s*FOR EACH STATEMENT/i);
    assert.match(source, /DROP TRIGGER IF EXISTS ledger_archive_segments_truncate_guard/i);
    assert.match(source, /jsonb_typeof\(stage_evidence\) = 'object'/i);
    assert.match(source, /archive_object_uri.*BETWEEN 8 AND 2048/is);
    assert.match(source, /content_digest ~ '\^sha256:\[0-9a-f\]\{64\}\$'/i);
  });

  test('repository exposes CAS control only and contains no source deletion primitive', async () => {
    const source = await readFile(repositoryUrl, 'utf8');

    assert.match(source, /expectedState: LedgerArchiveSegmentState/);
    assert.match(source, /expectedRevision: bigint/);
    assert.match(source, /state_revision = state_revision \+ 1/);
    assert.match(source, /AND state = \$\{input\.expectedState\}/);
    assert.match(source, /AND state_revision = \$\{input\.expectedRevision\}/);
    assert.doesNotMatch(source, /DELETE\s+FROM/i);
    assert.doesNotMatch(source, /DROP\s+TABLE/i);
    assert.doesNotMatch(source, /DETACH\s+PARTITION/i);
  });

  // The ledger archive control-plane runbook is Know-N operations
  // documentation and is not shipped here (tests/EXTRACTION.md); the
  // migration and repository invariants above are the enforceable part.
});
