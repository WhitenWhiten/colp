import {
  parsePaintAvatarUrl, parseRemoteAvatarUrl, sniffImageType,
} from './avatar-url.js';
import { readBoundedJson } from './json-response.js';
import { assertCredentialHostPermission } from './server-origin-permission.js';

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const ME_MAX_BYTES = 64 * 1_024;
const paints = new WeakMap<HTMLElement, number>();

/** Compact account labels shared by the popup and Options identity views. */
export function shortLabel(value: string): string {
  const at = value.indexOf('@');
  return at > 0 ? value.slice(0, at) : value.slice(0, 18);
}

export function avatarLetter(label?: string): string {
  const value = (label ?? 'K').trim();
  return (value[0] ?? 'K').toUpperCase();
}

/**
 * Paint a photo when a trusted URL is known. Product avatars are fetched as a
 * blob so chrome-extension pages are not blanked by same-site CORP. When the
 * snapshot has no URL yet, hydrate `/me` (and the IdP image on get-session).
 */
export function fillAvatar(target: HTMLElement, letter: string, url?: string, serverOrigin?: string): void {
  const generation = (paints.get(target) ?? 0) + 1;
  paints.set(target, generation);
  target.replaceChildren();
  const href = parsePaintAvatarUrl(url, serverOrigin);
  if (href) {
    paintPhoto(target, generation, letter, href);
    return;
  }
  target.textContent = letter;
  if (serverOrigin) void hydrateFromMe(target, generation, letter, serverOrigin);
}

function paintPhoto(target: HTMLElement, generation: number, letter: string, href: string): void {
  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  const fail = (): void => {
    if (paints.get(target) !== generation) return;
    target.replaceChildren();
    target.textContent = letter;
  };
  target.append(img);
  if (href.startsWith('data:')) {
    img.addEventListener('error', fail, { once: true });
    img.src = href;
    return;
  }
  void (async () => {
    try {
      const objectUrl = await fetchAvatarObjectUrl(href);
      if (paints.get(target) !== generation) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      img.addEventListener('error', fail, { once: true });
      img.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
      img.src = objectUrl;
    } catch {
      if (paints.get(target) !== generation) return;
      img.addEventListener('error', fail, { once: true });
      img.src = href;
    }
  })();
}

async function hydrateFromMe(
  target: HTMLElement, generation: number, letter: string, serverOrigin: string,
): Promise<void> {
  try {
    const href = await readMeAvatar(serverOrigin);
    if (!href || paints.get(target) !== generation) return;
    target.replaceChildren();
    paintPhoto(target, generation, letter, href);
  } catch { /* letter already painted */ }
}

async function readMeAvatar(serverOrigin: string): Promise<string | undefined> {
  const origin = serverOrigin.replace(/\/$/u, '');
  const get = async (path: string): Promise<Response> => {
    const url = `${origin}${path}`;
    const init: RequestInit = {
      credentials: 'include', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json' },
    };
    await assertCredentialHostPermission(url, init);
    return fetch(url, init);
  };
  const session = await get('/api/v1/session');
  if (!session.ok) return undefined;
  const sessionBody = await readBoundedJson(session, ME_MAX_BYTES, 'session_unavailable');
  if (!record(sessionBody) || sessionBody.authenticated !== true) return undefined;
  const me = await get('/api/v1/me');
  if (me.ok) {
    const body = await readBoundedJson(me, ME_MAX_BYTES, 'session_unavailable');
    const url = record(body) && record(body.profile)
      ? parseRemoteAvatarUrl(body.profile.avatarUrl, origin) : undefined;
    if (url) return url;
  }
  const identity = await get('/api/v1/auth/get-session');
  if (!identity.ok) return undefined;
  const ident = await readBoundedJson(identity, ME_MAX_BYTES, 'session_unavailable');
  return record(ident) && record(ident.user) ? parseRemoteAvatarUrl(ident.user.image, origin) : undefined;
}

async function fetchAvatarObjectUrl(href: string): Promise<string> {
  const response = await fetch(href, {
    method: 'GET', credentials: 'omit', cache: 'force-cache', redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error('avatar_unavailable');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > AVATAR_MAX_BYTES) throw new Error('avatar_unavailable');
  const type = sniffImageType(bytes);
  if (!type) throw new Error('avatar_unavailable');
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
