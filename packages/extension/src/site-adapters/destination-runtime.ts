import { object, literal, str, integer } from './schema.js';
import { classificationDestinationPolicy } from '../sw/classification-destination.js';
import { personalBookmarks } from '../bookmark-subscriptions/guards.js';
import { siteLedger } from './source-runtime.js';
import { get, put, sourceDigest } from './source-db.js';
const schema = object({ kind: literal('known.siteAdapters.destination.move'), commandId: str(128), nativeId: str(128),
  parentId: str(128), expectedParentId: str(128), expectedTitle: str(4096), expectedUrl: str(8192), dateAdded: integer, digest: v => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/u.test(v) });
export const validDestinationRequest = (v: unknown) => schema(v);
export async function handleDestinationRequest(raw: unknown) {
  if (!schema(raw)) throw new Error('invalid');
  const r = raw as { commandId: string; nativeId: string; parentId: string; expectedParentId: string; expectedTitle: string; expectedUrl: string; dateAdded: number; digest: string };
  const key = `aiMove:${r.commandId}`, digest = sourceDigest(r);
  const old = await siteLedger.db.read<{ digest: string; state: string }>('meta', key);
  if (old && old.digest !== digest) throw new Error('command_id_reused');
  await classificationDestinationPolicy.assertAllowed(r.parentId, r.digest);
  const n = (await chrome.bookmarks.get(r.nativeId))[0];
  if (!n?.url || n.dateAdded !== r.dateAdded || n.title !== r.expectedTitle || n.url !== r.expectedUrl || n.parentId !== r.expectedParentId && !(old && n.parentId === r.parentId)) throw new Error('capture_bookmark_changed');
  if (old?.state === 'confirmed' && n.parentId !== r.parentId) throw new Error('capture_bookmark_changed');
  if (old?.state !== 'confirmed' && n.parentId !== r.parentId) {
    await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
      const current = await get<{ digest: string }>(tx, 'meta', key); if (current && current.digest !== digest) throw new Error('command_id_reused');
      put(tx, 'meta', key, { digest, state: 'submitted' });
    });
    await classificationDestinationPolicy.assertAllowed(r.parentId, r.digest);
    const current = (await chrome.bookmarks.get(r.nativeId))[0];
    if (!current || current.dateAdded !== r.dateAdded || current.title !== r.expectedTitle || current.url !== r.expectedUrl || current.parentId !== r.expectedParentId) throw new Error('capture_bookmark_changed');
    await personalBookmarks.move(n.id, { parentId: r.parentId });
  }
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => { put(tx, 'meta', key, { digest, state: 'confirmed' }); });
  return { ok: true };
}
