import { assertCanonicalCommandId, type ProductCommandReceiptPort } from '../../commands/index.js';

export const BOOKMARK_PREFERENCES_CONTRACT_VERSION = '1.3.0';
export const BOOKMARK_PREFERENCES_ROUTE = '/api/v1/me/bookmark-preferences';
const VIRTUAL_REVISION = '0';

function strongBookmarkPreferencesEtag(revision: string): string {
  return `"${revision}"`;
}

export type BookmarkInsertPosition = 'top' | 'bottom';
/** What happens to AI tag suggestions: none, offered to click, or added for the user to remove. */
export type AiTagMode = 'off' | 'suggest' | 'add';

export interface BookmarkPreferencesView {
  readonly bookmarkInsertPosition: BookmarkInsertPosition;
  readonly foldersFirst: boolean;
  readonly captureMode: 'manual' | 'automatic';
  readonly resultPanelAutoDismissMs: number;
  readonly learnFromCorrections: boolean;
  readonly resumeClassificationWhenOnline: boolean;
  readonly aiTagMode: AiTagMode;
  readonly subscriptionOnUnfollow: 'keep' | 'remove';
  readonly subscriptionOnUnsubscribe: 'keep' | 'remove';
  readonly subscriptionDefaultCheckIntervalMinutes: 5 | 15 | 60 | null;
  readonly subscriptionDefaultDigestMode: 'latest' | 'recent';
  readonly subscriptionDefaultEditionLimit: number;

  readonly revision: string;
  readonly updatedAt: string;
}

export interface BookmarkPreferencesPatch {
  readonly bookmarkInsertPosition?: BookmarkInsertPosition;
  readonly foldersFirst?: boolean;
  readonly captureMode?: 'manual' | 'automatic';
  readonly resultPanelAutoDismissMs?: number;
  readonly learnFromCorrections?: boolean;
  readonly resumeClassificationWhenOnline?: boolean;
  readonly aiTagMode?: AiTagMode;
  readonly subscriptionOnUnfollow?: 'keep' | 'remove';
  readonly subscriptionOnUnsubscribe?: 'keep' | 'remove';
  readonly subscriptionDefaultCheckIntervalMinutes?: 5 | 15 | 60 | null;
  readonly subscriptionDefaultDigestMode?: 'latest' | 'recent';
  readonly subscriptionDefaultEditionLimit?: number;

}

export class BookmarkPreferencesError extends Error {
  readonly code = 'invalid_request' as const;

  constructor(message: string) {
    super(message);
    this.name = 'BookmarkPreferencesError';
  }
}

export class BookmarkPreferencesPreconditionError extends Error {
  readonly code = 'precondition_failed' as const;
  readonly precondition = 'resource' as const;
  readonly currentEtag: string;

  constructor(currentEtag: string) {
    super('The bookmark preferences ETag does not match the current representation.');
    this.name = 'BookmarkPreferencesPreconditionError';
    this.currentEtag = currentEtag;
  }
}

export interface BookmarkPreferencesStore {
  load(accountId: string): Promise<BookmarkPreferencesView | null>;
  insertFirst(accountId: string, view: BookmarkPreferencesView): Promise<'inserted' | 'conflict'>;
  updateIfRevision(accountId: string, expectedRevision: string, view: BookmarkPreferencesView): Promise<boolean>;
}

export interface BookmarkPreferencesPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly store: BookmarkPreferencesStore;
  readonly clock: { now(): Promise<Date> };
  readonly lockAccount?: (accountId: string) => Promise<void>;
}

export type UpdateBookmarkPreferencesResult =
  | { readonly kind: 'updated'; readonly preferences: BookmarkPreferencesView }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

function nextRevision(current: string): string {
  return String(BigInt(current) + 1n);
}

function wire(view: BookmarkPreferencesView): BookmarkPreferencesView {
  return Object.freeze({
    bookmarkInsertPosition: view.bookmarkInsertPosition,
    foldersFirst: view.foldersFirst,
    captureMode: view.captureMode,
    resultPanelAutoDismissMs: view.resultPanelAutoDismissMs,
    learnFromCorrections: view.learnFromCorrections,
    resumeClassificationWhenOnline: view.resumeClassificationWhenOnline,
    aiTagMode: view.aiTagMode,
    subscriptionOnUnfollow: view.subscriptionOnUnfollow,
    subscriptionOnUnsubscribe: view.subscriptionOnUnsubscribe,
    subscriptionDefaultCheckIntervalMinutes: view.subscriptionDefaultCheckIntervalMinutes,
    subscriptionDefaultDigestMode: view.subscriptionDefaultDigestMode,
    subscriptionDefaultEditionLimit: view.subscriptionDefaultEditionLimit,

    revision: view.revision,
    updatedAt: view.updatedAt,
  });
}

