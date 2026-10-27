import type { AdapterIcon } from './contracts.js';
import type { SiteIcon } from './registry-types.js';

/** A package icon is inline data, never a remote fetch performed when Settings opens. */
export const ICON_DATA_URL_MAX = 128 * 1_024;
const ICON_DATA_URL = /^data:image\/(?:png|jpe?g|webp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/u;
const ICON_ASSET_PATH = /^icons\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.(?:png|jpe?g|webp|gif|svg|ico)$/iu;
const ICON_URL_MAX = 2_048;

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

/** Package authors can choose the hosted favicon or embed an image; they cannot name a remote URL. */
export function validAdapterIcon(value: unknown): value is AdapterIcon {
  if (!plain(value)) return false;
  if (value.kind === 'favicon') return exact(value, ['kind']);
  return value.kind === 'data' && exact(value, ['kind', 'dataUrl'])
    && typeof value.dataUrl === 'string' && value.dataUrl.length <= ICON_DATA_URL_MAX && ICON_DATA_URL.test(value.dataUrl);
}

/** Bundled definitions may additionally use an extension-packaged asset or an audited HTTPS image. */
export function validSiteIcon(value: unknown): value is SiteIcon {
  if (validAdapterIcon(value)) return true;
  if (!plain(value)) return false;
  if (value.kind === 'asset') return exact(value, ['kind', 'path'])
    && typeof value.path === 'string' && value.path.length <= 256 && ICON_ASSET_PATH.test(value.path);
  if (value.kind !== 'url' || !exact(value, ['kind', 'url']) || typeof value.url !== 'string' || value.url.length > ICON_URL_MAX) return false;
  try { const url = new URL(value.url); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; }
  catch { return false; }
}
