import { createIcon, type IconName } from './icons.js';
import { uiLanguage } from './i18n.js';

/** Small DOM builders shared by the library pages (Bookmarks, History, Subscriptions, Sync, Save tabs). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(label: string, className = 'btn btn-secondary btn-sm', onClick?: () => void): HTMLButtonElement {
  const node = el('button', label, className);
  node.type = 'button';
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

/** A ghost icon button; the label is the accessible name and the tooltip. */
export function iconButton(name: IconName, label: string, onClick?: () => void, className = 'btn btn-ghost btn-sm btn-icon'): HTMLButtonElement {
  const node = el('button', undefined, className);
  node.type = 'button'; node.setAttribute('aria-label', label); node.title = label;
  node.append(createIcon(name, 16));
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

/** The toolbar search field (icon plus bare input). */
export function searchCompact(label: string, placeholder = label): { readonly field: HTMLLabelElement; readonly input: HTMLInputElement } {
  const field = el('label', undefined, 'search-compact');
  const input = el('input');
  input.type = 'search'; input.placeholder = placeholder; input.setAttribute('aria-label', label); input.autocomplete = 'off';
  field.append(createIcon('search', 14), input);
  return { field, input };
}

/** "Label: value" pill that wraps a real select, kept in step by select-pill.ts. */
export function selectPill(label: string, select: HTMLSelectElement): HTMLLabelElement {
  const pill = el('label', undefined, 'select-pill');
  const caption = el('span'); caption.append(`${label}: `);
  const value = el('strong'); value.dataset.pillValue = '';
  select.setAttribute('aria-label', label);
  const sync = () => { value.textContent = select.options[select.selectedIndex]?.textContent ?? ''; };
  select.addEventListener('change', sync); select.addEventListener(PILL_SYNC, sync); sync();
  pill.append(caption, value, createIcon('chevron-down', 12), select);
  return pill;
}

const PILL_SYNC = 'known:pill-sync';
/** Sets a pill's select from code and repaints its visible value (a plain `.value =` fires no event). */
export function setPill(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event(PILL_SYNC));
}

export function selectOf(values: readonly (readonly [string, string])[], selected = ''): HTMLSelectElement {
  const select = el('select');
  for (const [id, label] of values) { const option = el('option', label); option.value = id; select.append(option); }
  select.value = selected;
  return select;
}

/** The kit's empty state: icon circle, title, hint and an optional action. */
export function emptyBlock(input: { readonly icon: IconName; readonly title: string; readonly hint?: string; readonly action?: HTMLElement }): HTMLElement {
  const box = el('div', undefined, 'empty');
  const mark = el('span', undefined, 'empty-icon'); mark.append(createIcon(input.icon, 18));
  box.append(mark, el('p', input.title, 'empty-title'));
  if (input.hint) box.append(el('p', input.hint, 'empty-hint'));
  if (input.action) box.append(input.action);
  return box;
}

/**
 * A radio or a checkbox with its title and a muted line under it: the web's .option-row. Rows stack in an
 * `.option-list`, a card on a page or one bordered group in a dialog, instead of side-by-side cards.
 */
export function optionRow(input: { readonly type: 'radio' | 'checkbox'; readonly name?: string; readonly value?: string; readonly checked: boolean;
  readonly title: string; readonly hint?: string }): { readonly label: HTMLLabelElement; readonly input: HTMLInputElement } {
  const label = el('label', undefined, 'option-row');
  const box = el('input'); box.type = input.type; box.checked = input.checked;
  if (input.name) box.name = input.name;
  if (input.value) box.value = input.value;
  const text = el('span', undefined, 'option-row-text');
  text.append(el('span', input.title, 'option-row-title'));
  if (input.hint) text.append(el('span', input.hint, 'option-row-hint'));
  label.append(box, text);
  return { label, input: box };
}

/** Neutral notice with a toned rule, an icon and an optional ghost action. */
export function inlineAlert(tone: 'warning' | 'danger' | 'info' | 'success', text: string, action?: HTMLElement): HTMLElement {
  const box = el('div', undefined, 'inline-alert');
  if (tone !== 'info') box.dataset.tone = tone;
  box.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
  box.append(createIcon(tone === 'success' ? 'check-circle' : tone === 'info' ? 'info' : 'alert', 16), el('p', text));
  if (action) box.append(action);
  return box;
}

export function setBusy(node: HTMLElement, busy: boolean): void {
  if (busy) node.setAttribute('aria-busy', 'true'); else node.removeAttribute('aria-busy');
}

/** Count copy from `tn()` with its number grouped: "Import 1204 items" becomes "Import 1,204 items". */
export function grouped(copy: string, count: number): string {
  return count < 1000 ? copy : copy.replace(String(count), new Intl.NumberFormat(uiLanguage()).format(count));
}
