export type PersonalSyncAction = 'pause' | 'resume' | 'disconnect';
export type PersonalSyncCommand =
  | { readonly kind: 'known.personalSync.status' }
  | { readonly kind: 'known.personalSync.preview'; readonly action: 'resume' | 'disconnect' }
  | { readonly kind: 'known.personalSync.change'; readonly action: PersonalSyncAction;
      readonly revision: string; readonly userGesture: true; readonly token?: string };
const actions = new Set<unknown>(['pause', 'resume', 'disconnect']);
export function validPersonalSyncCommand(value: unknown): value is PersonalSyncCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>, keys = Object.keys(raw);
  if (raw.kind === 'known.personalSync.status') return keys.length === 1;
  if (raw.kind === 'known.personalSync.preview') return keys.length === 2 && (raw.action === 'resume' || raw.action === 'disconnect');
  if (raw.kind !== 'known.personalSync.change' || !actions.has(raw.action) || raw.userGesture !== true
    || typeof raw.revision !== 'string' || !raw.revision || raw.revision.length > 128) return false;
  if (raw.action === 'pause') return keys.length === 4;
  return keys.length === 5 && typeof raw.token === 'string' && /^[0-9a-f-]{36}$/u.test(raw.token);
}
export function trustedLifecyclePage(sender: { readonly id?: string; readonly url?: string }, extensionId: string, readOnly = false): boolean {
  if (sender.id !== extensionId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId && (url.pathname === '/options.html' || readOnly && url.pathname === '/popup.html');
  } catch { return false; }
}
export interface ConfirmationBasis {
  readonly accountKey: string;
  readonly generation: number;
  readonly revision: string;
  readonly collectionId: string;
  readonly digest: string;
}
/** Ephemeral, single-use confirmations: a worker restart requires a fresh preview, never blind replay. */
export function createSyncConfirmations(now: () => number = Date.now) {
  const pending = new Map<string, { action: 'resume' | 'disconnect'; basis: ConfirmationBasis; expiresAt: number }>();
  const prune = () => { for (const [id, value] of pending) if (value.expiresAt <= now()) pending.delete(id); };
  return Object.freeze({
    issue(action: 'resume' | 'disconnect', basis: ConfirmationBasis): string {
      prune(); if (pending.size >= 16) pending.delete(pending.keys().next().value!);
      const token = crypto.randomUUID(); pending.set(token, { action, basis: { ...basis }, expiresAt: now() + 120_000 });
      return token;
    },
    consume(token: string, action: 'resume' | 'disconnect', basis: ConfirmationBasis): void {
      const value = pending.get(token); pending.delete(token); prune();
      if (!value || value.expiresAt <= now() || value.action !== action
        || Object.keys(value.basis).some(key => value.basis[key as keyof ConfirmationBasis] !== basis[key as keyof ConfirmationBasis])) {
        throw new Error('personal_sync_preview_stale');
      }
    },
  });
}
