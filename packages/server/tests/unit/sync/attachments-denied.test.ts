import { describe, expect, it } from 'vitest';
import type { SnapshotNode } from '@know-n/colp/types';
import { createAttachmentExposurePolicyAdapter } from '../../../src/infrastructure/database/attachment-exposure-policy-adapter.js';
import {
  createSyncBootstrapSnapshotService,
  type SyncBootstrapAuthority,
} from '../../../src/modules/sync/index.js';

/**
 * Mirrors the P3-09 bootstrap Snapshot fixture. The composed deny adapter is
 * the production exposure port: it resolves without reading attachment history,
 * and the Snapshot projection stays `attachments: []`.
 */
const denyAttachments = createAttachmentExposurePolicyAdapter({
  async listBlobFacts() {
    throw new Error('must not read attachment history');
  },
});

function authority(nodes: readonly SnapshotNode[]): SyncBootstrapAuthority {
  return {
    async load() {
      return {
        sessionId: 'ses_1', collectionId: 'col_1', replicaId: 'rep_1', leaseGeneration: 3,
        sessionExpiresAt: '2099-07-25T10:15:00.000Z', replicaState: 'active',
        bindingMode: 'whole-profile', bindingRootNodeId: 'root_1',
        contentRevision: 'rev_7', policyRevision: 'policy_4', bootstrapCursor: 'ack_7',
        generatedAt: '2026-07-25T10:00:00.000Z',
        collection: {
          schemaVersion: '0.1', id: 'col_1', kind: 'bookmarks', title: 'Canonical',
          rootNodeId: 'root_1', visibility: 'private', createdAt: '2026-07-25T09:00:00.000Z',
          updatedAt: '2026-07-25T10:00:00.000Z', revision: 'rev_7',
        },
        nodes,
      };
    },
  };
}

const root: SnapshotNode = {
  id: 'root_1', collectionId: 'col_1', kind: 'root', parentId: null, position: null,
  folderRole: 'root', title: 'Canonical', createdAt: '2026-07-25T09:00:00.000Z',
  updatedAt: '2026-07-25T10:00:00.000Z', revision: 'rev_7',
};

describe('A3 Sync bootstrap Snapshot denies attachments', () => {
  it('keeps attachments empty when the deny adapter is composed', async () => {
    const service = createSyncBootstrapSnapshotService({
      authority: authority([root]),
      cursorSecret: 'x'.repeat(32),
      now: () => Date.parse('2026-07-25T10:00:00Z'),
      attachmentExposure: denyAttachments,
    });
    const page = await service.query({ sessionId: 'ses_1' });
    expect(page.mode).toBe('sync');
    expect(page.attachments).toEqual([]);
  });
});
