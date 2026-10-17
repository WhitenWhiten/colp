import { icon, type NativeNode } from './bookmark-manager-dom.js';
import { t } from './i18n.js';

export interface TreeHost {
  readonly nodes: ReadonlyMap<string, NativeNode>;
  readonly totals: ReadonlyMap<string, number>;
  /** Root folders of the Know-N collection that exist in this browser; empty when nothing syncs. */
  readonly synced: readonly string[];
  readonly currentId: string;
  readonly expanded: Set<string>;
  open(id: string): void;
  /** Expanding or collapsing repaints the manager. */
  changed(): void;
  dragOver(event: DragEvent, row: HTMLElement): void;
  drop(event: DragEvent, id: string): void;
}

function kicker(copy: string): HTMLElement {
  const label = document.createElement('p');
  label.className = 'mgr-tree-kicker';
  label.textContent = copy;
  return label;
}

function treeRow(node: NativeNode, depth: number, host: TreeHost): HTMLElement {
  const row = document.createElement('div');
  row.className = 'mgr-tree-row';
  row.style.setProperty('--depth', String(depth));
  if (node.id === host.currentId) row.dataset.current = 'true';
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'mgr-toggle';
  if ((node.children ?? []).some((child) => !child.url)) {
    const open = host.expanded.has(node.id);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', `${open ? t('common_collapse', 'Collapse') : t('common_expand', 'Expand')} ${node.title || t('common_untitledFolder', 'Untitled folder')}`);
    toggle.append(icon('chevron'));
    toggle.addEventListener('click', () => {
      if (host.expanded.has(node.id)) host.expanded.delete(node.id); else host.expanded.add(node.id);
      host.changed();
    });
  } else { toggle.disabled = true; toggle.tabIndex = -1; toggle.setAttribute('aria-hidden', 'true'); }
  const name = document.createElement('button');
  name.type = 'button'; name.className = 'mgr-folder mgr-tree-name';
  name.setAttribute('aria-current', node.id === host.currentId ? 'true' : 'false');
  const label = document.createElement('span');
  label.className = 'mgr-tree-label'; label.textContent = node.title || t('common_untitledFolder', 'Untitled folder');
  const count = document.createElement('em');
  count.textContent = String(host.totals.get(node.id) ?? 0);
  name.append(icon('folder'), label, count);
  name.addEventListener('click', () => { host.open(node.id); });
  name.addEventListener('dragover', (event) => { host.dragOver(event, row); });
  name.addEventListener('dragleave', () => { delete row.dataset.drop; });
  name.addEventListener('drop', (event) => { delete row.dataset.drop; host.drop(event, node.id); });
  row.append(toggle, name);
  return row;
}

/**
 * The folder tree. Folders that sync with Know-N are pinned above the plain
 * browser tree, so the collection has an obvious home instead of hiding among
 * ordinary browser folders.
 */
export function renderManagerTree(into: HTMLElement, top: NativeNode, host: TreeHost): void {
  into.replaceChildren();
  const roots = host.synced.filter((id) => host.nodes.has(id));
  if (roots.length > 0) {
    into.append(kicker(t('common_yourLibrary', 'Your library')));
    const walk = (node: NativeNode, depth: number): void => {
      into.append(treeRow(node, depth, host));
      if (!host.expanded.has(node.id)) return;
      for (const child of node.children ?? []) if (!child.url) walk(child, depth + 1);
    };
    for (const id of roots) walk(host.nodes.get(id)!, 0);
    into.append(kicker(t('options_foldersBrowser', 'Folders in this browser')));
  }
  const build = (node: NativeNode, depth: number): void => {
    for (const child of node.children ?? []) {
      if (child.url) continue;
      into.append(treeRow(child, depth, host));
      if (host.expanded.has(child.id)) build(child, depth + 1);
    }
  };
  build(top, 0);
}
