import type { Page } from '@playwright/test';

/** Advanced navigation follows the disclosure used by the settings page. */
export async function openSiteAdapterTab(page: Page, tab: 'sync' | 'cloud' | 'recovery'): Promise<void> {
  const tools = page.locator('#site-tools');
  if (await tools.getAttribute('open') === null) await tools.locator(':scope > summary').click();
  await page.locator(`#tab-${tab}`).click();
}

export async function openSiteAdapterConfiguration(page: Page): Promise<void> {
  await openSiteAdapterTab(page, 'sync');
  if (await page.locator('#site-configure').isVisible() && !await page.locator('#site-settings-dialog').isVisible()) {
    await page.locator('#site-configure').click();
  }
}

export async function openSiteAdapterChanges(page: Page): Promise<void> {
  const changes = page.locator('#reconcile-details');
  if (await changes.getAttribute('open') === null) await changes.locator(':scope > summary').click();
}
