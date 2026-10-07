import { isProductSurfaceRateLimiter, type ProductAdmissionRateLimiter } from '../transport/http-security.js';

export interface ApiRuntimeResources {
  readonly accountCredentialCursors: { destroy(): void };
  readonly accountCredentialGrantCursors: { destroy(): void };
  readonly ownedCollectionsCursorSigner: { destroy(): void };
  readonly sharedCollectionsCursorSigner: { destroy(): void };
  readonly collaborationMembersCursorSigner: { destroy(): void };
  readonly myCollaborationInvitesCursorSigner: { destroy(): void };
  readonly linkHealthCursorSigner: { destroy(): void };
  readonly classifyInboxCursorSigner: { destroy(): void };
  readonly collectionVersionCursorSigner: { destroy(): void };
  readonly syncRuntime?: { destroy(): void };
  readonly emailProvider?: { close(): Promise<void> };
  readonly authEmailComposition: { close(): Promise<void> };
  readonly mcpCollectionResourceCursorKeys?: { destroy(): void };
  readonly publicationCursorKeys: { destroy(): void };
  readonly mcpChangeSignalSource?: { close(): Promise<void> };
  readonly attachmentRateLimit?: { close(): Promise<void> };
  readonly authRateLimiter?: { close(): Promise<void> };
  readonly searchRateLimiter?: { close(): Promise<void> };
  readonly exploreDirectoryRateLimiter?: { close(): Promise<void> };
  readonly publicActivityRateLimiter?: { close(): Promise<void> };
  readonly syncColpRateLimiter?: { close(): Promise<void> };
  readonly followRateLimiter: ProductAdmissionRateLimiter;
  readonly collectionFollowRateLimiter: ProductAdmissionRateLimiter;
  readonly feedRateLimiter: ProductAdmissionRateLimiter;
  readonly notificationRateLimiter: ProductAdmissionRateLimiter;
  readonly productRouteRateLimiters: readonly ProductAdmissionRateLimiter[];
  readonly effectPageRateLimiter?: { close(): Promise<void> };
  readonly syncAdmissionPolicy?: { close(): Promise<void> };
  readonly publishingInsightsRateLimiter: { close(): Promise<void> };
  readonly collaborationInviteRateLimiter: { close(): Promise<void> };
  readonly mcpRateLimiter?: { close(): Promise<void> };
  readonly emailCallbackRateLimiter?: { close(): Promise<void> };
  readonly attachmentsObjectStorage?: { close?: () => Promise<void> };
  readonly avatarStore?: { close?: () => Promise<void> };
  readonly faviconStore?: { close?: () => Promise<void> };
  readonly linkPreviewStore?: { close?: () => Promise<void> };
  readonly cacheComposition: { close(): Promise<void> };
  readonly database: { close(): Promise<void> };
}

interface CloseFailure {
  readonly resource: string;
  readonly error: unknown;
}

function attemptDestroy(
  failures: CloseFailure[],
  resource: string,
  destroy: () => void,
): void {
  try {
    destroy();
  } catch (error: unknown) {
    failures.push({ resource, error });
  }
}

async function attemptClose(
  failures: CloseFailure[],
  resource: string,
  close: () => Promise<void>,
): Promise<void> {
  try {
    await close();
  } catch (error: unknown) {
    failures.push({ resource, error });
  }
}

async function attemptOptionalClose(
  failures: CloseFailure[],
  resource: string,
  closeable: { close(): Promise<void> } | undefined,
): Promise<void> {
  if (closeable !== undefined) {
    await attemptClose(failures, resource, () => closeable.close());
  }
}

