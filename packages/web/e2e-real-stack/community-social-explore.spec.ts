import { expect, test } from '@playwright/test'

import {
  REAL_STACK_WEB_BASE_URL,
  apiCreateComment,
  apiResolveAndVote,
  awaitCommunityRanking,
  createCommunityFixture,
  enableCommunity,
  expectCommunityTarget,
  principalContext,
  resolveCommunityTargetView,
  type CommunityTargetQuery,
} from './community-social-bootstrap'

/* community-social real-stack acceptance — the Explore hot board. One
   fixture supplies all four community target kinds; each receives a real
   upvote through the actual PUT /api/v1/community/vote route (session +
   Origin + CSRF + durable command id — the same durable write a page click
   performs; the per-kind page-level vote lives in
   community-social-targets.spec.ts). The vote events go through the real
   `community.rank-refresh` outbox consumer, so the spec polls the public
   ranking route until the worker-produced snapshot carries all four rows,
   then drives the board's roving-tabindex rails with the keyboard only. */

test.describe('community-social', () => {
  test('explore hot board: real worker-produced ranking across all four kinds, driven by the sort and kind rails from the keyboard', async ({ browser }) => {
    const fixture = await createCommunityFixture()
    const reader = await principalContext(browser, fixture.actor)
    try {
      const queries: CommunityTargetQuery[] = [
        { kind: 'collection', id: fixture.collectionId },
        { kind: 'bookmark', id: fixture.bookmarkNodeId, collectionId: fixture.collectionId },
        { kind: 'digest_series', id: fixture.seriesId },
        { kind: 'digest_edition', id: fixture.editionId, seriesId: fixture.seriesId },
      ]
      for (const query of queries) {
        await expectCommunityTarget(query, fixture.actor.cookieValue)
        await apiResolveAndVote(query, fixture.actor, 1)
      }
      /* A comment on the collection gives the anonymous assertions below a
         real readable row. */
      await apiCreateComment(
        queries[0]!, fixture.actor, `community-social explore seed ${Date.now()}`)

      /* Durable evidence first: the worker's refresh pass must surface all
         four kinds before the browser asserts anything. */
      const wanted = new Map([
        [fixture.collectionId, { title: fixture.collectionTitle, href: `/c/${fixture.collectionSlug}` }],
        [fixture.bookmarkNodeId, {
          title: fixture.bookmarkTitle,
          href: `/r/${fixture.bookmarkNodeId}?slug=${fixture.collectionSlug}`,
        }],
        [fixture.seriesId, { title: fixture.seriesTitle, href: `/reports/${fixture.seriesSlug}` }],
        [fixture.editionId, {
          title: fixture.editionTitle,
          href: `/reports/${fixture.seriesSlug}/issues/${fixture.editionId}`,
        }],
      ])
      const snapshot = await awaitCommunityRanking((page) => {
        const ids = new Set(page.items.map((item) => item.target.id))
        return [...wanted.keys()].every((id) => ids.has(id))
      })
      for (const [id, expected] of wanted) {
        const item = snapshot.items.find((entry) => entry.target.id === id)!
        expect(item.title).toBe(expected.title)
        expect(item.href).toBe(expected.href)
        expect(item.up).toBe(1)
      }

      const page = await reader.newPage()
      await enableCommunity(page)
      await page.goto('/explore')

      /* Sort is a labelled native select (SelectMenu). Hot is the community
         ranking board and is only offered when the community flag is on. */
      const sort = page.getByTestId('explore-sort').locator('select')
      await expect(sort).toBeVisible()
      await sort.selectOption({ label: 'Hot' })
      await expect(sort).toHaveValue('hot')

      /* The Hot selection mounts the real ranking board over
         GET /api/v1/community/ranking and renders the worker snapshot rows
         in strict server order. (The transient loading frame is not
         asserted — the route can settle before the assertion attaches.) */
      const list = page.getByTestId('community-hot-board-list')
      await expect(list).toBeVisible({ timeout: 30_000 })
      const items = page.getByTestId('community-hot-board-item')
      /* The four voted targets lead the board (zero-vote candidates score
         exactly 0); ranks render strictly as positions 1..N. */
      for (const title of [...wanted.values()].map((entry) => entry.title)) {
        await expect(items.filter({ hasText: title }).first()).toBeVisible()
      }
      const ranks = await page.getByTestId('community-hot-board-rank').allTextContents()
      expect(ranks).toEqual([...Array(ranks.length).keys()].map((index) => String(index + 1)))
      const firstFour = await page.getByTestId('community-hot-board-title').allTextContents()
      expect(firstFour.slice(0, 4).sort()).toEqual([...wanted.values()].map((entry) => entry.title).sort())
      /* Each item links to the real surface path the ranking SQL emits. */
      const hrefs = await page.getByTestId('community-hot-board-title')
        .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')))
      for (const expected of wanted.values()) expect(hrefs).toContain(expected.href)

      /* The board's own kind rail is the same keyboard contract: End jumps
         to Digest issues — the filtered list then contains only edition
         rows, and the seeded edition is among them. */
      const kindRail = page.getByTestId('community-hot-board-kinds')
      const allOption = kindRail.getByRole('radio', { name: 'All' })
      await expect(allOption).toHaveAttribute('aria-checked', 'true')
      await allOption.focus()
      await page.keyboard.press('End')
      const editionsOption = kindRail.getByRole('radio', { name: 'Digest issues' })
      await expect(editionsOption).toBeFocused()
      await expect(editionsOption).toHaveAttribute('aria-checked', 'true')
      await expect(allOption).toHaveAttribute('tabindex', '-1')
      await expect(editionsOption).toHaveAttribute('tabindex', '0')
      const editionItems = page.getByTestId('community-hot-board-item')
      await expect(editionItems.filter({ hasText: fixture.editionTitle })).toBeVisible()
      for (const meta of await page.getByTestId('community-hot-board-meta').allTextContents()) {
        expect(meta).toContain('Digest issue')
      }
      /* Home returns to All; ArrowLeft steps back to Digests. */
      await page.keyboard.press('Home')
      await expect(allOption).toHaveAttribute('aria-checked', 'true')
      await expect(items.filter({ hasText: fixture.bookmarkTitle })).toBeVisible()
      await allOption.focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      const seriesOption = kindRail.getByRole('radio', { name: 'Digests' })
      await expect(seriesOption).toBeFocused()
      await expect(seriesOption).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('community-hot-board-item')
        .filter({ hasText: fixture.seriesTitle })).toBeVisible()
      for (const meta of await page.getByTestId('community-hot-board-meta').allTextContents()) {
        expect(meta).toContain('Digest')
      }

      /* Anonymous: the ranking is a publicReads route — the board still
         renders — but every write surface collapses to the sign-in CTA. */
      const anonymous = await browser.newContext()
      try {
        const anonPage = await anonymous.newPage()
        await enableCommunity(anonPage)
        await anonPage.goto('/explore')
        const anonSort = anonPage.getByTestId('explore-sort').locator('select')
        await expect(anonSort).toBeVisible()
        await anonSort.selectOption({ label: 'Hot' })
        await expect(anonSort).toHaveValue('hot')
        await expect(anonPage.getByTestId('community-hot-board-list')).toBeVisible({ timeout: 30_000 })
        await expect(anonPage.getByTestId('community-hot-board-item')
          .filter({ hasText: fixture.collectionTitle })).toBeVisible()

        await anonPage.goto(`/c/${fixture.collectionSlug}`)
        const anonUp = anonPage.getByTestId('community-vote-up')
        await expect(anonUp).toBeVisible()
        // The pill itself is the sign-in affordance: live arrows, no separate CTA.
        await expect(anonUp).toBeEnabled()
        await expect(anonUp).toHaveAttribute('title', 'Sign in to vote')
        await expect(anonPage.getByTestId('community-vote-down')).toBeEnabled()
        await expect(anonPage.getByTestId('community-vote-up-count')).toHaveText('1')
        await expect(anonPage.getByTestId('community-vote-signin')).toHaveCount(0)
        await expect(anonPage.getByTestId('community-comments-list')).toContainText('community-social explore seed')
        await anonUp.click()
        await expect(anonPage).toHaveURL(/\/login\?returnTo=/u)
        await anonPage.goBack()
        await expect(anonPage.getByTestId('community-vote-up')).toBeVisible()
        await expect(anonPage.getByTestId('community-comments-signin')).toBeVisible()
        await expect(anonPage.getByTestId('community-comments-composer')).toBeVisible()
        await expect(anonPage.getByTestId('community-comments-composer').locator('textarea')).toHaveCount(0)
        await expect(anonPage.getByTestId('community-comments-settings')).toHaveCount(0)
        await anonPage.close()
      } finally {
        await anonymous.close()
      }

      /* Anonymous writes against the real routes are refused outright —
         no session means 401 before Origin/CSRF or the body is even read. */
      const collectionView = await resolveCommunityTargetView(
        { kind: 'collection', id: fixture.collectionId }, fixture.actor.cookieValue)
      const anonymousVote = await fetch(`${REAL_STACK_WEB_BASE_URL}/api/v1/community/vote`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: REAL_STACK_WEB_BASE_URL,
          'known-command-id': crypto.randomUUID(),
        },
        body: JSON.stringify({ target: collectionView.target, value: 1 }),
      })
      expect(anonymousVote.status).toBe(401)
      const anonymousComment = await fetch(`${REAL_STACK_WEB_BASE_URL}/api/v1/community/comments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: REAL_STACK_WEB_BASE_URL,
          'known-command-id': crypto.randomUUID(),
        },
        body: JSON.stringify({ target: collectionView.target, body: 'anonymous', replyToId: null }),
      })
      expect(anonymousComment.status).toBe(401)
    } finally {
      await reader.close()
    }
  })
})
