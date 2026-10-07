import { expect, test, type Page } from '@playwright/test'

import {
  awaitCommunityInbox,
  bookmarkUrl,
  createCommunityFixture,
  editionUrl,
  enableCommunity,
  expectCommunityTarget,
  firstCommentId,
  postRootComment,
  principalContext,
  readCommunityInbox,
  rotateBookmarkUrl,
  seriesUrl,
  upvoteThroughUi,
} from './community-social-bootstrap'

/* community-social real-stack acceptance — the three non-collection target
   kinds. Every spec mints a fresh two-principal fixture through
   /community/fixture (real Better Auth sessions; bookmark + public source
   collection created through the real Product mutation API, digest rows
   seeded exactly like the vote-http integration harness). Every business
   request goes through the real page against the real API: no route
   interception, no fabricated JSON. The reply notification is produced by
   the durable `community.comment-created` outbox event consumed by the
   `community_comment_notification` worker route, so the spec awaits the
   authority inbox instead of assuming a synchronous projection.

   Honest-coverage note: the retry-button states that require a transport
   failure (`community-vote-retry`, `community-comments-retry`,
   `community-hot-board-retry`) and the flag-off `unavailable` concealment
   have no honest trigger on a healthy real deployment — the runner always
   sets KNOWN_FEATURE_COMMUNITY. The exercised retry surfaces are the real
   ones: vote generation-conflict -> refresh -> confirmed re-vote, comment
   create conflict -> refreshed resubmit, locked-area 403 -> resubmit after
   unlock, and the notification read receipt. */

const MUTATION_TIMEOUT = { timeout: 30_000 }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/* Keyboard acceptance walks the page's real tab order — a scripted
   .focus() would satisfy Enter-dispatch but proves nothing about the
   control being Tab-reachable. The bound is far above any page's chrome
   depth; exhausting it is itself the failure. */
