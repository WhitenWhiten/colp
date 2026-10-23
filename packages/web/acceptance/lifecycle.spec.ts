import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>Imported research</H3><DL><DT><A HREF="https://example.org/first">First imported link</A><DT><H3>Nested research</H3><DL><DT><A HREF="https://example.org/second">Second imported link</A></DL></DL></DL>'

test('owner lifecycle on the production self-hosted application', async ({ page, browser }, testInfo) => {
  const username = process.env.COLP_ACCEPTANCE_USERNAME
  const password = process.env.COLP_ACCEPTANCE_PASSWORD
  if (!username || !password) throw new Error('Set acceptance owner credentials for this disposable stack.')
  const title = `Lifecycle ${Date.now()}`
  let shareUrl = ''
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))

  await test.step('sign in and open the account library', async () => {
    await page.goto('/login')
    await page.getByLabel('Username or email').fill(username)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/library/)
    const nav = page.getByTestId('library-nav')
    await expect(nav.getByRole('link', { name: /Bookmarks bar/ })).toBeVisible()
    await expect(nav.getByRole('link', { name: /Other bookmarks/ })).toBeVisible()
    await nav.getByRole('link', { name: /Bookmarks bar/ }).click()
  })
  let folderId = ''

  await test.step('create a folder, bookmark, and private note', async () => {
    await page.getByTestId('library-nav').getByRole('button', { name: 'New folder', exact: true }).click()
    await page.locator('#lc-title').fill(title)
    await page.getByTestId('library-compose').getByRole('button', { name: 'Create folder', exact: true }).click()
    await expect(page.locator('.library-folder-row', { hasText: title })).toBeVisible()
    await page.locator('.library-folder-row', { hasText: title }).getByRole('link').first().click()
    folderId = new URL(page.url()).searchParams.get('folder')!
    expect(folderId).toBeTruthy()
    await page.getByRole('button', { name: 'Add bookmark', exact: true }).first().click()
    await page.locator('#lc-url').fill('https://example.org/owner-bookmark')
    await page.locator('#lc-title').fill('Owner bookmark')
    await page.getByTestId('library-compose').getByRole('button', { name: 'Add bookmark', exact: true }).click()
    await page.getByRole('button', { name: 'Actions for Owner bookmark' }).click()
    await page.getByRole('menuitem', { name: 'Edit details', exact: true }).click()
    await page.locator('#nd-note').fill('Private acceptance note')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect(page.getByTestId('node-drawer-status')).not.toHaveText('Saving…')
    await page.getByRole('button', { name: 'Close editor' }).click()
    await page.getByRole('button', { name: 'Actions for Owner bookmark' }).click()
    await page.getByRole('menuitem', { name: 'Edit details', exact: true }).click()
    await expect(page.locator('#nd-note')).toHaveValue('Private acceptance note')
    await page.getByRole('button', { name: 'Close editor' }).click()
  })

  await test.step('preview HTML, import into the chosen folder, and skip a repeated import', async () => {
    await page.goto('/import')
    await page.getByLabel('Destination folder').click()
    await page.locator(`[role="option"][data-folder-id="${folderId}"]`).click()
    await page.getByLabel('Bookmarks HTML file').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) })
    await expect(page.getByText('Preview: 2 folders, 2 bookmarks.')).toBeVisible()
    await page.getByRole('button', { name: 'Confirm import' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Imported 4 items.' })).toBeVisible()
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click()
    // A finished import clears the file, so the repeat picks it again.
    await page.getByLabel('Bookmarks HTML file').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) })
    await page.getByRole('button', { name: 'Confirm import' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Imported 0 items; skipped 4 duplicates.' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('import.png') })
  })

  await test.step('share a live folder and revoke its anonymous link', async () => {
    await page.goto(`/library?folder=${encodeURIComponent(folderId)}`)
    await page.getByRole('button', { name: 'More collection actions' }).click()
    await page.getByRole('menuitem', { name: 'Share…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `Share ${title}` })
    await dialog.getByRole('button', { name: 'Create link', exact: true }).click()
    shareUrl = (await dialog.getByRole('link', { name: 'Open link', exact: true }).getAttribute('href'))!
    const anonymous = await browser.newContext()
    try {
      const publicPage = await anonymous.newPage()
      await publicPage.goto(shareUrl)
      await expect(publicPage.getByRole('heading', { name: title, exact: true })).toBeVisible()
      await expect(publicPage.getByText('Owner bookmark', { exact: true })).toBeVisible()
      await expect(publicPage.getByText('Private acceptance note')).toHaveCount(0)
      await expect(publicPage.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0)
      await publicPage.screenshot({ path: testInfo.outputPath('anonymous.png') })
      await dialog.getByRole('button', { name: 'Stop sharing', exact: true }).click()
      await expect(dialog.getByRole('button', { name: 'Create link', exact: true })).toBeVisible()
      await publicPage.reload()
      await expect(publicPage.getByRole('heading', { name: 'Link unavailable', exact: true })).toBeVisible()
    } finally { await anonymous.close() }
  })

  await test.step('show the empty Sync center and installed versions', async () => {
    await page.goto('/sync')
    await expect(page.getByRole('heading', { name: 'No browsers syncing yet' })).toBeVisible()
    await page.goto('/about')
    const serverPackage = JSON.parse(await readFile(new URL('../../server/package.json', import.meta.url), 'utf8'))
    const sdkPackage = JSON.parse(await readFile(new URL('../../server/node_modules/@know-n/colp/package.json', import.meta.url), 'utf8'))
    await expect(page.getByTestId('about-server')).toHaveText(serverPackage.version)
    await expect(page.getByTestId('about-colp')).toHaveText(sdkPackage.version)
    await expect(page.getByTestId('about-protocols')).toHaveText('0.1 0.2')
    for (const name of ['CHANGELOG', 'INSTALL']) {
      const response = await page.request.get(`/${name}.md`)
      expect(response.ok()).toBe(true)
      expect(await response.text()).toContain(name === 'CHANGELOG' ? '# Changelog' : 'COLP')
    }
    await page.screenshot({ path: testInfo.outputPath('about.png') })
  })
  expect(errors).toEqual([])
  await writeFile(testInfo.outputPath('lifecycle.json'), JSON.stringify({ origin: process.env.COLP_ACCEPTANCE_ORIGIN, folderId, title, shareUrl, bookmarks: 3, importedFolders: 2, privateNote: true }, null, 2))
})
