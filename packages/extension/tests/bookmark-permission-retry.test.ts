import { afterEach, expect, test, vi } from 'vitest';
import type { Locator, Page } from '@playwright/test';
import { Window } from 'happy-dom';
import { grantOptionalBookmarks } from '../e2e/bookmark-permission.js';

const mocks = vi.hoisted(() => ({ execFileAsync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execFileAsync }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test.skipIf(process.platform !== 'linux')('remembered consent does not send native keys into the next page step', async () => {
  let granted = false;
  const keys: string[] = [];
  mocks.execFileAsync.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'key') keys.push(args[1]!);
    return { stdout: '101\n', stderr: '' };
  });
  vi.stubGlobal('document', { title: 'Options' });
  vi.stubGlobal('chrome', {
    permissions: { contains: async () => granted },
    runtime: { sendMessage: async () => ({ ok: true }) },
  });
  const page = {
    title: async () => 'Options',
    bringToFront: async () => undefined,
    evaluate: async (fn: (value: unknown) => unknown, value: unknown) => fn(value),
  } as unknown as Page;
  const button = { click: async () => { granted = true; } } as unknown as Locator;
  await grantOptionalBookmarks(page, button, 'Remembered permission');
  expect(keys, 'there is no native permission prompt to accept').toEqual([]);
});

test.skipIf(process.platform !== 'linux').each([true, false])('retries permission with a native prompt still pending: %s, preserving the page dialog', async (unanswered) => {
  let pending = false, granted = false, attempts = 0, dialogOpen = true;
  const dom = new Window();
  vi.stubGlobal('window', dom);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('KeyboardEvent', dom.KeyboardEvent);
  const keys: string[] = [];
  mocks.execFileAsync.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'key') {
      keys.push(args[1]!);
      if (args[1] === 'Escape') {
        if (pending) pending = false;
        else {
          const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
          window.dispatchEvent(event);
          if (!event.defaultPrevented) dialogOpen = false;
        }
      }
      if (args[1] === 'Return' && attempts === 2) { granted = true; pending = false; }
    }
    return { stdout: '101\n', stderr: '' };
  });
  document.title = 'Options';
  vi.stubGlobal('chrome', {
    permissions: { contains: async () => granted },
    runtime: { sendMessage: async () => ({ ok: true }) },
  });
  const page = {
    title: async () => 'Options',
    bringToFront: async () => undefined,
    evaluate: async (fn: (value: unknown) => unknown, value: unknown) => fn(value),
    evaluateHandle: async (fn: () => object) => Object.assign(fn(), { dispose: async () => undefined }),
    keyboard: { press: async (key: string) => { if (key === 'Escape') pending = false; } },
  } as unknown as Page;
  const button = { click: async () => {
    expect(dialogOpen, 'Escape must not close the page dialog before a retry').toBe(true);
    pending = unanswered;
  } } as unknown as Locator;
  await grantOptionalBookmarks(page, button, 'Server permission', { origins: ['http://127.0.0.1/*'] }, async () => {
    expect(pending, 'the previous request must settle before refilling the server field').toBe(false);
    attempts++;
  });
  expect(attempts).toBe(2);
  if (process.platform === 'linux') expect(keys).toEqual(['Return', 'Escape', 'Tab', 'Return']);
  expect(granted).toBe(true);
  expect(document.title).toBe('Options');
  const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  window.dispatchEvent(escape);
  expect(escape.defaultPrevented, 'the page handles Escape normally after permission retries').toBe(false);
});
