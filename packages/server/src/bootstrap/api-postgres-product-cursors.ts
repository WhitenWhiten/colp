import {
  createProductClassifyInboxCursorSigner,
  createProductCollectionVersionCursorSigner,
  createProductLinkHealthCursorSigner,
  createProductOwnedCollectionsCursorSigner,
  createProductSharedCollectionsCursorSigner,
} from '../modules/collections/index.js';
import {
  createProductCollaborationMembersCursorSigner,
  createProductMyCollaborationInvitesCursorSigner,
} from '../modules/access-policy/index.js';
import { loadConfig } from './config.js';

export function createApiPostgresProductCursors(config: ReturnType<typeof loadConfig>) {
  const owned = config.productOwnedCollectionsCursor;
  const keys = { current: owned.current, previous: owned.previous };
  return {
    ownedCollectionsCursorSigner: createProductOwnedCollectionsCursorSigner(keys),
    sharedCollectionsCursorSigner: createProductSharedCollectionsCursorSigner(keys),
    collaborationMembersCursorSigner: createProductCollaborationMembersCursorSigner(keys),
    myCollaborationInvitesCursorSigner: createProductMyCollaborationInvitesCursorSigner(keys),
    linkHealthCursorSigner: createProductLinkHealthCursorSigner({
      current: config.linkHealth.cursor.current,
      previous: config.linkHealth.cursor.previous,
    }),
    classifyInboxCursorSigner: createProductClassifyInboxCursorSigner({
      current: config.classifyInbox.cursor.current,
      previous: config.classifyInbox.cursor.previous,
    }),
    collectionVersionCursorSigner: createProductCollectionVersionCursorSigner({
      current: config.collectionHistory.cursor.current,
      previous: config.collectionHistory.cursor.previous,
    }),
  };
}
