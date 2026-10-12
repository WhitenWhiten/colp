import { decodeLocalBackup, type LocalBackup } from '../local-backup/codec.js';
import { supportedBookmarkTree } from '../bookmark-folder-policy.js';
import { planMetadataReassociation, mergeRestoredMetadata } from '../metadata-reassociation.js';
import { nativeTreeProof, localProofDigest } from '../native-tree-proof.js';
import { createBookmarkAnnotationStore } from '../bookmark-annotation-store.js';
import { createFolderDescriptionStore } from '../folder-description-store.js';
import { exclusionIds, assertPersonalNativeAllowed } from '../bookmark-subscriptions/guards.js';
import type { MetadataReassociationCommand } from '../metadata-reassociation-commands.js';
import { hasBookmarkPermission, workCoordinator } from './runtime.js';
import { currentCaptureScope, assertCaptureOwner } from './capture-native.js';

interface Preview { readonly backup: LocalBackup; readonly digest: string; readonly expiresAt: number;
  readonly owner: Awaited<ReturnType<typeof currentCaptureScope>> }
const previews = new Map<string, Preview>();
async function inspect(backup: LocalBackup) {
  if (!await hasBookmarkPermission()) throw new Error('permission_required');
  const roots = supportedBookmarkTree(await chrome.bookmarks.getTree())[0]?.children ?? [];
  const tree = nativeTreeProof(roots), excluded = await exclusionIds();
  const plan = planMetadataReassociation(backup.nodes, tree, excluded);
  const annotations = createBookmarkAnnotationStore(), descriptions = createFolderDescriptionStore();
  try {
    const rows = [];
    for (const match of plan.matches) {
      const [node] = await chrome.bookmarks.get(match.nativeId);
      if (!node) throw new Error('metadata_target_changed');
      const annotation = node.url ? await annotations.get(node) : null;
      const description = node.url ? null : await descriptions.get(node);
      rows.push({ match, node, annotation, description, merged: mergeRestoredMetadata({
        tags: annotation?.tags ?? [], note: annotation?.note ?? null, description: description?.description ?? null,
      }, backup.nodes[match.backupIndex]!) });
    }
    return { plan, rows, digest: await localProofDigest([tree, [...excluded].sort(), rows]) };
  } finally { annotations.close(); descriptions.close(); }
}
/** Reassociates sidecars only. It never calls a native create, delete or move. */
export async function handleMetadataReassociation(command: MetadataReassociationCommand) {
  if (command.kind === 'known.metadataRestore.preview') {
    const backup = decodeLocalBackup(Uint8Array.from(atob(command.base64), char => char.charCodeAt(0)));
    const owner = await currentCaptureScope(), result = await inspect(backup);
    await assertCaptureOwner(owner);
    for (const [key, value] of previews) if (value.expiresAt <= Date.now()) previews.delete(key);
    if (previews.size >= 4) previews.delete(previews.keys().next().value!);
    const token = crypto.randomUUID();
    previews.set(token, { backup, digest: result.digest, expiresAt: Date.now() + 120000, owner });
    return { ok: true, token, matches: result.plan.matches.length, ambiguous: result.plan.ambiguous,
      unmatched: result.plan.unmatched, conflicts: result.rows.filter(row => row.merged.conflicts.length).length };
  }
  const preview = previews.get(command.token); previews.delete(command.token);
  if (!preview || preview.expiresAt <= Date.now()) throw new Error('metadata_preview_stale');
  return workCoordinator.run('local-bookmark', async () => {
    await assertCaptureOwner(preview.owner);
    const fresh = await inspect(preview.backup);
    if (fresh.digest !== preview.digest) throw new Error('metadata_preview_stale');
    const annotations = createBookmarkAnnotationStore(), descriptions = createFolderDescriptionStore();
    try {
      for (const row of fresh.rows) {
        await assertCaptureOwner(preview.owner); await assertPersonalNativeAllowed(row.node.id);
        const [node] = await chrome.bookmarks.get(row.node.id);
        if (!node || node.dateAdded !== row.node.dateAdded || node.title !== row.node.title
          || node.url !== row.node.url || node.parentId !== row.node.parentId) throw new Error('metadata_preview_stale');
        if (node.url) {
          await annotations.save(node, { tags: row.merged.tags, note: row.merged.note }, {
            preserveTags: true,
            base: { tags: row.annotation?.tags ?? [], note: row.annotation?.note ?? null } });
        } else if (!row.merged.conflicts.includes('description')) {
          await descriptions.save(node, row.merged.description, row.description?.version ?? 0);
        }
      }
      await assertCaptureOwner(preview.owner);
      return { ok: true, restored: fresh.rows.length, conflicts: fresh.rows.filter(row => row.merged.conflicts.length).length };
    } finally { annotations.close(); descriptions.close(); }
  });
}
