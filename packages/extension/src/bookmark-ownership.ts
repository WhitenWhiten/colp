import type { BookmarkCaptureEvent } from './bookmark-listener-lifecycle.js';
type Observer = (event: BookmarkCaptureEvent) => Promise<void>;
let observer: Observer = async () => {};
/** Called after ordinary Sync identifies its own projection callbacks. */
export function installBookmarkOwnershipObserver(value: Observer) { observer = value; }
export const observeBookmarkOwnership = (event: BookmarkCaptureEvent) => observer(event);
