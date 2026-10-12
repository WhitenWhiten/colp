import type { PinBlocker } from './bookmark-pin-order.js';

export type PinRequest =
  | { readonly kind: 'known.bookmarks.pin.status'; readonly folderIds: readonly string[] }
  | { readonly kind: 'known.bookmarks.pin.set'; readonly userGesture: true; readonly nativeId: string; readonly pinned: boolean };
export type PinError = 'permission_required' | 'not_available' | 'not_found' | 'pin_failed';
export type PinResponse =
  | { readonly ok: true; readonly folders: Readonly<Record<string, readonly PinBlocker[]>> }
  | { readonly ok: true; readonly blockers: readonly PinBlocker[] }
  | { readonly ok: false; readonly error: PinError; readonly blockers?: readonly PinBlocker[] };

const NATIVE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export function validPinRequest(value: unknown): value is PinRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.kind === 'known.bookmarks.pin.status') {
    const ids = request.folderIds;
    return Object.keys(request).length === 2 && Array.isArray(ids) && ids.length > 0 && ids.length <= 64
      && ids.every(id => typeof id === 'string' && NATIVE_ID.test(id));
  }
  return request.kind === 'known.bookmarks.pin.set' && Object.keys(request).length === 4 && request.userGesture === true
    && typeof request.nativeId === 'string' && NATIVE_ID.test(request.nativeId) && typeof request.pinned === 'boolean';
}

/** Pages ask the worker; a missing worker reads as "could not pin", never as success. */
export async function requestPin(message: PinRequest): Promise<PinResponse> {
  try { return await chrome.runtime.sendMessage(message) as PinResponse; }
  catch { return { ok: false, error: 'pin_failed' }; }
}
