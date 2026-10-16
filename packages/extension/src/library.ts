import { isProtocolOpaqueId } from './protocol-id.js';

export const COLLECTION_BINDING = 'known.sync.collection.v1';
export const LIBRARY_STATE = 'known.sync.library.v1';
export interface Library {
  readonly id: string;
  readonly title: string;
  readonly rootNodeId: string;
  readonly library: true;
  readonly bookmarksBarId: string;
  readonly otherBookmarksId: string;
}
export interface LibraryState {
  readonly accountId: string;
  readonly serverOrigin: string;
  readonly status: 'ready' | 'unsupported';
  readonly library?: Library;
}
export function parseLibrary(value: unknown): Library | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (row.library !== true || typeof row.title !== 'string' || !isProtocolOpaqueId(row.id)
    || !isProtocolOpaqueId(row.rootNodeId) || !isProtocolOpaqueId(row.bookmarksBarId)
    || !isProtocolOpaqueId(row.otherBookmarksId)) return;
  return { id: row.id, title: row.title, rootNodeId: row.rootNodeId, library: true,
    bookmarksBarId: row.bookmarksBarId, otherBookmarksId: row.otherBookmarksId };
}
export function parseLibraryState(value: unknown): LibraryState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (typeof row.accountId !== 'string' || typeof row.serverOrigin !== 'string') return;
  if (row.status === 'unsupported') return { accountId: row.accountId, serverOrigin: row.serverOrigin, status: 'unsupported' };
  const library = parseLibrary(row.library);
  if (row.status === 'ready' && library) return { accountId: row.accountId, serverOrigin: row.serverOrigin, status: 'ready', library };
}
/** Metadata belongs to one account/server; a disconnected library is never a sync binding. */
export function boundLibrary(stored: Record<string, unknown>, serverOrigin?: string): Library | undefined {
  const state = parseLibraryState(stored[LIBRARY_STATE]);
  if (state?.status !== 'ready' || state.library?.id !== stored[COLLECTION_BINDING]
    || serverOrigin !== undefined && state.serverOrigin !== serverOrigin) return;
  return state.library;
}
