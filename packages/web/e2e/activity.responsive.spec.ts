import type { Page } from '@playwright/test'
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

/* The bell is a fixed square in every cut: no control may be pushed past the
   bar's edge, the last primary link (with Automations' Paused flag) ends
   before it, and its corner count stays off the next control. */
async function expectBarClear(page: Page) {
  const bar = await page.evaluate(() => {
    const shown = (selector: string) => [...document.querySelectorAll(selector)].map(node => node.getBoundingClientRect()).filter(box => box.width > 0)
    const bell = document.querySelector('.nav-activity')!.getBoundingClientRect()
    const actions = shown('.nav-actions > *')
    return {
      width: window.innerWidth,
      actionsRight: Math.max(...actions.map(box => box.right)),
      linksRight: Math.max(0, ...shown('.nav-links a').map(box => box.right)),
      bellLeft: bell.left,
      pillRight: shown('.nav-activity .count-pill')[0]?.right ?? bell.right,
      nextLeft: actions.find(box => box.left >= bell.right)?.left ?? window.innerWidth,
    }
  })
  expect(bar.actionsRight, JSON.stringify(bar)).toBeLessThanOrEqual(bar.width)
  expect(bar.linksRight, JSON.stringify(bar)).toBeLessThanOrEqual(bar.bellLeft)
  expect(bar.pillRight, JSON.stringify(bar)).toBeLessThanOrEqual(bar.nextLeft)
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
  const bell = page.getByRole('link', { name: 'Activity, 107 unread', exact: true })
  await expect(bell).toBeVisible()
  await expect(bell).toHaveText('99+')
  await expectBarClear(page)
  const lane = page.viewportSize()!
  // The narrowest phone and the narrowest bar that still lists the primary links.
  const narrowest = { 'mobile-chromium': 320, 'tablet-chromium': 720 }[testInfo.project.name]
  if (narrowest) {
    await page.setViewportSize({ width: narrowest, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(narrowest + 1)
    await expectBarClear(page)
    await page.locator('.topnav').screenshot({ path: testInfo.outputPath(`activity-bell-${narrowest}.png`) })
    await page.setViewportSize(lane)
  }
  await bell.click()
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Activity, 0 unread', exact: true })).toBeVisible()
  await expect(page.locator('[data-activity-id]')).toHaveCount(5)
  expect(reads).toEqual([{ through: 'activity-newest', throughRevision: '1' }])
  await expect(page.getByRole('link', { name: 'Claude added 7 bookmarks to LLM Papers and 1 more folder' })).toHaveAttribute('href', '/library/col-1?folder=papers')

  const geometry = await page.evaluate(() => ({
    width: window.innerWidth, pageWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('[data-activity-id], .topnav-inner')].filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className),
    // New keeps its own column beside the sentence instead of wrapping under it.
    stranded: [...document.querySelectorAll('[data-activity-id]')].filter((entry) => {
      const badge = entry.querySelector('.badge')?.getBoundingClientRect()
      const body = entry.querySelector('.activity-body')!.getBoundingClientRect()
      return badge && (badge.left < body.right || badge.top > body.top + 12)
    }).map(entry => entry.getAttribute('data-activity-id')),
  }))
  expect(geometry.pageWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.width + 1)
  expect(geometry.overflowing, JSON.stringify(geometry)).toEqual([])
  expect(geometry.stranded, JSON.stringify(geometry)).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('activity-inbox.png'), fullPage: true })

  if (testInfo.project.name === 'mobile-chromium') {
    await page.setViewportSize({ width: 320, height: 700 })
    await expect(page.getByRole('link', { name: 'Activity, 0 unread', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await page.screenshot({ path: testInfo.outputPath('activity-inbox-320.png'), fullPage: true })
  }
})
