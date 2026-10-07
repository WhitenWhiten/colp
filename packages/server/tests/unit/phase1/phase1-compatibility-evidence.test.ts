/**
 * P1-14/P1-15 static compatibility evidence: current OpenAPI version, error registry,
 * migration list, N/N-1 producer/consumer version constants, editor route presence.
 *
 * Does not mutate production artifacts — read-only assertions only.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, test } from 'vitest';
import {
  COLLECTION_CREATED_EVENT_VERSION_N,
  COLLECTION_CREATED_EVENT_VERSION_N_PLUS,
  PHASE1_PRODUCER_EVENT_VERSIONS,
  collectionMutationEventSpecs,
  createCollectionMutationEnvelopeRegistry,
  createCollectionMutationEnvelopeRegistryNMinus1,
  UnsupportedEventVersionError,
} from '../../../src/infrastructure/outbox/index.js';
import {
  COLLECTION_CREATED_EVENT_TYPE,
  COLLECTION_CREATED_EVENT_VERSION,
} from '../../../src/modules/collections/index.js';

const root = resolve(import.meta.dirname, '../../..');

function readOpenApiSource(): {
  info: { version: string };
  paths: Record<string, Record<string, { operationId?: string }>>;
  components: {
    schemas: {
      ProductErrorCode?: { enum?: string[] };
    };
    responses?: Record<string, unknown>;
  };
} {
  return parse(readFileSync(join(root, 'openapi/product-v1.yaml'), 'utf8')) as ReturnType<
    typeof readOpenApiSource
  >;
}

describe('P1-15 OpenAPI compatibility + editor route surface (static)', () => {
  test('current Product OpenAPI matches the generated bundle while the accepted 1.2 contract remains frozen', () => {
    const document = readOpenApiSource();
    const generated = parse(readFileSync(join(root, 'generated/openapi/product-v1.bundle.yaml'), 'utf8')) as {
      info: { version: string };
    };
    assert.equal(document.info.version, generated.info.version);

    const phase2Baseline = parse(readFileSync(
      join(root, 'openapi/baselines/product-v1.1.2.0.yaml'),
      'utf8',
    )) as { info: { version: string } };
    assert.equal(phase2Baseline.info.version, '1.2.0');

    const editor = document.paths['/api/v1/collections/{collectionId}/editor'];
    assert.ok(editor, 'editor path missing');
    assert.equal(editor.get?.operationId, 'getCollectionEditorPage');
  });

  test('ProductErrorCode registry includes command_result_expired', () => {
    const document = readOpenApiSource();
    const codes = document.components.schemas.ProductErrorCode?.enum ?? [];
    assert.ok(codes.includes('command_result_expired'), codes.join(','));
    assert.ok(codes.includes('snapshot_expired'));
    assert.ok(codes.includes('invalid_cursor'));
    assert.ok(codes.includes('revision_conflict'));
  });

  test('OpenAPI source text still documents command_result_expired response semantics', () => {
    const source = readFileSync(join(root, 'openapi/product-v1.yaml'), 'utf8');
    assert.match(source, /command_result_expired/);
    assert.match(source, /historical command is never rerun/i);
  });
});

describe('P1-14 migration reconstruction inventory (static)', () => {
  test('migrations directory is non-empty and includes phase1 baseline + expand chain', () => {
    const dir = join(root, 'migrations');
    const names = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort();
    assert.ok(names.length >= 1, 'migration list must be non-empty');
    assert.ok(names.includes('202607220900_phase1_schema.ts'));

    // Expand chain for Phase 1 product surfaces (receipt, identity, collections, outbox)
    for (const required of [
      '202607221200_versioned_outbox_worker.ts',
      '202607221500_product_command_receipt_hardening.ts',
      '202607221700_identity_lifecycle.ts',
      '202607221800_collection_summary.ts',
    ]) {
      assert.ok(names.includes(required), `missing migration ${required}`);
    }

    // Lexicographic order is the reconstruction order
    assert.deepEqual(names, [...names].sort());
  });
});

describe('P1-14 N/N-1 outbox compatibility constants (static + unit)', () => {
  test('producer catalog stays on N for collection.created while N+1 is consumer-ready', () => {
    assert.equal(COLLECTION_CREATED_EVENT_VERSION, 1);
    assert.equal(COLLECTION_CREATED_EVENT_VERSION_N, 1);
    assert.equal(COLLECTION_CREATED_EVENT_VERSION_N_PLUS, 2);
    assert.equal(PHASE1_PRODUCER_EVENT_VERSIONS[COLLECTION_CREATED_EVENT_TYPE], 1);

    const catalog = collectionMutationEventSpecs().map(
      (s) => `${s.eventType}@${s.eventVersion}`,
    );
    assert.ok(catalog.includes('collection.created@1'));
    assert.ok(catalog.includes('collection.created@2'));
  });

  test('full registry accepts N and N+1; N-1 registry rejects N+1 fail-closed', () => {
    const full = createCollectionMutationEnvelopeRegistry();
    const nMinus1 = createCollectionMutationEnvelopeRegistryNMinus1();

    const envelopeV1 = {
      event_id: 'compat-event-1',
      event_type: COLLECTION_CREATED_EVENT_TYPE,
      event_version: COLLECTION_CREATED_EVENT_VERSION_N,
      aggregate_identity: {
        aggregate_type: 'collection',
        aggregate_id: 'col-compat',
        aggregate_scope: 'col-compat',
      },
      aggregate_revision: 'rev-1',
      commit_ordinal: '1',
      occurred_at: '2026-07-22T12:00:00.000Z',
      payload: {
        collectionId: 'col-compat',
        kind: 'bookmarks',
        ownerSubjectId: 'subject-compat',
        rootNodeId: 'root-compat',
      },
    };

    const envelopeV2 = {
      ...envelopeV1,
      event_id: 'compat-event-2',
      event_version: COLLECTION_CREATED_EVENT_VERSION_N_PLUS,
      payload: {
        ...envelopeV1.payload,
        title: 'Compat Title',
      },
    };

    assert.equal(full.validate(envelopeV1).event_version, 1);
    assert.equal(full.validate(envelopeV2).event_version, 2);
    assert.doesNotThrow(() => nMinus1.validate(envelopeV1));
    assert.throws(
      () => nMinus1.validate(envelopeV2),
      UnsupportedEventVersionError,
    );
  });
});

describe('P1-14 transport maps expired receipt to command_result_expired', () => {
  test('one authoritative expired mapping is consumed by all six mutation routes', () => {
    const mappingSource = readFileSync(
      join(root, 'src/transport/product-command-mapping.ts'),
      'utf8',
    );
    const routesSource = [
      'collection-resource-routes.ts',
      'node-routes.ts',
    ].map((name) => readFileSync(join(root, 'src/transport/product', name), 'utf8')).join('\n');

    assert.equal((mappingSource.match(/case 'expired':/g) ?? []).length, 1);
    assert.equal((mappingSource.match(/code:\s*'command_result_expired'/g) ?? []).length, 1);
    assert.equal(
      (routesSource.match(/sendProductCommandReceiptOutcome\(/g) ?? []).length,
      6,
    );
  });
});

