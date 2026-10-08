import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const migrationUrl = new URL('../../../migrations/202607252700_sync_operation_effects.ts', import.meta.url);
const pushUrl = new URL('../../../src/infrastructure/sync/sync-push-postgres.ts', import.meta.url);
const pushCreateUrl = new URL('../../../src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts', import.meta.url);
const pushMoveUrl = new URL('../../../src/infrastructure/sync/postgres/sync-push-move-delete-postgres.ts', import.meta.url);
const pullUrl = new URL('../../../src/infrastructure/sync/postgres/sync-pull-postgres.ts', import.meta.url);
const pullPersistenceClusterUrls = [
  pullUrl,
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-authority-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-cursor-codec-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-cursor-evidence.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-recovery-postgres.ts', import.meta.url),
];
const streamReaderUrl = new URL(
  '../../../src/infrastructure/sync/postgres/sync-operation-payload-reader.ts',
  import.meta.url,
);
const authorityUrl = new URL('../../../src/infrastructure/sync/sync-operation-effects-postgres.ts', import.meta.url);
const conflictUrl = new URL('../../../src/infrastructure/sync/sync-conflict-resolution-postgres.ts', import.meta.url);
const purgeUrl = new URL('../../../src/infrastructure/sync/sync-tombstone-purge-postgres.ts', import.meta.url);
const manifestUrl = new URL('../../../src/modules/publication/application/manifest-candidate.ts', import.meta.url);

describe('P3-32B authoritative Pull effect persistence contract', () => {
  test('migration creates immutable, source-bound effect and page authority with cutover', async () => {
    const source = await readFile(migrationUrl, 'utf8');
    for (const fragment of [
      'CREATE TABLE sync_collection_effect_cutovers', 'effect_cutover_ordinal',
      'nodes_position_token_colp_check',
      'CREATE TABLE sync_operation_effects', 'effect_id', 'collection_id', 'operation_id',
      'origin_replica_id', 'origin_sequence', 'commit_ordinal', 'protocol_version',
      'terminal_status', 'operation_digest', 'effect_json', 'effect_digest',
      'CREATE TABLE sync_operation_effect_pages', 'page_number', 'page_count',
      'member_count', 'page_json', 'page_digest', 'previous_page_digest',
      'sync_operation_effects_immutable', 'sync_operation_effect_pages_immutable',
    ]) assert.match(source, new RegExp(fragment, 'iu'), fragment);
    assert.match(source, /UNIQUE\s*\(collection_id, operation_id\)/iu);
    assert.match(source, /UNIQUE\s*\(collection_id, origin_replica_id, origin_sequence\)/iu);
    assert.doesNotMatch(source, /UNIQUE\s*\(origin_replica_id, origin_sequence\)/iu);
    assert.match(source, /UNIQUE\s*\(collection_id, commit_ordinal\)/iu);
    assert.match(source, /CHECK\s*\(terminal_status IN \('applied', 'rebased'\)\)/iu);
    assert.match(source, /REFERENCES operations\s*\(collection_id, operation_id\)/iu);
    assert.match(source, /ON DELETE RESTRICT/iu);
    assert.match(source, /ENABLE ROW LEVEL SECURITY/iu);
    assert.match(source, /FORCE ROW LEVEL SECURITY/iu);
    assert.doesNotMatch(source, /ON DELETE CASCADE/iu);
  });

  test('writer persists validated effects inside the sequence-owned mutation transaction', async () => {
    const [pushFacade, pushCreate, pushMove, authority] = await Promise.all([
      readFile(pushUrl, 'utf8'), readFile(pushCreateUrl, 'utf8'),
      readFile(pushMoveUrl, 'utf8'), readFile(authorityUrl, 'utf8'),
    ]);
    const push = `${pushFacade}\n${pushCreate}\n${pushMove}`;
    assert.match(push, /persistAuthoritativeOperationEffect/u);
    assert.match(push, /transaction\.databaseTransaction/u);
    assert.doesNotMatch(authority, /\.transaction\(\)/u);
    for (const phase of ['effect_built', 'effect_persisted', 'effect_pages_persisted']) {
      assert.match(authority, new RegExp(phase, 'u'));
    }
    assert.match(authority, /validateAuthoritativePullEvent/u);
    assert.match(authority, /canonicalOperationDigest/u);
    assert.match(authority, /validatePersistedAuthoritativeEffect/u);
    assert.match(authority, /readLiveSiblingNeighborhood/u);
    assert.doesNotMatch(authority, /orderBy\(sql[\s\S]*position_token COLLATE "C"/u);
    assert.match(authority, /canonicalAuthoritativeEffectPageDigest/u);
    assert.match(authority, /terminalStatus !== 'applied' && terminalStatus !== 'rebased'/u);
  });

  test('0.2 Pull joins and revalidates effect authority while 0.1 remains exact', async () => {
    const [source, reader] = await Promise.all([
      Promise.all(pullPersistenceClusterUrls.map((url) => readFile(url, 'utf8'))).then((parts) => parts.join('\n')),
      readFile(streamReaderUrl, 'utf8'),
    ]);
    assert.match(source, /from '\.\/sync-operation-payload-reader\.js'/u);
    assert.match(source, /readSyncPullStreamCut/u);
    assert.match(source, /session\.protocol_version/u);
    assert.match(reader, /LEFT JOIN sync_operation_effects AS effect/u);
    assert.match(source, /validatePersistedAuthoritativeEffect/u);
    assert.match(source, /protocolVersion === '0\.2'/u);
    assert.match(source, /sync_collection_effect_cutovers/u);
    assert.match(source, /effect_cutover_ordinal/u);
    assert.match(source, /sync_cursor_expired/u);
    assert.match(source, /integrity_failure/u);
    assert.match(source, /validateAuthoritativePullEvent/u);
    assert.match(source, /byteAwareEventCount/u);
    assert.match(source, /responseBudgetBytes/u);
  });

  test('resolution, retention and Manifest negotiation remain effect-aware', async () => {
    const [conflict, purge, manifest] = await Promise.all([
      readFile(conflictUrl, 'utf8'), readFile(purgeUrl, 'utf8'), readFile(manifestUrl, 'utf8'),
    ]);
    assert.match(conflict, /persistAuthoritativeOperationEffect/u);
    assert.match(conflict, /transaction, operation: wireOperation/u);
    assert.match(purge, /DELETE FROM sync_operation_effect_pages page USING sync_operation_effects effect/u);
    assert.match(purge, /DELETE FROM sync_operation_effects/u);
    assert.match(purge, /effect\.commit_ordinal <=/u);
    assert.match(purge, /effect_purged/u);
    assert.match(manifest, /implemented\.has\('syncEffectPages'\) \? \['0\.1', '0\.2'\] : \['0\.1'\]/u);
  });
});
