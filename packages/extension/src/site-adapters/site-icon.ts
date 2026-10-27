import type { AdapterIcon } from './contracts.js';
import type { SiteIcon } from './registry-types.js';

export type DisplayIcon = SiteIcon | AdapterIcon;

/** The site's conventional favicon, then the browser's cache for visits that did not fetch one directly. */
export function faviconSources(origin: string, size: number): readonly string[] {
  try {
    const site = new URL(origin);
    if (site.protocol !== 'https:') return [];
    const resource = new URL(chrome.runtime.getURL('/_favicon/'));
    resource.searchParams.set('pageUrl', `${site.origin}/`);
    resource.searchParams.set('size', String(size));
    return [new URL('/favicon.ico', site.origin).toString(), resource.toString()];
  } catch { return []; }
}

/** Ordered sources: the authored mark first, then the site favicon, then the callers' letter fallback. */
export function iconSources(icon: DisplayIcon | undefined, origin: string, size: number): readonly string[] {
  const sources: string[] = [];
  if (icon?.kind === 'data') sources.push(icon.dataUrl);
  else if (icon?.kind === 'url') sources.push(icon.url);
  else if (icon?.kind === 'asset') { try { sources.push(chrome.runtime.getURL(icon.path)); } catch { /* packaged asset unavailable */ } }
  for (const favicon of faviconSources(origin, size)) if (!sources.includes(favicon)) sources.push(favicon);
  return sources;
}

export interface SiteMarkOptions {
  readonly label: string;
  readonly origin: string;
  readonly icon?: DisplayIcon;
  readonly size?: number;
  readonly className?: string;
}

/** A site's mark: the authored/favicon image when it loads, otherwise its first letter. */
export function createSiteMark(options: SiteMarkOptions): HTMLElement {
  const size = Math.max(12, Math.min(64, Math.round(options.size ?? 20)));
  const mark = document.createElement('span');
  mark.className = options.className ?? 'sites-mark';
  mark.dataset.icon = 'letter';
  mark.setAttribute('aria-hidden', 'true');
  const letter = document.createElement('span');
  letter.className = 'sites-mark-letter';
  letter.textContent = Array.from(options.label.trim())[0]?.toLocaleUpperCase() ?? '?';
  mark.append(letter);
  const sources = iconSources(options.icon, options.origin, size);
  if (!sources.length) return mark;
  const image = document.createElement('img');
  image.width = size; image.height = size; image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
  let next = 0;
  const attempt = () => {
    if (next >= sources.length) { image.remove(); mark.dataset.icon = 'letter'; return; }
    image.src = sources[next++]!;
  };
  image.addEventListener('load', () => { mark.dataset.icon = 'image'; });
  image.addEventListener('error', attempt);
  mark.append(image); attempt();
  return mark;
}
