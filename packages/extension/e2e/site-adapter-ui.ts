import type { Page } from '@playwright/test';

/** Sync is the page's main view; COLP Server and Recovery open from the Advanced tools rows, and the breadcrumb leads back. */
export async function openSiteAdapterTab(page: Page, tab: 'sync' | 'cloud' | 'recovery'): Promise<void> {
  const back = page.locator('#tab-sync');
  if (await back.isVisible()) await back.click();
  if (tab === 'sync') return;
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
