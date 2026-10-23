import type { ActivityItem } from '../src/api/activityTypes'
import { expect, test } from './fixtures'
import { mockOwnerLibrary } from './helpers/library-mocks'

const NOW = new Date().toISOString()
const bookmark: ActivityItem = {
  id: 'activity-newest', kind: 'agent_bookmarks_added', state: 'unread', revision: '1',
  occurredAt: NOW, updatedAt: NOW, readAt: null, count: 7,
  agent: { clientId: 'claude', name: 'Claude', kind: 'oauth_client' },
  collection: { id: 'col-1', title: 'Personal' },
  folders: [{ nodeId: 'papers', title: 'LLM Papers', count: 6 }, { nodeId: 'reading', title: 'Reading', count: 1 }],
  items: [
    { nodeId: 'one', title: 'Attention Is All You Need', host: 'arxiv.org', occurredAt: NOW },
    { nodeId: 'two', title: 'A practical guide to evaluating language models and their real-world tradeoffs', host: 'research.example', occurredAt: NOW },
  ], run: null,
}

test('activity bell and inbox remain readable across viewport sizes', async ({ page }, testInfo) => {
  await mockOwnerLibrary(page)
  await page.route('**/api/v1/me/automations/pause', route => route.fulfill({ json: {
    paused: true, pausedAt: NOW, pausedBy: 'owner', revision: '1', heldJobs: 0,
  } }))
  let unreadCount = 107
  const reads: unknown[] = []
  const items: ActivityItem[] = [bookmark,
    ...(['run_completed', 'run_partial', 'run_failed', 'run_attention'] as const).map((kind, index) => ({
      ...bookmark, id: kind, kind, count: index === 0 ? 1 : 0, folders: [], items: [],
      run: { id: `run-${index}`, ruleId: 'weekly', ruleName: ['Weekly reading digest', 'Research overview', 'Paper classification', 'Research digest'][index]!, status: 'completed', outputCount: 1, attention: null },
    })),
  ]
  await page.route('**/api/v1/me/activity**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/summary')) return route.fulfill({ json: { unreadCount, latest: bookmark, revision: '2' } })
    if (path.endsWith('/read')) {
      reads.push(route.request().postDataJSON())
      expect(route.request().headers()['x-csrf-token']).toBe('e2e-csrf')
      expect(route.request().headers()['known-command-id']).toBeTruthy()
      unreadCount = 0
      return route.fulfill({ json: { readCount: 5, unreadCount } })
    }
    return route.fulfill({ json: { items, nextCursor: null, unreadCount } })
  })
  await page.goto('/about')
  const bell = page.getByRole('button', { name: 'Activity, 107 unread', exact: true })
  await expect(bell).toBeVisible()
  await expect(bell).toHaveText('99+')
  if (testInfo.project.name === 'mobile-chromium') {
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await page.setViewportSize({ width: 390, height: 844 })
  }
  await bell.click()
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Activity, 0 unread', exact: true })).toBeVisible()
  await expect(page.locator('[data-activity-id]')).toHaveCount(5)
  expect(reads).toEqual([{ through: 'activity-newest' }])
  await expect(page.getByRole('link', { name: 'Claude added 7 bookmarks to LLM Papers and 1 more folder' })).toHaveAttribute('href', '/library/col-1?folder=papers')

  const geometry = await page.evaluate(() => ({
    width: window.innerWidth, pageWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('[data-activity-id], .topnav-inner')].filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className),
  }))
  expect(geometry.pageWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.width + 1)
  expect(geometry.overflowing, JSON.stringify(geometry)).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('activity-inbox.png'), fullPage: true })

  if (testInfo.project.name === 'mobile-chromium') {
    await page.setViewportSize({ width: 320, height: 700 })
    await expect(page.getByRole('button', { name: 'Activity, 0 unread', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await page.screenshot({ path: testInfo.outputPath('activity-inbox-320.png'), fullPage: true })
  }
})
