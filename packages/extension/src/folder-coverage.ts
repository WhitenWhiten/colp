import { t } from './i18n.js';
import type { PublicRootNode } from './types.js';

export const ROOTS_REPAINT = 'known:roots-repaint';
interface FolderChoices { readonly roots: readonly PublicRootNode[]; excluded: Set<string> }
const choices = new WeakMap<HTMLElement, FolderChoices>();
const empty: FolderChoices = { roots: [], excluded: new Set() };

/** Explicit exclusions are the state; checkboxes only display whole-tree coverage. */
export function initializeFolderCoverage(tree: HTMLElement, roots: readonly PublicRootNode[]): void {
  choices.set(tree, { roots, excluded: new Set(roots.filter(root => root.privateLocal).map(root => root.ref)) });
}
export function syncRootRefs(tree: HTMLElement): string[] {
  return (choices.get(tree) ?? empty).roots.filter(root => root.depth === 0 && !root.managed).map(root => root.ref);
}
export function excludedFolderRefs(tree: HTMLElement): string[] {
  const state = choices.get(tree) ?? empty;
  return state.roots.filter(root => state.excluded.has(root.ref)).map(root => root.ref);
}
export function replaceFolderExclusions(tree: HTMLElement, excluded: ReadonlySet<string>): void {
  const state = choices.get(tree);
  if (state) state.excluded = new Set(state.roots.filter(root => !root.managed && excluded.has(root.ref)).map(root => root.ref));
}

function coverage(state: FolderChoices) {
  const parents: number[] = [];
  const rows = state.roots.map(root => ({ root, included: false, inherited: false, partial: false, parent: -1 }));
  for (const [index, row] of rows.entries()) {
    while (parents.length && rows[parents.at(-1)!]!.root.depth >= row.root.depth) parents.pop();
    row.parent = parents.at(-1) ?? -1;
    row.inherited = row.parent >= 0 && !rows[row.parent]!.included;
    row.included = !row.root.managed && !row.inherited && !state.excluded.has(row.root.ref);
    parents.push(index);
  }
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.parent >= 0 && (!row.included || row.partial)) rows[row.parent]!.partial = true;
  }
  return rows;
}

/** Paint from the model, returning the count of folders included in sync. */
export function paintCoverage(tree: HTMLElement): number {
  const rows = new Map(Array.from(tree.querySelectorAll<HTMLElement>('.root-row')).map(row => [row.dataset.ref, row]));
  const states = coverage(choices.get(tree) ?? empty);
  for (const state of states) {
    const row = rows.get(state.root.ref), input = row?.querySelector<HTMLInputElement>('.root-select input');
    if (!input) continue;
    input.indeterminate = state.included && state.partial;
    input.checked = state.included && !state.partial;
    input.disabled = state.root.managed || state.inherited;
    const label = input.closest('label');
    if (state.inherited) label?.setAttribute('title', t('sync_keptWithParent', 'This folder stays on this browser with its parent.'));
    else label?.removeAttribute('title');
  }
  return states.filter(state => state.included).length;
}

/** An excluded parent carries descendants; restoring it retains their own exclusions. */
export function recordFolderChoice(input: HTMLInputElement): void {
  const tree = input.closest('.root-row')?.parentElement;
  const state = tree && choices.get(tree);
  if (!state || !input.dataset.ref) return;
  const rows = coverage(state), index = rows.findIndex(row => row.root.ref === input.dataset.ref);
  const row = rows[index];
  if (!row || row.root.managed) return;
  if (!input.checked) { state.excluded.add(row.root.ref); return; }
  state.excluded.delete(row.root.ref);
  // Including a mixed parent explicitly includes its whole subtree.
  if (row.included && row.partial) {
    for (let next = index + 1; next < rows.length && rows[next]!.root.depth > row.root.depth; next++) {
      state.excluded.delete(rows[next]!.root.ref);
    }
  }
}
