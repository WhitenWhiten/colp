// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCaptureResultPanel, resultStatus, type ResultPanelOptions } from '../src/capture/result-panel.js';
import type { AccountAutomation, CaptureTask } from '../src/capture/contracts.js';
import { createPopupNote } from '../src/popup-note.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';
import { location, task } from './fixtures/capture.js';

/** A local-first save: signed out, no collection, no server decision. */
const local: CaptureTask = { ...task, scope: { ...task.scope, accountId: null, collectionId: null }, save: 'local-saved', sync: 'local-only',
  nativeId: 'saved', localLocation: { ...location, path: ['Other bookmarks'] }, local: { commandId: null, state: 'waiting' },
  existence: { kind: 'not-found', exact: [], similar: [], coverage: { local: 'complete', cloud: 'unavailable', collectionIds: [], checkedAt: 0, stale: false } } };
const filed: CaptureTask = { ...local, classification: 'applied', localLocation: { ...location, path: ['Bookmarks bar', 'Recipes'] },
  local: { commandId: 'c', state: 'applied', folderNativeId: 'recipes', folderTitle: 'Recipes' } };

function mount(overrides: Partial<ResultPanelOptions> = {}) {
  mountPopupShell({ mode: 'automatic' });
  const note = createPopupNote(byId('pp-note'));
  const options = {
    duration: 3000, note, present: vi.fn(async () => undefined), timedOut: vi.fn(async () => undefined), dismissed: vi.fn(),
    done: vi.fn(async () => true), undo: vi.fn(async () => true), remove: vi.fn(async () => true),
    restore: vi.fn(async () => true), history: vi.fn(), close: vi.fn(), ...overrides,
  };
  const panel = createCaptureResultPanel(options);
  return { panel, options, note, line: byId('pp-note'), status: () => byId('capture-status-text').textContent,
    meta: () => byId('capture-status-meta').textContent, progress: byId('capture-progress'), footer: byId('popup-foot') };
}

beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); delete document.body.dataset.complete; });

test('a local save waiting for its folder says so, without the signed-in cloud notice', () => {
  const { panel, status, meta, line, footer } = mount();
  panel.show(local);
  expect(status()).toBe('Saved');
  expect(meta()).toBe('On this browser');
  expect(line.textContent).toBe('Choosing a folder…');
  expect(line.textContent).not.toContain('Cloud status could not be verified');
  expect(footer.dataset.mode).toBe('result');
  expect(byId('capture').hidden).toBe(false);
  panel.dispose();
});

test('the status line follows the sync state of the task', () => {
  const sync = (over: Partial<CaptureTask>) => resultStatus({ ...filed, ...over });
  expect(sync({ sync: 'local-only' })).toMatchObject({ text: 'Saved', meta: 'On this browser', icon: 'check-circle' });
  expect(sync({ sync: 'confirmed' })).toMatchObject({ meta: 'Synced to Know-N' });
  expect(sync({ sync: 'pending', scope: { ...filed.scope, accountId: 'a' } })).toMatchObject({ meta: 'Syncing to Know-N' });
  expect(sync({ sync: 'attention' })).toMatchObject({ meta: 'Sync needs attention' });
  expect(sync({ save: 'unknown' })).toMatchObject({ text: 'Checking save result', icon: 'clock' });
  expect(sync({ save: 'failed' })).toMatchObject({ text: 'Could not save', tone: 'danger' });
  expect(sync({ disposition: 'existing' })).toMatchObject({ text: 'Already saved', icon: 'bookmark', tone: 'neutral' });
  expect(resultStatus(filed, true).text).toBe('Preview · Saved');
});

test('automatic saving without AI completes its panel without a server decision or classification', () => {
  const { panel, line } = mount();
  panel.show({ ...local, classification: 'none', local: undefined });
  expect(document.body.dataset.complete).toBe('true');
  expect(line.hidden).toBe(true);
  expect(byId('capture-undo').hidden).toBe(false);
  panel.dispose();
});

test('a filed local result completes with no server decision id and starts the progress line', async () => {
  const { panel, options, progress } = mount({ duration: 4000 });
  panel.show(filed);
  expect(document.body.dataset.complete).toBe('true');
  expect(progress.hidden).toBe(true);
  // The result is presented (which starts the auto-close), and only then does the line start.
  await vi.waitFor(() => { expect(options.present).toHaveBeenCalledOnce(); });
  await vi.waitFor(() => { expect(progress.hidden).toBe(false); });
  expect(progress.style.animationDuration).toBe('4000ms');
  panel.dispose();
});

test('with "Close manually" there is no progress line but the result is still presented', async () => {
  const { panel, options, progress } = mount({ duration: 0 });
  panel.show(filed);
  await vi.waitFor(() => { expect(options.present).toHaveBeenCalledOnce(); });
  expect(progress.hidden).toBe(true);
  panel.dispose();
});

