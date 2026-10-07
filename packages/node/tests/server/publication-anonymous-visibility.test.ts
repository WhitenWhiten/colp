import { describe, expect, it } from 'vitest';

import {
  assertAnonymousPublicationPrimaryVisibility,
  projectPublicationPublicWire,
  PublicationPublicProjectionError,
} from '../../src/server/index.js';

const collectionId = 'collection-public';
const root = { id: 'root', collectionId, kind: 'root', parentId: null };
const folder = { id: 'folder', collectionId, kind: 'folder', parentId: 'root' };

function snapshot(change: Record<string, unknown> = {}) {
  return {
    collection: { id: collectionId, kind: 'knowledge_collection', rootNodeId: 'root', visibility: 'public' },
    nodes: [root, folder],
    annotations: [],
    attachments: [],
    relations: [],
    page: { sequence: 1 },
    ...change,
  };
}

function assertPublic(value: unknown): void {
  assertAnonymousPublicationPrimaryVisibility(projectPublicationPublicWire(value));
}

describe('anonymous Snapshot visibility [evidence:http.publication-read-composition]', () => {
  it('allows public inheritance and sidecars belonging to the public collection', () => {
    expect(() => assertPublic(snapshot({
      annotations: [{ subject: { type: 'collection', id: collectionId }, visibility: 'public' }],
      attachments: [{ subject: { type: 'node', id: 'folder' }, visibility: 'public' }],
      relations: [{ fromNodeId: 'root', toNodeId: 'folder', visibility: 'inherit' }],
    }))).not.toThrow();
  });

  it.each(['annotations', 'attachments'])('rejects %s with an unknown collection subject', (key) => {
    expect(() => assertPublic(snapshot({
      [key]: [{ subject: { type: 'collection', id: 'collection-private' }, visibility: 'public' }],
    }))).toThrow(PublicationPublicProjectionError);
  });

  it('resolves a deep flat Node graph within the public projection budget', () => {
    const nodes = Array.from({ length: 16_000 }, (_, index) => ({
      id: `folder-${index}`,
      collectionId,
      kind: 'folder',
      parentId: index === 0 ? 'root' : `folder-${index - 1}`,
    }));
    // Encounter the deepest descendant first so memoization cannot conceal
    // recursive traversal of a valid, flat wire representation.
    expect(() => assertPublic(snapshot({ nodes: [...nodes.reverse(), root] }))).not.toThrow();
  });

  it.each([
    [root, { ...folder, parentId: 'missing' }],
    [root, { ...folder, parentId: 'folder' }],
    [root, folder, { ...folder }],
    [root, { ...folder, visibility: 'protected' }],
    [root, { ...folder, visibility: 'private' }],
    [root, { ...folder, parentId: 'child' }, { ...folder, id: 'child', parentId: 'folder' }],
  ])('rejects unknown, cyclic, duplicate, or restricted ancestry %#', (...nodes) => {
    expect(() => assertPublic(snapshot({ nodes }))).toThrow(PublicationPublicProjectionError);
  });

  it('allows an omitted collection root on a continuation page', () => {
    expect(() => assertPublic(snapshot({ nodes: [folder], page: { sequence: 2 } }))).not.toThrow();
    expect(() => assertPublic(snapshot({ nodes: [folder] }))).toThrow(PublicationPublicProjectionError);
  });

  it('rejects sidecars and relations whose Node subjects are unknown', () => {
    expect(() => assertPublic(snapshot({
      annotations: [{ subject: { type: 'node', id: 'missing' }, visibility: 'public' }],
    }))).toThrow(PublicationPublicProjectionError);
    expect(() => assertPublic(snapshot({
      relations: [{ fromNodeId: 'root', toNodeId: 'missing', visibility: 'inherit' }],
    }))).toThrow(PublicationPublicProjectionError);
  });
});
