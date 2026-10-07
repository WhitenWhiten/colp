import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEED_DATA_SQL_BODY_MARKER,
  SEED_OPAQUE_ID,
  SEED_OPAQUE_ID_PATTERN,
  SEED_OPAQUE_INSTALL_SQL,
  SEED_OPAQUE_PREFIX,
  assertSeedOpaqueIdSet,
  executableSeedDataSql,
  seedCollectionId,
  seedNodeId,
  seedOpaqueId,
  seedOpaqueIdFromSqlBase64,
} from '../../../src/infrastructure/seed/seed-opaque-id.js';

const FLAGSHIP = 'col-u01-01';
const CELEBRITY = 'col-ce01-01';
const FLAGSHIP_ROOT = 'nd-col-u01-01-root';
const FLAGSHIP_BOOKMARK = 'nd-col-u01-01-001';

describe('seedOpaqueId', () => {
  test('legacy → 22-char opaque regex, prefix preserved, last char AQgw, deterministic', () => {
    const collection = seedOpaqueId(SEED_OPAQUE_PREFIX.collectionUser, FLAGSHIP);
    const again = seedOpaqueId(SEED_OPAQUE_PREFIX.collectionUser, FLAGSHIP);
    assert.equal(collection.length, 22);
    assert.match(collection, SEED_OPAQUE_ID_PATTERN);
    assert.equal(collection.startsWith('col-u'), true);
    assert.match(collection.at(-1) ?? '', /[AQgw]/u);
    assert.equal(collection, again);

    const celebrity = seedCollectionId(CELEBRITY);
    assert.equal(celebrity.startsWith('col-ce'), true);
    assert.match(celebrity, SEED_OPAQUE_ID_PATTERN);

    const node = seedNodeId(FLAGSHIP_ROOT);
    assert.equal(node.startsWith('nd-col-'), true);
    assert.match(node, SEED_OPAQUE_ID_PATTERN);
    assert.notEqual(node, seedNodeId(FLAGSHIP_BOOKMARK));
  });

  test('SQL encode/translate path matches Node base64url mint', () => {
    const samples: ReadonlyArray<readonly [string, string]> = [
      [SEED_OPAQUE_PREFIX.collectionUser, FLAGSHIP],
      [SEED_OPAQUE_PREFIX.collectionCelebrity, CELEBRITY],
      [SEED_OPAQUE_PREFIX.node, FLAGSHIP_ROOT],
      [SEED_OPAQUE_PREFIX.node, FLAGSHIP_BOOKMARK],
      [SEED_OPAQUE_PREFIX.node, 'nd-col-u01-01-f06'],
    ];
    for (const [prefix, legacy] of samples) {
      assert.equal(seedOpaqueId(prefix, legacy), seedOpaqueIdFromSqlBase64(prefix, legacy));
    }
  });

  test('SEED_OPAQUE_ID helpers and collision-check of the demo identity set', () => {
    assert.equal(SEED_OPAQUE_ID.collection(FLAGSHIP), seedCollectionId(FLAGSHIP));
    assert.equal(SEED_OPAQUE_ID.node(FLAGSHIP_BOOKMARK), seedNodeId(FLAGSHIP_BOOKMARK));

    const collections: Array<readonly [string, string]> = [];
    for (let user = 1; user <= 15; user += 1) {
      for (let slot = 1; slot <= 5; slot += 1) {
        const legacy = `col-u${String(user).padStart(2, '0')}-${String(slot).padStart(2, '0')}`;
        collections.push([SEED_OPAQUE_PREFIX.collectionUser, legacy]);
      }
    }
    for (let celebrity = 1; celebrity <= 6; celebrity += 1) {
      collections.push([
        SEED_OPAQUE_PREFIX.collectionCelebrity,
        `col-ce${String(celebrity).padStart(2, '0')}-01`,
      ]);
    }

    const nodes: Array<readonly [string, string]> = [];
    for (const [, legacy] of collections) {
      nodes.push([SEED_OPAQUE_PREFIX.node, `nd-${legacy}-root`]);
    }
    for (let seq = 1; seq <= 24; seq += 1) {
      nodes.push([SEED_OPAQUE_PREFIX.node, `nd-col-u01-01-${String(seq).padStart(3, '0')}`]);
    }
    for (const suffix of ['f01', 'f02', 'f03', 'f04', 'f05', 'f06', 'f07']) {
      nodes.push([SEED_OPAQUE_PREFIX.node, `nd-col-u01-01-${suffix}`]);
    }

    const ids = assertSeedOpaqueIdSet([...collections, ...nodes]);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.every((id) => SEED_OPAQUE_ID_PATTERN.test(id)), true);
  });

  test('data.sql CREATE FUNCTION block stays in lockstep with SEED_OPAQUE_INSTALL_SQL', () => {
    const dataSql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'seed', 'demo', 'data.sql'),
      'utf8',
    );
    const start = dataSql.indexOf('CREATE OR REPLACE FUNCTION seed_opaque');
    const end = dataSql.indexOf('$seed_collection_id$;');
    assert.ok(start >= 0 && end > start, 'data.sql must define seed_opaque and seed_collection_id');
    const fromFile = dataSql.slice(start, end + '$seed_collection_id$;'.length);
    const fromTs = `${SEED_OPAQUE_INSTALL_SQL.join(';\n\n')};`;
    const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
    assert.equal(normalize(fromFile), normalize(fromTs));
    assert.equal(executableSeedDataSql(dataSql).startsWith(SEED_DATA_SQL_BODY_MARKER), true);
  });
});
