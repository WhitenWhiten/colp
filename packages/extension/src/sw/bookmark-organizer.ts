import { organizeChoices, organizePaths, type OrganizeRequest, type OrganizeResponse } from '../bookmark-organizer.js';
import { sortNativeBookmarkFolder } from '../bookmark-folders-first.js';
import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { bookmarkListenerLifecycle } from './bookmarks.js';
import { withManualBookmarkOrganization } from './bookmark-folders-first.js';
import { currentSyncScope } from './scope.js';
import { loadPinIndex, sortFolderPins } from './bookmark-pin-pass.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { hasBookmarkPermission, syncState, workCoordinator } from './runtime.js';

let applying = false;
async function assertAvailable(ownsEngine = false): Promise<void> {
  if (!await hasBookmarkPermission()) throw new Error('permission_required');
  if (!ownsEngine && workCoordinator.hasInFlight('engine')) throw new Error('busy');
  const scope = await currentSyncScope().catch(() => undefined);
  if (scope && (await syncState.getEngineState(scope))?.recoveryFrozen) throw new Error('busy');
}

export async function handleOrganizeRequest(request: OrganizeRequest): Promise<OrganizeResponse> {
  let moved = 0;
  try {
    if (!await hasBookmarkPermission()) throw new Error('permission_required');
    if (request.kind === 'known.bookmarks.organize.preview') {
      return await withSubscriptionRead(async () => ({ ok: true,
        choices: organizeChoices(await chrome.bookmarks.getTree(), await exclusionIds(true)) }));
    }
    if (applying) throw new Error('busy');
    applying = true;
    try {
      return await withManualBookmarkOrganization(async () => {
        await bookmarkListenerLifecycle.settled();
        await assertAvailable();
        const ownsEngine = await currentSyncScope().then(() => true, () => false);
        // Connected profiles hold the engine lane so our own captured moves cannot
        // start Pull between directories. Signed-out work keeps its local authority.
        return workCoordinator.run(ownsEngine ? 'engine' : 'local-bookmark', async context => {
          await assertAvailable(ownsEngine);
          return withSubscriptionRead(async (): Promise<OrganizeResponse> => {
            const excluded = await exclusionIds(true);
            const paths = organizePaths(await chrome.bookmarks.getTree(), request.nativeIds, excluded);
            const plannedParents = new Map(paths.map(folder => [folder.id, folder.parentId]));
            const preferences = await readEffectiveBookmarkPreferences();
            const pins = preferences.bookmarkInsertPosition === 'top' ? await loadPinIndex() : undefined;
            for (const folder of paths) {
              // Reject a directory moved out of the selected tree while the operation was waiting.
              const available = async () => {
                if (context?.signal.aborted) throw new Error('busy');
                await assertAvailable(ownsEngine);
                let id = folder.id;
                while (plannedParents.has(id)) {
                  const live = (await chrome.bookmarks.get(id))[0];
                  if (!live || live.parentId !== plannedParents.get(id)) throw new Error('tree_changed');
                  id = live.parentId ?? '';
                }
                return true;
              };
              await available();
              const complete = await sortNativeBookmarkFolder(chrome.bookmarks, folder.id, available,
                async id => excluded.has(id), () => { moved += 1; });
              if (!complete) throw new Error('tree_changed');
              if (pins?.size && !await sortFolderPins(folder.id, pins, { ...preferences, foldersFirst: true }, excluded, available,
                { onMoved: () => { moved += 1; } })) throw new Error('tree_changed');
            }
            return { ok: true, moved };
          });
        }).finally(() => bookmarkListenerLifecycle.settled());
      });
    } finally { applying = false; }
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { ok: false, error: code === 'permission_required' || code === 'busy' || code === 'tree_changed'
      ? code : 'organize_failed', moved };
  }
}
