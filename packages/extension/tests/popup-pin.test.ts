// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bindPopupPin } from '../src/popup-pin.js';

let sendMessage: ReturnType<typeof vi.fn>, createTab: ReturnType<typeof vi.fn>;
let folder = 'f1';
const status = (blockers: string[]) => ({ ok: true, folders: { [folder]: blockers } });

function setup() {
  const button = document.createElement('button'), hint = document.createElement('p');
  hint.hidden = true; document.body.append(button, hint);
  return { button, hint, pin: bindPopupPin({ button, hint }, () => folder) };
}

beforeEach(() => {
  folder = 'f1'; sendMessage = vi.fn(); createTab = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', { runtime: { sendMessage, getURL: (path: string) => `chrome-extension://test/${path}` }, tabs: { create: createTab } });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('popup pin toggle', () => {
  test('a new save goes in unpinned unless the toggle is pressed where pins apply', async () => {
    const { button, pin } = setup();
    sendMessage.mockResolvedValueOnce(status([]));
    await pin.refresh();
    expect(sendMessage).toHaveBeenCalledWith({ kind: 'known.bookmarks.pin.status', folderIds: ['f1'] });
    expect(button.hidden).toBe(false);
    expect(pin.pinned()).toBe(false);
    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(pin.pinned()).toBe(true);
  });

  test('where pins are off, pressing explains what is missing and links to the settings', async () => {
    const { button, hint, pin } = setup();
    sendMessage.mockResolvedValueOnce(status(['insert_bottom', 'folder_unorganized']));
    await pin.refresh();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    expect(pin.pinned()).toBe(false);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('New bookmarks go to the top of the folder · This folder is organized');
    expect(hint.textContent).not.toContain('Show folders before bookmarks');
    hint.querySelector('button')!.click();
    expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://test/options.html#saving' });
  });

  test('choosing a folder that cannot take pins drops a pressed pin; one that can hides the hint', async () => {
    const { button, hint, pin } = setup();
    sendMessage.mockResolvedValueOnce(status([]));
    await pin.refresh(); button.click();
    folder = 'f2'; sendMessage.mockResolvedValueOnce(status(['folders_first_off']));
    await pin.refresh();
    expect(pin.pinned()).toBe(false);
    button.click();
    expect(hint.hidden).toBe(false);
    folder = 'f3'; sendMessage.mockResolvedValueOnce(status([]));
    await pin.refresh();
    expect(hint.hidden).toBe(true);
  });

  test('a pin pressed for a saved bookmark drops when its folder stops taking pins; a saved pin stays', async () => {
    const { button, pin } = setup();
    sendMessage.mockResolvedValueOnce(status([]));
    await pin.refresh(); pin.adopt(false); button.click();
    expect(pin.change()).toBe(true);
    sendMessage.mockResolvedValueOnce(status(['folder_unorganized']));
    await pin.refresh();
    expect(pin.change()).toBeUndefined();
    pin.adopt(true);
    sendMessage.mockResolvedValueOnce(status(['folder_unorganized']));
    await pin.refresh();
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  test('without bookmark access the toggle steps aside', async () => {
    const { button, pin } = setup();
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'permission_required' });
    await pin.refresh();
    expect(button.hidden).toBe(true);
  });

  test('editing a saved bookmark shows its pin, keeps it paused elsewhere, and reports only a change', async () => {
    const { button, pin } = setup();
    sendMessage.mockResolvedValueOnce(status(['insert_bottom']));
    await pin.refresh();
    pin.adopt(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.hasAttribute('data-paused')).toBe(true);
    expect(pin.change()).toBeUndefined();
    // Unpinning stays possible where pins are off.
    button.click();
    expect(pin.change()).toBe(false);
    pin.adopt(undefined);
    expect(pin.change()).toBeUndefined();
  });
});