export function parseBookmarkPreferencesPatch(body: unknown): BookmarkPreferencesPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BookmarkPreferencesError('Bookmark preferences patch must be a JSON object.');
  }
  const raw = body as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new BookmarkPreferencesError('Bookmark preferences patch must include at least one field.');
  for (const key of keys) {
    if (!['bookmarkInsertPosition', 'foldersFirst', 'captureMode', 'resultPanelAutoDismissMs', 'learnFromCorrections', 'resumeClassificationWhenOnline', 'aiTagMode', 'subscriptionOnUnfollow', 'subscriptionOnUnsubscribe', 'subscriptionDefaultCheckIntervalMinutes', 'subscriptionDefaultDigestMode', 'subscriptionDefaultEditionLimit'].includes(key)) {
      throw new BookmarkPreferencesError(`Property "${key}" is not allowed.`);
    }
  }
  const patch: BookmarkPreferencesPatch = {
    ...(Object.hasOwn(raw, 'subscriptionOnUnfollow') ? { subscriptionOnUnfollow: raw.subscriptionOnUnfollow as 'keep' | 'remove' } : {}),
    ...(Object.hasOwn(raw, 'subscriptionOnUnsubscribe') ? { subscriptionOnUnsubscribe: raw.subscriptionOnUnsubscribe as 'keep' | 'remove' } : {}),
    ...(Object.hasOwn(raw, 'subscriptionDefaultCheckIntervalMinutes') ? { subscriptionDefaultCheckIntervalMinutes: raw.subscriptionDefaultCheckIntervalMinutes as 5 | 15 | 60 | null } : {}),
    ...(Object.hasOwn(raw, 'subscriptionDefaultDigestMode') ? { subscriptionDefaultDigestMode: raw.subscriptionDefaultDigestMode as 'latest' | 'recent' } : {}),
    ...(Object.hasOwn(raw, 'subscriptionDefaultEditionLimit') ? { subscriptionDefaultEditionLimit: raw.subscriptionDefaultEditionLimit as number } : {}),
    ...(Object.hasOwn(raw, 'captureMode') ? { captureMode: raw.captureMode as 'manual' | 'automatic' } : {}),
    ...(Object.hasOwn(raw, 'resultPanelAutoDismissMs') ? { resultPanelAutoDismissMs: raw.resultPanelAutoDismissMs as number } : {}),
    ...(Object.hasOwn(raw, 'learnFromCorrections') ? { learnFromCorrections: raw.learnFromCorrections as boolean } : {}),
    ...(Object.hasOwn(raw, 'resumeClassificationWhenOnline') ? { resumeClassificationWhenOnline: raw.resumeClassificationWhenOnline as boolean } : {}),
    ...(Object.hasOwn(raw, 'aiTagMode') ? { aiTagMode: raw.aiTagMode as AiTagMode } : {}),

    ...(Object.hasOwn(raw, 'bookmarkInsertPosition')
      ? { bookmarkInsertPosition: raw.bookmarkInsertPosition as BookmarkInsertPosition }
      : {}),
    ...(Object.hasOwn(raw, 'foldersFirst') ? { foldersFirst: raw.foldersFirst as boolean } : {}),
  };
  if (patch.bookmarkInsertPosition !== undefined
      && patch.bookmarkInsertPosition !== 'top' && patch.bookmarkInsertPosition !== 'bottom') {
    throw new BookmarkPreferencesError('bookmarkInsertPosition must be top or bottom.');
  }
  if (patch.foldersFirst !== undefined && typeof patch.foldersFirst !== 'boolean') {
    throw new BookmarkPreferencesError('foldersFirst must be a boolean.');
  }
  if (Object.hasOwn(raw, 'captureMode') && patch.captureMode !== 'manual' && patch.captureMode !== 'automatic') {
    throw new BookmarkPreferencesError('captureMode must be manual or automatic.');
  }
  if (Object.hasOwn(raw, 'resultPanelAutoDismissMs') && (!Number.isSafeInteger(patch.resultPanelAutoDismissMs)
    || (patch.resultPanelAutoDismissMs !== 0 && (patch.resultPanelAutoDismissMs! < 3000 || patch.resultPanelAutoDismissMs! > 30000)))) {
    throw new BookmarkPreferencesError('resultPanelAutoDismissMs must be 0 or 3000–30000.');
  }
  for (const field of ['learnFromCorrections', 'resumeClassificationWhenOnline'] as const) {
    if (Object.hasOwn(raw, field) && typeof patch[field] !== 'boolean') throw new BookmarkPreferencesError(`${field} must be boolean.`);
  }
  if (Object.hasOwn(raw, 'aiTagMode') && !['off', 'suggest', 'add'].includes(raw.aiTagMode as string)) {
    throw new BookmarkPreferencesError('aiTagMode must be off, suggest or add.');
  }
  for (const field of ['subscriptionOnUnfollow', 'subscriptionOnUnsubscribe'] as const) {
    if (Object.hasOwn(raw, field) && raw[field] !== 'keep' && raw[field] !== 'remove') {
      throw new BookmarkPreferencesError(`${field} must be keep or remove.`);
    }
  }
  if (Object.hasOwn(raw, 'subscriptionDefaultCheckIntervalMinutes')
      && ![5, 15, 60, null].includes(raw.subscriptionDefaultCheckIntervalMinutes as number | null)) {
    throw new BookmarkPreferencesError('subscriptionDefaultCheckIntervalMinutes must be 5, 15, 60 or null.');
  }
  if (Object.hasOwn(raw, 'subscriptionDefaultDigestMode')
      && raw.subscriptionDefaultDigestMode !== 'latest' && raw.subscriptionDefaultDigestMode !== 'recent') {
    throw new BookmarkPreferencesError('subscriptionDefaultDigestMode must be latest or recent.');
  }
  if (Object.hasOwn(raw, 'subscriptionDefaultEditionLimit')
      && (!Number.isInteger(raw.subscriptionDefaultEditionLimit)
        || Number(raw.subscriptionDefaultEditionLimit) < 1 || Number(raw.subscriptionDefaultEditionLimit) > 20)) {
    throw new BookmarkPreferencesError('subscriptionDefaultEditionLimit must be an integer from 1 to 20.');
  }
  return Object.freeze(patch);
}

