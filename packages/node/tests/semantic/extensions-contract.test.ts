import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const invalidNamespace = 'http://invalid.example/ns/a~b';
const escapedInvalidNamespace = 'http:~1~1invalid.example~1ns~1a~0b';
const timestamp = '2026-07-16T06:30:00Z';

function fixture(name = 'collection-snapshot.json'): Snapshot {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Snapshot;
}

function addSidecars(snapshot: Snapshot): void {
  const mutable = snapshot as any;
  mutable.attachments.push({
    id: 'attachment-1',
    collectionId: mutable.collection.id,
    subject: { type: 'node', id: mutable.nodes[1].id },
    rel: 'alternate',
    url: 'https://example.com/attachment',
    visibility: 'public',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 'attachment-revision',
  });
  mutable.relations.push({
    id: 'relation-1',
    collectionId: mutable.collection.id,
    type: 'related',
    fromNodeId: mutable.nodes[0].id,
    toNodeId: mutable.nodes[1].id,
    visibility: 'public',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 'relation-revision',
  });
}

function expectInvalidNamespace(snapshot: Snapshot, expectedPath: string): void {
  const result = validateSnapshotSemantics(snapshot);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_extension_namespace', path: expectedPath }),
    ]),
  );
}

describe('extension namespace semantics', () => {
  it.each([
    ['Collection', (snapshot: any) => snapshot.collection, `/collection/extensions/${escapedInvalidNamespace}`],
    ['Node', (snapshot: any) => snapshot.nodes[0], `/nodes/0/extensions/${escapedInvalidNamespace}`],
    ['Annotation', (snapshot: any) => snapshot.annotations[0], `/annotations/0/extensions/${escapedInvalidNamespace}`],
    ['Attachment', (snapshot: any) => snapshot.attachments[0], `/attachments/0/extensions/${escapedInvalidNamespace}`],
    ['Relation', (snapshot: any) => snapshot.relations[0], `/relations/0/extensions/${escapedInvalidNamespace}`],
  ])(
    'rejects an invalid namespace on %s at its JSON-pointer-safe path [evidence:semantic.extensions]',
    (_label, select, expectedPath) => {
      const snapshot = fixture();
      addSidecars(snapshot);
      (snapshot as any).mode = 'sync';
      select(snapshot).extensions = { [invalidNamespace]: { arbitrary: true } };
      expectInvalidNamespace(snapshot, expectedPath);
    },
  );

  it('matches RFC 3986 validity instead of WHATWG URL normalization [evidence:semantic.extensions]', () => {
    const snapshot = fixture();
    (snapshot as any).mode = 'sync';
    (snapshot.collection as any).extensions = { 'https://example.com/[]': true };

    expectInvalidNamespace(snapshot, '/collection/extensions/https:~1~1example.com~1[]');
  });

  it('does not let the publication allowlist waive namespace validity [evidence:semantic.extensions]', () => {
    const snapshot = fixture();
    (snapshot.collection as any).extensions = { [invalidNamespace]: true };
    const result = validateSnapshotSemantics(snapshot, {
      publicSafeExtensions: new Set([invalidNamespace]),
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_extension_namespace',
          path: `/collection/extensions/${escapedInvalidNamespace}`,
        }),
      ]),
    );
    expect(result.issues.some((candidate) => candidate.code === 'unsafe_publication_extension')).toBe(false);
  });

  it('still requires a valid HTTPS namespace to be publication-approved [evidence:semantic.extensions]', () => {
    const snapshot = fixture();
    const namespace = 'https://extensions.example/ns/public/v1';
    (snapshot.collection as any).extensions = { [namespace]: { nested: { arbitrary: ['data'] } } };

    const rejected = validateSnapshotSemantics(snapshot);
    expect(rejected.valid).toBe(false);
    if (!rejected.valid) {
      expect(rejected.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unsafe_publication_extension' })]),
      );
      expect(rejected.issues.some((candidate) => candidate.code === 'invalid_extension_namespace')).toBe(false);
    }

    expect(
      validateSnapshotSemantics(snapshot, { publicSafeExtensions: new Set([namespace]) }),
    ).toEqual({ valid: true, issues: [] });
  });

  it('lets consumers preserve valid unknown publication extensions as opaque JSON', () => {
    const snapshot = fixture();
    const namespace = 'https://extensions.example/ns/future/v1';
    (snapshot.collection as any).extensions = { [namespace]: { future: ['opaque', 0, false] } };

    expect(validateSnapshotSemantics(snapshot, {
      publicationExtensionMode: 'consumer',
    })).toEqual({ valid: true, issues: [] });

    (snapshot.collection as any).extensions = { [invalidNamespace]: true };
    const invalid = validateSnapshotSemantics(snapshot, { publicationExtensionMode: 'consumer' });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.issues.some((issue) => issue.code === 'invalid_extension_namespace')).toBe(true);
    }
  });
});
