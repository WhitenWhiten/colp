// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { bindNativeWaitSettings } from '../src/native-wait-ui.js';
import type { PublicNativeWait } from '../src/types.js';

const wait = (n: number, over: Partial<PublicNativeWait> = {}): PublicNativeWait => ({
  waitRef: `w${n}`, intentId: `i${n}`, colpId: `c${n}`, title: `Bookmark ${n}`, url: `https://site${n}.example/x`,
  waitReason: 'native_result_unknown', candidates: [{ nativeId: 'b1', title: 'Existing one' }], affectedRange: { parentNativeId: 'p' }, generation: 1, ...over });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

async function mount(respond: (message: { kind: string }) => unknown) {
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const send = vi.fn(async (message: { kind: string }) => respond(message));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  bindNativeWaitSettings();
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  return send;
}
const group = () => document.getElementById('native-wait-settings')!;
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.native-wait-item'));

test('nothing waiting hides the group and its summary; waiting items raise both', async () => {
  await mount(() => ({ ok: true, waits: [] }));
  expect(group().hidden).toBe(true);
  expect(document.getElementById('sync-summary')!.hidden).toBe(true);
  await mount(() => ({ ok: true, waits: [wait(1), wait(2, { candidates: [] })] }));
  expect(group().hidden).toBe(false);
  expect(document.getElementById('sync-summary')!.hidden).toBe(false);
  expect(document.getElementById('sync-summary-copy')!.textContent).toBe('2 bookmarks from your library need your decision before they’re added here.');
  expect(rows()).toHaveLength(2);
});

test('a row shows at most two actions and keeps the destructive one in the menu', async () => {
  await mount(() => ({ ok: true, waits: [wait(1), wait(2, { candidates: [] })] }));
  const visible = (row: HTMLElement) => Array.from(row.querySelectorAll<HTMLButtonElement>('.set-row-control > button:not([hidden])'));
  expect(visible(rows()[0]!).map((button) => button.textContent)).toEqual(['Use existing', 'Keep both', '']);
  expect(visible(rows()[0]!).filter((button) => button.textContent).length).toBeLessThanOrEqual(2);
  expect(visible(rows()[1]!).map((button) => button.textContent)).toEqual(['Keep both', '']);
  expect(rows()[0]!.querySelector('.native-wait-target')!.textContent).toBe('Bookmark 1');
  expect(rows()[0]!.querySelector('.native-wait-reason')!.textContent).toBe('site1.example · This browser created the bookmark, but the result was not recorded');
  expect(document.querySelector('[data-native-wait-action="cancel"]')).toBeNull();
});

test('Don\'t place asks first; Keep item puts the row back and Don\'t place sends the decision', async () => {
  const send = await mount((message) => message.kind === 'known.nativeWait.list' ? { ok: true, waits: [wait(1)] } : { ok: true, result: 'cancelled' });
  rows()[0]!.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!.click();
  document.querySelector<HTMLButtonElement>('.mgr-menu-item')!.click();
  const confirm = rows()[0]!.querySelector('.native-wait-cancel-confirm')!;
  expect(confirm.textContent).toMatch(/Don't place this cloud item on this device\?/);
  expect(rows()[0]!.querySelector<HTMLElement>('.set-row-control')!.hidden).toBe(true);
  confirm.querySelector<HTMLButtonElement>('.btn-ghost')!.click();
  expect(rows()[0]!.querySelector('.native-wait-cancel-confirm')).toBeNull();
  expect(rows()[0]!.querySelector<HTMLElement>('.set-row-control')!.hidden).toBe(false);
  rows()[0]!.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!.click();
  document.querySelector<HTMLButtonElement>('.mgr-menu-item')!.click();
  rows()[0]!.querySelector<HTMLButtonElement>('.native-wait-cancel-confirm .btn-danger')!.click();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.nativeWait.confirm', action: 'cancel', userGesture: true })));
});

test('a refusal with no code never prints "undefined"', async () => {
  await mount((message) => message.kind === 'known.nativeWait.list' ? { ok: true, waits: [wait(1, { candidates: [] })] } : { ok: false, error: 'something_else' });
  rows()[0]!.querySelector<HTMLButtonElement>('[data-native-wait-action="keep_local_and_create"]')!.click();
  await vi.waitFor(() => expect(document.getElementById('native-wait-feedback')!.hidden).toBe(false));
  const copy = document.getElementById('native-wait-feedback')!.textContent!;
  expect(copy).toBe('Could not complete this action. Try again.');
  expect(copy).not.toMatch(/undefined|something_else/u);
  expect(document.getElementById('native-wait-feedback')!.parentElement!.dataset.tone).toBe('warning');
});

test('a worker that answers nothing reads as unavailable, not as a crash', async () => {
  await mount(() => undefined);
  expect(document.getElementById('native-wait-feedback')!.textContent).toBe('The extension background is temporarily unavailable. Try again.');
});
