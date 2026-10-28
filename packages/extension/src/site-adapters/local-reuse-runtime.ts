import { siteLedger } from './source-runtime.js';
import { get, put, sourceDigest } from './source-db.js';
import { assertSourceRoot, executePlannedNative, recoverPlannedNative } from '../sw/planned-capture.js';
import { rememberLocalSourceSave } from './local-save-runtime.js';
import type { PlannedNativeCommand, PlannedNativeResult } from './planned-types.js';
export async function recoverLocalSave(command: PlannedNativeCommand, digest: string): Promise<PlannedNativeResult | null> {
  if (!command.local?.reuse) {
    const result = await recoverPlannedNative(command, digest);
    return result ? rememberLocalSourceSave(command, result) : null;
  }
  const receipt = await siteLedger.db.read<{ digest: string; result: PlannedNativeResult }>('meta', `localReuse:${command.commandId}`);
  if (receipt && receipt.digest !== digest) throw Error('capture_command_reused');
  return receipt?.result ?? null;
}
export async function executeLocalSave(command: PlannedNativeCommand, digest: string, authorize: () => Promise<void>): Promise<PlannedNativeResult> {
  if (sourceDigest(command) !== digest) throw Error('capture_command_reused');
  if (!command.local?.reuse) return rememberLocalSourceSave(command, await executePlannedNative(command, digest, authorize));
  const old = await recoverLocalSave(command, digest); if (old) return old;
  await authorize(); await assertSourceRoot(command.local.root);
  const reuse = command.local.reuse, node = (await chrome.bookmarks.get(reuse.native.nativeId).catch(() => []))[0];
  if (!node || node.dateAdded !== reuse.native.dateAdded || node.title !== reuse.written.title || node.parentId !== reuse.written.parentId
    || node.url !== reuse.written.url) throw Error('sourceCopyDetached');
  const result: PlannedNativeResult = { status: 'confirmed', native: reuse.native, written: reuse.written };
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
    const receipt = await get<{ digest: string }>(tx, 'meta', `localReuse:${command.commandId}`);
    if (receipt && receipt.digest !== digest) throw Error('capture_command_reused');
    put(tx, 'meta', `localReuse:${command.commandId}`, { digest, result });
    put(tx, 'meta', `localShared:${command.commandId}`, reuse.shared);
  });
  return result;
}
