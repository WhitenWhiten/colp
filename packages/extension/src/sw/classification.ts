import { withDestinationPolicyBoundary } from '../classification-destination-boundary.js';
import { classificationDestinationPolicy } from './classification-destination.js';
import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { personalSyncFetch } from '../personal-sync-fetch.js';
import { isSubscriptionExcluded } from '../bookmark-subscriptions/guards.js';
import { localClassificationPreview } from './classification-local.js';
import { resolveClassificationNativeFolder } from '../classification-folder.js';
import { resolveIngressBoundary } from '../bookmark-event-ingress.js';
import { folderIsInMount, walkAncestorIds } from '../save-folder.js';
import { createClassificationProductClient, ClassificationProductError } from '../classification-product-client.js';
import type { ClassificationRequest } from '../classification-messages.js';
import type { AuthorityContext } from '../authority-fence.js';
import { loadConfig, currentSyncScope } from './scope.js';
import { store, syncState } from './runtime.js';
import { runPopupClassification } from './classification-preview.js';
import type { ClassificationPreviewMessage } from '../classification-preview-store.js';
import type { ClassificationPreviewReply } from '../classification-preview-reply.js';
import type { SyncScope } from '../sync-state-store.js';

export async function handleClassificationRequest(message: ClassificationRequest, context: AuthorityContext, sender?: chrome.runtime.MessageSender) {
  if (message.kind === 'known.classification.preview' || message.kind === 'known.classification.local-preview') {
    return runPopupClassification(message, context, sender, request => executePreview(request, context));
  }
  try {
    const { client, scope } = await classificationClient(context);
    if (message.kind === 'known.classification.session') return { ok: true as const, result: await client.session() };
    if (message.kind === 'known.classification.settings') return { ok: true as const, result: await client.settings(message.collectionId) };
    if (scope.collectionId !== message.collectionId) throw new ClassificationProductError('classification_scope_changed', 409);
    return { ok: true as const, result: null, nativeFolder: await resolveFolder(message.folderId, scope, context) };
  } catch (error) { return classificationFailure(error, false); }
}

async function executePreview(message: ClassificationPreviewMessage, context: AuthorityContext): Promise<ClassificationPreviewReply> {
  if (message.kind === 'known.classification.local-preview') return localClassificationPreview(message, context);
  try {
    const { client, scope } = await classificationClient(context, 'nodeId' in message.document ? message.document.nodeId : undefined);
    if (scope.collectionId !== message.collectionId) throw new ClassificationProductError('classification_scope_changed', 409);
    const result = await client.preview(message.collectionId, message.document, message.commandId);
    return { ok: true, result, nativeFolder: await resolveFolder(result.folder?.folderId ?? null, scope, context) };
  } catch (error) { return classificationFailure(error, true); }
}

async function classificationClient(context: AuthorityContext, nodeId?: string) {
  await classificationDestinationPolicy.assertCloudSupported();
  const config = await loadConfig(), credential = await store.loadCredential();
  if (!credential?.subject || credential.serverOrigin !== config.serverOrigin) throw new ClassificationProductError('reconnect_required', 401);
  const subject = credential.subject, scope = await currentSyncScope();
  if (scope.accountId !== subject) throw new ClassificationProductError('classification_scope_changed', 409);
  const client = createClassificationProductClient({ serverOrigin: config.serverOrigin, expectedAuthUserId: subject, signal: context.signal,
    fetch: personalSyncFetch(scope),
    dispatch: send => withDestinationPolicyBoundary(() => withSubscriptionRead(async () => {
      await classificationDestinationPolicy.assertCloudSupported();
      const mapped = nodeId && await syncState.getMappingByColpId(scope, nodeId);
      if (mapped && await isSubscriptionExcluded(mapped.nativeId)) throw new Error('subscription_classification_excluded');
      return send();
    })),
    async assertCurrent() {
      await store.fence.assertWritable(context.generation);
      const current = await store.loadCredential();
      if (current?.subject !== subject || current.serverOrigin !== config.serverOrigin) throw new ClassificationProductError('reconnect_required', 401);
    },
  });
  return { client, scope };
}

async function resolveFolder(folderId: string | null, scope: SyncScope, context: AuthorityContext) {
  const boundary = await resolveIngressBoundary(syncState, scope);
  const nativeFolder = await resolveClassificationNativeFolder(folderId, {
    mapping: id => syncState.getMappingByColpId(scope, id),
    native: async id => (await chrome.bookmarks.get(id).catch(() => []))[0],
    inScope: async id => !await isSubscriptionExcluded(id) && folderIsInMount(id,
      await walkAncestorIds(id, async parentId => (await chrome.bookmarks.get(parentId).catch(() => []))[0]?.parentId), boundary.selectedNative),
  });
  await store.fence.assertWritable(context.generation);
  const current = await currentSyncScope();
  if (current.collectionId !== scope.collectionId || current.replicaId !== scope.replicaId || current.generation !== scope.generation) {
    throw new ClassificationProductError('classification_scope_changed', 409);
  }
  return nativeFolder;
}

function classificationFailure(error: unknown, retrySafe: boolean) {
  return { ok: false as const, error: error instanceof ClassificationProductError ? error.code
    : error instanceof Error && (/^destination_policy_/u.test(error.message) || error.message === 'cloud_destination_policy_unsupported') ? error.message : 'classification_unavailable',
    status: error instanceof ClassificationProductError ? error.status : 0,
    sameRequestRetrySafe: error instanceof ClassificationProductError ? error.sameRequestRetrySafe : retrySafe };
}
