import { t } from './i18n.js';
import type { PublicRootNode } from './types.js';

/**
 * Sync › Folders coverage. A checked folder syncs everything inside it, so the
 * folders under it read checked too: ticked and locked, with a tooltip naming
 * the folder that carries them. "No Know-N sync" is how one of them stays out;
 * it then reads unchecked. Only the folders the user checked themselves are
 * sent: the worker would fold the inner ones into the outer one anyway.
 */

/** Fired on the tree after a script rewrites its boxes, so the folders pane repaints coverage, dashes and the count. */
export const ROOTS_REPAINT = 'known:roots-repaint';

const box = (row: Element, kind: 'select' | 'private') => row.querySelector<HTMLInputElement>(`.root-${kind} input`);

/** Refs the user checked: a preview's selection. Boxes ticked by a checked parent are not among them. */
export function checkedRootRefs(tree: HTMLElement, kind: 'select' | 'private' = 'select'): string[] {
  return Array.from(tree.querySelectorAll<HTMLInputElement>(`.root-${kind} input:checked:not([data-inherited])`))
    .map((input) => input.dataset.ref).filter((value): value is string => Boolean(value));
}

/** The loaded selection the way checkedRootRefs reads it back: a folder inside a selected one is not listed. */
export function outermostSelectedRefs(roots: readonly PublicRootNode[]): Set<string> {
  const refs = new Set<string>(), open: PublicRootNode[] = [];
  for (const root of roots) {
    while (open.length && open.at(-1)!.depth >= root.depth) open.pop();
    if (root.selected && !root.managed && !open.some((parent) => parent.selected && !parent.managed)) refs.add(root.ref);
    open.push(root);
  }
  return refs;
}

/** Paints which folders a checked parent carries. Rows are in tree order, each with `data-depth`. */
export function paintCoverage(tree: HTMLElement): void {
  const open: Array<{ depth: number; title: string; checked: boolean; excluded: boolean }> = [];
  for (const row of Array.from(tree.querySelectorAll<HTMLElement>('.root-row'))) {
    const input = box(row, 'select'), depth = Number(row.dataset.depth);
    if (!input) continue;
    while (open.length && open.at(-1)!.depth >= depth) open.pop();
    const carrier = open.find((parent) => parent.checked);
    const excluded = Boolean(box(row, 'private')?.checked) || open.some((parent) => parent.excluded);
    const managed = input.dataset.managed !== undefined;
    const label = input.closest('label');
    if (carrier && !managed) {
      input.dataset.inherited = '';
      input.checked = !excluded; input.disabled = true;
      if (label) label.title = excluded ? t('sync_folderKeptOut', 'Kept out of sync with No Know-N sync.')
        : t('sync_folderSyncsWithParent', 'Syncs with $1. To leave it out, choose No Know-N sync.', carrier.title);
    } else {
      // A folder its parent no longer carries goes back to unchecked, not to a tick the user never made.
      if (input.dataset.inherited !== undefined) { delete input.dataset.inherited; input.checked = false; }
      input.disabled = managed;
      label?.removeAttribute('title');
    }
    open.push({ depth, title: row.querySelector('.folder-name')?.textContent ?? '', checked: input.checked && !excluded, excluded });
  }
}
