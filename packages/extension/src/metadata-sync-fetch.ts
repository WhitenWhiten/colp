import { browserMetadataSyncPolicy, type MetadataPolicyScope, type createMetadataSyncPolicyStore } from './metadata-sync-policy.js';
import { personalSyncFetch } from './personal-sync-fetch.js';
import { withSubscriptionRead } from './bookmark-subscriptions/barrier.js';

/** Admit metadata at the underlying fetch, after personal-policy and subscription waits. */
export function metadataSyncFetch(scope: MetadataPolicyScope, fetcher: typeof fetch = fetch,
  policy: ReturnType<typeof createMetadataSyncPolicyStore> = browserMetadataSyncPolicy()): typeof fetch {
  const consent = policy.capture(scope); void consent.catch(() => undefined);
  return personalSyncFetch(scope, fetcher, async send => {
    const captured = await consent;
    return withSubscriptionRead(() => policy.dispatch(scope, send, captured.revision));
  });
}
