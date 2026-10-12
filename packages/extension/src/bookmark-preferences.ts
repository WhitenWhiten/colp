export const BOOKMARK_PREFERENCES_CACHE = 'known.bookmark.preferences.v1';
export const BOOKMARK_PREFERENCES_SCHEMA = 1;

export type BookmarkInsertPosition = 'top' | 'bottom';
/** What happens to AI tag suggestions when a suggestion runs: none, offered to click, or added for the user to remove. */
export type AiTagMode = 'off' | 'suggest' | 'add';

export interface BookmarkPreferences {
  readonly bookmarkInsertPosition: BookmarkInsertPosition;
  readonly foldersFirst: boolean;
  readonly captureMode?: 'manual' | 'automatic';
  readonly resultPanelAutoDismissMs?: number;
  readonly learnFromCorrections?: boolean;
  readonly resumeClassificationWhenOnline?: boolean;
  /** Absent until this browser or the account chooses; see effectiveAiTagMode. */
  readonly aiTagMode?: AiTagMode;
  readonly subscriptionOnUnfollow?: 'keep' | 'remove';
  readonly subscriptionOnUnsubscribe?: 'keep' | 'remove';
  readonly subscriptionDefaultCheckIntervalMinutes?: 5 | 15 | 60 | null;
  readonly subscriptionDefaultDigestMode?: 'latest' | 'recent';
  readonly subscriptionDefaultEditionLimit?: number;

}

/**
 * The tag mode in force. Nobody chose yet: Suggest, except that automatic saves through the user's
 * own AI already added tags before this setting existed, so they keep adding them.
 */
export function effectiveAiTagMode(preferences: Pick<BookmarkPreferences, 'aiTagMode' | 'captureMode'> | undefined, local: boolean): AiTagMode {
  return preferences?.aiTagMode ?? (local && preferences?.captureMode === 'automatic' ? 'add' : 'suggest');
}

export interface BookmarkPreferencesPending {
  readonly commandId: string;
  readonly value: BookmarkPreferences;
  readonly patch?: Partial<BookmarkPreferences>;
  readonly ifMatch: string;
  readonly baseRevision: string;
  readonly updatedAt: number;
}

export interface BookmarkPreferencesConflict {
  readonly local: BookmarkPreferences;
  readonly remote: BookmarkPreferences;
  readonly patch?: Partial<BookmarkPreferences>;
  readonly remoteRevision: string;
  readonly remoteEtag: string;
  readonly updatedAt: number;
}

export interface BookmarkPreferencesCacheRecord {
  readonly schema: 1;
  readonly serverOrigin: string;
  readonly subject: string | null;
  readonly value: BookmarkPreferences;
  readonly revision: string;
  readonly etag: string;
  readonly pending?: BookmarkPreferencesPending;
  readonly conflict?: BookmarkPreferencesConflict;
  readonly updatedAt: number;
}

export const DEFAULT_BOOKMARK_PREFERENCES: BookmarkPreferences = Object.freeze({
  bookmarkInsertPosition: 'bottom', foldersFirst: false,
  captureMode: 'manual',
  resultPanelAutoDismissMs: 3000,
  learnFromCorrections: true,
  resumeClassificationWhenOnline: true,
  subscriptionOnUnfollow: 'keep',
  subscriptionOnUnsubscribe: 'keep',
  subscriptionDefaultCheckIntervalMinutes: 15,
  subscriptionDefaultDigestMode: 'latest',
  subscriptionDefaultEditionLimit: 10,

});
export const BOOKMARK_PREFERENCE_KEYS = [
  'bookmarkInsertPosition', 'foldersFirst', 'captureMode', 'resultPanelAutoDismissMs',
  'learnFromCorrections', 'resumeClassificationWhenOnline', 'aiTagMode', 'subscriptionOnUnfollow',
  'subscriptionOnUnsubscribe', 'subscriptionDefaultCheckIntervalMinutes',
  'subscriptionDefaultDigestMode', 'subscriptionDefaultEditionLimit',
] as const satisfies readonly (keyof BookmarkPreferences)[];

