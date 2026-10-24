import type { SiteAdapter } from '../contracts.js';
import { BilibiliReader } from './reader.js';
import { createPageHttp, abortableSleep } from './http.js';
import { validMembershipHint } from '../schemas.js';
/** Site extraction only; transport, account fences and cleanup belong to the host runtime. */
export function createBilibiliAdapter(): SiteAdapter {
  const reader = new BilibiliReader(createPageHttp({ fetch, now: Date.now, sleep: abortableSleep }));
  return {
    detectSource: context => reader.detectSource(context),
    async start(context) {
      const hint = (event: Event) => {
        const value: unknown = (event as CustomEvent).detail;
        if (validMembershipHint(value)) void context.hint(value).catch(() => undefined);
      };
      context.document.defaultView?.addEventListener('known-bilibili-favorite-hint', hint);
      return () => context.document.defaultView?.removeEventListener('known-bilibili-favorite-hint', hint);
    },
    resolveItem: (context, url) => reader.resolveItem(url, context),
    readItem: (context, id) => reader.readItem(id, context),
    readMemberships: (context, query) => reader.readMemberships(query, context),
    readCollectionsPage: (context, cursor) => reader.readCollectionsPage(context.accountId, cursor, context),
    readItemsPage: (context, collectionId, cursor) => reader.readItemsPage(collectionId, cursor, context),
    clear: () => reader.clear(), importResume: 'restartAndDeduplicate',
  };
}
