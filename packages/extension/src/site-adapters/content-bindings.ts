import { copiesInScope } from './copy-scope.js';
import { managedLibraryKey } from './copy-identity.js';
import type { CaptureContentBinding, NativeBinding, Representation, RepresentationKey, SavePolicy } from './contracts.js';
import { get, put, rows, sourceDigest, type SourceDatabase } from './source-db.js';
import { representationKey, type ItemReservation } from './reservations.js';
import { identityDefinition, resolveContentIdentity, sitesLoaded } from './registry.js';
import { contentBindingKey as contentKey, readSourceConnection, sameContentIdentity } from './content-identity.js';
import { semanticIndexKey, type SemanticJob } from './semantic-jobs.js';
import { managedContent } from './semantic-scope.js';
import { managedReference } from './managed-changes.js';
import type { SourcePolicyRecord } from './layout.js';
import type { SourceAuthority } from './ledger-types.js';
import { assertSourceRebound, assertRestoredItemAvailable } from './portable.js';
export interface ContentBindingRow extends CaptureContentBinding {
  copyPolicy?: SavePolicy['copies'];
  scopeVersion?: 2;
  shared?: import('./managed-client.js').ManagedReference;
  managed?: import('./managed-client.js').ManagedDestination; managedParent?: NativeBinding<'folder'>;
  intentPending?: boolean; requestDigest: string; sourceGeneration?: readonly [number, number]; supersededBy?: string; commandId: string; state: 'pending' | 'active' | 'detached' | 'suppressed';
  forceAnother?: boolean; mode: 'create' | 'reuse' | 'reclassify' | 'suggest'; policyRevision: number | null;
  title: string; url: string; parentId: string; reuse?: Representation;
}
export interface CachedContentCopy {
  native: NativeBinding<'bookmark'>; purpose: 'sourceArchive' | 'semantic'; shared: import('./managed-client.js').ManagedReference;
  title: string; url: string; parentId: string;
}
const semanticKey = (connectionId: string, itemId: string, scopeId?: string): RepresentationKey => ({ connectionId, itemId, purpose: 'semantic', sourceCollectionId: null, mountId: null, ...(scopeId ? { scopeId } : {}) });
export const contentIdentityFromUrl = resolveContentIdentity;
/** One source-store transaction arbitrates semantic and source intents, including account-independent pending saves. */
export function createContentBindings(db: SourceDatabase, assertNative: (native: NativeBinding<'bookmark'>, expected?: { title: string; parentId: string; url?: string }) => Promise<void>) {
  async function validate(binding: ContentBindingRow) {
    if (binding.state === 'detached' || binding.state === 'suppressed') throw new Error('content_binding_needs_review');
    if (binding.native) await assertNative(binding.native, { title: binding.title, parentId: binding.parentId, url: binding.url });
  }
  return {
    async prepare(input: { cached?: CachedContentCopy; content?: import('./contracts.js').ContentIdentity; scopeId?: string; managed?: ContentBindingRow['managed']; managedParent?: NativeBinding<'folder'>; itemId: string; commandId: string; captureIntentId: string; title: string; url: string; parentId: string; automatic: boolean }) {
      await sitesLoaded(); const identity = input.content ?? resolveContentIdentity(input.url);
      if (!identity || identity.itemId !== input.itemId) throw new Error('content_identity_unresolved');
      const definition = identityDefinition(identity.siteKey, identity.identityVersion);
      const candidates = await db.transaction(['contentBindings'], 'readonly', async tx => (await rows<ContentBindingRow>(tx, 'contentBindings', identity.siteKey, identity.identityVersion, input.itemId))
        .filter(b => !b.supersededBy && sameContentIdentity(b.content, identity) && (input.scopeId === undefined || b.scopeId === input.scopeId)));
      for (const b of candidates) await validate(b);
      const a = await db.read<SourceAuthority>('authorities', definition.adapterId);
      if (identity.accountId && (!a?.enabled || a.accountId !== identity.accountId)) throw new Error('content_identity_unresolved');
      const settings = a?.enabled && a.connectionId ? await db.read<SourcePolicyRecord>('meta', `policy:${a.connectionId}`) : undefined;
      if (input.cached && settings?.enabled && settings.policy.copies !== 'sourceAndSemantic') {
        if (input.scopeId !== managedLibraryKey(input.cached.shared.library)) throw Error('content_binding_needs_review');
        await assertNative(input.cached.native, input.cached);
      }
      const connectionId = settings?.enabled ? settings.connectionId : candidates[0]?.connectionId ?? null;
      if (connectionId) await assertSourceRebound(db, connectionId);
      if (connectionId) await assertRestoredItemAvailable(db, connectionId, input.itemId);
      const reps = connectionId ? await db.transaction(['representations', 'mounts'], 'readonly', async tx => await copiesInScope(tx, await rows<Representation>(tx, 'representations', connectionId, input.itemId), input.scopeId, r => r)) : [];
      for (const r of reps) {
        // Independent semantic saves do not reuse or repair source-archive copies.
        if (settings?.policy.copies === 'sourceAndSemantic' && r.purpose === 'sourceArchive') continue;
        if (r.state !== 'active') throw new Error('content_binding_needs_review');
        await assertNative(r.native, r.lastWritten ? { ...r.lastWritten, url: r.lastWritten.url ?? definition.itemUrl(r.itemId) ?? undefined } : undefined);
      }
      return db.transaction(['contentBindings', 'itemReservations', 'representations', 'meta', 'authorities', 'semanticJobs', 'semanticIndexes', 'mounts'], 'readwrite', async tx => {
        const history = (await rows<ContentBindingRow>(tx, 'contentBindings', identity.siteKey, identity.identityVersion, input.itemId))
          .filter(b => sameContentIdentity(b.content, identity) && (input.scopeId === undefined || b.scopeId === input.scopeId));
        if (input.scopeId) {
          const jobId = await get<string>(tx, 'semanticIndexes', semanticIndexKey(input.scopeId, managedContent(identity)));
          const job = jobId ? await get<SemanticJob>(tx, 'semanticJobs', jobId) : undefined;
          if (job?.state === 'pending') throw new Error('semantic_save_pending');
        }
        const current = history.filter(b => !b.supersededBy);
        if (sourceDigest(current) !== sourceDigest(candidates)) throw new Error('content_binding_changed');
        const requestDigest = sourceDigest({ content: identity, commandId: input.commandId, url: input.url, title: input.title, parentId: input.parentId, automatic: input.automatic });
        const replay = history.find(b => b.commandId === input.commandId); if (replay) { if (replay.requestDigest !== requestDigest && replay.requestDigest !== sourceDigest({ commandId: input.commandId, url: input.url, title: input.title, parentId: input.parentId, automatic: input.automatic })) throw new Error('command_id_reused'); return replay; }
        if (current.length > 1) throw new Error('content_adoption_required');
        const old = current[0];
        if (old?.connectionId && old.connectionId !== connectionId && !(input.scopeId && old.scopeId === input.scopeId
          && !identity.accountId && settings?.policy.copies === 'sourceAndSemantic')) throw new Error('content_account_adoption_required');
        if (old?.native === null || old?.intentPending) throw new Error('semantic_save_pending');
        const policy = settings?.policy;
        if (connectionId && settings && sourceDigest(await get(tx, 'meta', `policy:${connectionId}`)) !== sourceDigest(settings)) throw new Error('source_policy_changed');
        const latest = connectionId ? await copiesInScope(tx, await rows<Representation>(tx, 'representations', connectionId, input.itemId), input.scopeId, r => r) : [];
        if (sourceDigest(latest) !== sourceDigest(reps)) throw new Error('content_binding_changed');
        const semantic = latest.find(r => r.purpose === 'semantic');
        const copies = [...new Map(latest.map(r => [r.native.nativeId, r])).values()];
        if (policy && policy.copies !== 'sourceAndSemantic' && copies.length > 1) throw new Error('multiple_copies_need_review');
        const reuse = semantic ?? (policy && policy.copies !== 'sourceAndSemantic' ? copies[0] : undefined);
        const cached = !reuse && !old?.native && policy && policy.copies !== 'sourceAndSemantic' ? input.cached : undefined;
        const native = reuse?.native ?? old?.native ?? cached?.native ?? null;
        const pending = !native && connectionId ? await copiesInScope(tx, await rows<ItemReservation>(tx, 'itemReservations', connectionId, input.itemId), input.scopeId, r => r.representation) : [];
        if (pending.some(r => r.representation.purpose === 'semantic' || policy?.copies !== 'sourceAndSemantic')) throw new Error('source_save_pending');
        // A source bookmark can already exist while its representation receipt is still committing.
        const sourceCopy = copies.length > 0 || pending.some(r => r.representation.purpose === 'sourceArchive' && r.state !== 'blocked');
        const mode = !native ? 'create' : semantic || old?.native || cached?.purpose === 'semantic' ? 'reuse' : policy?.copies === 'singlePreferSemantic' ? 'reclassify' : 'suggest';
        const id = crypto.randomUUID();
        const binding: ContentBindingRow = { id, ...(input.scopeId ? { scopeId: input.scopeId, scopeVersion: 2 } : {}),
          ...(old?.shared ?? reuse?.shared ?? cached?.shared ? { shared: old?.shared ?? reuse?.shared ?? cached?.shared } : {}),
          ...(!native && input.managed ? { managed: input.managed, managedParent: input.managedParent } : {}),
          sourceConnections: [...new Set([...old?.sourceConnections ?? [], ...old?.connectionId ? [old.connectionId] : [], ...connectionId ? [connectionId] : []])],
          intentPending: mode === 'reclassify' && input.automatic, requestDigest, ...(connectionId && a ? { sourceGeneration: [a.installationGeneration, a.sourceSessionGeneration] as const } : {}), content: identity,
          captureIntentId: input.captureIntentId, commandId: input.commandId, purpose: 'semantic', connectionId, native, state: native ? 'active' : 'pending', mode,
          forceAnother: !native && sourceCopy && policy?.copies === 'sourceAndSemantic', policyRevision: policy?.revision ?? null, ...(policy ? { copyPolicy: policy.copies } : {}),
          title: reuse?.lastWritten?.title ?? old?.title ?? cached?.title ?? input.title, url: old?.url ?? reuse?.lastWritten?.url ?? cached?.url ?? (reuse ? definition.itemUrl(input.itemId) ?? input.url : input.url),
          parentId: reuse?.lastWritten?.parentId ?? old?.parentId ?? cached?.parentId ?? input.parentId, ...(reuse ? { reuse } : {}) };
        // Reuse one content binding, preserving its original creation receipt separately from this semantic intent.
        if (old) put(tx, 'contentBindings', contentKey(identity, old.id), { ...old, supersededBy: id });
        put(tx, 'contentBindings', contentKey(identity, id), binding);
        if (connectionId) {
          const key = semanticKey(connectionId, input.itemId, input.scopeId);
          if (native && mode === 'reuse') put(tx, 'representations', representationKey(key), { ...key, native, state: 'active', manualRevision: 0,
            lastWritten: { title: binding.title, parentId: binding.parentId, url: binding.url } } satisfies Representation);
          put(tx, 'itemReservations', representationKey(key), { id, representation: key, commandId: input.commandId, payloadDigest: sourceDigest({ content: binding.content, mode }),
            state: native ? 'confirmed' : 'reserved' } satisfies ItemReservation);
        }
        return binding;
      });
    },
    async forIntent(id: string) { return db.transaction(['contentBindings'], 'readonly', tx => new Promise<ContentBindingRow | undefined>((resolve, reject) => {
      const r = tx.objectStore('contentBindings').index('captureIntentId').get(id);
      r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
    })); },
    async acknowledge(binding: ContentBindingRow, native: NativeBinding<'bookmark'>, node: { title: string; parentId: string }, mode?: ContentBindingRow['mode']) {
      await assertNative(native, node);
      return db.transaction(['contentBindings', 'representations', 'itemReservations', 'meta'], 'readwrite', async tx => {
        const key = contentKey(binding.content, binding.id), old = await get<ContentBindingRow>(tx, 'contentBindings', key);
        if (!old || old.native && old.native.nativeId !== native.nativeId || old.state === 'suppressed' || old.state === 'detached') throw new Error('content_binding_changed');
        const shared = old.shared ?? await managedReference(tx, old.managed);
        put(tx, 'contentBindings', key, { ...old, ...(shared ? { shared } : {}), native, ...node, mode: mode ?? old.mode, state: 'active', intentPending: false });
        if (old.connectionId) {
          const rep = semanticKey(old.connectionId, old.content.itemId, old.scopeId);
          if ((mode ?? old.mode) !== 'suggest') put(tx, 'representations', representationKey(rep), { ...rep, ...(shared ? { shared } : {}), native, state: 'active', manualRevision: 0, lastWritten: { ...node, url: old.url } } satisfies Representation);
          const reservation = await get<ItemReservation>(tx, 'itemReservations', representationKey(rep));
          if (reservation) put(tx, 'itemReservations', representationKey(rep), { ...reservation, state: 'confirmed' });
        }
      });
    },
    async adopt(binding: ContentBindingRow, native: NativeBinding<'bookmark'>, node: { title: string; parentId: string; url: string }, connectionId: string | null, allowAccountChange = false) {
      if (native.proof.kind !== 'explicitAdoption') throw new Error('explicit_adoption_required');
      if (binding.connectionId && binding.connectionId !== connectionId && !allowAccountChange) throw new Error('content_account_adoption_required');
      await assertNative(native, node);
      return db.transaction(['contentBindings', 'representations', 'itemReservations', 'mounts'], 'readwrite', async tx => {
        const key = contentKey(binding.content, binding.id), current = await get<ContentBindingRow>(tx, 'contentBindings', key);
        if (!current || sourceDigest(current) !== sourceDigest(binding) || current.supersededBy) throw new Error('content_binding_changed');
        const next: ContentBindingRow = { ...current, ...node, native, connectionId, state: 'active', mode: 'suggest' };
        put(tx, 'contentBindings', key, next);
        if (connectionId) {
          const rep = semanticKey(connectionId, binding.content.itemId, binding.scopeId);
          put(tx, 'representations', representationKey(rep), { ...rep, native, state: 'active', manualRevision: 0, lastWritten: node } satisfies Representation);
          const reserved = await get<ItemReservation>(tx, 'itemReservations', representationKey(rep));
          if (reserved) put(tx, 'itemReservations', representationKey(rep), { ...reserved, state: 'confirmed' });
        }
        return next;
      });
    },
    /** Called before a source folder/item reservation. No native writes and no URL-based adoption. */
    async sourceDecision(input: { connectionId: string; itemId: string; scopeId?: string; policy: SavePolicy; representation: RepresentationKey }) {
      const identity = { ...await readSourceConnection(db, input.connectionId), itemId: input.itemId };
      const definition = identityDefinition(identity.siteKey, identity.identityVersion);
      const content = { siteKey: identity.siteKey, identityVersion: identity.identityVersion, itemId: input.itemId,
        ...(definition.contentIdScope !== 'site' ? { accountId: identity.accountId } : {}) };
      const bindings = await db.transaction(['contentBindings'], 'readonly', async tx => (await rows<ContentBindingRow>(tx, 'contentBindings', identity.siteKey, identity.identityVersion, input.itemId))
        .filter(b => !b.supersededBy && sameContentIdentity(b.content, content) && (input.scopeId === undefined || b.scopeId === input.scopeId)));
      for (const b of bindings) if (input.policy.copies !== 'sourceAndSemantic' || !['detached', 'suppressed'].includes(b.state)) await validate(b);
      const representations = await db.transaction(['representations', 'mounts'], 'readonly', async tx => await copiesInScope(tx, await rows<Representation>(tx, 'representations', input.connectionId, input.itemId), input.scopeId, r => r));
      for (const r of input.policy.copies === 'sourceAndSemantic' ? [] : representations) {
        if (r.state !== 'active') throw new Error('content_binding_needs_review');
        await assertNative(r.native, r.lastWritten ? { ...r.lastWritten, url: r.lastWritten.url ?? definition.itemUrl(r.itemId) ?? undefined } : undefined);
      }
      return db.transaction(['contentBindings', 'representations', 'itemReservations', 'mounts'], 'readwrite', async tx => {
        const history = (await rows<ContentBindingRow>(tx, 'contentBindings', identity.siteKey, identity.identityVersion, input.itemId))
          .filter(b => sameContentIdentity(b.content, content) && (input.scopeId === undefined || b.scopeId === input.scopeId));
        const current = history.filter(b => !b.supersededBy);
        if (sourceDigest(current) !== sourceDigest(bindings)) throw new Error('content_binding_changed');
        if (sourceDigest(await copiesInScope(tx, await rows<Representation>(tx, 'representations', input.connectionId, input.itemId), input.scopeId, r => r)) !== sourceDigest(representations)) throw new Error('content_binding_changed');
        if (current.length > 1 || current.some(b => b.connectionId && b.connectionId !== input.connectionId
          && !(input.scopeId && b.scopeId === input.scopeId && !content.accountId && input.policy.copies === 'sourceAndSemantic'))) throw new Error('content_account_adoption_required');
        for (const b of current) {
          if (input.policy.copies === 'sourceAndSemantic' && ['detached', 'suppressed'].includes(b.state)) continue;
          const adopted = { ...b, connectionId: b.connectionId ?? input.connectionId, policyRevision: b.policyRevision ?? input.policy.revision,
            sourceConnections: [...new Set([...b.sourceConnections ?? [], ...b.connectionId ? [b.connectionId] : [], input.connectionId])] };
          put(tx, 'contentBindings', contentKey(content, b.id), adopted);
          const key = semanticKey(input.connectionId, input.itemId, input.scopeId);
          if (b.native) put(tx, 'representations', representationKey(key), { ...key, native: b.native, state: 'active', manualRevision: 0,
            lastWritten: { title: b.title, parentId: b.parentId, url: b.url } } satisfies Representation);
          else put(tx, 'itemReservations', representationKey(key), { id: b.id, representation: key, commandId: b.commandId,
            payloadDigest: sourceDigest(b.content), state: 'unknown' } satisfies ItemReservation);
        }
        if (input.policy.copies === 'sourceAndSemantic') return { status: 'create' } as const;
        const existing = await copiesInScope(tx, await rows<Representation>(tx, 'representations', input.connectionId, input.itemId), input.scopeId, r => r);
        const unique = [...new Map(existing.map(r => [r.native.nativeId, r])).values()];
        if (unique.length > 1) throw new Error('multiple_copies_need_review');
        if (unique.length) {
          const rep = unique[0]!; if (rep.state !== 'active') throw new Error('content_binding_needs_review');
          put(tx, 'representations', representationKey(input.representation), { ...rep, ...input.representation });
          return { status: 'reuse', representation: rep } as const;
        }
        const reservations = await copiesInScope(tx, await rows<ItemReservation>(tx, 'itemReservations', input.connectionId, input.itemId), input.scopeId, r => r.representation);
        if (reservations.some(r => representationKey(r.representation) !== representationKey(input.representation))) return { status: 'dependency' } as const;
        return { status: 'create' } as const;
      });
    },
  };
}
