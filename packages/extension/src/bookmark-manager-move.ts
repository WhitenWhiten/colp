import { createDialog, dialogButton } from './dialog.js';
import { t } from './i18n.js';
import { collectSubtreeIds, type NativeNode } from './bookmark-manager-dom.js';
import { createFolderListbox, folderChoices } from './library-folder-picker.js';

/**
 * Where can these items go? Every folder except the items' own subtrees and
 * read-only subscription folders; the folder they already share is listed but
 * not selectable.
 */
export function moveTargets(root: NativeNode, moving: readonly NativeNode[], hidden: ReadonlySet<string> = new Set()) {
  const forbidden = new Set<string>(hidden);
  const parents = new Set<string>();
  for (const node of moving) { collectSubtreeIds(node, forbidden); if (node.parentId) parents.add(node.parentId); }
  const here = parents.size === 1 ? [...parents][0]! : undefined;
  return folderChoices([root], { exclude: forbidden, ...(here ? { disabled: new Map([[here, t('common_currentLocation', 'Current location')]]) } : {}) });
}

/** The Move to dialog: a searchable folder tree; choosing a folder closes it and moves the item there. */
export function openMoveDialog(root: NativeNode, moving: readonly NativeNode[], hidden: ReadonlySet<string>,
  onPick: (parentId: string) => void, trigger?: HTMLElement | null, title = t('common_moveTo2', 'Move to')): void {
  const { dialog, body, actions } = createDialog(title, 'mgr-move');
  const box = createFolderListbox({ choices: moveTargets(root, moving, hidden), label: title,
    onPick(choice) { dialog.close(); onPick(choice.id); } });
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  cancel.addEventListener('click', () => dialog.close());
  body.append(box.element); actions.append(cancel);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); box.focus();
}
