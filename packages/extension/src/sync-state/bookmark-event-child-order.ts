import { placedChildOrder } from '../bookmark-child-order.js';
import { childOrderFromProjection } from '../bookmark-reorder-diff.js';
import { requestValue } from './idb.js';
import { STORES } from './schema.js';
import type { BookmarkEventRecord, JsonObject, MappingInput } from './types.js';

/** The accepted callback and its order baseline commit together, including before flush. */
export async function recordCapturedChildOrder(tx: IDBTransaction, key: string, event: BookmarkEventRecord): Promise<void> {
  if (event.kind === 'change') return;
  const mappings = tx.objectStore(STORES.mappings);
  const identity = await requestValue(mappings.get([key, event.nativeId])) as MappingInput | undefined;
  const context = event.details.context as JsonObject | undefined;
  const target = context?.targetParentNativeId ?? context?.parentNativeId;
  const source = context?.sourceParentNativeId ?? identity?.parentNativeId;
  const remove = async (parentId: unknown) => {
    if (typeof parentId !== 'string') return;
    const parent = await requestValue(mappings.get([key, parentId])) as MappingInput | undefined;
    const order = childOrderFromProjection(parent?.projection);
    if (parent && order) mappings.put({ ...parent, projection: { ...parent.projection,
      childrenOrder: order.filter(id => id !== event.nativeId) } });
  };
  if (event.kind === 'remove') { await remove(source); return; }
  if (source !== target) await remove(source);
  if (typeof target !== 'string') return;
  const parent = await requestValue(mappings.get([key, target])) as MappingInput | undefined;
  const order = childOrderFromProjection(parent?.projection);
  if (!parent || !order) return;
  const anchor = { ...(typeof context?.afterNativeId === 'string' ? { afterNativeId: context.afterNativeId } : {}),
    ...(typeof context?.beforeNativeId === 'string' ? { beforeNativeId: context.beforeNativeId } : {}),
    ...(typeof context?.index === 'number' ? { index: context.index } : {}) };
  mappings.put({ ...parent, projection: { ...parent.projection,
    childrenOrder: placedChildOrder(order, event.nativeId, anchor) } });
}
