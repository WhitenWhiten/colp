import { personalBookmarks } from './bookmark-subscriptions/guards.js';
import { bookmarkApiErrorFromUnknown } from './bookmark-api-error.js';
import type { PullBookmarkApi } from './pull-applier-types.js';

export function createChromePullBookmarkApi(): PullBookmarkApi {
  return {
    create: wrap((input) => personalBookmarks.create(input)),
    update: wrap((id, changes) => personalBookmarks.update(id, changes)),
    move: wrap((id, destination) => personalBookmarks.move(id, destination)),
    remove: wrap((id) => personalBookmarks.remove(id)),
    removeTree: wrap((id) => personalBookmarks.removeTree(id)),
    get: wrap((id) => chrome.bookmarks.get(id)),
    getChildren: wrap((id) => chrome.bookmarks.getChildren(id)),
  };
}

function wrap<Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>):
  (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    try { return await fn(...args); }
    catch (error) { throw bookmarkApiErrorFromUnknown(error); }
  };
}
