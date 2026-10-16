import { t } from './i18n.js';
import type { PublicRootNode } from './types.js';

/** Folder checkboxes describe whole-tree sync; hidden private flags hold explicit exclusions. */
export const ROOTS_REPAINT = 'known:roots-repaint';
const box = (row: Element, kind: 'select' | 'private') => row.querySelector<HTMLInputElement>(`.root-${kind} input`);

/** Every editable browser root is selected. Only explicit exclusions are sent as private refs. */
export function checkedRootRefs(tree: HTMLElement, kind: 'select' | 'private' = 'select'): string[] {
  const selector = kind === 'select'
    ? '.root-row[data-depth="0"] .root-select input:not([data-managed])'
    : '.root-private input:checked';
  return Array.from(tree.querySelectorAll<HTMLInputElement>(selector))
    .map(input => input.dataset.ref).filter((value): value is string => Boolean(value));
}
export function outermostSelectedRefs(roots: readonly PublicRootNode[]): Set<string> {
  return new Set(roots.filter(root => root.depth === 0 && !root.managed).map(root => root.ref));
}
/** An excluded parent carries its descendants; checking it again restores their own choices. */
export function paintCoverage(tree: HTMLElement): void {
  const open: Array<{ depth: number; excluded: boolean }> = [];
  for (const row of Array.from(tree.querySelectorAll<HTMLElement>('.root-row'))) {
    const input = box(row, 'select'), depth = Number(row.dataset.depth);
    if (!input) continue;
    while (open.length && open.at(-1)!.depth >= depth) open.pop();
    const inheritedExclusion = open.some(parent => parent.excluded);
    const managed = input.dataset.managed !== undefined;
    const excluded = Boolean(box(row, 'private')?.checked) || inheritedExclusion;
    input.checked = !managed && !excluded;
    input.disabled = managed || inheritedExclusion;
    delete input.dataset.inherited;
    const label = input.closest('label');
    if (inheritedExclusion) label?.setAttribute('title', t('sync_keptWithParent', 'This folder stays on this browser with its parent.'));
    else label?.removeAttribute('title');
    row.dataset.localOnly = String(excluded);
    open.push({ depth, excluded });
  }
}
/** Translate a user checkbox change into an explicit private-local boundary. */
export function recordFolderChoice(input: HTMLInputElement): void {
  const row = input.closest('.root-row');
  const privateInput = row && box(row, 'private');
  if (privateInput) privateInput.checked = !input.checked;
  if (row && input.checked && (row as HTMLElement).dataset.partiallySynced === 'true') {
    const rows = Array.from(row.parentElement?.querySelectorAll<HTMLElement>('.root-row') ?? []);
    const index = rows.indexOf(row as HTMLElement), depth = Number((row as HTMLElement).dataset.depth);
    for (let next = index + 1; next < rows.length && Number(rows[next]!.dataset.depth) > depth; next++) {
      const child = box(rows[next]!, 'private'); if (child) child.checked = false;
    }
  }
}
