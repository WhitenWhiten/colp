import { expect, test } from '@playwright/test'

import {
  awaitCommunityInbox,
  createCommunityFixture,
  enableCommunity,
  expectCommunityTarget,
  firstCommentId,
  postRootComment,
  principalContext,
  readCommunityInbox,
  upvoteThroughUi,
} from './community-social-bootstrap'

/* community-social real-stack acceptance — the collection target kind. Two
   REAL Better Auth principals minted by /community/fixture: `target` owns
   the published public collection, `actor` is the reader. Every business
   request goes through the real page against the real API: no route
   interception, no fabricated JSON. The reply notification is produced by
   the durable `community.comment-created` outbox event consumed by the
   `community_comment_notification` worker route, so the spec awaits the
   authority inbox (read through the same /api/v1 session the page uses)
   instead of assuming a synchronous projection. */

test.describe('community-social', () => {
  test('vote, comment thread, author/owner manage, and the reply-notification inbox on a real public collection', async ({ browser }) => {
    const fixture = await createCommunityFixture()
    const reader = await principalContext(browser, fixture.actor)
    const owner = await principalContext(browser, fixture.target)
    try {
      /* Deployment gate: the community routes exist only while
         KNOWN_FEATURE_COMMUNITY is on — the real-stack runner always sets
         it, so a 404 here is a product/configuration failure, never a skip. */
      await expectCommunityTarget(
        { kind: 'collection', id: fixture.collectionId }, fixture.actor.cookieValue)

      const page = await reader.newPage()
      const desk = await owner.newPage()
      await enableCommunity(page)
      await enableCommunity(desk)
      const collectionUrl = `/c/${fixture.collectionSlug}`

      // Reader lands on the public collection and upvotes through the control.
      await page.goto(collectionUrl)
      await upvoteThroughUi(page)

      // Reader posts a root comment through the durable create command.
      const commentBody = `community-social root ${Date.now()}`
      const commentId = await postRootComment(page, commentBody)

      // The owner reads the same thread and replies to the reader's comment —
      // the reply is what produces the reader's comment_reply notification.
      await desk.goto(collectionUrl)
      await expect(desk.getByTestId(`comment-${commentId}`)).toContainText(commentBody)
      await desk.getByTestId(`comment-${commentId}-reply`).click()
      const replyBody = `community-social reply ${Date.now()}`
      await desk.getByTestId(`comment-${commentId}-input`).fill(replyBody)
      const replyPost = desk.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/community/comments')
      await desk.getByTestId(`comment-${commentId}-submit`).click()
      expect((await replyPost).status()).toBe(201)
      await desk.getByTestId(`comment-${commentId}-thread`).click()
      const replyRow = desk.locator('.community-comment-thread > li.community-comment').first()
      await expect(replyRow).toContainText(replyBody)

      // Author manage: the reader edits their own comment through the If-Match
      // PATCH, then a second comment is deleted into a tombstone.
      const editedBody = `${commentBody} (edited)`
      await page.getByTestId(`comment-${commentId}-edit`).click()
      await page.getByTestId(`comment-${commentId}-edit-input`).fill(editedBody)
      const editPatch = page.waitForResponse((response) => response.request().method() === 'PATCH'
        && new URL(response.url()).pathname === `/api/v1/community/comments/${commentId}`)
      await page.getByTestId(`comment-${commentId}-edit-submit`).click()
      expect((await editPatch).status()).toBe(200)
      await expect(page.getByTestId(`comment-${commentId}`)).toContainText(editedBody)

      await page.getByTestId('community-comments-input').fill('community-social transient')
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

      // Owner manage: the curator surface (settings + per-comment curation)
      // exists only for the target owner — the reader never sees it. Hiding
      // the reply redacts the notification preview while the row keeps its
      // position.
      await expect(desk.getByTestId('community-comments-settings')).toBeVisible()
      await expect(page.getByTestId('community-comments-settings')).toHaveCount(0)
      const projected = await awaitCommunityInbox(
        page, (inbox) => inbox.items.some((item) => item.preview === replyBody))
      const replyNotification = projected.items.find((item) => item.preview === replyBody)!
      expect(replyNotification.kind).toBe('comment_reply')
      expect(replyNotification.read).toBe(false)
      expect(replyNotification.href).toContain(`#comment-${replyNotification.commentId}`)

      const replyId = replyNotification.commentId
      await desk.getByTestId(`comment-${replyId}-hide`).click()
      await desk.getByRole('dialog').getByTestId('community-reason-input').fill('community-social curation')
      const curatePut = desk.waitForResponse((response) => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === `/api/v1/community/comments/${replyId}/curation`)
      await desk.getByRole('dialog').getByTestId('community-reason-submit').click()
      expect((await curatePut).status()).toBe(200)
      await expect(desk.getByTestId(`comment-${replyId}`)).toContainText('Comment hidden')

      // The Community tab of the real inbox: the redacted row keeps its
      // position, the deep link lands on the thread anchor, and the receipted
      // bulk read drops the authority unread count.
      await awaitCommunityInbox(page, (inbox) => inbox.items.some(
        (item) => item.id === replyNotification.id && item.preview === null && !item.read))
      await page.goto('/notifications?tab=community')
      const row = page.locator('[data-community-notification-item]').first()
      await expect(row).toBeVisible()
      await expect(row).toContainText('replied: Reply no longer visible')
      await expect(row).toHaveClass(/is-unread/)
      await expect(row).toHaveAttribute('aria-label', /^Unread notification:/)
      await row.locator('.result-row-title a').click()
      await expect(page).toHaveURL(new RegExp(
        `${collectionUrl.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}#comment-${replyId}$`, 'u'))

      await page.goto('/notifications?tab=community')
      const markRead = page.locator('[data-community-notification-item]')
        .first().getByRole('button', { name: /^Mark read/ })
      const readPost = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/me/community-notifications/read')
      await markRead.click()
      expect((await readPost).status()).toBe(200)
      const readRow = page.locator('[data-community-notification-item]').first()
      await expect(readRow).not.toHaveClass(/is-unread/)
      await expect(readRow).toHaveAttribute('aria-label', /^Read notification:/)
      const settled = await readCommunityInbox(page)
      expect(settled.items.find((item) => item.id === replyNotification.id)?.read).toBe(true)
      expect(settled.unreadCount).toBe(0)
    } finally {
      await reader.close()
      await owner.close()
    }
  })
})
