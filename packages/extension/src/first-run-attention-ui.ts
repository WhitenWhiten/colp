import { FIRST_RUN_KEEP_BOTH, attentionItemCopy } from './first-run-draft.js';
import { syncCenterHref } from './sync-attention-ui.js';
import type { PublicAttentionItem } from './types.js';
import { t } from './i18n.js';

export function renderAttentionItems(
  list: HTMLElement, items: readonly PublicAttentionItem[], onKeepBoth: (itemId: string) => void,
): void {
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = [item.label, attentionItemCopy(item)].filter(Boolean).join(' · ');
    row.append(label);
    if (item.decision === 'open' && item.kind === 'duplicate_candidate') {
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.className = 'btn btn-ghost btn-sm';
      keep.textContent = FIRST_RUN_KEEP_BOTH;
      keep.addEventListener('click', () => onKeepBoth(item.itemId));
      row.append(keep);
    }
    list.append(row);
  }
  list.hidden = false;
}

export function renderAttentionNavigation(list: HTMLElement, cursor: string | undefined, nextCursor: string | undefined,
  open: (cursor?: string) => void) {
  const navigation = document.createElement('li');
  for (const [label, page, first] of [[t('common_firstPage', 'First page'), undefined, true], [t('common_nextPage', 'Next page'), nextCursor, false]] as const) {
    if (first ? !cursor : !page) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-ghost btn-sm'; button.textContent = label;
    button.addEventListener('click', () => open(page)); navigation.append(button);
  }
  list.append(navigation);
}

export function setAttentionConflictLink(host: HTMLElement, href?: string): void {
  const valid = syncCenterHref(href);
  const link = host.querySelector('a');
  if (link && valid) {
    link.href = valid;
    host.hidden = false;
  } else {
    if (link) link.removeAttribute('href');
    host.hidden = true;
  }
}
