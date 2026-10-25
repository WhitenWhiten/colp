import { afterEach, expect, test, vi } from 'vitest';
import type { Locator, Page } from '@playwright/test';
import { grantOptionalBookmarks } from '../e2e/bookmark-permission.js';

const mocks = vi.hoisted(() => ({ execFileAsync: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execFileAsync }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test.skipIf(process.platform !== 'linux')('dismisses an unanswered native prompt before retrying a disabled server field', async () => {
  let pending = false, granted = false, attempts = 0;
  const keys: string[] = [];
  mocks.execFileAsync.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'key') {
      keys.push(args[1]!);
      if (args[1] === 'Escape') pending = false;
      if (args[1] === 'Return' && attempts === 2) { granted = true; pending = false; }
    }
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
    keyboard: { press: async (key: string) => { if (key === 'Escape') pending = false; } },
  } as unknown as Page;
  const button = { click: async () => { pending = true; } } as unknown as Locator;
  await grantOptionalBookmarks(page, button, 'Server permission', { origins: ['http://127.0.0.1/*'] }, async () => {
    expect(pending, 'the previous request must settle before refilling the server field').toBe(false);
    attempts++;
  });
  expect(attempts).toBe(2);
  if (process.platform === 'linux') expect(keys).toEqual(['Return', 'Escape', 'Tab', 'Return']);
  expect(granted).toBe(true);
  expect(document.title).toBe('Options');
});
