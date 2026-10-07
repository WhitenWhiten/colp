import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  listCollectionMembers,
  type CollaborationMemberListItem,
  type CollaborationQueryPort,
} from '../../../src/modules/access-policy/index.js';
import { createTestCollaborationListCursors } from '../../support/collaboration-list-cursors.js';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const COLLECTION_ID = 'col-avatar';
const OWNER_SUBJECT = 'sub-owner';

function queryPort(members: readonly CollaborationMemberListItem[]): CollaborationQueryPort {
  return {
    async loadCollection() {
      return {
        id: COLLECTION_ID,
        title: 'Avatar shelf',
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'private',
        policyRevision: 'policy-1',
        deletedAt: null,
      };
    },
    async listMembers() {
      return members;
    },
    async listPendingInvites() {
      return [];
    },
    async listMyPendingInvites() {
      return [];
    },
  };
}

test('listCollectionMembers projects a safe avatarUrl and keeps initials', async () => {
  const page = await listCollectionMembers({
    facts: {
      async loadCollectionFacts() {
        return {
          collectionId: COLLECTION_ID,
          ownerSubjectId: OWNER_SUBJECT,
          visibility: 'private',
          policyRevision: 'policy-1',
          membershipRole: 'owner',
          deleted: false,
        };
      },
    },
    query: queryPort([
      {
        subjectId: OWNER_SUBJECT,
        role: 'owner',
        displayName: 'Ada Owner',
        email: 'ada@example.test',
        avatarUrl: 'https://cdn.example.test/ada.png',
        grantedAt: NOW,
      },
      {
        subjectId: 'sub-editor',
        role: 'editor',
        displayName: 'Ed Editor',
        email: 'ed@example.test',
        avatarUrl: 'javascript:alert(1)',
        grantedAt: NOW,
      },
      {
        subjectId: 'sub-viewer',
        role: 'viewer',
        displayName: 'Vie Wer',
        email: 'vie@example.test',
        avatarUrl: '',
        grantedAt: NOW,
      },
    ]),
    cursors: createTestCollaborationListCursors().members,
  }, {
    actor: { principalId: 'p-owner', subjectId: OWNER_SUBJECT, kind: 'account' },
    collectionId: COLLECTION_ID,
    now: NOW,
  });

  assert.equal(page.members[0]?.avatarUrl, 'https://cdn.example.test/ada.png');
  assert.equal(page.members[0]?.initials, 'AO');
  assert.equal(page.members[1]?.avatarUrl, null);
  assert.equal(page.members[1]?.initials, 'EE');
  assert.equal(page.members[2]?.avatarUrl, null);
  assert.equal(page.members[2]?.initials, 'VW');
});
