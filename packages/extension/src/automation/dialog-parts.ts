import { el, optionRow } from '../library-dom.js';

/**
 * The parts the import, subscribe and review dialogs share (doc 17 RS-02, RS-04, RS-12): what a file is and
 * would do in one quiet box at the top, counts as rows rather than bullets, and choices as option rows in one
 * bordered group. The folder rows are rolePickers() in ruleset-pane.ts.
 */

/** The top of the dialog: one line in ink, then quieter lines and lists under it. */
export function dialogSummary(headline: string, ...rest: (HTMLElement | null)[]): HTMLElement {
  const box = el('div', undefined, 'automation-dialog-summary');
  box.append(el('p', headline, 'automation-dialog-headline'), ...rest.filter((node): node is HTMLElement => node !== null));
  return box;
}

/** Counts by folder or kind of page, "Research: 31 bookmarks", one per row. */
export function countList(lines: readonly string[]): HTMLElement {
  const list = el('ul', undefined, 'automation-run-folders');
  for (const line of lines) list.append(el('li', line));
  return list;
}

/** Radio or checkbox rows in one bordered group, the web's option rows. */
export function optionGroup(type: 'radio' | 'checkbox', options: readonly { readonly value: string; readonly title: string; readonly hint?: string; readonly checked: boolean }[],
  label?: string): { readonly element: HTMLElement; readonly inputs: readonly HTMLInputElement[] } {
  const name = `automation-option-${crypto.randomUUID()}`;
  const group = el('div', undefined, 'option-list option-list--boxed');
  if (type === 'radio') group.setAttribute('role', 'radiogroup');
  if (label) group.setAttribute('aria-label', label);
  const inputs = options.map((option) => {
    const row = optionRow({ type, name, value: option.value, checked: option.checked, title: option.title, ...(option.hint ? { hint: option.hint } : {}) });
    group.append(row.label);
    return row.input;
  });
  return { element: group, inputs };
}
