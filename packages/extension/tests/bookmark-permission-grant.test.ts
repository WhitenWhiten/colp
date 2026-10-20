// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { grantOptionalBookmarks } from '../e2e/bookmark-permission.js';

const system = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: system.exec });
  return { ...actual, execFile, default: { ...actual, execFile } };
});
beforeEach(() => {
  vi.useFakeTimers(); document.title = 'Options';
  system.exec.mockReset().mockResolvedValue({ stdout: '123\n', stderr: '' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function permissionPage(granted: boolean) {
  const contains = vi.fn(async (_request: { permissions?: string[]; origins?: string[] }) => granted);
  const auth = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('chrome', { permissions: { contains }, runtime: { sendMessage: auth } });
  const click = vi.fn(async () => {});
  const page = { title: async () => document.title, isClosed: () => false, bringToFront: async () => {},
    getByRole: () => ({ click }), keyboard: { press: async () => {} },
    evaluate: async (fn: (value: unknown) => unknown, value?: unknown) => fn(value),
  } as unknown as Page;
  return { page, contains, auth, click };
}

test('three unsuccessful real permission reads reject even when every prompt interaction succeeded', async () => {
  const f = permissionPage(false); const beforeAttempt = vi.fn(async () => {});
  const result = grantOptionalBookmarks(f.page, 'Allow bookmark access', 'Unit permission',
    { permissions: ['bookmarks'] }, beforeAttempt);
  const rejected = expect(result).rejects.toThrow('bookmarks_permission_denied');
  await vi.runAllTimersAsync(); await rejected;
  expect(f.contains).toHaveBeenCalledTimes(3);
  expect(f.contains.mock.calls.every(([request]) => JSON.stringify(request) === '{"permissions":["bookmarks"]}')).toBe(true);
  expect(f.click).toHaveBeenCalledTimes(3); expect(beforeAttempt).toHaveBeenCalledTimes(3);
  expect(f.auth).not.toHaveBeenCalled();
  expect(document.title).toBe('Options');
});

test('grant completes only after permission is true and the reloaded extension responds', async () => {
  const f = permissionPage(true);
  const result = grantOptionalBookmarks(f.page, 'Allow bookmark access', 'Unit permission');
  await vi.runAllTimersAsync(); await result;
  expect(f.contains).toHaveBeenCalledTimes(1); expect(f.click).toHaveBeenCalledTimes(1);
  expect(f.auth).toHaveBeenCalledWith({ kind: 'known.auth.status' });
  expect(document.title).toBe('Options');
});
