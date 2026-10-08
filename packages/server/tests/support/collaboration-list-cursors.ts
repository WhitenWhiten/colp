import {
  createProductCollaborationMembersCursorSigner,
  createProductMyCollaborationInvitesCursorSigner,
} from '../../src/modules/access-policy/index.js';

const TEST_COLLABORATION_LIST_CURSOR_KEYS = {
  current: { id: 'test-collab-v1', key: 'test-collaboration-list-cursor-key' },
} as const;

export function createTestCollaborationListCursors() {
  return {
    members: createProductCollaborationMembersCursorSigner(TEST_COLLABORATION_LIST_CURSOR_KEYS),
    myInvites: createProductMyCollaborationInvitesCursorSigner(TEST_COLLABORATION_LIST_CURSOR_KEYS),
  };
}