export async function closeApiRuntimeResources(input: ApiRuntimeResources): Promise<void> {
  const failures: CloseFailure[] = [];
  attemptDestroy(failures, 'accountCredentialCursors', () => input.accountCredentialCursors.destroy());
  attemptDestroy(failures, 'accountCredentialGrantCursors', () => input.accountCredentialGrantCursors.destroy());
  attemptDestroy(failures, 'ownedCollectionsCursorSigner', () => input.ownedCollectionsCursorSigner.destroy());
  attemptDestroy(failures, 'sharedCollectionsCursorSigner', () => input.sharedCollectionsCursorSigner.destroy());
  attemptDestroy(
    failures,
    'collaborationMembersCursorSigner',
    () => input.collaborationMembersCursorSigner.destroy(),
  );
  attemptDestroy(
    failures,
    'myCollaborationInvitesCursorSigner',
    () => input.myCollaborationInvitesCursorSigner.destroy(),
  );
  attemptDestroy(failures, 'linkHealthCursorSigner', () => input.linkHealthCursorSigner.destroy());
  attemptDestroy(failures, 'classifyInboxCursorSigner', () => input.classifyInboxCursorSigner.destroy());
  attemptDestroy(failures, 'collectionVersionCursorSigner', () => input.collectionVersionCursorSigner.destroy());
  if (input.syncRuntime !== undefined) {
    const syncRuntime = input.syncRuntime;
    attemptDestroy(failures, 'syncRuntime', () => syncRuntime.destroy());
  }
  await attemptOptionalClose(failures, 'emailProvider', input.emailProvider);
  await attemptClose(failures, 'authEmailComposition', () => input.authEmailComposition.close());
  if (input.mcpCollectionResourceCursorKeys !== undefined) {
    const cursorKeys = input.mcpCollectionResourceCursorKeys;
    attemptDestroy(
      failures,
      'mcpCollectionResourceCursorKeys',
      () => cursorKeys.destroy(),
    );
  }
  attemptDestroy(failures, 'publicationCursorKeys', () => input.publicationCursorKeys.destroy());
  await attemptOptionalClose(failures, 'mcpChangeSignalSource', input.mcpChangeSignalSource);
  await attemptOptionalClose(failures, 'attachmentRateLimit', input.attachmentRateLimit);
  await attemptOptionalClose(failures, 'authRateLimiter', input.authRateLimiter);
  await attemptOptionalClose(failures, 'searchRateLimiter', input.searchRateLimiter);
  await attemptOptionalClose(failures, 'exploreDirectoryRateLimiter', input.exploreDirectoryRateLimiter);
  await attemptOptionalClose(failures, 'publicActivityRateLimiter', input.publicActivityRateLimiter);
  await attemptOptionalClose(failures, 'syncColpRateLimiter', input.syncColpRateLimiter);
  if (isProductSurfaceRateLimiter(input.followRateLimiter)) {
    const limiter = input.followRateLimiter;
    await attemptClose(failures, 'followRateLimiter', () => limiter.close());
  }
  if (isProductSurfaceRateLimiter(input.collectionFollowRateLimiter)) {
    const limiter = input.collectionFollowRateLimiter;
    await attemptClose(failures, 'collectionFollowRateLimiter', () => limiter.close());
  }
  if (isProductSurfaceRateLimiter(input.feedRateLimiter)) {
    const limiter = input.feedRateLimiter;
    await attemptClose(failures, 'feedRateLimiter', () => limiter.close());
  }
  if (isProductSurfaceRateLimiter(input.notificationRateLimiter)) {
    const limiter = input.notificationRateLimiter;
    await attemptClose(failures, 'notificationRateLimiter', () => limiter.close());
  }
  await Promise.all(input.productRouteRateLimiters.map(async (limiter, index) => {
    if (isProductSurfaceRateLimiter(limiter)) {
      await attemptClose(failures, `productRouteRateLimiters[${index}]`, () => limiter.close());
    }
  }));
  await attemptOptionalClose(failures, 'effectPageRateLimiter', input.effectPageRateLimiter);
  await attemptOptionalClose(failures, 'syncAdmissionPolicy', input.syncAdmissionPolicy);
  await attemptClose(failures, 'publishingInsightsRateLimiter', () => input.publishingInsightsRateLimiter.close());
  await attemptClose(failures, 'collaborationInviteRateLimiter', () => input.collaborationInviteRateLimiter.close());
  // FIX-M-018 graceful close: bounded + idempotent (memory adapter = no-op).
  await attemptOptionalClose(failures, 'mcpRateLimiter', input.mcpRateLimiter);
  // FIX-L-061 graceful close: bounded + idempotent (memory adapter = no-op).
  await attemptOptionalClose(failures, 'emailCallbackRateLimiter', input.emailCallbackRateLimiter);
  const faviconStore = input.faviconStore;
  if (faviconStore?.close !== undefined) {
    const close = faviconStore.close;
    await attemptClose(failures, 'faviconStore', () => close.call(faviconStore));
  }
  const linkPreviewStore = input.linkPreviewStore;
  if (linkPreviewStore?.close !== undefined) {
    const close = linkPreviewStore.close;
    await attemptClose(failures, 'linkPreviewStore', () => close.call(linkPreviewStore));
  }
  const avatarStore = input.avatarStore;
  if (avatarStore?.close !== undefined) {
    const close = avatarStore.close;
    await attemptClose(failures, 'avatarStore', () => close.call(avatarStore));
  }
  const objectStorage = input.attachmentsObjectStorage;
  if (objectStorage?.close !== undefined) {
    const close = objectStorage.close;
    await attemptClose(failures, 'attachmentsObjectStorage', () => close.call(objectStorage));
  }
  await attemptClose(failures, 'cacheComposition', () => input.cacheComposition.close());
  await attemptClose(failures, 'database', () => input.database.close());

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `API runtime resource close failed: ${failures.map(({ resource }) => resource).join(', ')}`,
    );
  }
}
