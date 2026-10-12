// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { createPopupFeedbackUi } from '../src/popup-feedback-ui.js';
import { createPopupNote } from '../src/popup-note.js';
import { projectSyncStatus } from '../src/sync-status.js';

function mount(url = 'https://example.com/') {
  document.body.innerHTML = `
    <div id="pp-fields"></div>
    <p id="pp-note" hidden></p>
    <button id="open-native-wait" hidden></button>
    <button id="save"></button>`;
  const el = (id: string) => document.getElementById(id)!;
  const openNativeWait = el('open-native-wait') as HTMLButtonElement;
  const line = el('pp-note');
  const note = createPopupNote(line);
  const ui = createPopupFeedbackUi({
    save: el('save') as HTMLButtonElement, fields: el('pp-fields'), note,
    openNativeWait, currentTabUrl: () => url, nativeWaitPending: () => false,
  });
  return { ui, line, openNativeWait, save: el('save') as HTMLButtonElement, fields: el('pp-fields') };
}

test.each(['synced', 'syncing', 'setup-required', 'waiting-network', 'saved-locally', 'local-only'] as const)(
  'the note stays quiet for the calm or already-said sync state "%s"', (label) => {
    const { ui, line } = mount();
    ui.paintStatus(projectSyncStatus(label));
    expect(line.hidden).toBe(true);
    expect(line.textContent).toBe('');
  });

test('an actionable sync state "review-conflicts" is the note, in the error tone', () => {
  const { ui, line } = mount();
  const status = projectSyncStatus('review-conflicts'); ui.paintStatus(status);
  expect(line.hidden).toBe(false);
  expect(line.textContent).toBe(status.label);
  expect(line.dataset.tone).toBe('error');
});

test('"Action required" stays visible and still reveals the native-wait link', () => {
  const { ui, line, openNativeWait } = mount();
  ui.paintStatus(projectSyncStatus('action-required'));
  expect(line.textContent).toBe('Action required');
  expect(openNativeWait.hidden).toBe(false);
  ui.paintStatus(projectSyncStatus('synced'));
  expect(line.hidden).toBe(true);
  expect(openNativeWait.hidden).toBe(true);
});

test('a translated or edited label cannot change quiet states or required actions', () => {
  const { ui, line, openNativeWait } = mount();
  ui.paintStatus({ ...projectSyncStatus('action-required'), label: '检查此保存' });
  expect(line.textContent).toBe('检查此保存'); expect(openNativeWait.hidden).toBe(false);
  ui.paintStatus({ ...projectSyncStatus('synced'), label: '云端保存完毕' });
  expect(line.hidden).toBe(true); expect(openNativeWait.hidden).toBe(true);
});

test('a save error wins over a sync fact and a calm message sits below it', () => {
  const { ui, line } = mount();
  ui.paintStatus(projectSyncStatus('review-conflicts'));
  ui.setFeedback("Couldn't save this page.", 'error');
  expect(line.textContent).toBe("Couldn't save this page.");
  expect(line.dataset.tone).toBe('error');
  ui.setFeedback('');
  expect(line.textContent).toBe(projectSyncStatus('review-conflicts').label);
});

test('a page that cannot be bookmarked gets the quiet disabled look, hides the fields and a neutral sentence', () => {
  const { ui, save, line, fields } = mount('chrome://newtab/');
  expect(ui.reflectSavable()).toBe(false);
  expect(save.disabled).toBe(true);
  expect(fields.hidden).toBe(true);
  expect(document.body.hasAttribute('data-unsavable')).toBe(true);
  expect(line.textContent).toBe('This browser page cannot be bookmarked.');
  expect(line.dataset.tone).toBeUndefined();
});

test('a savable page never carries the unsavable marker', () => {
  document.body.setAttribute('data-unsavable', '');
  const { ui, save } = mount();
  expect(ui.reflectSavable()).toBe(true);
  expect(document.body.hasAttribute('data-unsavable')).toBe(false);
  expect(save.disabled).toBe(false);
});
