import type { CaptureContentBinding, NativeBinding, Representation, RepresentationKey, SavePolicy } from './contracts.js';
import { get, put, rows, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';
import { representationKey, type ItemReservation } from './reservations.js';
import { resolveAvUrl, itemId as normalizedItemId } from './bilibili/identity.js';
import type { SourcePolicyRecord } from './layout.js';
import type { SourceAuthority } from './ledger-types.js';
import { assertSourceRebound, assertRestoredItemAvailable } from './portable.js';
export interface ContentBindingRow extends CaptureContentBinding {
  intentPending?: boolean; requestDigest: string; sourceGeneration?: readonly [number, number]; supersededBy?: string; commandId: string; state: 'pending' | 'active' | 'detached' | 'suppressed';
  forceAnother?: boolean; mode: 'create' | 'reuse' | 'reclassify' | 'suggest'; policyRevision: number | null;
  title: string; url: string; parentId: string; reuse?: Representation;
}
const contentKey = (item: string, id: string) => sourceKey('bilibili', item, id);
const semanticKey = (connectionId: string, itemId: string): RepresentationKey => ({ connectionId, itemId, purpose: 'semantic', sourceCollectionId: null, mountId: null });
export function contentIdentityFromUrl(url: string) {
  const aid = resolveAvUrl(url); return aid ? { siteKey: 'bilibili', identityVersion: 1, itemId: normalizedItemId(aid) } as const : null;
}
/** One source-store transaction arbitrates semantic and source intents, including account-independent pending saves. */
export function createContentBindings(db: SourceDatabase, assertNative: (native: NativeBinding<'bookmark'>, expected?: { title: string; parentId: string; url?: string }) => Promise<void>) {
  async function validate(binding: ContentBindingRow) {
    if (binding.state === 'detached' || binding.state === 'suppressed') throw new Error('content_binding_needs_review');
    if (binding.native) await assertNative(binding.native, { title: binding.title, parentId: binding.parentId, url: binding.url });
  }
  return {
    async prepare(input: { itemId: string; commandId: string; captureIntentId: string; title: string; url: string; parentId: string; automatic: boolean }) {
      const candidates = await db.transaction(['contentBindings'], 'readonly', async tx => (await rows<ContentBindingRow>(tx, 'contentBindings', 'bilibili', input.itemId)).filter(b => !b.supersededBy));
      for (const b of candidates) await validate(b);
      const a = await db.read<SourceAuthority>('authorities', 'bundled.bilibili');
      const settings = a?.enabled && a.connectionId ? await db.read<SourcePolicyRecord>('meta', `policy:${a.connectionId}`) : undefined;
      const connectionId = settings?.enabled ? settings.connectionId : candidates[0]?.connectionId ?? null;
      if (connectionId) await assertSourceRebound(db, connectionId);
      if (connectionId) await assertRestoredItemAvailable(db, connectionId, input.itemId);
      const reps = connectionId ? await db.transaction(['representations'], 'readonly', tx => rows<Representation>(tx, 'representations', connectionId, input.itemId)) : [];
      for (const r of reps) { if (r.state !== 'active') throw new Error('content_binding_needs_review'); await assertNative(r.native, r.lastWritten ? { ...r.lastWritten, url: r.lastWritten.url ?? `https://www.bilibili.com/video/av${r.itemId.split(':').at(-1)}` } : undefined); }
      return db.transaction(['contentBindings', 'itemReservations', 'representations', 'meta', 'authorities'], 'readwrite', async tx => {
        const history = await rows<ContentBindingRow>(tx, 'contentBindings', 'bilibili', input.itemId);
        const current = history.filter(b => !b.supersededBy);
        if (sourceDigest(current) !== sourceDigest(candidates)) throw new Error('content_binding_changed');
        const requestDigest = sourceDigest({ commandId: input.commandId, url: input.url, title: input.title, parentId: input.parentId, automatic: input.automatic });
        const replay = history.find(b => b.commandId === input.commandId); if (replay) { if (replay.requestDigest !== requestDigest) throw new Error('command_id_reused'); return replay; }
        if (current.length > 1) throw new Error('content_adoption_required');
        const old = current[0];
        if (old?.connectionId && old.connectionId !== connectionId) throw new Error('content_account_adoption_required');
        if (old?.native === null || old?.intentPending) throw new Error('semantic_save_pending');
        const policy = settings?.policy;
        if (connectionId && settings && sourceDigest(await get(tx, 'meta', `policy:${connectionId}`)) !== sourceDigest(settings)) throw new Error('source_policy_changed');
        const latest = connectionId ? await rows<Representation>(tx, 'representations', connectionId, input.itemId) : [];
        if (sourceDigest(latest) !== sourceDigest(reps)) throw new Error('content_binding_changed');
        const semantic = latest.find(r => r.purpose === 'semantic');
        const copies = [...new Map(latest.map(r => [r.native.nativeId, r])).values()];
        if (policy && policy.copies !== 'sourceAndSemantic' && copies.length > 1) throw new Error('multiple_copies_need_review');
        const reuse = semantic ?? (policy && policy.copies !== 'sourceAndSemantic' ? copies[0] : undefined);
        const native = reuse?.native ?? old?.native ?? null;
        if (!native && connectionId) {
          const pending = await rows<ItemReservation>(tx, 'itemReservations', connectionId, input.itemId);
          if (pending.some(r => r.representation.purpose === 'semantic' || policy?.copies !== 'sourceAndSemantic')) throw new Error('source_save_pending');
        }
        const mode = !native ? 'create' : semantic || old?.native ? 'reuse' : policy?.copies === 'singlePreferSemantic' ? 'reclassify' : 'suggest';
        const id = crypto.randomUUID();
        const binding: ContentBindingRow = { id, intentPending: mode === 'reclassify' && input.automatic, requestDigest, ...(connectionId && a ? { sourceGeneration: [a.installationGeneration, a.sourceSessionGeneration] as const } : {}), content: { siteKey: 'bilibili', identityVersion: 1, itemId: input.itemId },
          captureIntentId: input.captureIntentId, commandId: input.commandId, purpose: 'semantic', connectionId, native, state: native ? 'active' : 'pending', mode,
          forceAnother: !native && copies.length > 0 && policy?.copies === 'sourceAndSemantic', policyRevision: policy?.revision ?? null, title: reuse?.lastWritten?.title ?? old?.title ?? input.title, url: old?.url ?? reuse?.lastWritten?.url ?? (reuse ? `https://www.bilibili.com/video/av${input.itemId.split(':').at(-1)}` : input.url),
          parentId: reuse?.lastWritten?.parentId ?? old?.parentId ?? input.parentId, ...(reuse ? { reuse } : {}) };
        // Reuse one content binding, preserving its original creation receipt separately from this semantic intent.
        if (old) put(tx, 'contentBindings', contentKey(input.itemId, old.id), { ...old, supersededBy: id });
        put(tx, 'contentBindings', contentKey(input.itemId, id), binding);
        if (connectionId) {
          const key = semanticKey(connectionId, input.itemId);
          if (native && mode === 'reuse') put(tx, 'representations', representationKey(key), { ...key, native, state: 'active', manualRevision: 0,
            lastWritten: { title: binding.title, parentId: binding.parentId, url: binding.url } } satisfies Representation);
          put(tx, 'itemReservations', representationKey(key), { id, representation: key, commandId: input.commandId, payloadDigest: sourceDigest({ content: binding.content, mode }),
            state: native ? 'confirmed' : 'reserved' } satisfies ItemReservation);
        }
        return binding;
      });
    },
    async forIntent(id: string) { return db.transaction(['contentBindings'], 'readonly', async tx => {
      const r = tx.objectStore('contentBindings').openCursor(); return new Promise<ContentBindingRow | undefined>((resolve, reject) => {
        r.onerror = () => reject(r.error); r.onsuccess = () => { const c = r.result; if (!c) return resolve(undefined); if (c.value.captureIntentId === id) return resolve(c.value); c.continue(); };
      });
    }); },
    async acknowledge(binding: ContentBindingRow, native: NativeBinding<'bookmark'>, node: { title: string; parentId: string }) {
      await assertNative(native, node);
      return db.transaction(['contentBindings', 'representations', 'itemReservations'], 'readwrite', async tx => {
        const key = contentKey(binding.content.itemId, binding.id), old = await get<ContentBindingRow>(tx, 'contentBindings', key);
        if (!old || old.native && old.native.nativeId !== native.nativeId || old.state === 'suppressed' || old.state === 'detached') throw new Error('content_binding_changed');
        put(tx, 'contentBindings', key, { ...old, native, ...node, state: 'active', intentPending: false });
        if (old.connectionId) {
          const rep = semanticKey(old.connectionId, old.content.itemId);
          if (old.mode !== 'suggest') put(tx, 'representations', representationKey(rep), { ...rep, native, state: 'active', manualRevision: 0, lastWritten: { ...node, url: old.url } } satisfies Representation);
          const reservation = await get<ItemReservation>(tx, 'itemReservations', representationKey(rep));
          if (reservation) put(tx, 'itemReservations', representationKey(rep), { ...reservation, state: 'confirmed' });
        }
      });
    },
    async adopt(binding: ContentBindingRow, native: NativeBinding<'bookmark'>, node: { title: string; parentId: string; url: string }, connectionId: string | null, allowAccountChange = false) {
      if (native.proof.kind !== 'explicitAdoption') throw new Error('explicit_adoption_required');
      if (binding.connectionId && binding.connectionId !== connectionId && !allowAccountChange) throw new Error('content_account_adoption_required');
      await assertNative(native, node);
      return db.transaction(['contentBindings', 'representations', 'itemReservations'], 'readwrite', async tx => {
        const key = contentKey(binding.content.itemId, binding.id), current = await get<ContentBindingRow>(tx, 'contentBindings', key);
        if (!current || sourceDigest(current) !== sourceDigest(binding) || current.supersededBy) throw new Error('content_binding_changed');
        const next: ContentBindingRow = { ...current, ...node, native, connectionId, state: 'active', mode: 'suggest' };
        put(tx, 'contentBindings', key, next);
        if (connectionId) {
          const rep = semanticKey(connectionId, binding.content.itemId);
          put(tx, 'representations', representationKey(rep), { ...rep, native, state: 'active', manualRevision: 0, lastWritten: node } satisfies Representation);
          const reserved = await get<ItemReservation>(tx, 'itemReservations', representationKey(rep));
          if (reserved) put(tx, 'itemReservations', representationKey(rep), { ...reserved, state: 'confirmed' });
        }
        return next;
      });
    },
    /** Called before a source folder/item reservation. No native writes and no URL-based adoption. */
    async sourceDecision(input: { connectionId: string; itemId: string; policy: SavePolicy; representation: RepresentationKey }) {
      const bindings = await db.transaction(['contentBindings'], 'readonly', async tx => (await rows<ContentBindingRow>(tx, 'contentBindings', 'bilibili', input.itemId)).filter(b => !b.supersededBy));
      for (const b of bindings) if (input.policy.copies !== 'sourceAndSemantic' || !['detached', 'suppressed'].includes(b.state)) await validate(b);
      const representations = await db.transaction(['representations'], 'readonly', tx => rows<Representation>(tx, 'representations', input.connectionId, input.itemId));
      for (const r of input.policy.copies === 'sourceAndSemantic' ? [] : representations) {
        if (r.state !== 'active') throw new Error('content_binding_needs_review');
        await assertNative(r.native, r.lastWritten ? { ...r.lastWritten, url: r.lastWritten.url ?? `https://www.bilibili.com/video/av${r.itemId.split(':').at(-1)}` } : undefined);
      }
      return db.transaction(['contentBindings', 'representations', 'itemReservations'], 'readwrite', async tx => {
        const history = await rows<ContentBindingRow>(tx, 'contentBindings', 'bilibili', input.itemId);
        const current = history.filter(b => !b.supersededBy);
        if (sourceDigest(current) !== sourceDigest(bindings)) throw new Error('content_binding_changed');
        if (sourceDigest(await rows<Representation>(tx, 'representations', input.connectionId, input.itemId)) !== sourceDigest(representations)) throw new Error('content_binding_changed');
        if (current.length > 1 || current.some(b => b.connectionId && b.connectionId !== input.connectionId)) throw new Error('content_account_adoption_required');
        for (const b of current) {
          if (input.policy.copies === 'sourceAndSemantic' && ['detached', 'suppressed'].includes(b.state)) continue;
          const adopted = { ...b, connectionId: input.connectionId, policyRevision: input.policy.revision }; put(tx, 'contentBindings', contentKey(input.itemId, b.id), adopted);
          const key = semanticKey(input.connectionId, input.itemId);
          if (b.native) put(tx, 'representations', representationKey(key), { ...key, native: b.native, state: 'active', manualRevision: 0,
            lastWritten: { title: b.title, parentId: b.parentId, url: b.url } } satisfies Representation);
          else put(tx, 'itemReservations', representationKey(key), { id: b.id, representation: key, commandId: b.commandId,
            payloadDigest: sourceDigest(b.content), state: 'unknown' } satisfies ItemReservation);
        }
        if (input.policy.copies === 'sourceAndSemantic') return { status: 'create' } as const;
        const existing = await rows<Representation>(tx, 'representations', input.connectionId, input.itemId);
        const unique = [...new Map(existing.map(r => [r.native.nativeId, r])).values()];
        if (unique.length > 1) throw new Error('multiple_copies_need_review');
        if (unique.length) {
          const rep = unique[0]!; if (rep.state !== 'active') throw new Error('content_binding_needs_review');
          put(tx, 'representations', representationKey(input.representation), { ...rep, ...input.representation });
          return { status: 'reuse', representation: rep } as const;
        }
        const reservations = await rows<ItemReservation>(tx, 'itemReservations', input.connectionId, input.itemId);
        if (reservations.some(r => representationKey(r.representation) !== representationKey(input.representation))) return { status: 'dependency' } as const;
        return { status: 'create' } as const;
      });
    },
  };
}
