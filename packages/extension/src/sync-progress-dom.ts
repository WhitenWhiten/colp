import { signedInSyncStatus } from './sync-label.js';
import { paintSyncBar, syncProgressState, watchSyncProgress, type SyncProgressView } from './sync-progress-ui.js';

const required = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

/**
 * Options page: the card above every Sync tab and the thin bar under the
 * sidebar identity. Both stay hidden until a sync is running; a sync watched
 * to the end leaves "Sync complete" in place of the bar.
 */
export function bindOptionsSyncProgress(input: { readonly connected: () => boolean }) {
  const card = required<HTMLElement>('sync-progress');
  const title = required<HTMLElement>('sync-progress-title');
  const bar = required<HTMLElement>('sync-progress-bar');
  const detail = required<HTMLElement>('sync-progress-detail');
  const note = required<HTMLElement>('sync-progress-note');
  const help = required<HTMLElement>('sync-progress-help');
  const guidance = required<HTMLUListElement>('sync-progress-guidance');
  const hubBar = required<HTMLElement>('hub-progress');
  const resume = required<HTMLButtonElement>('sync-progress-resume');
  // Resuming is the Status tab's control and its review dialog; the card only takes the user there.
  resume.addEventListener('click', () => {
    location.hash = '#sync/center';
    document.getElementById('personal-sync-toggle')?.click();
  });
  let paintedGuidance = '';
  function paint(view: SyncProgressView): void {
    card.hidden = !view.show;
    card.dataset.state = syncProgressState(view);
    resume.hidden = !view.paused;
    hubBar.hidden = !view.show || view.done;
    hubBar.title = view.short;
    if (!view.show) return;
    title.textContent = view.title;
    detail.textContent = view.detail;
    note.hidden = !view.note; note.textContent = view.note ?? '';
    paintSyncBar(bar, view); paintSyncBar(hubBar, view);
    help.hidden = view.guidance.length === 0;
    const key = view.guidance.join('\n');
    if (key !== paintedGuidance) {
      paintedGuidance = key;
      guidance.replaceChildren(...view.guidance.map((line) => {
        const item = document.createElement('li'); item.textContent = line; return item;
      }));
    }
  }
  return watchSyncProgress({ paint, enabled: input.connected, status: signedInSyncStatus });
}

/** Popup: one line with the count and a thin bar; the line opens Sync status. */
export function bindPopupSyncProgress(input: { readonly connected: () => boolean }) {
  const strip = required<HTMLButtonElement>('sync-progress-strip');
  const text = required<HTMLElement>('sync-progress-short');
  const bar = required<HTMLElement>('sync-progress-strip-bar');
  strip.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#sync/center') });
  });
  return watchSyncProgress({
    enabled: input.connected,
    status: signedInSyncStatus,
    paint(view) {
      strip.hidden = !view.show;
      if (!view.show) return;
      strip.dataset.state = syncProgressState(view);
      text.textContent = view.short;
      strip.title = view.note ? `${view.detail}\n${view.note}` : view.detail;
      paintSyncBar(bar, view);
    },
  });
}
