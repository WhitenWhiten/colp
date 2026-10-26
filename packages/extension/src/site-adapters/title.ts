import { LIMITS } from './limits.js';

/** Titles sent by adapters must also be valid canonical bookmark/folder titles. */
export function validSiteTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.title
    && value.trim().length > 0 && !/[\u0000-\u001f]/u.test(value);
}

/** Explicit display projection for long source labels; identity never uses this value. */
export function siteDisplayTitle(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 16384) return null;
  const cleaned = value.replace(/[\u0000-\u001f]/gu, ' ').trim();
  let title = cleaned.slice(0, LIMITS.title);
  if (title.length < cleaned.length && /[\ud800-\udbff]$/u.test(title)) title = title.slice(0, -1);
  return validSiteTitle(title) ? title : null;
}
