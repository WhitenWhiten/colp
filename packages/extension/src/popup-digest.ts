import type { DigestIndicator } from './automation/digest-indicator.js';
import { digestLabel } from './automation/digest-indicator.js';
import type { AutomationResponse } from './automation/messages.js';
import { relativeText, t } from './i18n.js';
import type { PopupNote } from './popup-note.js';

/**
 * What the toolbar's count means, as the popup's quietest line: "1 new digest
 * from “Weekly reading digest” · Read". Read opens the run on the web, where
 * reading it marks it read. The popup itself never marks anything read; the
 * worker's next status read clears the count.
 */
export function digestLine(digest: DigestIndicator): HTMLElement {
  const label = digestLabel(digest);
  const lead = digest.ruleName ? t('automation_digestFrom', '$1 from “$2”', label, digest.ruleName) : label;
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'btn-retry';
  link.textContent = digest.count === 1 ? t('automation_digestRead', 'Read') : t('automation_digestOpenAll', 'Open Digests');
  link.addEventListener('click', () => { void chrome.tabs.create({ url: digest.url }); });
  const line = document.createElement('span');
  line.dataset.digest = String(digest.count);
  // An answer the worker couldn't refresh says how old it is.
  line.append(digest.stale ? `${lead} · ${t('automation_digestAsOf', 'as of $1', relativeText(digest.fetchedAt))} · ` : `${lead} · `, link);
  return line;
}

export async function paintDigestNote(note: PopupNote): Promise<void> {
  const reply = await chrome.runtime.sendMessage({ kind: 'known.automation.digest' }).catch(() => null) as AutomationResponse | null;
  const digest = reply?.ok && 'digest' in reply ? reply.digest : null;
  note.set('digest', digest ? digestLine(digest) : undefined);
}
