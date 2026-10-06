import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import { assembleSnapshotPages, validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = 'core.snapshot-metadata';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();

async function fixture(): Promise<Snapshot> {
  return JSON.parse(await readFile(resolve(fixturesRoot, 'collection-snapshot.json'), 'utf8')) as Snapshot;
}

function issueSummary(result: ReturnType<typeof validateSnapshotSemantics>): Array<[string, string]> {
  return result.valid ? [] : result.issues.map(({ code, path }) => [code, path]);
}

describe(`Snapshot metadata contract [evidence:${evidence}]`, () => {
  it.each([
    ['snapshotId', 'invalid id/with/slashes', '/snapshotId'],
    ['mode', 'archive', '/mode'],
    ['complete', 'true', '/complete'],
    ['revision', '', '/revision'],
    ['generatedAt', 'yesterday', '/generatedAt'],
    ['page', null, '/page'],
  ] as const)('requires a valid %s', async (field, wrongValue, expectedPath) => {
    const missing = structuredClone(await fixture()) as unknown as Record<string, unknown>;
    delete missing[field];
    const missingResult = validators.validate('snapshot', missing);
    expect(missingResult.valid).toBe(false);
    if (!missingResult.valid) {
      expect(missingResult.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          instancePath: '',
          keyword: 'required',
          params: { missingProperty: field },
        }),
      ]));
    }

    const wrong = structuredClone(await fixture()) as unknown as Record<string, unknown>;
    wrong[field] = wrongValue;
    const wrongResult = validators.validate('snapshot', wrong);
    expect(wrongResult.valid).toBe(false);
    if (!wrongResult.valid) {
      expect(wrongResult.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ instancePath: expectedPath }),
      ]));
    }
  });

  it('rejects a page that changes the Collection projection', async () => {
    const source = await fixture();
    const first = structuredClone(source);
    const second = structuredClone(source);
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = source.nodes.slice(1);
    second.collection.title = 'Changed between pages';
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    const result = assembleSnapshotPages([first, second]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map(({ code, path }) => [code, path])).toContainEqual([
        'snapshot_page_context_changed',
        '/pages/1',
      ]);
    }
  });

  it.each([
    ['nextCursor', undefined, '/page', 'nextCursor'],
    ['hasMore', undefined, '/page', 'hasMore'],
    ['sequence', undefined, '/page', 'sequence'],
    ['nextCursor', 'invalid/cursor', '/page/nextCursor', undefined],
    ['hasMore', 'yes', '/page/hasMore', undefined],
    ['sequence', 0, '/page/sequence', undefined],
  ] as const)('requires a valid page.%s', async (field, wrongValue, expectedPath, missingProperty) => {
    const snapshot = structuredClone(await fixture()) as unknown as Record<string, any>;
    if (wrongValue === undefined) delete snapshot.page[field];
    else snapshot.page[field] = wrongValue;
    const result = validators.validate('snapshot', snapshot);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          instancePath: expectedPath,
          ...(missingProperty === undefined
            ? {}
            : { keyword: 'required', params: { missingProperty } }),
        }),
      ]));
    }
  });

  it.each([
    [true, null],
    [false, 'unused-cursor'],
  ] as const)('rejects hasMore=%s with nextCursor=%s', async (hasMore, nextCursor) => {
    const snapshot = await fixture();
    snapshot.page = { hasMore, nextCursor, sequence: 1 };
    expect(issueSummary(validateSnapshotSemantics(snapshot))).toContainEqual([
      'invalid_snapshot_page_cursor',
      '/page/nextCursor',
    ]);
  });

  it('treats logical completeness independently from HTTP page finality', async () => {
    const paginatedComplete = await fixture();
    paginatedComplete.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    expect(validateSnapshotSemantics(paginatedComplete)).toEqual({ valid: true, issues: [] });

    const finalCropped = await fixture();
    finalCropped.complete = false;
    expect(validateSnapshotSemantics(finalCropped)).toEqual({ valid: true, issues: [] });
  });

  it('assembles cropped pages and preserves complete=false', async () => {
    const source = await fixture();
    const first = structuredClone(source);
    const second = structuredClone(source);
    first.complete = false;
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.complete = false;
    second.nodes = source.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    const result = assembleSnapshotPages([first, second]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.snapshot.complete).toBe(false);
      expect(result.snapshot.nodes).toHaveLength(source.nodes.length);
    }
  });

  it.each([
    ['snapshotId', 'another-snapshot'],
    ['revision', 'another-revision'],
    ['mode', 'sync'],
    ['complete', false],
    ['generatedAt', '2026-07-16T06:31:00Z'],
    ['protocolVersion', '0.2'],
  ] as const)('rejects a page that changes %s', async (field, value) => {
    const source = await fixture();
    const first = structuredClone(source);
    const second = structuredClone(source) as unknown as Record<string, unknown>;
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = source.nodes.slice(1);
    second[field] = value;
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    const result = assembleSnapshotPages([first, second as unknown as Snapshot]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map(({ code, path }) => [code, path])).toContainEqual([
        'snapshot_page_context_changed',
        '/pages/1',
      ]);
    }
  });

  it.each([
    ['paginated', true, { nextCursor: 'page-2', hasMore: true, sequence: 1 }],
    ['cropped', false, { nextCursor: null, hasMore: false, sequence: 1 }],
  ] as const)('rejects a body contentDigest on a %s Snapshot', async (_label, complete, page) => {
    const snapshot = await fixture();
    snapshot.complete = complete;
    snapshot.page = page;
    snapshot.contentDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    expect(issueSummary(validateSnapshotSemantics(snapshot))).toContainEqual([
      'invalid_snapshot_content_digest_scope',
      '/contentDigest',
    ]);
  });

  it('allows a body contentDigest only on a complete single-page Snapshot', async () => {
    const snapshot = await fixture();
    const canonical = canonicalize(snapshot);
    if (canonical === undefined) throw new Error('Fixture is not canonicalizable.');
    snapshot.contentDigest = `sha-256=:${createHash('sha256').update(canonical).digest('base64')}:`;
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('rejects a syntactically valid digest that does not match the logical Snapshot', async () => {
    const snapshot = await fixture();
    snapshot.contentDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    expect(issueSummary(validateSnapshotSemantics(snapshot))).toContainEqual([
      'snapshot_content_digest_mismatch',
      '/contentDigest',
    ]);
  });

  it.each([
    'sha-512=:ZmFrZQ==:',
    'sha-256=ZmFrZQ==',
    'sha-256=:not base64:',
    'sha-256=:ZmFrZQ==:',
  ])('rejects invalid body contentDigest syntax: %s', async (contentDigest) => {
    const snapshot = await fixture() as unknown as Record<string, unknown>;
    snapshot.contentDigest = contentDigest;
    const result = validators.validate('snapshot', snapshot);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ instancePath: '/contentDigest', keyword: 'pattern' }),
      ]));
    }
  });
});
