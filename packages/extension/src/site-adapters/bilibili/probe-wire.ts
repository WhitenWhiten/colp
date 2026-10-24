import { decimal } from './identity.js';
export interface FavoriteHint { interactionId: string; itemId: string; added: string[]; removed: string[]; code: number }
/** Only this endpoint's bounded scalar fields cross MAIN. No request bodies or tokens. */
export function favoriteRequest(url: string, method: string, body: unknown): Omit<FavoriteHint, 'interactionId' | 'code'> | null {
  try {
    const u = new URL(url, location.href);
    if (u.origin !== 'https://api.bilibili.com' || u.pathname !== '/x/v3/fav/resource/deal' || method.toUpperCase() !== 'POST') return null;
    if (!(typeof body === 'string' || body instanceof URLSearchParams) || String(body).length > 8192) return null;
    const p = new URLSearchParams(String(body)), aid = decimal(p.get('rid'));
    if (!aid || p.get('type') !== '2') return null;
    const added = (p.get('add_media_ids') || '').split(',').filter(Boolean), removed = (p.get('del_media_ids') || '').split(',').filter(Boolean);
    if (added.length + removed.length > 64 || !added.length && !removed.length || [...added, ...removed].some(x => !decimal(x))
        || new Set([...added, ...removed]).size !== added.length + removed.length) return null;
    return { itemId: `video:av:${aid}`, added, removed };
  } catch { return null; }
}
