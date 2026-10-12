import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hydrateIcons } from '../../src/icons.js';

/**
 * Mounts the real popup.html body (without its script) so a test exercises the
 * markup the popup ships. happy-dom replaces `URL`, so the path comes from
 * import.meta.url through node:url.
 */
export function mountPopupShell(options: { readonly state?: string; readonly mode?: string } = {}): void {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../popup.html');
  const body = /<body[^>]*>([\s\S]*)<\/body>/u.exec(readFileSync(file, 'utf8'))![1]!.replace(/<script[\s\S]*?<\/script>/gu, '');
  document.body.innerHTML = body;
  document.body.dataset.state = options.state ?? 'connected';
  document.body.dataset.captureMode = options.mode ?? 'manual';
  hydrateIcons(document);
}

export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
