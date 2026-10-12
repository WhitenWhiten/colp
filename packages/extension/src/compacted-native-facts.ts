/** Terminal payloads still back native identity repair and a pending Pull echo. */
export function compactNativePayload(operation: { readonly [key: string]: unknown }): Record<string, unknown> | undefined {
  const payload = object(operation.payload);
  if (operation.type === 'create_node') {
    const node = object(payload?.node);
    if (!node || typeof payload?.parentId !== 'string') return undefined;
    return { parentId: payload.parentId, node: { ...nativeFields(node), kind: node.kind,
      ...(typeof node.folderRole === 'string' ? { folderRole: node.folderRole } : {}) } };
  }
  if (operation.type === 'update_node_content' && payload) {
    return { base: contentFields(object(payload.base)), value: contentFields(object(payload.value)) };
  }
  return undefined;
}
function contentFields(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...nativeFields(value), ...(typeof value?.description === 'string' || value?.description === null
    ? { description: value.description } : {}),
    ...(Array.isArray(value?.tags) && value.tags.every(tag => typeof tag === 'string') ? { tags: [...value.tags] } : {}) };
}
function nativeFields(value: Record<string, unknown> | undefined): Record<string, string | null> {
  return Object.fromEntries(['title', 'url'].flatMap(key => typeof value?.[key] === 'string' || value?.[key] === null
    ? [[key, value[key] as string | null]] : []));
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
