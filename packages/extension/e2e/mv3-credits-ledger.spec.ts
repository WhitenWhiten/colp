import { expect, test, chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { KNOW_N_BACKEND_ONLY, knowNBackendRoot } from './cloud-product-fixtures.js';
import { EXTENSION_ID, openExtensionOptions, showOptionsPane, signInExtension } from './extension-auth.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

// Capture, classification, credits and the favicon helper are Know-N backend routes.
test.skip(!knowNBackendRoot, KNOW_N_BACKEND_ONLY);

test('real MV3 credits view keeps one PostgreSQL snapshot across filters, pages, details and authority changes', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack({ classification: true });
  const product = stack.classificationProduct;
  if (!product) throw new Error('classification_fixture_missing');
  const seeded = await product.seedCreditLedger(FIXTURE_COLLECTION_ID);
  await product.seedTags(FIXTURE_COLLECTION_ID);
  const extensionPath = resolve(import.meta.dirname, '../dist/production');
  const context = await chromium.launchPersistentContext('', {
    headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${stack.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
  try {
    const { page } = await openExtensionOptions(context);
    await signInExtension(page);
    await showOptionsPane(page, 'credits');
    await expect(page.locator('#credits-card')).toBeVisible();
    await expect(page.locator('[data-credit-list]')).toBeVisible({ timeout: 30_000 });

    // Type and rows apply as soon as they change; the charge and run filters are deep-link only, so set them directly.
    const filter = page.locator('[data-credit-filter]');
    const applyHidden = (values: { chargeId: string; runId: string }) => filter.evaluate((form, hidden) => {
      for (const [name, value] of Object.entries(hidden)) (form.querySelector(`input[name="${name}"]`) as HTMLInputElement).value = value;
      (form as HTMLFormElement).requestSubmit();
    }, values);
    // The page sizes start at 20, so add a tiny one to exercise paging with the seeded rows.
    await filter.locator('select[name="limit"]').evaluate(select => select.append(new Option('2', '2')));
    await filter.locator('select[name="limit"]').selectOption('2');
    await expect(page.locator('[data-credit-list] .credit-row')).toHaveCount(2);
    const snapshotAvailable = await page.locator('[data-credit-summary="title"]').textContent();
    const next = page.locator('[data-credit-action="next"]');
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.locator('[data-credit-list] .credit-row')).toHaveCount(4);
    expect(await page.locator('[data-credit-summary="title"]').textContent()).toBe(snapshotAvailable);

    await filter.locator('select[name="kind"]').selectOption('grant');
    await expect(page.locator('#credits-card')).toHaveAttribute('data-credit-state', 'ready');
    await expect(page.locator('[data-credit-list] .credit-row')).toHaveCount(2);
    await expect(page.locator('[data-credit-list]')).toContainText('Credits granted');

    await filter.locator('select[name="kind"]').selectOption('');
    await applyHidden({ chargeId: seeded.chargeId, runId: '' });
    await expect(page.locator('#credits-card')).toHaveAttribute('data-credit-state', 'ready');
    await expect(page.locator('[data-credit-list] .credit-row')).toHaveCount(2);

    await applyHidden({ chargeId: '00000000-0000-4000-8000-000000000099', runId: 'missing-run' });
    await expect(page.locator('[data-credit-state-view="filtered_empty"]')).toBeVisible();

    await applyHidden({ chargeId: '', runId: '' });
    await filter.locator('select[name="limit"]').selectOption('20');
    await expect(page.locator('[data-credit-list] .credit-row')).toHaveCount(seeded.entryCount);
    await page.locator('[data-credit-list] .credit-row').first().click();
    await expect(page.locator('[data-credit-detail]')).toBeVisible();
    await expect(page.locator('[data-credit-detail]')).toContainText('Sequence');

    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html?creditEntryId=${seeded.entryIds[0]}#credits`);
    await expect(page.locator('#credits-card')).toBeVisible();
    await expect(page.locator('[data-credit-detail]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-credit-detail]')).toContainText('Sequence');

    let releaseResponse!: () => void;
    let requestSeen!: () => void;
    const responseGate = new Promise<void>((resolveGate) => { releaseResponse = resolveGate; });
    const ledgerRequest = new Promise<void>((resolveRequest) => { requestSeen = resolveRequest; });
    await page.route('**/api/v1/me/credits/ledger*', async (route) => {
      requestSeen();
      await responseGate;
      try { await route.continue(); } catch { /* authority change may abort the intercepted request first */ }
    });
    await page.locator('.set-row [data-credit-action="refresh"]').click();
    await ledgerRequest;
    const credentialKey = 'known.auth.credential.v1';
    const originalCredential = await page.evaluate(async (key) => (await chrome.storage.session.get(key))[key], credentialKey);
    await page.evaluate(async ({ key, value }) => {
      if (!value || typeof value !== 'object') throw new Error('credential_missing');
      await chrome.storage.session.set({ [key]: { ...(value as Record<string, unknown>), subject: 'account-switched-before-response' } });
    }, { key: credentialKey, value: originalCredential });
    await expect(page.locator('[data-credit-list] .credit-row')).toHaveCount(0);
    releaseResponse();
    await page.unroute('**/api/v1/me/credits/ledger*');
    await page.evaluate(async ({ key, value }) => { await chrome.storage.session.set({ [key]: value }); }, { key: credentialKey, value: originalCredential });

    // Saving needs bookmark access, so grant it where the product offers it.
    await showOptionsPane(page, 'general');
    await grantOptionalBookmarks(page, page.locator('#permissions-grant-bookmarks'), 'Known credits popup');
    // The popup judges the page under it, so open it over a normal web page (a popup tab over itself cannot save).
    await grantTabAccess(context);
    await context.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Credits fixture page</title>' }));
    const target = await context.newPage(); await target.goto('https://example.test/credits-fixture');
    const popup = await openPopupOver(context, target);
    await expect(popup.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await expect(popup.locator('#folder-suggest')).toBeVisible({ timeout: 30_000 });
    // The cost line is visible — the shown quote is the consent, so assert both.
    await expect(popup.locator('#pp-note')).toHaveText('Uses 1 credit');

    await product.expireAllCredits(FIXTURE_COLLECTION_ID);
    await popup.reload();
    // The credits card moved off the popup; the ledger view on Options owns
    // the numbers now — the popup only needs to keep the save lane usable.
    await expect(popup.locator('#save')).toBeEnabled();
    await popup.close();
  } finally {
    await context.close();
    await stack.close();
  }
});
