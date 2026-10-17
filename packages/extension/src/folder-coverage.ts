import { t } from './i18n.js';
import type { PublicRootNode } from './types.js';

export const ROOTS_REPAINT = 'known:roots-repaint';
interface FolderChoices { readonly roots: readonly PublicRootNode[]; selected: Set<string>; excluded: Set<string> }
const choices = new WeakMap<HTMLElement, FolderChoices>();
const empty: FolderChoices = { roots: [], selected: new Set(), excluded: new Set() };

/** Selected subtrees and explicit exclusions are separate from their checkbox coverage. */
export function initializeFolderCoverage(tree: HTMLElement, roots: readonly PublicRootNode[]): void {
  choices.set(tree, { roots, selected: new Set(roots.filter(root => root.selected && !root.managed).map(root => root.ref)),
    excluded: new Set(roots.filter(root => root.privateLocal).map(root => root.ref)) });
}
export function syncRootRefs(tree: HTMLElement): string[] {
  const state = choices.get(tree) ?? empty, rows = coverage(state);
  return rows.filter(row => state.selected.has(row.root.ref) && row.included
    && (row.parent < 0 || !rows[row.parent]!.included)).map(row => row.root.ref);
}
export function excludedFolderRefs(tree: HTMLElement): string[] {
  const state = choices.get(tree) ?? empty;
  return state.roots.filter(root => state.excluded.has(root.ref)).map(root => root.ref);
}
export function replaceFolderSelection(tree: HTMLElement, selected: ReadonlySet<string>, excluded: ReadonlySet<string>): void {
  const state = choices.get(tree);
  if (!state) return;
  state.selected = new Set(state.roots.filter(root => !root.managed && selected.has(root.ref)).map(root => root.ref));
  state.excluded = new Set(state.roots.filter(root => !root.managed && excluded.has(root.ref)).map(root => root.ref));
}

function coverage(state: FolderChoices) {
  const parents: number[] = [];
  const rows = state.roots.map(root => ({ root, included: false, inherited: false, partial: false, parent: -1 }));
  for (const [index, row] of rows.entries()) {
    while (parents.length && rows[parents.at(-1)!]!.root.depth >= row.root.depth) parents.pop();
    row.parent = parents.at(-1) ?? -1;
    const parent = rows[row.parent];
    row.inherited = Boolean(parent && (parent.inherited || parent.root.managed || state.excluded.has(parent.root.ref)));
    row.included = !row.root.managed && !row.inherited && !state.excluded.has(row.root.ref)
      && (state.selected.has(row.root.ref) || Boolean(parent?.included));
    parents.push(index);
  }
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const parent = rows[row.parent];
    if (parent && (row.partial || (parent.included ? !row.included : row.included))) parent.partial = true;
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
    input.indeterminate = state.partial;
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
  if (!row || row.root.managed || row.inherited) return;
  for (let next = index + 1; next < rows.length && rows[next]!.root.depth > row.root.depth; next++) {
    state.selected.delete(rows[next]!.root.ref);
  }
  if (!input.checked) {
    state.selected.delete(row.root.ref);
    if (rows[row.parent]?.included) state.excluded.add(row.root.ref);
    return;
  }
  state.excluded.delete(row.root.ref);
  if (!rows[row.parent]?.included) state.selected.add(row.root.ref);
  // Including a mixed parent explicitly includes its whole subtree.
  if (row.partial) {
    for (let next = index + 1; next < rows.length && rows[next]!.root.depth > row.root.depth; next++) {
      state.excluded.delete(rows[next]!.root.ref);
    }
  }
}
