import type { ContentBindingRow } from './content-bindings.js';
import { contentBindingKey } from './content-identity.js';
import { representationKey, type ItemReservation } from './reservations.js';
import { get, put, sourceDigest, type SourceDatabase } from './source-db.js';
/** Freeze the host guard before checking another ledger. An issued/unknown native write is never discarded. */
export async function retryUnsubmittedContent(db: SourceDatabase, binding: ContentBindingRow, ports: {
  cancelUnsubmitted(): Promise<void>; release(): Promise<void>;
}) {
  const key = contentBindingKey(binding.content, binding.id), marker = `contentRetry:${binding.id}`;
  const interrupted = await db.read<{ state: string; binding?: ContentBindingRow }>('meta', marker);
  if (interrupted?.state === 'checking' && interrupted.binding && sourceDigest(binding) === sourceDigest({ ...interrupted.binding, state: 'detached' })) binding = interrupted.binding;
  if (binding.native || binding.supersededBy || binding.state !== 'pending') throw new Error('content_retry_unavailable');
  await db.transaction(['contentBindings', 'semanticJobs', 'meta'], 'readwrite', async tx => {
    const current = await get<ContentBindingRow>(tx, 'contentBindings', key);
    const saved = await get<{ state: string; binding?: ContentBindingRow }>(tx, 'meta', marker);
    const ownFrozen = saved?.state === 'checking' && sourceDigest(saved.binding) === sourceDigest(binding) && sourceDigest(current) === sourceDigest({ ...binding, state: 'detached' });
    if (!current || !ownFrozen && sourceDigest(current) !== sourceDigest(binding) || await get(tx, 'semanticJobs', binding.captureIntentId)) throw new Error('content_retry_unavailable');
    put(tx, 'contentBindings', key, { ...binding, state: 'detached' }); put(tx, 'meta', marker, { state: 'checking', binding });
  });
  try {
    await ports.cancelUnsubmitted(); await ports.release();
    await db.transaction(['contentBindings', 'itemReservations', 'meta'], 'readwrite', async tx => {
      const current = await get<ContentBindingRow>(tx, 'contentBindings', key);
      if (!current || sourceDigest(current) !== sourceDigest({ ...binding, state: 'detached' })) throw new Error('content_binding_changed');
      if (binding.connectionId) {
        const reservation = representationKey({ connectionId: binding.connectionId, itemId: binding.content.itemId, scopeId: binding.scopeId,
          purpose: 'semantic', sourceCollectionId: null, mountId: null });
        const old = await get<ItemReservation>(tx, 'itemReservations', reservation);
        if (old?.commandId === binding.commandId) tx.objectStore('itemReservations').delete(reservation);
      }
      tx.objectStore('contentBindings').delete(key); put(tx, 'meta', marker, { state: 'released', bindingId: binding.id });
    });
  } catch (error) {
    await db.transaction(['contentBindings', 'meta'], 'readwrite', async tx => {
      const current = await get<ContentBindingRow>(tx, 'contentBindings', key);
      if (current && sourceDigest(current) === sourceDigest({ ...binding, state: 'detached' })) put(tx, 'contentBindings', key, binding);
      put(tx, 'meta', marker, { state: 'retained', bindingId: binding.id, reason: error instanceof Error ? error.message : 'content_retry_unavailable' });
    }); throw error;
  }
}
