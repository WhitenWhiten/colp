import { expect, type Page } from '@playwright/test'

/** The Publication selector is an accessible radio group, even though its elements are buttons. */
export async function selectCollectionVisibility(page: Page, visibility: 'Private' | 'Unlisted' | 'Public'): Promise<void> {
  const choice = page.getByRole('radiogroup', { name: 'Collection visibility', exact: true })
    .getByRole('radio', { name: visibility, exact: true })
  if (!await page.getByRole('dialog', { name: 'Edit collection', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Collection actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit collection', exact: true }).click()
    await expect(page.getByTestId('collection-settings')).toBeVisible()
  }
  await expect(choice).toBeEnabled()
  await choice.click()
  await expect(choice).toHaveAttribute('aria-checked', 'true')
}

/** Assert the current create flow lands on Library Desk and return its id. */
export async function expectCollectionDeskAfterCreate(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/library\/[^/?]+(?:\?.*)?$/u)
  await expect(page.getByTestId('library-workspace')).toBeVisible()
  const collectionId = new URL(page.url()).pathname.split('/')[2]
  if (!collectionId) throw new Error('created collection id is missing from the Library Desk URL')
  return collectionId
}

/** Fixture setup used to open the full-screen editor; node create now lives on the desk. */
export async function openCollectionEditorAfterDeskCreate(page: Page): Promise<string> {
  return expectCollectionDeskAfterCreate(page)
}

export async function openCollectionSettings(page: Page, collectionId: string): Promise<void> {
  await page.goto(`/library/${encodeURIComponent(collectionId)}?collection=edit`)
  await expect(page.getByTestId('collection-settings')).toBeVisible()
}

export async function createDeskBookmark(page: Page, title: string, url: string): Promise<void> {
  await page.getByRole('button', { name: 'Add bookmark', exact: true }).first().click()
  const composer = page.getByTestId('library-compose')
  await composer.getByLabel('URL', { exact: true }).fill(url)
  await composer.getByRole('textbox', { name: /^Title/ }).fill(title)
  const collectionId = new URL(page.url()).pathname.split('/')[2]
  const created = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/collections/${collectionId}/nodes`)
  await composer.locator('button[type="submit"]').click()
  expect((await created).status()).toBe(201)
  await expect(composer).toBeHidden()
  await expect(page.getByTestId('library-bookmarks')).toContainText(title)
}
