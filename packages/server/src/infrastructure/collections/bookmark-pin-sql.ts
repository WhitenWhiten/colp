import { BOOKMARK_PIN_EXTENSION } from '../../modules/collections/index.js';
import { nodeExtensionFlagSql } from '../database/node-extension-sql.js';

/** True when the node payload carries the bookmark pin; `alias` is a trusted table alias. */
export function bookmarkPinnedSql(alias: string): string {
  return nodeExtensionFlagSql(alias, BOOKMARK_PIN_EXTENSION, 'pinned');
}
