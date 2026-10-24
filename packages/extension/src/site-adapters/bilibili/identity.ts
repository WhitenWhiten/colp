import type { SiteCollection, SiteItem } from '../contracts.js';
import { LIMITS } from '../limits.js';
export const BILIBILI = Object.freeze({ adapterId: 'bundled.bilibili', version: '1.0.0', siteKey: 'bilibili', identityVersion: 1,
  origin: 'https://www.bilibili.com', matches: ['https://www.bilibili.com/*'] });
/** Decimal source IDs are opaque strings. Reject unsafe JSON numbers rather than rounding. */
export function decimal(value: unknown): string | null {
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof s === 'string' && /^[1-9]\d{0,19}$/u.test(s) ? s : null;
}
export const itemId = (aid: string) => `video:av:${aid}`;
export function aidFromItem(id: string): string | null { return id.startsWith('video:av:') ? decimal(id.slice(9)) : null; }
export function resolveAvUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.origin !== BILIBILI.origin || u.username || u.password) return null;
    return decimal(/^\/video\/av([1-9]\d*)\/?$/u.exec(u.pathname)?.[1]);
  } catch { return null; }
}
export function collection(raw: unknown): SiteCollection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>, id = decimal(r.id);
  return id && typeof r.title === 'string' && r.title.trim() && r.title.length <= LIMITS.title
    ? { id, identity: 'siteId', title: r.title.trim(), parentId: null } : null;
}
export type Detail = { status: 'ok'; item: SiteItem } | { status: 'invalid' | 'unsupported' | 'missing' };
export function detail(raw: unknown): Detail {
  if (!raw || typeof raw !== 'object') return { status: 'missing' };
  const r = raw as Record<string, unknown>, aid = decimal(r.id);
  if (r.type !== 2) return { status: 'unsupported' };
  if (!aid || typeof r.title !== 'string' || !r.title.trim() || r.title.length > LIMITS.title) return { status: 'missing' };
  if (r.attr === 9 || r.title === '已失效视频') return { status: 'invalid' };
  return { status: 'ok', item: { id: itemId(aid), identity: 'siteId', kind: 'video',
    url: `${BILIBILI.origin}/video/av${aid}`, title: r.title.trim() } };
}
/** Validate namespace and canonical URL together; equal URL or labels never establish identity. */
export function validBilibiliItem(item: SiteItem): boolean {
  return item.identity === 'siteId' && item.kind === 'video' && !!aidFromItem(item.id)
    && resolveAvUrl(item.url) === aidFromItem(item.id) && item.url === `${BILIBILI.origin}/video/av${aidFromItem(item.id)}`;
}