test('the pointer entering the popup pauses the countdown for good', async () => {
  const { panel, options, progress } = mount({ duration: 250 });
  panel.show(filed);
  await vi.waitFor(() => { expect(progress.hidden).toBe(false); });
  document.documentElement.dispatchEvent(new Event('pointerenter'));
  expect(progress.hasAttribute('data-paused')).toBe(true);
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  expect(options.timedOut).not.toHaveBeenCalled();
  expect(options.close).not.toHaveBeenCalled();
  panel.dispose();
});

test('focus moving inside pauses it too', async () => {
  const { panel, options, progress } = mount({ duration: 250 });
  panel.show(filed);
  await vi.waitFor(() => { expect(progress.hidden).toBe(false); });
  byId('capture-history').focus();
  document.dispatchEvent(new Event('focusin'));
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  expect(options.timedOut).not.toHaveBeenCalled();
  panel.dispose();
});

test('polling preserves the active suggestion lane note and treats a confirmed correction as calm', () => {
  const { panel, options } = mount({ suggestionsActive: () => true });
  options.note.set('classify', 'No other folder fits.');
  panel.show({ ...filed, classification: 'manual', reason: 'classification_corrected' });
  expect(byId('pp-note').textContent).toBe('No other folder fits.');
  expect(byId('capture-alert').hidden).toBe(true);
  panel.dispose();
});

test('starting a suggestion explicitly pauses the automatic result countdown', async () => {
  const { panel, options, progress } = mount({ duration: 200 });
  panel.show(filed);
  await vi.waitFor(() => expect(progress.hidden).toBe(false));
  panel.pause();
  await new Promise(resolve => { setTimeout(resolve, 300); });
  expect(options.timedOut).not.toHaveBeenCalled();
  expect(options.close).not.toHaveBeenCalled();
  panel.dispose();
});

test('when the line runs out the implicit rating is sent and the popup closes', async () => {
  const { panel, options } = mount({ duration: 200 });
  panel.show(filed);
  await vi.waitFor(() => { expect(options.close).toHaveBeenCalledOnce(); }, { timeout: 3000 });
  expect(options.timedOut).toHaveBeenCalledWith(filed);
  panel.dispose();
});

test('Done runs the done action and closes only when it says so', async () => {
  const done = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { panel, options } = mount({ done });
  panel.show(filed);
  byId('capture-done').click();
  await vi.waitFor(() => { expect(done).toHaveBeenCalledOnce(); });
  expect(options.close).not.toHaveBeenCalled();
  await vi.waitFor(() => { expect(byId<HTMLButtonElement>('capture-done').disabled).toBe(false); });
  byId('capture-done').click();
  await vi.waitFor(() => { expect(options.close).toHaveBeenCalledOnce(); });
  panel.dispose();
});

test('Undo removes the bookmark, says "Removed" and then closes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const { panel, options, status } = mount();
  panel.show(filed);
  byId('capture-undo').click();
  await vi.waitFor(() => { expect(options.undo).toHaveBeenCalledWith(filed); });
  await vi.waitFor(() => { expect(status()).toBe('Removed'); });
  expect(byId('pp-fields').hidden).toBe(true);
  expect(options.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(options.close).toHaveBeenCalledOnce();
  panel.dispose();
});

test('after Undo a late poll does not paint the removed result back', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const { panel, options, status } = mount();
  panel.show(filed);
  byId('capture-undo').click();
  await vi.waitFor(() => { expect(status()).toBe('Removed'); });
  panel.show(filed);
  expect(status()).toBe('Removed');
  expect(byId('pp-fields').hidden).toBe(true);
  expect(byId<HTMLButtonElement>('capture-done').disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(options.done).not.toHaveBeenCalled();
  expect(options.close).toHaveBeenCalledOnce();
  panel.dispose();
});

test('an Undo that fails leaves the result as it was', async () => {
  const undo = vi.fn(async () => false);
  const { panel, options, status } = mount({ undo });
  panel.show(filed);
  byId('capture-undo').click();
  await vi.waitFor(() => { expect(undo).toHaveBeenCalledOnce(); });
  expect(status()).toBe('Saved');
  expect(options.close).not.toHaveBeenCalled();
  panel.dispose();
});

test('History opens the history route for this result', () => {
  const { panel, options } = mount();
  panel.show(filed);
  byId('capture-history').click();
  expect(options.history).toHaveBeenCalledWith(filed);
  panel.dispose();
});

test('a failure reads as needing attention in an alert, not the note', () => {
  const { panel, line } = mount();
  panel.show({ ...local, classification: 'manual', reason: 'local_classification_failed' });
  const alert = byId('capture-alert');
  expect(alert.hidden).toBe(false);
  expect(byId('capture-alert-text').textContent).toBe("Saved. The suggestion couldn't run. Choose a folder instead.");
  expect(line.hidden).toBe(true);
  panel.dispose();
});