async function tabUntilFocused(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId)
  for (let step = 0; step < 120; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Tab order never reached ${testId}`)
}

test.describe('community-social', () => {
  test('bookmark target: keyboard vote, comment thread, owner curation, reply inbox deep link, then generation conflict and refresh', async ({ browser }) => {
    const fixture = await createCommunityFixture()
    const reader = await principalContext(browser, fixture.actor)
    const owner = await principalContext(browser, fixture.target)
    try {
      await expectCommunityTarget(
        { kind: 'bookmark', id: fixture.bookmarkNodeId, collectionId: fixture.collectionId },
        fixture.actor.cookieValue)

      const page = await reader.newPage()
      const desk = await owner.newPage()
      await enableCommunity(page)
      await enableCommunity(desk)
      const url = bookmarkUrl(fixture)

      /* Loading: the comments panel mounts aria-busy while the real
         target-resolve + comment-list reads are in flight, then readies. */
      await page.goto(url)
      await expect(page.locator('[data-testid="community-comments"].community-comments--loading'))
        .toBeVisible()
      await expect(page.getByTestId('community-comments-input')).toBeVisible()

      /* Keyboard: Tab through the page's real focus order onto the upvote
         control, then activate it with Enter — a real keydown/click on the
         real button, not a .click() or .focus() shortcut. */
      const upvote = page.getByTestId('community-vote-up')
      await expect(upvote).toBeEnabled()
      const votePut = page.waitForResponse((response) => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === '/api/v1/community/vote')
      await tabUntilFocused(page, 'community-vote-up')
      await expect(upvote).toBeFocused()
      await page.keyboard.press('Enter')
      expect((await votePut).status()).toBe(200)
      await expect(upvote).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('community-vote-up-count')).toHaveText('1')

      const commentBody = `community-social bookmark root ${Date.now()}`
      const commentId = await postRootComment(page, commentBody)

      /* The owner is the collection curator: the settings surface and the
         per-comment curation controls exist only on their desk, and the
         server-declared canVote=false renders their buttons disabled. */
      await desk.goto(url)
      await expect(desk.getByTestId('community-comments-settings')).toBeVisible()
      await expect(page.getByTestId('community-comments-settings')).toHaveCount(0)
      const ownerUpvote = desk.getByTestId('community-vote-up')
      await expect(ownerUpvote).toBeVisible()
      await expect(ownerUpvote).toBeDisabled()
      await expect(ownerUpvote).toHaveAttribute('title', 'You cannot vote on this')

      await expect(desk.getByTestId(`comment-${commentId}`)).toContainText(commentBody)
      await desk.getByTestId(`comment-${commentId}-reply`).click()
      const replyBody = `community-social bookmark reply ${Date.now()}`
      await desk.getByTestId(`comment-${commentId}-input`).fill(replyBody)
      const replyPost = desk.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/community/comments')
      await desk.getByTestId(`comment-${commentId}-submit`).click()
      expect((await replyPost).status()).toBe(201)
      await desk.getByTestId(`comment-${commentId}-thread`).click()
      const replyRow = desk.locator('.community-comment-thread > li.community-comment').first()
      await expect(replyRow).toContainText(replyBody)

      /* The reader keeps their stale-generation page open on the bookmark;
         the inbox deep link runs on a second reader tab so the conflict
         segment below still holds the pre-rotation view. */
      const inboxPage = await reader.newPage()
      await enableCommunity(inboxPage)
      await inboxPage.goto('/notifications?tab=community')
      const projected = await awaitCommunityInbox(
        inboxPage, (inbox) => inbox.items.some((item) => item.preview === replyBody))
      const replyNotification = projected.items.find((item) => item.preview === replyBody)!
      expect(replyNotification.kind).toBe('comment_reply')
      expect(replyNotification.read).toBe(false)
      expect(replyNotification.href).toContain(`/r/${fixture.bookmarkNodeId}`)
      expect(replyNotification.href).toContain(`slug=${fixture.collectionSlug}`)
      expect(replyNotification.href).toContain(`#comment-${replyNotification.commentId}`)

      /* Curator hide redacts the notification preview while the row keeps
         its inbox position; the deep link still lands on the reply anchor. */
      const replyId = replyNotification.commentId
      await desk.getByTestId(`comment-${replyId}-hide`).click()
      await desk.getByRole('dialog').getByTestId('community-reason-input').fill('community-social bookmark curation')
      const curatePut = desk.waitForResponse((response) => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === `/api/v1/community/comments/${replyId}/curation`)
      await desk.getByRole('dialog').getByTestId('community-reason-submit').click()
      expect((await curatePut).status()).toBe(200)
      await expect(desk.getByTestId(`comment-${replyId}`)).toContainText('Comment hidden')

      await awaitCommunityInbox(inboxPage, (inbox) => inbox.items.some(
        (item) => item.id === replyNotification.id && item.preview === null && !item.read))
      await inboxPage.goto('/notifications?tab=community')
      const row = inboxPage.locator('[data-community-notification-item]').first()
      await expect(row).toBeVisible()
      await expect(row).toContainText('replied: Reply no longer visible')
      await expect(row).toHaveClass(/is-unread/)
      await expect(row).toHaveAttribute('aria-label', /^Unread notification:/)
      await row.locator('.result-row-title a').click()
      await expect(inboxPage).toHaveURL(new RegExp(
        `/r/${escapeRegExp(fixture.bookmarkNodeId)}\\?slug=${escapeRegExp(fixture.collectionSlug)}#comment-${escapeRegExp(replyId)}$`, 'u'))

      await inboxPage.goto('/notifications?tab=community')
      const markRead = inboxPage.locator('[data-community-notification-item]')
        .first().getByRole('button', { name: /^Mark read/ })
      const readPost = inboxPage.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/me/community-notifications/read')
      await markRead.click()
      expect((await readPost).status()).toBe(200)
      const readRow = inboxPage.locator('[data-community-notification-item]').first()
      await expect(readRow).not.toHaveClass(/is-unread/)
      await expect(readRow).toHaveAttribute('aria-label', /^Read notification:/)
      const settled = await readCommunityInbox(inboxPage)
      expect(settled.items.find((item) => item.id === replyNotification.id)?.read).toBe(true)
      expect(settled.unreadCount).toBe(0)
      await inboxPage.close()

      /* Generation fence: rotating the bookmark URL through the REAL node
         PATCH mints the next community_bookmark_generations row. The stale
         vote write 409s into the conflict surface; Refresh re-resolves to
         the new generation (the G1 vote no longer counts); the confirming
         Enter-vote then commits on G2. */
      const rotation = await rotateBookmarkUrl(
        fixture, `https://community-fixture.example.test/rotated-${Date.now()}`)
      expect(rotation.generation).toMatch(/^bm-gen-/u)

      const stalePut = page.waitForResponse((response) => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === '/api/v1/community/vote')
      await page.getByTestId('community-vote-up').click()
      expect((await stalePut).status()).toBe(409)
      const refresh = page.getByTestId('community-vote-refresh')
      await expect(refresh).toBeVisible()
      await expect(page.getByTestId('community-vote')).toContainText(
        'This target changed. Refresh to see the latest votes, then vote again.')
      await refresh.click()
      const refreshedUp = page.getByTestId('community-vote-up')
      await expect(refreshedUp).toBeEnabled(MUTATION_TIMEOUT)
      await expect(page.getByTestId('community-vote-up-count')).toHaveText('0')
      const confirmedPut = page.waitForResponse((response) => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === '/api/v1/community/vote')
      await refreshedUp.focus()
      await page.keyboard.press('Enter')
      expect((await confirmedPut).status()).toBe(200)
      await expect(page.getByTestId('community-vote-up-count')).toHaveText('1')

      /* The comment board holds the same stale generation: the write 409s
         revision_conflict, the board abandons the intent and re-resolves
         itself — the G1 thread conceals with the content it described —
         and the kept draft resubmits onto the new generation. */
      const conflictComment = `community-social post-rotation ${Date.now()}`
      await page.getByTestId('community-comments-input').fill(conflictComment)
      const conflictedPost = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/community/comments')
      await page.getByTestId('community-comments-submit').click()
      expect((await conflictedPost).status()).toBe(409)
      await expect(page.getByTestId('community-comments-input')).toBeEnabled(MUTATION_TIMEOUT)
      await expect(page.getByTestId(`comment-${commentId}`)).toHaveCount(0)
      const resubmittedPost = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/community/comments')
      await page.getByTestId('community-comments-submit').click()
      expect((await resubmittedPost).status()).toBe(201)
      const rotatedCommentId = await firstCommentId(page)
      await expect(page.getByTestId(`comment-${rotatedCommentId}`)).toContainText(conflictComment)
    } finally {
      await reader.close()
      await owner.close()
    }
  })

  test('digest series target: page vote, comment thread, owner hide and unhide curation', async ({ browser }) => {
    const fixture = await createCommunityFixture()
    const reader = await principalContext(browser, fixture.actor)
    const owner = await principalContext(browser, fixture.target)
    try {
      await expectCommunityTarget(
        { kind: 'digest_series', id: fixture.seriesId }, fixture.actor.cookieValue)

      const page = await reader.newPage()
      const desk = await owner.newPage()
      await enableCommunity(page)
      await enableCommunity(desk)
      const url = seriesUrl(fixture)

      /* The public report read is real: GET /api/v1/public-reports/:slug
         projects the seeded series, and the published edition lands in the
         archive. (The transient loading frame is not asserted — on a healthy
         local stack it can settle before the assertion attaches.) */
      await page.goto(url)
      await expect(page.getByTestId('report-series-page')).toBeVisible()
      await expect(page.getByTestId('report-issue-list')).toContainText(fixture.editionTitle)

      await upvoteThroughUi(page)
      const commentBody = `community-social series root ${Date.now()}`
      const commentId = await postRootComment(page, commentBody)

      await desk.goto(url)
      await expect(desk.getByTestId('community-comments-settings')).toBeVisible()
      await expect(page.getByTestId('community-comments-settings')).toHaveCount(0)
      await expect(desk.getByTestId(`comment-${commentId}`)).toContainText(commentBody)
      await desk.getByTestId(`comment-${commentId}-reply`).click()
      const replyBody = `community-social series reply ${Date.now()}`
      await desk.getByTestId(`comment-${commentId}-input`).fill(replyBody)
      const replyPost = desk.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/community/comments')
      await desk.getByTestId(`comment-${commentId}-submit`).click()
      expect((await replyPost).status()).toBe(201)
      await desk.getByTestId(`comment-${commentId}-thread`).click()
      const replyRow = desk.locator('.community-comment-thread > li.community-comment').first()
      await expect(replyRow).toContainText(replyBody)
      const replyId = (await replyRow.getAttribute('data-testid'))!.replace(/^comment-/u, '')

      /* Cross-actor read: the reader reloads (no live push) — the fresh
         roots page carries replyCount and the thread expands to the real
         reply. */
      await page.reload()
      await expect(page.getByTestId(`comment-${commentId}`)).toContainText(commentBody)
      await page.getByTestId(`comment-${commentId}-thread`).click()
      await expect(page.getByTestId(`comment-${replyId}`)).toContainText(replyBody)

      /* Curator hide produces the tombstone on the desk; for the reader a
         reload drops the root's visible reply count, so the thread control
         and the reply both conceal — non-curator concealment is absence. */
      await desk.getByTestId(`comment-${replyId}-hide`).click()
      await desk.getByRole('dialog').getByTestId('community-reason-input').fill('community-social series curation')
      const hidePut = desk.waitForResponse((response) => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === `/api/v1/community/comments/${replyId}/curation`)
      await desk.getByRole('dialog').getByTestId('community-reason-submit').click()
      expect((await hidePut).status()).toBe(200)
      await expect(desk.getByTestId(`comment-${replyId}`)).toContainText('Comment hidden')

      await page.reload()
      await expect(page.getByTestId(`comment-${commentId}`)).toBeVisible()
      await expect(page.getByTestId(`comment-${commentId}-thread`)).toHaveCount(0)
      await expect(page.getByTestId(`comment-${replyId}`)).toHaveCount(0)

      /* Restore brings the same row back through the curation PUT; the reader's
         next load expands the thread to the restored body. */
      await desk.getByTestId(`comment-${replyId}-unhide`).click()
      await desk.getByRole('dialog').getByTestId('community-reason-input').fill('community-social series restore')
      const unhidePut = desk.waitForResponse((response) => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === `/api/v1/community/comments/${replyId}/curation`)
      await desk.getByRole('dialog').getByTestId('community-reason-submit').click()
      expect((await unhidePut).status()).toBe(200)
      await expect(desk.getByTestId(`comment-${replyId}`)).toContainText(replyBody)

      await page.reload()
      await page.getByTestId(`comment-${commentId}-thread`).click()
      await expect(page.getByTestId(`comment-${replyId}`)).toContainText(replyBody)

      /* The reply notification deep-links into the series page's thread. */
      const projected = await awaitCommunityInbox(
        page, (inbox) => inbox.items.some((item) => item.commentId === replyId))
      const replyNotification = projected.items.find((item) => item.commentId === replyId)!
      expect(replyNotification.href).toContain(`/reports/${fixture.seriesSlug}#comment-${replyId}`)
    } finally {
      await reader.close()
      await owner.close()
    }
  })

  test('digest edition target: page vote, comment edit and author delete, anonymous read-only state', async ({ browser }) => {
    const fixture = await createCommunityFixture()
    const reader = await principalContext(browser, fixture.actor)
    const anonymous = await browser.newContext()
    try {
      await expectCommunityTarget(
        { kind: 'digest_edition', id: fixture.editionId, seriesId: fixture.seriesId },
        fixture.actor.cookieValue)

      const page = await reader.newPage()
      await enableCommunity(page)
      const url = editionUrl(fixture)

      await page.goto(url)
      await expect(page.getByTestId('report-issue-page')).toBeVisible()
      /* The edition vote control mounts only once the series projection
         resolves (the digest_edition target needs the series id). */
      await upvoteThroughUi(page)

      const commentBody = `community-social edition root ${Date.now()}`
      const commentId = await postRootComment(page, commentBody)

      /* Author manage: edit through the If-Match PATCH, then a second
         comment deleted into its tombstone through the real DELETE. */
      const editedBody = `${commentBody} (edited)`
      await page.getByTestId(`comment-${commentId}-edit`).click()
      await page.getByTestId(`comment-${commentId}-edit-input`).fill(editedBody)
      const editPatch = page.waitForResponse((response) => response.request().method() === 'PATCH'
        && new URL(response.url()).pathname === `/api/v1/community/comments/${commentId}`)
      await page.getByTestId(`comment-${commentId}-edit-submit`).click()
      expect((await editPatch).status()).toBe(200)
      await expect(page.getByTestId(`comment-${commentId}`)).toContainText(editedBody)

      await page.getByTestId('community-comments-input').fill('community-social edition transient')
      const transientPost = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/community/comments')
      await page.getByTestId('community-comments-submit').click()
      expect((await transientPost).status()).toBe(201)
      const transientId = await firstCommentId(page)
      const deleteRequest = page.waitForResponse((response) => response.request().method() === 'DELETE'
        && new URL(response.url()).pathname === `/api/v1/community/comments/${transientId}`)
      await page.getByTestId(`comment-${transientId}-delete`).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
      expect((await deleteRequest).status()).toBe(200)
      await expect(page.getByTestId(`comment-${transientId}`)).toContainText('Comment deleted')

      /* Anonymous on the same edition page: authoritative counts and the
         comment stay readable, the vote pill's arrows lead to sign-in (no
         separate CTA), comment writes collapse to the sign-in CTA, and the
         curator surface never renders. */
      const anonPage = await anonymous.newPage()
      await enableCommunity(anonPage)
      await anonPage.goto(url)
      await expect(anonPage.getByTestId('report-issue-page')).toBeVisible()
      const anonUp = anonPage.getByTestId('community-vote-up')
      await expect(anonUp).toBeVisible()
      await expect(anonUp).toBeEnabled()
      await expect(anonUp).toHaveAttribute('title', 'Sign in to vote')
      await expect(anonPage.getByTestId('community-vote-up-count')).toHaveText('1')
      await expect(anonPage.getByTestId('community-vote-signin')).toHaveCount(0)
      await expect(anonPage.getByTestId(`comment-${commentId}`)).toContainText(editedBody)
      await expect(anonPage.getByTestId('community-comments-signin')).toBeVisible()
      await expect(anonPage.getByTestId('community-comments-composer')).toBeVisible()
      await expect(anonPage.getByTestId('community-comments-composer').locator('textarea')).toHaveCount(0)
      await expect(anonPage.getByTestId('community-comments-settings')).toHaveCount(0)
      await expect(anonPage.getByTestId(`comment-${commentId}-hide`)).toHaveCount(0)
      await anonPage.close()
    } finally {
      await reader.close()
      await anonymous.close()
    }
  })

  test('comment-area lock: a curator lock rejects the reader write with the real 403, then unlock restores it', async ({ browser }) => {
    const fixture = await createCommunityFixture()
    const reader = await principalContext(browser, fixture.actor)
    const owner = await principalContext(browser, fixture.target)
    try {
      const page = await reader.newPage()
      const desk = await owner.newPage()
      await enableCommunity(page)
      await enableCommunity(desk)
      const url = seriesUrl(fixture)

      /* The curator locks the area through the settings ETag write. The
         lock copy and the disabled composer render only on the curator
         desk — a non-curator never learns the lock from the UI. */
      await desk.goto(url)
      await expect(desk.getByTestId('community-comments-settings')).toBeVisible()
      await desk.getByTestId('community-comments-lock').click()
      await desk.getByRole('dialog').getByTestId('community-reason-input').fill('community-social moderation')
      const lockPut = desk.waitForResponse((response) => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === '/api/v1/community/comment-settings')
      await desk.getByRole('dialog').getByTestId('community-reason-submit').click()
      expect((await lockPut).status()).toBe(200)
      await expect(desk.getByTestId('community-comments-locked'))
        .toContainText('Comments are locked: community-social moderation')
      await expect(desk.getByTestId('community-comments-input')).toBeDisabled()

      /* The reader's composer still renders enabled; the write reaches the
         real route and fails 403 insufficient_permission — the locked
         surface reports the server message, not a hidden rule. */
      await page.goto(url)
      await expect(page.getByTestId('community-comments-settings')).toHaveCount(0)
      await expect(page.getByTestId('community-comments-input')).toBeEnabled()
      const lockedBody = `community-social locked write ${Date.now()}`
      await page.getByTestId('community-comments-input').fill(lockedBody)
      const deniedPost = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/community/comments')
      await page.getByTestId('community-comments-submit').click()
      expect((await deniedPost).status()).toBe(403)
      await expect(page.getByTestId('community-comments-error'))
        .toContainText('Comments are locked for this target.')

      /* Unlock through the same ETag path; the kept draft resubmits and
         lands — the lock cycle is the real error/retry surface. */
      await desk.getByTestId('community-comments-lock').click()
      await desk.getByRole('dialog').getByTestId('community-reason-input').fill('community-social reopen')
      const unlockPut = desk.waitForResponse((response) => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === '/api/v1/community/comment-settings')
      await desk.getByRole('dialog').getByTestId('community-reason-submit').click()
      expect((await unlockPut).status()).toBe(200)
      await expect(desk.getByTestId('community-comments-locked')).toHaveCount(0)

      const retriedPost = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/community/comments')
      await page.getByTestId('community-comments-submit').click()
      expect((await retriedPost).status()).toBe(201)
      const commentId = await firstCommentId(page)
      await expect(page.getByTestId(`comment-${commentId}`)).toContainText(lockedBody)
    } finally {
      await reader.close()
      await owner.close()
    }
  })
})
