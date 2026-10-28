import { decimal } from './identity.js';
export interface FavoriteHint { interactionId: string; itemId: string; added: string[]; removed: string[]; code: number }
export function favoriteEndpoint(url: string, method: string) {
  try { const u = new URL(url, location.href); return u.origin === 'https://api.bilibili.com' && u.pathname === '/x/v3/fav/resource/deal' && method.toUpperCase() === 'POST'; }
  catch { return false; }
}
/** Only this endpoint's bounded scalar fields cross MAIN. No request bodies or tokens. */
export function favoriteRequest(url: string, method: string, body: unknown): Omit<FavoriteHint, 'interactionId' | 'code'> | null {
  try {
    if (!favoriteEndpoint(url, method)) return null;
    if (body instanceof FormData) {
      const fields = new URLSearchParams(); let count = 0, length = 0;
      body.forEach((value, key) => {
        if (typeof value !== 'string' || ++count > 128 || (length += key.length + value.length) > 8192) throw Error('invalidForm');
        fields.append(key, value);
      });
      body = fields;
    }
    if (!(typeof body === 'string' || body instanceof URLSearchParams) || String(body).length > 8192) return null;
    const p = new URLSearchParams(String(body)), aid = decimal(p.get('rid'));
    if (['rid', 'type', 'add_media_ids', 'del_media_ids'].some(key => p.getAll(key).length > 1)) return null;
    if (!aid || p.get('type') !== '2') return null;
    const added = (p.get('add_media_ids') || '').split(',').filter(Boolean), removed = (p.get('del_media_ids') || '').split(',').filter(Boolean);
    if (added.length + removed.length > 64 || !added.length && !removed.length || [...added, ...removed].some(x => !decimal(x))
        || new Set([...added, ...removed]).size !== added.length + removed.length) return null;
    return { itemId: `video:av:${aid}`, added, removed };
  } catch { return null; }
}