export function parseBookmarkPreferencePatch(value: unknown): Partial<BookmarkPreferences> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.some(key => !(BOOKMARK_PREFERENCE_KEYS as readonly string[]).includes(key)
      || raw[key] === undefined || (raw[key] === null && key !== 'subscriptionDefaultCheckIntervalMinutes'))) return undefined;
  return normalizeBookmarkPreferences({ ...DEFAULT_BOOKMARK_PREFERENCES, ...raw }) ? { ...raw } : undefined;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function canonicalServerOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
      || !['https:', 'http:'].includes(parsed.protocol)
      || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error('bookmark_preferences_origin_invalid');
  }
  return parsed.origin;
}

export function bookmarkPreferencesScopeKey(serverOrigin: string, subject: string | null): string {
  const origin = canonicalServerOrigin(serverOrigin);
  if (subject !== null && (!subject || subject.length > 256 || /[\u0000-\u001f\u007f]/u.test(subject))) {
    throw new Error('bookmark_preferences_subject_invalid');
  }
  return subject === null ? `${origin}\u001fdevice` : `${origin}\u001faccount\u001f${subject}`;
}

export function preferencesEtag(revision: string): string {
  return `"${revision}"`;
}

export function normalizeBookmarkPreferences(value: unknown): BookmarkPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.bookmarkInsertPosition !== 'top' && record.bookmarkInsertPosition !== 'bottom') return undefined;
  if (typeof record.foldersFirst !== 'boolean') return undefined;
  if (record.captureMode !== undefined && !['manual', 'automatic'].includes(String(record.captureMode))) return undefined;
  if (record.resultPanelAutoDismissMs !== undefined && (!Number.isSafeInteger(record.resultPanelAutoDismissMs)
    || (record.resultPanelAutoDismissMs !== 0 && (Number(record.resultPanelAutoDismissMs) < 3000 || Number(record.resultPanelAutoDismissMs) > 30000)))) return undefined;
  for (const key of ['learnFromCorrections', 'resumeClassificationWhenOnline']) {
    if (record[key] !== undefined && typeof record[key] !== 'boolean') return undefined;
  }
  if (record.aiTagMode !== undefined && !['off', 'suggest', 'add'].includes(String(record.aiTagMode))) return undefined;
  for (const key of ['subscriptionOnUnfollow', 'subscriptionOnUnsubscribe']) {
    if (record[key] !== undefined && record[key] !== 'keep' && record[key] !== 'remove') return undefined;
  }
  if (record.subscriptionDefaultCheckIntervalMinutes !== undefined
      && ![5, 15, 60, null].includes(record.subscriptionDefaultCheckIntervalMinutes as number | null)) return undefined;
  if (record.subscriptionDefaultDigestMode !== undefined
      && record.subscriptionDefaultDigestMode !== 'latest' && record.subscriptionDefaultDigestMode !== 'recent') return undefined;
  if (record.subscriptionDefaultEditionLimit !== undefined
      && (!Number.isInteger(record.subscriptionDefaultEditionLimit)
        || Number(record.subscriptionDefaultEditionLimit) < 1 || Number(record.subscriptionDefaultEditionLimit) > 20)) return undefined;
  return { bookmarkInsertPosition: record.bookmarkInsertPosition, foldersFirst: record.foldersFirst,
    captureMode: record.captureMode as 'manual' | 'automatic' ?? 'manual',
    resultPanelAutoDismissMs: record.resultPanelAutoDismissMs as number ?? 3000,
    learnFromCorrections: record.learnFromCorrections as boolean ?? true,
    resumeClassificationWhenOnline: record.resumeClassificationWhenOnline as boolean ?? true,
    ...(record.aiTagMode !== undefined ? { aiTagMode: record.aiTagMode as AiTagMode } : {}),
    ...(record.subscriptionOnUnfollow !== undefined ? { subscriptionOnUnfollow: record.subscriptionOnUnfollow as 'keep' | 'remove' } : {}),
    ...(record.subscriptionOnUnsubscribe !== undefined ? { subscriptionOnUnsubscribe: record.subscriptionOnUnsubscribe as 'keep' | 'remove' } : {}),
    ...(record.subscriptionDefaultCheckIntervalMinutes !== undefined ? { subscriptionDefaultCheckIntervalMinutes: record.subscriptionDefaultCheckIntervalMinutes as 5 | 15 | 60 | null } : {}),
    ...(record.subscriptionDefaultDigestMode !== undefined ? { subscriptionDefaultDigestMode: record.subscriptionDefaultDigestMode as 'latest' | 'recent' } : {}),
    ...(record.subscriptionDefaultEditionLimit !== undefined ? { subscriptionDefaultEditionLimit: record.subscriptionDefaultEditionLimit as number } : {}),
  };
}

