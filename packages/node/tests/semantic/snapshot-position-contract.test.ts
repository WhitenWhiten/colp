import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compareOrderKeys } from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  assembleSnapshotPages,
  validateSnapshotSemantics,
} from '../../src/semantic/index.js';
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

function rootOf(snapshot: Snapshot): Extract<StrictNode, { kind: 'root' }> {
  const root = snapshot.nodes.find((node) => node.kind === 'root');
  if (root === undefined) throw new Error('fixture must contain a root node');
  return root;
}

function nodeBase(snapshot: Snapshot, id: string) {
  return {
    id,
    collectionId: snapshot.collection.id,
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
    revision: snapshot.revision,
    extensions: {},
  };
}

function folder(snapshot: Snapshot, id: string, parentId: string, position: string): StrictNode {
  return {
    ...nodeBase(snapshot, id),
    kind: 'folder',
    parentId,
    position,
    title: id,
  };
}

function bookmark(snapshot: Snapshot, id: string, parentId: string, position: string): StrictNode {
  return {
    ...nodeBase(snapshot, id),
    kind: 'bookmark',
    parentId,
    position,
    title: id,
    url: `https://example.com/${id}`,
  };
}

function expectOnlyIssue(
  result: { readonly valid: boolean; readonly issues: readonly { code: string; path: string }[] },
  code: string,
  path: string,
): void {
  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => ({ code: issue.code, path: issue.path }))).toEqual([
    { code, path },
  ]);
}

describe('Snapshot position contract', () => {
  const registry = createValidatorRegistry();
  const fullAlphabet = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  const invalidTokens: readonly (readonly [string, unknown])[] = [
    ['non-string token', null],
    ['empty token', ''],
    ['token longer than 128 characters', 'a'.repeat(129)],
    ['non-ASCII token', 'caf\u00e9'],
    ['space', 'a b'],
    ['period', 'a.b'],
    ['slash', 'a/b'],
  ];

  it.each([
    ['minimum-length token', '0'],
    ['maximum-length token', 'z'.repeat(128)],
    ['every alphabet character including boundaries', fullAlphabet],
  ])('accepts a structurally valid %s [evidence:semantic.snapshot.position]', (_label, token) => {
    expect(registry.validate('orderKey', token)).toEqual({ valid: true, errors: [] });
  });

  it.each(invalidTokens)('rejects a structurally invalid %s [evidence:semantic.snapshot.position]', (_label, token) => {
    expect(registry.validate('orderKey', token).valid).toBe(false);
  });

  it.each(invalidTokens)('rejects a comparator %s [evidence:semantic.snapshot.position]', (_label, token) => {
    expect(() => compareOrderKeys(token as string, 'a')).toThrowError(
      new TypeError('Position tokens must match ^[0-9A-Za-z_-]{1,128}$.'),
    );
    expect(() => compareOrderKeys('a', token as string)).toThrowError(
      new TypeError('Position tokens must match ^[0-9A-Za-z_-]{1,128}$.'),
    );
  });

  it.each(invalidTokens)('defensively rejects a direct semantic %s at its exact path [evidence:semantic.snapshot.position]', async (_label, token) => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    snapshot.nodes = [
      root,
      { ...bookmark(snapshot, 'bookmark-a', root.id, 'valid'), position: token } as unknown as StrictNode,
    ];

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'invalid_position', '/nodes/1/position');
  });

  it('rejects a same-parent duplicate at the later position path [evidence:semantic.snapshot.position]', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    snapshot.nodes = [
      root,
      bookmark(snapshot, 'bookmark-a', root.id, 'same'),
      bookmark(snapshot, 'bookmark-b', root.id, 'same'),
    ];

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot),
      'duplicate_position',
      '/nodes/2/position',
    );
  });

  it('accepts the same position under different parents [evidence:semantic.snapshot.position]', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const firstParent = folder(snapshot, 'folder-a', root.id, 'A');
    const secondParent = folder(snapshot, 'folder-b', root.id, 'B');
    snapshot.nodes = [
      root,
      firstParent,
      secondParent,
      bookmark(snapshot, 'bookmark-a', firstParent.id, 'same'),
      bookmark(snapshot, 'bookmark-b', secondParent.id, 'same'),
    ];

    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('rejects a cross-page sibling duplicate after assembly [evidence:semantic.snapshot.position]', async () => {
    const complete = await completeSnapshot();
    const root = rootOf(complete);
    const first = structuredClone(complete);
    first.nodes = [root, bookmark(first, 'bookmark-a', root.id, 'same')];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(complete);
    second.nodes = [bookmark(second, 'bookmark-b', root.id, 'same')];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    expect(validateSnapshotSemantics(first, deferredContext)).toEqual({ valid: true, issues: [] });
    expect(validateSnapshotSemantics(second, deferredContext)).toEqual({ valid: true, issues: [] });
    const assembled = assembleSnapshotPages([first, second]);
    expectOnlyIssue(assembled, 'duplicate_position', '/nodes/2/position');
  });

  it('orders punctuation, digits, uppercase, underscore, lowercase, and prefixes by ASCII octet [evidence:semantic.snapshot.position]', () => {
    const tokens = ['a', 'A0', '_', '00', 'z', '-', 'Z', '0', 'A'];

    expect(compareOrderKeys('-', '0')).toBe(-1);
    expect(compareOrderKeys('Z', '_')).toBe(-1);
    expect(compareOrderKeys('_', 'a')).toBe(-1);
    expect(compareOrderKeys('A', 'A0')).toBe(-1);
    expect(compareOrderKeys('A0', 'A')).toBe(1);
    expect(compareOrderKeys('same', 'same')).toBe(0);
    expect(tokens.sort(compareOrderKeys)).toEqual(['-', '0', '00', 'A', 'A0', 'Z', '_', 'a', 'z']);
  });

  it('does not apply numeric or locale interpretation [evidence:semantic.snapshot.position]', () => {
    expect(['2', '10', '1'].sort(compareOrderKeys)).toEqual(['1', '10', '2']);
    expect(['a', '_', 'Z'].sort(compareOrderKeys)).toEqual(['Z', '_', 'a']);
  });
});
