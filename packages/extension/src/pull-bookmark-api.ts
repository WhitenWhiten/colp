import { personalBookmarks } from './bookmark-subscriptions/guards.js';
import { bookmarkApiErrorFromUnknown } from './bookmark-api-error.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import { NativeWriteNotStartedError, type NativeWriteCheck } from './native-call-result.js';

export function createChromePullBookmarkApi(): PullBookmarkApi {
  return {
    nativeWriteChecks: true,
    create: wrap((input, beforeNative?: NativeWriteCheck) => personalBookmarks.create(input, beforeNative)),
    update: wrap((id, changes, beforeNative?: NativeWriteCheck) => personalBookmarks.update(id, changes, beforeNative)),
    move: wrap((id, destination, beforeNative?: NativeWriteCheck) => personalBookmarks.move(id, destination, beforeNative)),
    remove: wrap((id, beforeNative?: NativeWriteCheck) => personalBookmarks.remove(id, beforeNative)),
    removeTree: wrap((id, beforeNative?: NativeWriteCheck) => personalBookmarks.removeTree(id, beforeNative)),
    get: wrap((id) => chrome.bookmarks.get(id)),
    getChildren: wrap((id) => chrome.bookmarks.getChildren(id)),
  };
}

function wrap<Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>):
  (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    try { return await fn(...args); }
    catch (error) {
      if (error instanceof NativeWriteNotStartedError) throw error;
      throw bookmarkApiErrorFromUnknown(error);
    }
  };
}
