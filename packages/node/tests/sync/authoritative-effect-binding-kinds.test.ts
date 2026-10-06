import { describe, expect, it, vi } from 'vitest';

import type { Operation } from '../../src/types/index.js';
import { canonicalAuthoritativeMemberDigest } from '../../src/sync/index.js';
import {
  WRONG_DIGEST,
  binding,
  effectBinding,
  evidence,
  fixture,
  folderNode,
  parentRevision,
  placement,
  tombstone,
} from './authoritative-effect-binding-fixture.js';

describe(`assertEffectBinding ${evidence}`, () => {
  describe('node_created', () => {
    it('rejects an effect Node kind that differs from the create DTO', () => {
      const { operation, effect } = fixture('create_node');
      const draft = { ...(effect as object), node: { ...folderNode, kind: 'bookmark', url: 'https://example.com/' } };
      expect(binding(operation, draft)).toThrow(/does not match its create DTO/);
    });

    it.each([
      ['node collectionId', { node: { ...folderNode, collectionId: 'collection-x' } }],
      ['placement parentId', {
        placement: { ...placement, parentId: 'folder-9' },
        node: { ...folderNode, parentId: 'folder-9' },
        parentRevision: { ...parentRevision, parentId: 'folder-9' },
      }],
      ['node parentId', { node: { ...folderNode, parentId: 'folder-9' } }],
      ['node position', { node: { ...folderNode, position: 'z' } }],
      ['parentRevision parentId', { parentRevision: { ...parentRevision, parentId: 'folder-9' } }],
    ])('rejects a non-authoritative %s', (_label, override) => {
      const { operation, effect } = fixture('create_node');
      expect(binding(operation, { ...(effect as object), ...override }))
        .toThrow(/placement or parent revision is not authoritative/);
    });

    it.each([
      ['bookmark carrying a children revision', 'bookmark', 'cr-node-1', true],
      ['folder without children revision', 'folder', null, true],
      ['bookmark without children revision', 'bookmark', null, false],
    ])('%s', (_label, kind, childrenRevision, rejects) => {
      const { operation } = fixture('create_node');
      const create = {
        ...operation, payload: { parentId: 'folder-2', node: { kind, title: 'Node' } },
      } as Operation;
      const node = {
        ...folderNode, kind,
        ...(kind === 'bookmark' ? { url: 'https://example.com/' } : {}),
      };
      const effect = {
        ...effectBinding, kind: 'node_created', node, placement, parentRevision,
        nodeChildrenRevision: childrenRevision,
      };
      const run = binding(create, effect);
      if (rejects) {
        expect(run).toThrow(/children revision/);
      } else {
        expect(run).not.toThrow();
      }
    });
  });

  describe('node_content_updated', () => {
    it.each([
      ['id', { node: { ...folderNode, id: 'node-9' } }],
      ['collectionId', { node: { ...folderNode, collectionId: 'collection-x' } }],
    ])('rejects an effect Node with a different %s', (_label, override) => {
      const { operation, effect } = fixture('update_node_content');
      expect(binding(operation, { ...(effect as object), ...override }))
        .toThrow(/does not match its target/);
    });
  });

  describe('node_moved', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['node id', { node: { ...folderNode, id: 'node-9' } }],
      ['node collectionId', { node: { ...folderNode, collectionId: 'collection-x' } }],
      ['placement parentId', {
        placement: { ...placement, parentId: 'folder-9' },
        node: { ...folderNode, parentId: 'folder-9' },
        parentRevisions: [
          { parentId: 'folder-1', childrenRevision: 'cr-8' },
          { parentId: 'folder-9', childrenRevision: 'cr-12' },
        ],
      }],
      ['node parentId', { node: { ...folderNode, parentId: 'folder-9' } }],
      ['node position', { node: { ...folderNode, position: 'z' } }],
      ['target revision parentId', {
        parentRevisions: [
          { parentId: 'folder-1', childrenRevision: 'cr-8' },
          { parentId: 'folder-3', childrenRevision: 'cr-12' },
        ],
      }],
      ['same source and target', {
        parentRevisions: [
          { parentId: 'folder-2', childrenRevision: 'cr-8' },
          { parentId: 'folder-2', childrenRevision: 'cr-12' },
        ],
      }],
      ['no parent revision', { parentRevisions: [] }],
      ['three parent revisions', {
        parentRevisions: [
          { parentId: 'folder-1', childrenRevision: 'cr-8' },
          { parentId: 'folder-9', childrenRevision: 'cr-9' },
          { parentId: 'folder-2', childrenRevision: 'cr-12' },
        ],
      }],
    ];
    it.each(cases)('rejects %s', (_label, override) => {
      const { operation, effect } = fixture('move_node');
      expect(binding(operation, { ...(effect as object), ...override }))
        .toThrow(/lacks authoritative source\/target parent revisions/);
    });

    it('accepts a single authoritative parent revision', () => {
      const { operation, effect } = fixture('move_node');
      expect(binding(operation, {
        ...(effect as object),
        parentRevisions: [{ parentId: 'folder-2', childrenRevision: 'cr-12' }],
      })).not.toThrow();
    });
  });

  describe('node_deleted', () => {
    it.each([
      ['deletion', 'resourceType', 'annotation'],
      ['deletion', 'targetId', 'node-9'],
      ['deletion', 'collectionId', 'collection-x'],
      ['deletion', 'operationId', 'op-9'],
      ['tombstone', 'resourceType', 'annotation'],
      ['tombstone', 'targetId', 'node-9'],
      ['tombstone', 'collectionId', 'collection-x'],
      ['tombstone', 'operationId', 'op-9'],
    ])('rejects a %s authority with mismatched %s', (field, key, value) => {
      const { operation, effect } = fixture('delete_node');
      const draft = {
        ...(effect as object),
        [field]: { ...tombstone(), [key]: value },
      };
      expect(binding(operation, draft)).toThrow(/not bound to the Operation/);
    });

    it.each([
      ['scope', { scope: 'subtree' }],
      ['affectedCount', { affectedCount: 2 }],
    ])('rejects matching deletion/tombstone with non-single %s', (_label, override) => {
      const { operation, effect } = fixture('delete_node');
      // Keep both authorities identical so only the scope/count guard can fire.
      const draft = {
        ...(effect as object),
        deletion: tombstone(override),
        tombstone: tombstone(override),
      };
      expect(binding(operation, draft)).toThrow(/exact single-node Tombstone/);
    });

    it('rejects a tombstone that differs from the deletion authority', () => {
      const { operation, effect } = fixture('delete_node');
      const draft = { ...(effect as object), tombstone: tombstone({ deleteCursor: 'cursor-delete-2' }) };
      expect(binding(operation, draft)).toThrow(/exact single-node Tombstone/);
    });
  });

  describe('node_restored', () => {
    it.each([
      ['id', { node: { ...folderNode, id: 'node-9', revision: 'r-restored' } }],
      ['collectionId', { node: { ...folderNode, collectionId: 'collection-x', revision: 'r-restored' } }],
    ])('rejects an effect Node with a different %s', (_label, override) => {
      const { operation, effect } = fixture('restore_node');
      expect(binding(operation, { ...(effect as object), ...override }))
        .toThrow(/does not match its original target/);
    });

    it('rejects reusing the consumed tombstone revision', () => {
      const { operation, effect } = fixture('restore_node');
      const draft = {
        ...(effect as object),
        node: { ...folderNode, revision: 'delete-r-1' },
      };
      expect(binding(operation, draft)).toThrow(/new Node revision/);
    });

    it.each([
      ['resourceType', 'annotation'],
      ['targetId', 'node-9'],
      ['collectionId', 'collection-x'],
      ['deleteCursor', 42],
      ['deleteCursor', ''],
    ])('rejects a consumed tombstone with %s %j', (key, value) => {
      const { operation, effect } = fixture('restore_node');
      const draft = {
        ...(effect as object),
        consumedTombstone: { ...tombstone(), [key]: value },
      };
      expect(binding(operation, draft)).toThrow(/consumed Tombstone is not bound/);
    });

    it.each([
      ['placement parentId', {
        placement: { ...placement, parentId: 'folder-9' },
        parentRevision: { ...parentRevision, parentId: 'folder-9' },
      }],
      ['node position', { node: { ...folderNode, position: 'z', revision: 'r-restored' } }],
      ['parentRevision parentId', { parentRevision: { ...parentRevision, parentId: 'folder-9' } }],
    ])('rejects a non-authoritative %s', (_label, override) => {
      const { operation, effect } = fixture('restore_node');
      expect(binding(operation, { ...(effect as object), ...override }))
        .toThrow(/placement or parent revision is not authoritative/);
    });
  });

  describe('subtree_deleted', () => {
    it.each([
      ['resourceType', 'annotation'],
      ['targetId', 'node-9'],
      ['collectionId', 'collection-x'],
      ['operationId', 'op-9'],
      ['scope', 'single'],
      ['affectedCount', 9],
    ])('rejects a root tombstone with %s %j', (key, value) => {
      const { operation, effect } = fixture('delete_subtree');
      const draft = {
        ...(effect as object),
        rootTombstone: tombstone({ scope: 'subtree', affectedCount: 1, [key]: value }),
      };
      expect(binding(operation, draft)).toThrow(/root Tombstone is not bound/);
    });

    it('rejects inline members shorter than memberCount', () => {
      const { operation, effect } = fixture('delete_subtree');
      const draft = {
        ...(effect as object),
        memberCount: 2,
        rootTombstone: tombstone({ scope: 'subtree', affectedCount: 2 }),
      };
      expect(binding(operation, draft)).toThrow(/memberCount does not match exact inline members/);
    });

    it('rejects inline members that exclude the deleted root', () => {
      const { operation, effect } = fixture('delete_subtree');
      const draft = {
        ...(effect as object),
        members: ['node-9'], memberDigest: canonicalAuthoritativeMemberDigest(['node-9']),
      };
      expect(binding(operation, draft)).toThrow(/must include the deleted root/);
    });

    it('rejects a memberDigest that does not match the inline members', () => {
      const { operation, effect } = fixture('delete_subtree');
      const draft = { ...(effect as object), memberDigest: WRONG_DIGEST };
      expect(binding(operation, draft)).toThrow(/memberDigest does not match/);
    });

    it.each([
      ['memberCount', { memberCount: 9 }],
      ['memberDigest', { memberDigest: WRONG_DIGEST }],
    ])('rejects an effect page reference whose %s disagrees with member authority', (key, value) => {
      const { operation, effect } = fixture('delete_subtree');
      const { members: _members, ...rest } = effect as unknown as Record<string, unknown>;
      const draft = {
        ...rest,
        effectRef: {
          pageCount: 1, memberCount: 1,
          memberDigest: canonicalAuthoritativeMemberDigest(['node-1']),
          firstPageDigest: WRONG_DIGEST, [key]: value,
        },
      };
      expect(binding(operation, draft)).toThrow(/page reference does not match member authority/);
    });

    it('consults the page-template assertion only when effectRef is present', () => {
      const { operation, effect } = fixture('delete_subtree');
      const { members: _members, ...rest } = effect as unknown as Record<string, unknown>;
      const memberDigest = canonicalAuthoritativeMemberDigest(['node-1']);
      const onPage = vi.fn();
      const options = {
        authority: 'https://sync.example',
        template: 'https://sync.example/effects/{effectId}/pages/{pageNumber}',
        onPage,
      };
      expect(binding(operation, {
        ...rest,
        effectRef: { pageCount: 1, memberCount: 1, memberDigest, firstPageDigest: WRONG_DIGEST },
      }, options)).not.toThrow();
      expect(onPage).toHaveBeenCalledTimes(1);
      expect(onPage).toHaveBeenCalledWith(
        'effect-1',
        'https://sync.example/effects/{effectId}/pages/{pageNumber}',
        'https://sync.example',
      );

      const inline = vi.fn();
      expect(binding(operation, effect, { onPage: inline })).not.toThrow();
      expect(inline).not.toHaveBeenCalled();
    });
  });
});