export function parseBookmarkPreferencesCache(value: unknown, expectedKey?: string): BookmarkPreferencesCacheRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema !== BOOKMARK_PREFERENCES_SCHEMA || typeof record.serverOrigin !== 'string'
      || (record.subject !== null && typeof record.subject !== 'string')
      || typeof record.revision !== 'string' || !record.revision
      || typeof record.etag !== 'string' || !/^"[\x21\x23-\x7e]+"$/u.test(record.etag)
      || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return undefined;
  let key: string;
  try { key = bookmarkPreferencesScopeKey(record.serverOrigin, record.subject as string | null); }
  catch { return undefined; }
  if (expectedKey !== undefined && key !== expectedKey) return undefined;
  const preferences = normalizeBookmarkPreferences(record.value);
  if (!preferences) return undefined;
  const pending = parsePending(record.pending);
  const conflict = parseConflict(record.conflict);
  return { schema: 1, serverOrigin: canonicalServerOrigin(record.serverOrigin), subject: record.subject as string | null,
    value: preferences, revision: record.revision, etag: record.etag,
    ...(pending ? { pending } : {}), ...(conflict ? { conflict } : {}), updatedAt: record.updatedAt };
}

export function defaultBookmarkPreferencesRecord(serverOrigin: string, subject: string | null, now = Date.now()): BookmarkPreferencesCacheRecord {
  const origin = canonicalServerOrigin(serverOrigin);
  const revision = subject === null ? 'device-0' : '0';
  return { schema: 1, serverOrigin: origin, subject, value: DEFAULT_BOOKMARK_PREFERENCES,
    revision, etag: preferencesEtag(revision), updatedAt: now };
}

function parsePending(value: unknown): BookmarkPreferencesPending | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>; const preferences = normalizeBookmarkPreferences(record.value);
  if (!preferences || typeof record.commandId !== 'string' || !UUID_V4.test(record.commandId)
      || typeof record.ifMatch !== 'string' || !/^"[\x21\x23-\x7e]+"$/u.test(record.ifMatch)
      || typeof record.baseRevision !== 'string' || !record.baseRevision
      || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return undefined;
  const patch = parseBookmarkPreferencePatch(record.patch);
  return { commandId: record.commandId, value: preferences, ...(patch ? { patch } : {}), ifMatch: record.ifMatch,
    baseRevision: record.baseRevision, updatedAt: record.updatedAt };
}

function parseConflict(value: unknown): BookmarkPreferencesConflict | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>; const local = normalizeBookmarkPreferences(record.local);
  const remote = normalizeBookmarkPreferences(record.remote);
  if (!local || !remote || typeof record.remoteRevision !== 'string' || !record.remoteRevision
      || typeof record.remoteEtag !== 'string' || !/^"[\x21\x23-\x7e]+"$/u.test(record.remoteEtag)
      || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return undefined;
  const patch = parseBookmarkPreferencePatch(record.patch);
  return { local, remote, ...(patch ? { patch } : {}), remoteRevision: record.remoteRevision, remoteEtag: record.remoteEtag, updatedAt: record.updatedAt };
}
