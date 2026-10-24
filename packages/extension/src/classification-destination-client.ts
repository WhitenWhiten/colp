/** Ordinary existing-bookmark editors retain the AI policy through final native application. */
export async function moveSuggestedBookmark(nativeId: string, parentId: string, digest: string, commandId: string,
  proof?: { parentId: string; dateAdded?: number; title: string; url: string }) {
  const node = (await chrome.bookmarks.get(nativeId))[0];
  if (!node?.dateAdded || !node.parentId) throw new Error('capture_bookmark_changed');
  if (proof && (node.dateAdded !== proof.dateAdded || node.title !== proof.title || node.url !== proof.url || ![proof.parentId, parentId].includes(node.parentId))) throw new Error('capture_bookmark_changed');
  const reply = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.destination.move', commandId, nativeId, parentId,
    expectedParentId: proof?.parentId ?? node.parentId, expectedTitle: proof?.title ?? node.title, expectedUrl: proof?.url ?? node.url,
    dateAdded: proof?.dateAdded ?? node.dateAdded, digest }) as { ok?: boolean; error?: string };
  if (!reply.ok) throw new Error(reply.error ?? 'destination_policy_unresolved');
}
