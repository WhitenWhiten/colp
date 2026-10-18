import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions, signInExtension, showOptionsPane, waitForLibraryBinding } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

for (const rebuilt of [false, true]) test(`a fresh profile can retry reconnect after a failed verification before first sync${rebuilt ? ' with a rebuilt server library' : ''}`, async ({}, info) => {
  test.setTimeout(120_000);
  const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-reconnect-'));
  let context: BrowserContext | undefined;
  try {
    const extension = resolve(import.meta.dirname, '../dist/production');
    context = await chromium.launchPersistentContext(profile, {
      headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        `--host-resolver-rules=${stack.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'],
    });
    const { page } = await openExtensionOptions(context);
    await signInExtension(page);
    const libraryId = await waitForLibraryBinding(page);
    await showOptionsPane(page, 'folders');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N reconnect');
    await showOptionsPane(page, 'sync-center');
    await page.getByRole('button', { name: 'Disconnect sync', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect sync', exact: true }).click();
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is disconnected');
    // Model the local state left by resetting the server database. Responses and auth stay real.
    const oldReplica = rebuilt ? await page.evaluate(async () => {
      const stored = await chrome.storage.local.get(null);
      const rememberedKey = Object.keys(stored).find(key => key.startsWith('known.personal-sync-connection.v1:'))!;
      const policyKey = Object.keys(stored).find(key => key.startsWith('known.personal-sync.v1:'))!;
      const remembered = stored[rememberedKey] as { collectionId: string; binding: { replicaId: string } };
      const policy = stored[policyKey] as Record<string, unknown>;
      await chrome.storage.local.set({
        [rememberedKey]: { ...remembered, collectionId: 'library-before-reset' },
        [policyKey]: { ...policy, collectionId: 'library-before-reset' },
      });
      return remembered.binding.replicaId;
    }) : undefined;

    await page.getByRole('button', { name: 'Reconnect sync', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await context.setOffline(true);
    await page.getByRole('dialog').getByRole('button', { name: 'Resume sync', exact: true }).click();
    const toast = page.locator('.toast--error:not(.is-closing)');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('role', 'alert');
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is disconnected');
    await expect(page.locator('#personal-sync-feedback')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('reconnect-error-toast.png'), fullPage: true });

    await context.setOffline(false);
    await page.getByRole('button', { name: 'Reconnect sync', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Resume sync', exact: true }).click();
    await expect(page.locator('#personal-sync-status')).toHaveText(/^(Sync is on|Ready to sync\.)/u);
    await expect(toast).not.toBeVisible();
    await waitForLibraryBinding(page, libraryId);
    if (oldReplica) {
      const binding = await page.evaluate(() => chrome.storage.local.get('known.auth.binding.v1'));
      expect((binding['known.auth.binding.v1'] as { replicaId: string }).replicaId).not.toBe(oldReplica);
    }
    await showOptionsPane(page, 'folders');
    await expect(page.locator('.root-select input').first()).toBeVisible();
  } finally {
    await context?.close();
    await stack.close();
    await rm(profile, { recursive: true, force: true });
  }
});
