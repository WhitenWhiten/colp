import { prepareLocalSlot, rememberLocalSourceSave } from './local-save-runtime.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
import { createSemanticJobs, type SemanticJob } from './semantic-jobs.js';
import { semanticContext, scopedSemanticBindings, attachSemanticAssociation, importSharedSemantic } from './semantic-associations.js';
import { captureContent } from './semantic-scope.js';
import { managedSaves, managedClientForLibrary, projectManagedBinding } from './managed-runtime.js';
import { installSemanticSaveAuthorization } from './semantic-authorization.js';
import { siteLedger, SITE_RECOVERY_ALARM } from './source-runtime.js';
import { readSourceConnection } from './content-identity.js';
import { readConnectionAuthority } from './ledger.js';
import { identityDefinition } from './registry.js';
import { sourceDigest, sourcePrefixRange, get, put } from './source-db.js';
import { contentBindingKey } from './content-identity.js';
import type { ContentBindingRow } from './content-bindings.js';
import type { NativeBinding, Representation } from './contracts.js';
import type { SourceMount, SourcePolicyRecord } from './layout.js';
import type { PlannedNativeCommand } from './planned-types.js';
import type { SemanticClaimResult } from './managed-client.js';
import { representationKey } from './reservations.js';
import { assertCaptureScope } from '../sw/capture-native.js';
import { currentSyncScope } from '../sw/scope.js';
import { workCoordinator } from '../sw/runtime.js';
import { sameDestinationOwner } from './copy-identity.js';
import { assertContentNative } from './content-runtime.js';
import { assertSourceRoot, executePlannedNative, recoverPlannedNative } from '../sw/planned-capture.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { localClassificationEnabled, localClassificationCanRunOffline } from '../classification-local-session.js';
import { runLocalClassification } from '../sw/classification-local.js';
import { classificationDocument } from '../classification-intent.js';
import { classificationDestinationPolicy } from '../sw/classification-destination.js';
import { assertSourceRebound, assertRestoredItemAvailable } from './portable.js';
import { cursorPage } from '../sync-state/idb.js';
import { managedDestinations } from './managed-destinations.js';
import { executeLocalSave, recoverLocalSave } from './local-reuse-runtime.js';
const schedule = () => { scheduleSourceAlarm(Date.now() + 30000, SITE_RECOVERY_ALARM); };
async function mounts() { return managedDestinations(siteLedger.db); }
export async function assertSemanticDestination(binding: NativeBinding<'folder'>, digest?: string) {
  await assertSourceRoot(binding);
  const roots = new Set((await mounts()).map(m => m.root.nativeId));
  const seen = new Set<string>(); let id: string | undefined = binding.nativeId;
  while (id) {
    if (roots.has(id)) throw new Error('semanticDestinationMapped');
    if (seen.has(id) || seen.size >= 256) throw new Error('semanticDestinationUnavailable'); seen.add(id);
    id = (await chrome.bookmarks.get(id))[0]?.parentId;
  }
  await classificationDestinationPolicy.assertAllowed(binding.nativeId, digest);
}
async function authorize(job: SemanticJob) {
  const deviceId = await captureDeviceId();
  if (job.command && job.command.deviceId !== deviceId) throw new Error('semanticPaused');
  const current = await siteLedger.db.read<SemanticJob>('semanticJobs', job.id);
  if (!current || current.controlRevision !== job.controlRevision) throw new Error('semanticJobChanged');
  for (const source of current.sources) {
    const a = await readConnectionAuthority(siteLedger.db, source.connectionId), p = await siteLedger.db.read<SourcePolicyRecord>('meta', `policy:${source.connectionId}`);
    if (a?.enabled && p?.enabled && p.semantic === 'automatic' && p.policy.copies === 'sourceAndSemantic' && p.policy.revision === source.policyRevision
      && (!p.localDeviceId || p.localDeviceId === deviceId) && (!p.semanticOwner || sameDestinationOwner(p.semanticOwner, job.scope))
      && a.installationGeneration === source.installationGeneration && a.sourceSessionGeneration === source.sourceSessionGeneration) {
      await assertSourceRebound(siteLedger.db, source.connectionId); await assertRestoredItemAvailable(siteLedger.db, source.connectionId, job.content.itemId); return;
    }
  }
  throw new Error('semanticPaused');
}
async function beforeClassify() {
  if (!await localClassificationEnabled()) throw new Error('local_key_required');
  if (navigator.onLine === false && !await localClassificationCanRunOffline()) throw new Error('semanticOffline');
}
export const semanticJobs = createSemanticJobs(siteLedger.db, {
  authorize,
  async existing(job) {
    const identity = captureContent(job.content);
    let bindings = await scopedSemanticBindings(identity, job.scope, job.scopeId);
    if (!bindings.length && await importSharedSemantic(identity, job.scope, job.scopeId, job.connections, job.id))
      bindings = await scopedSemanticBindings(identity, job.scope, job.scopeId);
    if (bindings.length > 1) throw new Error('semanticBindingNeedsReview');
    const b = bindings[0];
    if (b?.state === 'suppressed') return { status: 'suppressed' };
    if (b?.state === 'detached') return { status: 'detached' };
    if (b?.native) {
      await assertContentNative(b.native, { title: b.title, parentId: b.parentId, url: b.url });
      await assertSemanticDestination({ bindingId: 'semantic-parent', deviceId: b.native.deviceId, nativeId: b.parentId, kind: 'folder',
        dateAdded: (await chrome.bookmarks.get(b.parentId))[0]?.dateAdded ?? null, proof: { kind: 'explicitAdoption', id: b.id } });
      return { status: 'saved', native: b.native, written: { title: b.title, parentId: b.parentId, url: b.url }, shared: b.shared };
    }
    if (b && b.captureIntentId !== job.id) throw new Error('semantic_save_pending');
    return { status: 'missing' };
  },
  async claim(job) {
    const claim = undefined;
    const identity = captureContent(job.content);
    await siteLedger.db.transaction(['contentBindings'], 'readwrite', async tx => {
      const key = contentBindingKey(identity, job.id), current = await get<ContentBindingRow>(tx, 'contentBindings', key);
      if (current?.native) throw new Error('sourceSyncPending');
      put(tx, 'contentBindings', key, current ?? { id: job.id, content: identity, scopeId: job.scopeId, scopeVersion: 2, purpose: 'semantic', native: null,
        captureIntentId: job.id, commandId: job.id, connectionId: job.connections[0] ?? null, sourceConnections: job.connections,
        requestDigest: sourceDigest({ content: job.content, scopeId: job.scopeId }), state: 'pending', mode: 'create', policyRevision: null,
        title: job.title, url: job.url, parentId: '', forceAnother: true } satisfies ContentBindingRow);
    });
    return { status: 'claimed', claim };
  },
  async release(job) {
    const context = await semanticContext(); if (!context.library || !job.claim) return;
    const client = await managedClientForLibrary(context.library);
    await client.call('managed.semantic.release', { collectionId: context.library.collectionId, copy: { purpose: 'semantic', content: job.content }, claim: job.claim });
  },
  beforeClassify,
  async classify(job) {
    return workCoordinator.run('local-classification', async context => {
      await beforeClassify(); await authorize(job);
      const reply = await runLocalClassification({ document: classificationDocument(job, { folder: true, tags: false }), commandId: job.providerCommandId,
        generation: context.generation, signal: context.signal, excludedFolderIds: (await mounts()).map(m => m.root.nativeId), assertCurrent: () => authorize(job) });
      if (!reply.ok) throw new Error(reply.error);
      if (!reply.nativeFolder || reply.result.folder?.decision === 'later') throw new Error('semanticChooseFolder');
      const node = (await chrome.bookmarks.get(reply.nativeFolder.nativeId))[0];
      const folder: NativeBinding<'folder'> = { bindingId: crypto.randomUUID(), deviceId: await captureDeviceId(), kind: 'folder', nativeId: node!.id,
        dateAdded: node!.dateAdded ?? null, proof: { kind: 'explicitAdoption', id: job.id } };
      await assertSemanticDestination(folder, reply.destinationPolicyDigest);
      return { folder, tags: [], destinationDigest: reply.destinationPolicyDigest };
    });
  },
  async prepare(job, selection) {
    await assertSemanticDestination(selection.folder, selection.destinationDigest);
    if ((await semanticContext(selection.folder.nativeId)).scopeId !== job.scopeId) throw new Error('semanticDestinationOutsideLibrary');
    const representation = { connectionId: job.connections[0]!, itemId: job.content.itemId, purpose: 'semantic' as const, sourceCollectionId: null, mountId: null, scopeId: job.scopeId };
    const command: PlannedNativeCommand = { commandId: `semantic:${job.id}`, ownerId: job.id, logicalDigest: sourceDigest({ jobId: job.id, content: job.content, selection }),
      connectionId: representation.connectionId, kind: 'bookmark', parent: selection.folder, title: job.title, deviceId: await captureDeviceId(),
      bookmark: { planId: job.id, effectId: 'semantic', representation, url: job.url, scope: job.scope, source: 'site-import' } };
    return prepareLocalSlot(command, { kind: 'bookmark', copy: { purpose: 'semantic', content: job.content } });
  },
  async execute(job, recover) {
    const command = job.command!;
    if (recover) return command.managed ? managedSaves.recover(command) : recoverLocalSave(command, sourceDigest(command));
    await assertSemanticDestination(command.parent, job.selection?.destinationDigest);
    return command.managed ? managedSaves.execute(command, () => authorize(job)) : executeLocalSave(command, sourceDigest(command), () => authorize(job));
  },
  async finish(job, native, written, shared) {
    const current = await siteLedger.db.read<SemanticJob>('semanticJobs', job.id);
    if (!current || current.controlRevision !== job.controlRevision) throw new Error('semanticJobChanged');
    shared ??= job.command?.local ? await siteLedger.db.read<import('./managed-client.js').ManagedReference>('meta', `localShared:${job.command.commandId}`) : undefined;
    await attachSemanticAssociation({ identity: captureContent(job.content), scopeId: job.scopeId, id: job.id, connections: current.connections, native, written, managed: job.command?.managed, shared });
    if (!job.command?.managed && job.claim) {
      const context = await semanticContext();
      if (context.library) await (await managedClientForLibrary(context.library)).call('managed.semantic.release', {
        collectionId: context.library.collectionId, copy: { purpose: 'semantic', content: job.content }, claim: job.claim,
      });
    }
  }, schedule,
});
export function installSemanticRuntime() {
  installSemanticSaveAuthorization(async task => {
    const job = task.planned && await siteLedger.db.read<SemanticJob>('semanticJobs', task.planned.planId);
    if (!job?.command || job.command.commandId !== task.commandId || sourceDigest(job.command) !== task.planned?.resolvedDigest
      || job.command.bookmark?.url !== task.url || job.command.parent.nativeId !== task.targetNativeId) throw new Error('semanticJobChanged');
    await authorize(job); await assertSemanticDestination(job.command.parent, job.selection?.destinationDigest);
  });
}
export async function enqueueSourceSemantics(connectionId: string) {
  const authority = await readConnectionAuthority(siteLedger.db, connectionId), policy = await siteLedger.db.read<SourcePolicyRecord>('meta', `policy:${connectionId}`);
  if (!authority?.enabled || !policy?.enabled || policy.semantic !== 'automatic' || policy.policy.copies !== 'sourceAndSemantic') return;
  const context = await semanticContext();
  if (policy.localDeviceId && policy.localDeviceId !== await captureDeviceId()) return false;
  if (policy.semanticOwner && !sameDestinationOwner(policy.semanticOwner, context.scope)) return false;
  const connection = await readSourceConnection(siteLedger.db, connectionId), definition = identityDefinition(connection.siteKey, connection.identityVersion);
  const revision = await siteLedger.db.read<number>('meta', `semanticSourceRevision:${connectionId}`) ?? 0;
  const scanKey = `semanticScan:${connectionId}`, signature = sourceDigest({ scopeId: context.scopeId, policy: policy.policy.revision, authority });
  const previous = await siteLedger.db.read<{ signature: string; revision: number; after?: string; done: boolean }>('meta', scanKey);
  const scan = previous?.signature === signature && previous.revision === revision ? previous : { signature, revision, done: false };
  if (scan.done) return false;
  const prefix = sourcePrefixRange(connectionId), range = scan.after ? IDBKeyRange.bound(scan.after, prefix.upper, true) : prefix;
  const representations = await siteLedger.db.transaction(['representations'], 'readonly', tx => cursorPage<Representation>(tx.objectStore('representations'), range, 20));
  for (const r of representations) {
    if (r.purpose !== 'sourceArchive' || r.state !== 'active') continue;
    const item = (await siteLedger.db.read<{ entity: import('./contracts.js').SiteItem }>('items', JSON.stringify([connectionId, r.itemId])))?.entity;
    if (!item || item.identity !== 'siteId') continue;
    await semanticJobs.enqueue({ scopeId: context.scopeId, scope: context.scope, content: { site: connection.siteKey, identityVersion: connection.identityVersion,
      itemId: item.id, accountId: definition.contentIdScope === 'site' ? null : connection.accountId }, title: item.title, url: item.url,
      source: { connectionId, policyRevision: policy.policy.revision, installationGeneration: authority.installationGeneration, sourceSessionGeneration: authority.sourceSessionGeneration } });
  }
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', scanKey,
    { ...scan, after: representations.length ? representationKey(representations.at(-1)!) : scan.after, done: representations.length < 20 }));
  return representations.length === 20;
}
