import { fillAvatar } from './account-label.js';
import { AUTH_SNAPSHOT, parseAuthSnapshot } from './auth-snapshot.js';
import type { PublicAuthState } from './types.js';

export function setHidden(node: HTMLElement, hidden: boolean): void {
  node.hidden = hidden;
  if (hidden) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}


export function isSavableUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}


export function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error('popup_markup_invalid');
  return value;
}

/* Account monogram (the kit's .avatar): an ink circle carrying the account's
   first letter. A photo URL is used when the snapshot carries a trusted one. */
export function accountAvatar(name: string, imageUrl?: string, serverOrigin?: string): HTMLElement {
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  fillAvatar(avatar, (name.trim().charAt(0) || '?').toUpperCase(), imageUrl, serverOrigin);
  return avatar;
}

/* The header shows only the account monogram; the full label lives in
   Options. The wrapper's title still names who is signed in, and the button
   around it exists only while there is an account to open. */
export function paintAccountLabel(host: HTMLElement, state: PublicAuthState): void {
  host.title = state.accountLabel ?? '';
  const known = Boolean(state.accountLabel || state.avatarUrl);
  if (known) {
    host.replaceChildren(accountAvatar(state.accountLabel ?? '', state.avatarUrl, state.status === 'connected' ? state.serverOrigin : undefined));
  } else host.replaceChildren();
  const button = host.closest<HTMLElement>('button');
  if (button) setHidden(button, !known);
}

/* The overflow menu closes on a press outside it, after a pick, and on
   Escape, which returns focus to its summary. */
export function bindOverflowMenu(more: HTMLDetailsElement): void {
  document.addEventListener('pointerdown', (event) => { if (more.open && !more.contains(event.target as Node)) more.open = false; });
  more.querySelector('.popup-more-menu')?.addEventListener('click', () => { more.open = false; more.querySelector<HTMLElement>('summary')?.focus(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && more.open) { more.open = false; more.querySelector<HTMLElement>('summary')?.focus(); }
  });
}

export function bindAuthSnapshot(read: () => PublicAuthState | undefined, paint: (state: PublicAuthState) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[AUTH_SNAPSHOT]) return;
    const next = parseAuthSnapshot(changes[AUTH_SNAPSHOT].newValue);
    if (next?.avatarUrl && next.avatarUrl !== read()?.avatarUrl) paint(next);
  });
}


/* Lives here so popup.ts stays inside its shrinking-only line cap. Save is
   aria-disabled while bookmark access is missing, and the Allow button takes
   the primary look meanwhile (one primary per view). */
export function paintPermissionGate(): void {
  const permissionNote = document.getElementById('permission-note');
  const save = document.getElementById('save');
  if (!permissionNote || !save) return;
  const missing = !permissionNote.hidden;
  save.classList.toggle('btn-primary', !missing);
  save.classList.toggle('btn-secondary', missing);
  save.setAttribute('aria-disabled', missing ? 'true' : 'false');
}
