import { bundledSites, legacySite, siteDefinition } from './registry.js';
import { createIcon } from '../icons.js';
import { t } from '../i18n.js';
export const selectedSite = siteDefinition(new URL(location.href).searchParams.get('adapterId') ?? legacySite.adapterId);
export const sendSiteMessage = (message: unknown) => chrome.runtime.sendMessage({ ...(message as Record<string, unknown>), adapterId: selectedSite.adapterId });
/** The page head's "Site: …" pill; with one bundled site there is nothing to pick. */
export function mountSiteSelector() {
  const slot = document.querySelector<HTMLElement>('#adapter-picker'); if (!slot || bundledSites.length < 2) return;
  const label = document.createElement('label'), value = document.createElement('strong'), select = document.createElement('select');
  label.className = 'select-pill'; select.id = 'adapter-select'; select.setAttribute('aria-label', t('sites_siteAdapter', 'Site adapter'));
  for (const site of bundledSites) select.append(new Option(site.label, site.adapterId));
  select.value = selectedSite.adapterId; value.textContent = selectedSite.label;
  select.onchange = () => { const url = new URL(location.href); url.searchParams.set('adapterId', select.value); location.assign(url.href); };
  label.append(`${t('sites_site', 'Site')}: `, value, createIcon('chevron-down', 12), select); slot.replaceChildren(label); slot.hidden = false;
}
/** A kit button (docs/ui-design.md): secondary unless the step approves something. */
export function siteButton(label: string, tone: 'primary' | 'secondary' | 'ghost' = 'secondary') {
  const button = document.createElement('button'); button.type = 'button'; button.className = `btn btn-${tone} btn-sm`; button.textContent = label; return button;
}
/** A settings row: title and hint on the left, `control` at the end (stacked under the text when `stack`). */
export function siteRow(title: string, hint: string, stack = false) {
  const row = document.createElement('div'), text = document.createElement('div'), heading = document.createElement('p'), control = document.createElement('div');
  row.className = stack ? 'set-row set-row--stack' : 'set-row'; text.className = 'set-row-text'; heading.className = 'set-row-title'; control.className = 'set-row-control';
  heading.textContent = title; text.append(heading);
  if (hint) { const p = document.createElement('p'); p.className = 'set-row-hint'; p.textContent = hint; text.append(p); }
  row.append(text, control); return { row, text, control };
}
/** Show an action only while it can run: a step that can't run yet is hidden, not greyed. */
export function offer(button: HTMLButtonElement, available: boolean) { button.disabled = !available; button.hidden = !available; }
