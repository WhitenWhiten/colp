// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindManualFooter } from '../src/popup-footer.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';

const create = vi.fn(async () => ({}));
const sendMessage = vi.fn();
let close: ReturnType<typeof vi.spyOn>;
const setFeedback = vi.fn();

function trustedClick(id: string): void {
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(click, 'isTrusted', { value: true });
  byId(id).dispatchEvent(click);
}

beforeEach(() => {
  mountPopupShell();
  create.mockClear(); sendMessage.mockReset(); setFeedback.mockReset();
  vi.stubGlobal('chrome', { tabs: { create }, runtime: { getURL: (path: string) => `chrome-extension://id/${path}`, sendMessage } });
  close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
  bindManualFooter(setFeedback);
});
afterEach(() => { vi.unstubAllGlobals(); close.mockRestore(); document.body.replaceChildren(); });

test('Bookmarks opens the library in a tab and lets the popup go', async () => {
  byId('open-bookmarks').click();
  await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce(); });
  expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://id/options.html#bookmarks' });
});

test('Save tabs asks the worker for the window preview and closes when it opens', async () => {
  sendMessage.mockResolvedValue({ ok: true });
  trustedClick('save-tabs');
  await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce(); });
  expect(sendMessage).toHaveBeenCalledWith({ kind: 'known.save.native', entry: 'window', userGesture: true });
  expect(setFeedback).not.toHaveBeenCalled();
});

test('Save tabs ignores a click the page scripted', () => {
  byId('save-tabs').click();
  expect(sendMessage).not.toHaveBeenCalled();
});

test('when the preview cannot open the popup stays and says so', async () => {
  sendMessage.mockResolvedValue({ ok: false });
  trustedClick('save-tabs');
  await vi.waitFor(() => { expect(setFeedback).toHaveBeenCalledWith("Couldn't open the tab list. Try again.", 'error'); });
  expect(close).not.toHaveBeenCalled();
});
