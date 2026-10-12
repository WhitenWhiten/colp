export interface PortableMetadataNode {
  readonly sourceId: string; readonly parentIndex: number | null; readonly title: string;
  readonly url?: string; readonly tags?: readonly string[]; readonly note?: string; readonly description?: string | null;
}
export interface ExistingMetadataNode {
  readonly id: string; readonly parentId: string | null; readonly title: string;
  readonly url: string | null; readonly managed: boolean;
}
export interface RetainedMetadata { readonly tags: readonly string[]; readonly note: string | null; readonly description: string | null }

/** Match unique full path + kind + exact URL, never a native id or URL alone. No native create/delete is planned. */
export function planMetadataReassociation(backup: readonly PortableMetadataNode[], native: readonly ExistingMetadataNode[],
  excluded: ReadonlySet<string> = new Set()) {
  if (backup.length > 100_000 || native.length > 100_000) throw new Error('preview_too_large');
  const paths: string[][] = [], backupKeys: string[] = [];
  const key = (path: readonly string[], url: string | null) => JSON.stringify([path, url === null ? 'folder' : 'bookmark', url]);
  let pathBytes = 0;
  for (const [index, node] of backup.entries()) {
    if (node.parentIndex !== null && (!Number.isSafeInteger(node.parentIndex) || node.parentIndex < 0
      || node.parentIndex >= index || backup[node.parentIndex]?.url !== undefined)) throw new Error('backup_invalid');
    const path = [...(node.parentIndex === null ? [] : paths[node.parentIndex]!), node.title];
    if (path.length > 65) throw new Error('preview_too_large');
    const identity = key(path, node.url ?? null); pathBytes += identity.length;
    if (pathBytes > 16 * 1024 * 1024) throw new Error('preview_too_large');
    paths.push(path); backupKeys.push(identity);
  }
  const byId = new Map(native.map(node => [node.id, node]));
  if (byId.size !== native.length) throw new Error('native_tree_invalid');
  const targets = new Map<string, string[]>();
  for (const node of native) {
    let ancestor: ExistingMetadataNode | undefined = node;
    const path: string[] = [], seen = new Set<string>(); let blocked = false;
    while (ancestor) {
      if (seen.has(ancestor.id) || path.length > 65) throw new Error('native_tree_invalid');
      seen.add(ancestor.id); path.unshift(ancestor.title);
      blocked ||= ancestor.managed || excluded.has(ancestor.id);
      if (ancestor.parentId === null) break;
      ancestor = byId.get(ancestor.parentId);
      if (!ancestor) throw new Error('native_tree_invalid');
    }
    if (blocked) continue;
    const identity = key(path, node.url); pathBytes += identity.length;
    if (pathBytes > 32 * 1024 * 1024) throw new Error('preview_too_large');
    const ids = targets.get(identity) ?? []; ids.push(node.id); targets.set(identity, ids);
  }
  const counts = new Map<string, number>();
  for (const identity of backupKeys) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  const matches: Array<{ backupIndex: number; nativeId: string }> = [];
  let ambiguous = 0, unmatched = 0;
  for (const [index, node] of backup.entries()) {
    if (!node.tags?.length && !node.note && !node.description) continue;
    const identity = backupKeys[index]!, ids = targets.get(identity) ?? [];
    if (ids.length > 1 || counts.get(identity)! > 1) { ambiguous++; continue; }
    if (!ids.length) { unmatched++; continue; }
    matches.push({ backupIndex: index, nativeId: ids[0]! });
  }
  return { matches, ambiguous, unmatched };
}
/** Fill missing text, merge tags losslessly and preserve conflicting current values for review. */
export function mergeRestoredMetadata(current: RetainedMetadata, backup: PortableMetadataNode, tagLimit = 128) {
  const merged = [...new Set([...current.tags, ...(backup.tags ?? [])])];
  const conflicts: Array<'tags' | 'note' | 'description'> = [];
  if (merged.length > tagLimit) conflicts.push('tags');
  if (current.note !== null && backup.note && current.note !== backup.note) conflicts.push('note');
  if (current.description !== null && backup.description && current.description !== backup.description) conflicts.push('description');
  return { tags: merged.length > tagLimit ? [...current.tags] : merged,
    note: current.note ?? backup.note ?? null, description: current.description ?? backup.description ?? null, conflicts };
}
