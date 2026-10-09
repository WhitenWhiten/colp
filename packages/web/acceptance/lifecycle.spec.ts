import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>Imported research</H3><DL><DT><A HREF="https://example.org/first">First imported link</A><DT><H3>Nested research</H3><DL><DT><A HREF="https://example.org/second">Second imported link</A></DL></DL></DL>'

test('owner lifecycle on the production self-hosted image', async ({ page, browser }, testInfo) => {
  const username = process.env.COLP_ACCEPTANCE_USERNAME
  const password = process.env.COLP_ACCEPTANCE_PASSWORD
  if (!username || !password) throw new Error('Set acceptance owner credentials for this disposable stack.')
  const title = `Lifecycle ${Date.now()}`
  const slug = `lifecycle-${Date.now()}`
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))

  await test.step('sign in and create a collection through the UI', async () => {
    await page.goto('/login')
    await page.getByLabel('Username or email').fill(username)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/library/)
    await page.goto('/library/new')
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page).toHaveURL(/\/library\/[^/?]+$/)
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
  })
  const collectionId = new URL(page.url()).pathname.split('/').at(-1)!
  let folderId = ''

  await test.step('create a folder, bookmark, and private note', async () => {
    await page.getByRole('button', { name: 'More collection actions' }).click()
    await page.getByRole('menuitem', { name: 'Add folder', exact: true }).click()
    await page.locator('#lc-title').fill('Acceptance folder')
    await page.getByTestId('library-compose').getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.locator('.library-folder-row', { hasText: 'Acceptance folder' })).toBeVisible()
    await page.locator('.library-folder-row', { hasText: 'Acceptance folder' }).getByRole('link').first().click()
    folderId = new URL(page.url()).searchParams.get('folder')!
    expect(folderId).toBeTruthy()
    await page.getByRole('button', { name: 'Add bookmark', exact: true }).first().click()
    await page.locator('#lc-url').fill('https://example.org/owner-bookmark')
    await page.locator('#lc-title').fill('Owner bookmark')
    await page.getByTestId('library-compose').getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('button', { name: 'Actions for Owner bookmark' }).click()
    await page.getByRole('menuitem', { name: 'Edit details', exact: true }).click()
    await page.locator('#nd-note').fill('Private acceptance note')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('node-drawer-status')).toContainText(/Saved/i)
    await page.getByRole('button', { name: 'Close editor' }).click()
  })

  await test.step('preview HTML, import into the chosen folder, and skip a repeated import', async () => {
    await page.goto('/import')
    await page.getByLabel('Collection', { exact: true }).selectOption(collectionId)
    await page.getByLabel('Destination folder').selectOption(folderId)
    await page.getByLabel('Bookmarks HTML file').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) })
    await expect(page.getByText('Preview: 2 folders, 2 bookmarks.')).toBeVisible()
    await page.getByRole('button', { name: 'Confirm import' }).click()
    await expect(page.getByText('Import complete: 4 items added; 0 duplicates skipped.')).toBeVisible()
    await page.getByRole('button', { name: 'Confirm import' }).click()
    await expect(page.getByText('Import complete: 0 items added; 4 duplicates skipped.')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('import.png') })
  })

  await test.step('share an unlisted collection and read it in an anonymous browser', async () => {
    await page.goto(`/library/${collectionId}?collection=edit`)
    const settings = page.getByRole('dialog', { name: 'Edit collection' })
    await settings.getByRole('radio', { name: 'Unlisted', exact: true }).check()
    await settings.getByLabel('Public address').fill(slug)
    await settings.getByRole('button', { name: 'Save collection' }).click()
    await expect(settings.getByText('Published at', { exact: true })).toBeVisible()
    const anonymous = await browser.newContext()
    try {
      const publicPage = await anonymous.newPage()
      await publicPage.goto(`${process.env.COLP_ACCEPTANCE_ORIGIN}/c/${slug}`)
      await expect(publicPage.getByRole('heading', { name: title })).toBeVisible()
      await expect(publicPage.getByText('Private acceptance note')).toHaveCount(0)
      await publicPage.screenshot({ path: testInfo.outputPath('anonymous.png') })
    } finally { await anonymous.close() }
    await page.goto(`/c/${slug}`)
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible()
  })

  let snapshot: { nodes: Array<{ id: string; kind: string; parentId: string; title: string; position: string }>; annotations: Array<{ value: unknown }> } | undefined
  await test.step('download HTML and JSON through the Export menu', async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    for (const format of ['HTML', 'JSON']) {
      const pending = page.waitForEvent('download')
      await page.getByRole('menuitem', { name: format, exact: true }).click()
      const download = await pending
      const path = testInfo.outputPath(`collection.${format.toLowerCase()}`)
      await download.saveAs(path)
      const text = await readFile(path, 'utf8')
      if (format === 'HTML') expect(text).toContain('NETSCAPE-Bookmark-file-1')
      else {
        snapshot = JSON.parse(text)
        expect(snapshot!.nodes.filter(node => node.kind === 'bookmark')).toHaveLength(3)
        expect(snapshot!.annotations.some(annotation => annotation.value === 'Private acceptance note')).toBe(true)
        const first = snapshot!.nodes.find(node => node.title === 'First imported link')!
        const nested = snapshot!.nodes.find(node => node.title === 'Nested research')!
        expect(first.parentId).toBe(nested.parentId)
        expect(first.position < nested.position).toBe(true)
      }
    }
  })

  await test.step('show the empty Sync center and installed versions', async () => {
    await page.goto('/sync')
    await expect(page.getByRole('heading', { name: 'No connected browsers' })).toBeVisible()
    await page.goto('/about')
    await expect(page.getByTestId('about-server')).toHaveText('0.1.0')
    await expect(page.getByTestId('about-colp')).toHaveText('0.1.1')
    await expect(page.getByTestId('about-protocols')).toHaveText('0.1 0.2')
    for (const name of ['CHANGELOG', 'INSTALL']) {
      const response = await page.request.get(`/${name}.md`)
      expect(response.ok()).toBe(true)
      expect(await response.text()).toContain(name === 'CHANGELOG' ? '# Changelog' : 'COLP')
    }
    await page.screenshot({ path: testInfo.outputPath('about.png') })
  })
  expect(errors).toEqual([])
  await writeFile(testInfo.outputPath('lifecycle.json'), JSON.stringify({ origin: process.env.COLP_ACCEPTANCE_ORIGIN, collectionId, folderId, title, slug, bookmarks: 3, importedFolders: 2, privateNote: true }, null, 2))
})
