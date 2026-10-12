import { hydrateIcons, type IconName } from './icons.js';
import { element, setHidden } from './popup-dom.js';

/**
 * The popup shell is one layout for every state (header, optional progress
 * line, body, footer). These helpers are the only writers of the three parts
 * that change meaning between manual, edit and automatic-result: the status
 * line, the attention alert and the footer's action set.
 */
export type FooterMode = 'manual' | 'existing' | 'saved' | 'result';

export interface StatusLine {
  readonly icon: IconName;
  readonly text: string;
  /** Muted text after the dot: where the bookmark lives, or when it was saved. */
  readonly meta?: string;
  readonly tone?: 'neutral' | 'danger';
}

/** Paints the status line, or hides it for `undefined`. */
export function paintStatusLine(line: StatusLine | undefined): void {
  const host = element('capture-status');
  if (!line) { setHidden(host, true); return; }
  const icon = element('capture-status-icon');
  icon.dataset.icon = line.icon;
  hydrateIcons(host);
  element('capture-status-text').textContent = line.text;
  element('capture-status-meta').textContent = line.meta ?? '';
  if (line.tone) host.dataset.tone = line.tone; else delete host.dataset.tone;
  setHidden(host, false);
}

/** A notice that needs the user's eye (failure, offline, attention); `undefined` hides it. */
export function paintCaptureAlert(text: string | undefined, tone: 'warning' | 'danger' = 'warning'): void {
  const host = element('capture-alert');
  element('capture-alert-text').textContent = text ?? '';
  host.dataset.tone = tone;
  setHidden(host, !text);
}

export function setFooterMode(mode: FooterMode): void {
  element('popup-foot').dataset.mode = mode;
}

/** A calendar date for the "Already saved" status; the bookmark's own creation time. */
export function formatSavedDate(timestamp: number | undefined): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(timestamp)); }
  catch { return ''; }
}

/** The site icon in the page tile; anything but an http(s) image falls back to the generic page icon. */
export function paintFavicon(url: string | undefined): void {
  const image = element('tab-favicon') as HTMLImageElement;
  const fallback = element('tab-fallback');
  const usable = url !== undefined && /^https?:/u.test(url) ? url : '';
  if (usable) {
    setHidden(fallback, true);
    if (image.getAttribute('src') !== usable) image.src = usable;
    setHidden(image, false);
    return;
  }
  image.removeAttribute('src');
  setHidden(image, true);
  setHidden(fallback, false);
}

/** "host/path" for the domain line; the raw value when it is not a URL. */
export function urlSummary(raw: string): string {
  try {
    const parsed = new URL(raw);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch { return raw; }
}
