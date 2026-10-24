/** Synthetic IDs/titles in observed shapes. Fixture revision 1, 2026-10-24;
 * prototype observations 2026-10-23. No account/session data copied. */
export const fixtures = {
  nav: { code: 0, data: { isLogin: true, mid: 42 } },
  signedOut: { code: -101, data: { isLogin: false } },
  catalog: { code: 0, data: { list: [{ id: 101, title: 'Collection', media_count: 3 }, { id: 102, title: 'Collection', media_count: 0 }] } },
  missingCatalog: { code: 0, data: {} },
  ids: { code: 0, data: [{ id: 1, type: 2 }, { id: 2, type: 2 }, { id: 3, type: 12 }] },
  details: { code: 0, data: [{ id: 1, type: 2, title: 'Video', attr: 1 }, { id: 2, type: 2, title: '已失效视频', attr: 9 }] },
  empty: { code: 0, data: [] }, failure: { code: -412, data: null },
};
export const video = { id: 'video:av:1', identity: 'siteId', kind: 'video', url: 'https://www.bilibili.com/video/av1', title: 'Video' } as const;
export const observation = { type: 'favorite.confirmed', interactionId: 'interaction-1', item: video,
  memberships: { mode: 'delta', added: ['101'], removed: [] }, confirmation: { kind: 'siteResponse', operation: 'favorite.deal' } } as const;
export const envelope = { protocolVersion: 1, requestId: 'request-1', leaseId: 'lease-1', capability: 'private-capability' } as const;
export const partialPage = { status: 'ok', kind: 'items', collectionId: '101', page: {
  items: [{ item: video }], nextCursor: 'opaque-1', coverage: 'partial', consistency: 'bestEffort',
  omissions: [{ id: 'video:av:2', reason: 'invalid' }, { id: 'resource:12:3', reason: 'unsupported' }],
} } as const;
/** Structurally valid, semantically stale: lifecycle/lease admission must reject it. */
export const staleMessage = { ...envelope, leaseId: 'expired-lease', operation: 'emit', data: observation } as const;