test('a calm reason is only the note', () => {
  const { panel, line } = mount();
  panel.show({ ...local, classification: 'manual', reason: 'manually_edited' });
  expect(byId('capture-alert').hidden).toBe(true);
  expect(line.textContent).toBe('Saved. Your change was kept.');
  panel.dispose();
});

test('a page that was already saved offers Remove, not Undo', () => {
  const only = { ...location, nativeId: '9' };
  const { panel } = mount();
  panel.show({ ...task, disposition: 'existing', save: 'unsubmitted', classification: 'none',
    existence: { kind: 'local', exact: [only], similar: [], coverage: { local: 'complete', cloud: 'complete', collectionIds: [], checkedAt: 0, stale: false } } });
  expect(byId('capture-status-text').textContent).toBe('Already saved');
  expect(byId('capture-undo').hidden).toBe(true);
  expect(byId('remove-bookmark').hidden).toBe(false);
  panel.dispose();
});

test('Remove deletes the existing bookmark, offers Undo, and ignores late polls', async () => {
  const { panel, options, status } = mount();
  const existing = { ...local, disposition: 'existing' as const, save: 'unsubmitted' as const, classification: 'none' as const,
    existence: { ...local.existence!, exact: [{ ...location, writable: true }] } };
  panel.show(existing);
  byId('remove-bookmark').click();
  await vi.waitFor(() => expect(status()).toBe('Removed'));
  expect(options.remove).toHaveBeenCalledExactlyOnceWith(existing);
  expect(options.undo).not.toHaveBeenCalled();
  expect(byId('remove-bookmark').textContent).toBe('Undo');
  expect(byId('pp-fields').hidden).toBe(true);
  panel.show(existing);
  expect(status()).toBe('Removed');
  byId('remove-bookmark').click();
  await vi.waitFor(() => expect(options.close).toHaveBeenCalledOnce());
  expect(options.restore).toHaveBeenCalledOnce();
  panel.dispose();
});

test('a failed Remove keeps the existing result available', async () => {
  const { panel, status } = mount({ remove: vi.fn(async () => false) });
  panel.show({ ...local, disposition: 'existing' });
  byId('remove-bookmark').click();
  await vi.waitFor(() => expect(byId<HTMLButtonElement>('remove-bookmark').disabled).toBe(false));
  expect(status()).toBe('Already saved');
  expect(panel.removed()).toBe(false);
  panel.dispose();
});

describe('what the rules did (AW-19)', () => {
  const automation: AccountAutomation = { outcome: 'placed', ruleIds: ['rule-arxiv'], bundleRevision: 'b-1', settingsRevision: 1,
    satisfies: ['classify.root'], rule: { id: 'rule-arxiv', name: 'arXiv papers', revision: '1', bindingRevision: '1', semanticDigest: 'd' },
    destination: { serverUuid: 's', collectionId: 'c', nodeId: 'academic' }, folderTitle: 'Academic', fromNativeId: 'inbox',
    collectionId: 'c', replicaId: 'r', generation: 1 };
  const ruled = (over: Partial<AccountAutomation> = {}, task: Partial<CaptureTask> = {}): CaptureTask =>
    ({ ...local, classification: 'none', local: undefined, automation: { ...automation, ...over }, ...task });

  test('a placement names the folder and the rule in one calm line', () => {
    const { panel, line } = mount();
    panel.show(ruled());
    expect(line.textContent).toBe('Saved to Academic by rule “arXiv papers”.');
    expect(byId('capture-alert').hidden).toBe(true);
    expect(document.body.dataset.complete).toBe('true');
    panel.dispose();
  });

  test('while the user’s own AI suggests tags, the line says so instead of choosing a folder', () => {
    const { panel, line } = mount();
    panel.show(ruled({}, { classification: 'running', local: { commandId: 'c', state: 'running' } }));
    expect(line.textContent).toBe('Suggesting tags…');
    panel.dispose();
  });

  test('a rule that matched but could not act explains why, as an alert', () => {
    const { panel } = mount();
    panel.show(ruled({ outcome: 'blocked', reason: 'bindingUnavailable', satisfies: [] }));
    expect(byId('capture-alert').hidden).toBe(false);
    expect(byId('capture-alert-text').textContent).toBe('Rule “arXiv papers” matched, but its folder isn’t in this browser, so the page stayed where you saved it.');
    panel.show(ruled({ outcome: 'expired', satisfies: [] }));
    expect(byId('capture-alert-text').textContent).toBe('Rules are out of date; connect to refresh. The page stayed where you saved it.');
    panel.dispose();
  });
});
