import { describe, expect, test, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { readOptionalPermissionAfterReload } from '../e2e/bookmark-permission.js';

const permission = { permissions: ['bookmarks'] };
describe('permission harness reads the new document after Chromium reloads options', () => {
  test.each([true, false])('reload recovery preserves the actual permission value %s', async granted => {
    const evaluate = vi.fn().mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation'))
      .mockResolvedValueOnce(granted);
    const page = { evaluate, isClosed: () => false } as unknown as Pick<Page, 'evaluate' | 'isClosed'>;
    expect(await readOptionalPermissionAfterReload(page, permission)).toBe(granted);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls.every(([, request]) => request === permission)).toBe(true);
  });

  test('an ordinary API error is not retried or interpreted as granted', async () => {
    const failure = new Error('permissions API unavailable');
    const evaluate = vi.fn().mockRejectedValue(failure);
    const page = { evaluate, isClosed: () => false } as unknown as Pick<Page, 'evaluate' | 'isClosed'>;
    await expect(readOptionalPermissionAfterReload(page, permission)).rejects.toThrow('permissions API unavailable');
    expect(evaluate).toHaveBeenCalledOnce();
  });

  test('a closed page remains an actual failure even if its error mentions a lost context', async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error('Cannot find context with specified id'));
    const page = { evaluate, isClosed: () => true } as unknown as Pick<Page, 'evaluate' | 'isClosed'>;
    await expect(readOptionalPermissionAfterReload(page, permission)).rejects.toThrow('Cannot find context');
    expect(evaluate).toHaveBeenCalledOnce();
  });
});
