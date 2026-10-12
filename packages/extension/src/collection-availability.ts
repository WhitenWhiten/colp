/** Missing is authoritative only for a complete, fully validated collection listing. */
export function collectionAvailability(body: unknown, collectionId: string,
  parse: (value: unknown) => { readonly id: string; readonly kind: string; readonly visibility?: string } | null | undefined):
'available' | 'unavailable' | 'unknown' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
  const row = body as Record<string, unknown>;
  if (!Array.isArray(row.items) || row.items.length > 100_000) return 'unknown';
  const items = row.items.map(item => { try { return parse(item); } catch { return null; } });
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || ids.has(item.id)) return 'unknown';
    ids.add(item.id);
  }
  const target = items.find(item => item?.id === collectionId);
  if (target) return target.kind === 'bookmarks' && target.visibility === 'private' ? 'available' : 'unavailable';
  if (Object.keys(row).some(key => !['items', 'nextCursor', 'next', 'hasMore', 'total'].includes(key))
    || row.nextCursor != null || row.next != null || row.hasMore !== undefined && row.hasMore !== false
    || row.total !== undefined && row.total !== items.length) return 'unknown';
  return 'unavailable';
}
