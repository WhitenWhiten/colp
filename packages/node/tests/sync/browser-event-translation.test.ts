import { describe, expect, it } from 'vitest';

import {
  translateSyncBrowserDelete,
  translateSyncBrowserDeleteOperation,
  translateSyncBrowserEvent,
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.delete-subtree-translation]';

const context = {
  opId: 'op-folder-delete',
  replicaId: 'replica-browser',
  sequence: 7,
  occurredAt: '2026-07-18T00:00:00Z',
  collectionId: 'collection-1',
  baseRevision: 'revision-1',
} as const;

describe(`SYNC-0026 browser deletion translation ${evidence}`, () => {
  it(`translates a folder-only recursive delete to delete_subtree ${evidence}`, () => {
    const translated = translateSyncBrowserDelete({ nodeId: 'folder-1', nodeKind: 'folder' });
    expect(translated).toEqual({ type: 'delete_subtree', targetId: 'folder-1', payload: {} });
  });

  it(`does not require or synthesize child deletion events ${evidence}`, () => {
    const events = [{ type: 'delete', nodeId: 'folder-1', nodeKind: 'folder' as const }];
    const translated = events.map((event) => translateSyncBrowserDelete(event));
    expect(translated).toHaveLength(1);
    expect(translated[0]).toMatchObject({ type: 'delete_subtree', targetId: 'folder-1' });
  });

  it.each([
    ['bookmark', 'delete_node'],
    ['separator', 'delete_node'],
    ['alias', 'delete_node'],
  ] as const)(`keeps non-folder deletion as %s -> %s ${evidence}`, (nodeKind, type) => {
    expect(translateSyncBrowserDelete({ nodeId: 'node-1', nodeKind })).toMatchObject({
      type,
      targetId: 'node-1',
    });
  });

  it(`builds a typed delete_subtree operation while preserving adapter context ${evidence}`, () => {
    const operation = translateSyncBrowserDeleteOperation(
      { nodeId: 'folder-1', nodeKind: 'folder', reason: 'recursive' },
      { ...context, source: { adapterProfile: 'firefox', nativeEvent: 'onRemoved' } },
    );
    expect(operation).toMatchObject({
      ...context,
      type: 'delete_subtree',
      targetId: 'folder-1',
      payload: { reason: 'recursive' },
      source: { adapterProfile: 'firefox', nativeEvent: 'onRemoved' },
    });
  });

  it.each([
    ['root', { nodeId: 'root-1', nodeKind: 'root' }],
    ['missing node id', { nodeKind: 'folder' }],
    ['missing node kind', { nodeId: 'folder-1' }],
    ['null event', null],
  ] as const)(`rejects malformed or forbidden %s deletion boundaries ${evidence}`, (_label, event) => {
    expect(() => translateSyncBrowserDelete(event as never)).toThrow();
  });

  it.each([
    ['null nodeId', { nodeId: null, nodeKind: 'bookmark' }],
    ['undefined nodeId', { nodeId: undefined, nodeKind: 'folder' }],
    ['invalid nodeKind', { nodeId: 'node-1', nodeKind: 'widget' }],
    ['empty nodeKind', { nodeId: 'node-1', nodeKind: '' }],
  ] as const)(`rejects delete events with %s ${evidence}`, (_label, event) => {
    expect(() => translateSyncBrowserDelete(event as never)).toThrow(TypeError);
  });

  it(`rejects Root deletion through the generic event translator ${evidence}`, () => {
    expect(() => translateSyncBrowserEvent({
      type: 'delete',
      nodeId: 'root-1',
      nodeKind: 'root',
    })).toThrow(/Root deletion/u);
    expect(() => translateSyncBrowserEvent({
      type: 'delete',
      nodeId: 'root-1',
      nodeKind: 'root',
    })).toThrow(/Root deletion/u);
  });

  it.each([
    ['folder', 'delete_subtree'],
    ['bookmark', 'delete_node'],
  ] as const)(
    `routes delete %s through translateSyncBrowserEvent to %s ${evidence}`,
    (nodeKind, type) => {
      expect(translateSyncBrowserEvent({
        type: 'delete',
        nodeId: 'target-1',
        nodeKind,
      })).toMatchObject({ type, targetId: 'target-1' });
    },
  );

  it.each(['create', 'update', 'move'] as const)(
    `retains native %s kind without rewriting to a delete intent ${evidence}`,
    (type) => {
      expect(translateSyncBrowserEvent({
        type,
        nodeId: 'node-1',
        nodeKind: 'bookmark',
      })).toEqual({ type, targetId: 'node-1' });
      expect(translateSyncBrowserEvent({
        type,
        nodeId: 'node-1',
        nodeKind: 'folder',
      })).toEqual({ type, targetId: 'node-1' });
    },
  );

  it.each(['create', 'update', 'move'] as const)(
    `rejects %s events with invalid or missing shape fail-closed ${evidence}`,
    (type) => {
      expect(() => translateSyncBrowserEvent({
        type,
        nodeId: 'node-1',
        nodeKind: 'not-a-kind' as never,
      })).toThrow(TypeError);
      expect(() => translateSyncBrowserEvent({
        type,
        nodeId: '' as never,
        nodeKind: 'bookmark',
      })).toThrow(TypeError);
      expect(() => translateSyncBrowserEvent({
        type,
        nodeKind: 'bookmark',
      } as never)).toThrow(TypeError);
      expect(() => translateSyncBrowserEvent({
        type,
        nodeId: 'node-1',
      } as never)).toThrow(TypeError);
    },
  );

  it(`rejects unknown browser event types fail-closed ${evidence}`, () => {
    expect(() => translateSyncBrowserEvent({
      type: 'reorder' as never,
      nodeId: 'node-1',
      nodeKind: 'bookmark',
    })).toThrow(TypeError);
    expect(() => translateSyncBrowserEvent({
      type: 'reorder' as never,
      nodeId: 'node-1',
      nodeKind: 'bookmark',
    })).toThrow(/valid type/u);
  });
});
