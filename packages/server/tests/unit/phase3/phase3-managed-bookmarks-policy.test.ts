import { describe, expect, test } from 'vitest';
import { CHROMIUM_POLICY_KEY, MANAGED_BOOKMARKS_VALUE, ManagedPolicyProviderError,
  managedBookmarksPolicyDocument, selectManagedPolicyProvider } from '../../../scripts/phase3-managed-bookmarks-policy.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('P3-38 Windows managed bookmark policy plan', () => {
  test('uses the narrow current-user Chromium value and a unique managed node', () => {
    expect(CHROMIUM_POLICY_KEY).toBe(String.raw`HKCU\Software\Policies\Chromium`);
    expect(MANAGED_BOOKMARKS_VALUE).toBe('ManagedBookmarks');
    expect(JSON.parse(managedBookmarksPolicyDocument('P3-38 managed unique', 'https://managed.invalid/p3-38')))
      .toEqual([{ toplevel_name: 'P3-38 managed unique' },
        { name: 'P3-38 managed unique', url: 'https://managed.invalid/p3-38' }]);
  });

  test('falls back only for an explicit Windows access-denied preflight', async () => {
    const denied = new ManagedPolicyProviderError('access_denied');
    await expect(selectManagedPolicyProvider({ platform: 'win32', installWindows: async () => { throw denied; } }))
      .resolves.toMatchObject({ provider: 'linux-container-policy', fallbackReason: 'windows-policy-access-denied' });
    await expect(selectManagedPolicyProvider({ platform: 'win32', installWindows: async () => {
      throw new ManagedPolicyProviderError('operation_failed');
    } })).rejects.toThrow(/operation_failed/u);
  });

  test('never represents access denied as supported or a soft skip', async () => {
    const selected = await selectManagedPolicyProvider({ platform: 'win32', installWindows: async () => {
      throw new ManagedPolicyProviderError('access_denied');
    } });
    expect(selected).not.toHaveProperty('supported');
    expect(selected).not.toHaveProperty('skipped');
    expect(selected.provider).toBe('linux-container-policy');
  });

  test('preflights without writing and owns exact extension-policy backup restoration', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../scripts/phase3-managed-bookmarks-policy.mjs'), 'utf8');
    expect(source).toMatch(/preflightWindowsPolicyAccess\(\)[\s\S]*OpenSubKey\('Software\\\\Policies',\$true\)/u);
    expect(source).toMatch(/3rdparty\\\\extensions/u);
    expect(source).toMatch(/identityDisabled/u);
    expect(source).toMatch(/restoreRegistryState/u);
    expect(source).toMatch(/key_restoration_verification_failed/u);
  });
});