export function virtualBookmarkPreferences(createdAt: Date): BookmarkPreferencesView {
  return Object.freeze({
    bookmarkInsertPosition: 'bottom',
    foldersFirst: false,
    captureMode: 'manual',
    resultPanelAutoDismissMs: 3000,
    learnFromCorrections: true,
    resumeClassificationWhenOnline: true,
    aiTagMode: 'suggest',
    subscriptionOnUnfollow: 'keep',
    subscriptionOnUnsubscribe: 'keep',
    subscriptionDefaultCheckIntervalMinutes: 15,
    subscriptionDefaultDigestMode: 'latest',
    subscriptionDefaultEditionLimit: 10,

    revision: VIRTUAL_REVISION,
    updatedAt: createdAt.toISOString(),
  });
}

export async function getBookmarkPreferences(
  store: BookmarkPreferencesStore,
  input: { readonly accountId: string; readonly createdAt: Date },
): Promise<BookmarkPreferencesView> {
  return (await store.load(input.accountId)) ?? virtualBookmarkPreferences(input.createdAt);
}

export async function updateBookmarkPreferences(
  ports: BookmarkPreferencesPorts,
  input: {
    readonly actor: { readonly principalId: string; readonly accountId: string; readonly createdAt: Date };
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly ifMatch: string;
    readonly patch: BookmarkPreferencesPatch;
  },
): Promise<UpdateBookmarkPreferencesResult> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: input.commandScope,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') {
    return { kind: 'replay', status: claim.result.status, body: claim.result.body,
      stableHeaders: claim.result.stableHeaders, mediaType: claim.result.mediaType };
  }
  if (claim.kind !== 'claimed') return claim;
  await ports.lockAccount?.(input.actor.accountId);
  const current = await getBookmarkPreferences(ports.store, input.actor);
  if (input.ifMatch !== strongBookmarkPreferencesEtag(current.revision)) {
    throw new BookmarkPreferencesPreconditionError(strongBookmarkPreferencesEtag(current.revision));
  }
  const next: BookmarkPreferencesView = Object.freeze({
    bookmarkInsertPosition: input.patch.bookmarkInsertPosition ?? current.bookmarkInsertPosition,
    foldersFirst: input.patch.foldersFirst ?? current.foldersFirst,
    captureMode: input.patch.captureMode ?? current.captureMode,
    resultPanelAutoDismissMs: input.patch.resultPanelAutoDismissMs ?? current.resultPanelAutoDismissMs,
    learnFromCorrections: input.patch.learnFromCorrections ?? current.learnFromCorrections,
    resumeClassificationWhenOnline: input.patch.resumeClassificationWhenOnline ?? current.resumeClassificationWhenOnline,
    aiTagMode: input.patch.aiTagMode ?? current.aiTagMode,
    subscriptionOnUnfollow: input.patch.subscriptionOnUnfollow !== undefined ? input.patch.subscriptionOnUnfollow : current.subscriptionOnUnfollow,
    subscriptionOnUnsubscribe: input.patch.subscriptionOnUnsubscribe !== undefined ? input.patch.subscriptionOnUnsubscribe : current.subscriptionOnUnsubscribe,
    subscriptionDefaultCheckIntervalMinutes: input.patch.subscriptionDefaultCheckIntervalMinutes !== undefined ? input.patch.subscriptionDefaultCheckIntervalMinutes : current.subscriptionDefaultCheckIntervalMinutes,
    subscriptionDefaultDigestMode: input.patch.subscriptionDefaultDigestMode !== undefined ? input.patch.subscriptionDefaultDigestMode : current.subscriptionDefaultDigestMode,
    subscriptionDefaultEditionLimit: input.patch.subscriptionDefaultEditionLimit !== undefined ? input.patch.subscriptionDefaultEditionLimit : current.subscriptionDefaultEditionLimit,

    revision: nextRevision(current.revision),
    updatedAt: (await ports.clock.now()).toISOString(),
  });
  if (current.revision === VIRTUAL_REVISION) {
    const inserted = await ports.store.insertFirst(input.actor.accountId, next);
    if (inserted === 'conflict') {
      const fresh = await ports.store.load(input.actor.accountId);
      throw new BookmarkPreferencesPreconditionError(strongBookmarkPreferencesEtag(fresh?.revision ?? current.revision));
    }
  } else if (!await ports.store.updateIfRevision(input.actor.accountId, current.revision, next)) {
    const fresh = await ports.store.load(input.actor.accountId);
    throw new BookmarkPreferencesPreconditionError(strongBookmarkPreferencesEtag(fresh?.revision ?? current.revision));
  }
  const body = new TextEncoder().encode(JSON.stringify({
    bookmarkInsertPosition: next.bookmarkInsertPosition,
    foldersFirst: next.foldersFirst,
    captureMode: next.captureMode,
    resultPanelAutoDismissMs: next.resultPanelAutoDismissMs,
    learnFromCorrections: next.learnFromCorrections,
    resumeClassificationWhenOnline: next.resumeClassificationWhenOnline,
    aiTagMode: next.aiTagMode,
    subscriptionOnUnfollow: next.subscriptionOnUnfollow,
    subscriptionOnUnsubscribe: next.subscriptionOnUnsubscribe,
    subscriptionDefaultCheckIntervalMinutes: next.subscriptionDefaultCheckIntervalMinutes,
    subscriptionDefaultDigestMode: next.subscriptionDefaultDigestMode,
    subscriptionDefaultEditionLimit: next.subscriptionDefaultEditionLimit,

    revision: next.revision,
    updatedAt: next.updatedAt,
  }));
  await ports.receipts.complete(binding, input.fingerprint, {
    status: 200,
    body,
    stableHeaders: { etag: strongBookmarkPreferencesEtag(next.revision), 'cache-control': 'private, no-store', 'content-type': 'application/json' },
    mediaType: 'application/json',
    contractVersion: BOOKMARK_PREFERENCES_CONTRACT_VERSION,
    targetIdentity: input.actor.accountId,
  });
  return { kind: 'updated', preferences: wire(next) };
}
