import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  closeApiRuntimeResources,
  type ApiRuntimeResources,
} from '../../../src/bootstrap/api-lifecycle.js';
import type { ProductAdmissionRateLimiter } from '../../../src/transport/http-security.js';

function createMemoryRateLimiter(): ProductAdmissionRateLimiter {
  return {
    consume: () => ({ allowed: true }),
    reset: () => undefined,
    size: () => 0,
    evictions: () => 0,
    capacityRejections: () => 0,
  };
}

test('API cleanup attempts every resource and reports all close failures together', async () => {
  const calls: string[] = [];
  const failures = new Set([
    'emailProvider',
    'mcpChangeSignalSource',
    'followRateLimiter',
    'productRouteRateLimiters[0]',
    'avatarStore',
    'cacheComposition',
  ]);
  const record = (resource: string): void => {
    calls.push(resource);
    if (failures.has(resource)) throw new Error(`${resource} failed`);
  };
  const destroyable = (resource: string) => ({
    destroy: () => record(resource),
  });
  const closeable = (resource: string) => ({
    close: async () => record(resource),
  });
  const sharedRateLimiter = (resource: string): ProductAdmissionRateLimiter => ({
    purpose: 'follow',
    consume: async () => ({
      kind: 'allowed',
      decision: { allowed: true, retryAfterSeconds: 0 },
    }),
    readiness: () => ({
      status: 'healthy',
      reason: 'none',
      lastCheckedAtEpochMs: 0,
    }),
    close: async () => record(resource),
  });
  const memoryRateLimiter = createMemoryRateLimiter();
  const resources = {
    accountCredentialCursors: destroyable('accountCredentialCursors'),
    accountCredentialGrantCursors: destroyable('accountCredentialGrantCursors'),
    ownedCollectionsCursorSigner: destroyable('ownedCollectionsCursorSigner'),
    sharedCollectionsCursorSigner: destroyable('sharedCollectionsCursorSigner'),
    collaborationMembersCursorSigner: destroyable('collaborationMembersCursorSigner'),
    myCollaborationInvitesCursorSigner: destroyable('myCollaborationInvitesCursorSigner'),
    linkHealthCursorSigner: destroyable('linkHealthCursorSigner'),
    collectionVersionCursorSigner: destroyable('collectionVersionCursorSigner'),
    syncRuntime: destroyable('syncRuntime'),
    emailProvider: closeable('emailProvider'),
    authEmailComposition: closeable('authEmailComposition'),
    mcpCollectionResourceCursorKeys: destroyable('mcpCollectionResourceCursorKeys'),
    publicationCursorKeys: destroyable('publicationCursorKeys'),
    mcpChangeSignalSource: closeable('mcpChangeSignalSource'),
    authRateLimiter: closeable('authRateLimiter'),
    searchRateLimiter: closeable('searchRateLimiter'),
    exploreDirectoryRateLimiter: closeable('exploreDirectoryRateLimiter'),
    publicActivityRateLimiter: closeable('publicActivityRateLimiter'),
    syncColpRateLimiter: closeable('syncColpRateLimiter'),
    followRateLimiter: sharedRateLimiter('followRateLimiter'),
    collectionFollowRateLimiter: memoryRateLimiter,
    feedRateLimiter: memoryRateLimiter,
    notificationRateLimiter: memoryRateLimiter,
    productRouteRateLimiters: [sharedRateLimiter('productRouteRateLimiters[0]')],
    effectPageRateLimiter: closeable('effectPageRateLimiter'),
    collaborationInviteRateLimiter: closeable('collaborationInviteRateLimiter'),
    mcpRateLimiter: closeable('mcpRateLimiter'),
    emailCallbackRateLimiter: closeable('emailCallbackRateLimiter'),
    avatarStore: closeable('avatarStore'),
    cacheComposition: closeable('cacheComposition'),
    database: closeable('database'),
  } satisfies ApiRuntimeResources;

  let reported: unknown;
  try {
    await closeApiRuntimeResources(resources);
  } catch (error: unknown) {
    reported = error;
  }

  assert.ok(reported instanceof AggregateError);
  assert.equal(reported.errors.length, failures.size);
  for (const resource of failures) assert.match(reported.message, new RegExp(resource.replace('[', '\\[')));
  assert.deepEqual(calls, [
    'accountCredentialCursors',
    'accountCredentialGrantCursors',
    'ownedCollectionsCursorSigner',
    'sharedCollectionsCursorSigner',
    'collaborationMembersCursorSigner',
    'myCollaborationInvitesCursorSigner',
    'linkHealthCursorSigner',
    'collectionVersionCursorSigner',
    'syncRuntime',
    'emailProvider',
    'authEmailComposition',
    'mcpCollectionResourceCursorKeys',
    'publicationCursorKeys',
    'mcpChangeSignalSource',
    'authRateLimiter',
    'searchRateLimiter',
    'exploreDirectoryRateLimiter',
    'publicActivityRateLimiter',
    'syncColpRateLimiter',
    'followRateLimiter',
    'productRouteRateLimiters[0]',
    'effectPageRateLimiter',
    'collaborationInviteRateLimiter',
    'mcpRateLimiter',
    'emailCallbackRateLimiter',
    'avatarStore',
    'cacheComposition',
    'database',
  ]);
  assert.ok(calls.indexOf('database') > calls.indexOf('cacheComposition'));
});
