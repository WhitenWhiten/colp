/* CS-03 community comments panel. Mounts on every commentable surface
   (collection, bookmark detail, digest series, digest issue) below the vote
   control. It resolves the live target itself (generation + canComment come
   from the same CS-01 authority as the vote control), lists root comments
   createdAt DESC with cursor paging, lazily expands each root's flattened
   replies createdAt ASC, and posts roots/replies through the durable create
   command. Anonymous visitors read the full thread plus a sign-in CTA.
   Tombstones (deleted/hidden) render in place with no body; the panel
   conceals itself entirely when the feature is unexposed or the target
   cannot be resolved (uniform concealment).

   CS-04 adds the management surface: authors edit/delete their own
   comments (canEdit/canDelete), target curators hide/unhide individual
   comments and lock/unlock the whole comment area (canCurate +
   canCurateComments). Every manage write is conditional on its own ETag
   authority inside useCommunityComments; a 412 refreshes the projection
   and asks the user to review-and-retry. The settings/lock surface is
   curator-only — non-curators never see it.

   Content-governance: a signed-in reader can report a visible comment
   through the same ReportContentDialog as collections. Tombstones and
   anonymous visitors have no report entry. */
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { isCommunityExposureEnabled, isLive } from '../api'
import type { CommunityComment, CommunityTargetQuery } from '../api'
import { useAuth } from '../auth/AuthContext'
import { formatDateTime } from '../lib/formatDate'
import { profileInitials } from '../lib/initials'
import { formatRelativeTime } from '../lib/relativeTime'
import { plural } from '../lib/plural'
import { useCommunityComments } from '../lib/useCommunityComments'
import { useNearViewport } from '../lib/useNearViewport'
import { AvatarImage } from './AvatarImage'
import { CommunityCharCounter } from './CommunityCharCounter'
import { CommunityReasonModal } from './CommunityReasonModal'
import { useConfirm } from './ConfirmModal'
import { Icon } from './Icon'
import { LoadMoreButton } from './LoadMoreButton'
import { ReportContentDialog } from './ReportContentDialog'

export function CommunityComments({ query, enabled = true, className, testId = 'community-comments' }: {
  /** Target selector for the surface; null keeps the panel hidden. */
  query: CommunityTargetQuery | null
  /** Page-level gate (e.g. wait for the series projection on issue pages). */
  enabled?: boolean
  className?: string
  testId?: string
}) {
  const { user, isLoggedIn, bootstrapping } = useAuth()
  const confirm = useConfirm()
  const exposed = isCommunityExposureEnabled()
  /* R15-29: the thread sits far below the fold; read it only as it nears
     the viewport, unless a #comment- deep link is waiting for it. */
  const { hash } = useLocation()
  const [sentinelRef, near] = useNearViewport(hash.startsWith('#comment-'))
  const canResolve = exposed && enabled && !bootstrapping && query !== null && near
  const board = useCommunityComments({ query: canResolve ? query : null, enabled: canResolve })
  const [draft, setDraft] = useState('')
  const [replyDraft, setReplyDraft] = useState<{ id: string; text: string } | null>(null)
  const [editDraft, setEditDraft] = useState<{ id: string; text: string } | null>(null)
  const [curateTarget, setCurateTarget] = useState<{ comment: CommunityComment; hidden: boolean } | null>(null)
  const [lockTarget, setLockTarget] = useState<boolean | null>(null)
  const [reportCommentId, setReportCommentId] = useState<string | null>(null)

  if (!exposed || !enabled || !query || bootstrapping) return null
  if (!near) return <div ref={sentinelRef} data-comments-sentinel aria-hidden="true" />
  if (board.status === 'unavailable') return null

  const rootClass = `community-comments${className ? ` ${className}` : ''}`

  if (board.status === 'loading') {
    return (
      <section className={`${rootClass} community-comments--loading`} data-testid={testId} aria-busy="true">
        <h2 className="community-comments-title">Comments</h2>
        <p className="community-comments-note" role="status">Loading comments…</p>
      </section>
    )
  }

  if (board.status === 'error') {
    return (
      <section className={rootClass} data-testid={testId}>
        <h2 className="community-comments-title">Comments</h2>
        <p className="community-comments-note" role="alert">{board.error ?? "Couldn't load comments."}</p>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid={`${testId}-retry`}
          onClick={() => board.reload()}
        >
          Try again
        </button>
      </section>
    )
  }

  const view = board.view
  const canComment = isLoggedIn && view?.canComment === true
  // R15-11: every visitor gets a report path; the dialog offers guests
  // sign-in or email.
  const reportButton = (comment: CommunityComment) => (
    comment.state === 'visible' ? (
      <button
        type="button"
        className="community-comment-action"
        data-testid={`comment-${comment.id}-report`}
        onClick={() => setReportCommentId(comment.id)}
      >
        Report
      </button>
    ) : null
  )
  /* A locked area rejects new comments for everyone; the settings copy is
     curator-only, so curators see the lock notice + unlock control while a
     non-curator instead reads canComment=false with a commentDeniedReason
     on the target view (R14-36). */
  const areaLocked = board.settings?.locked === true
  /* The contract caps bodies at 4000 Unicode code points; count with the
     spread iterator so astral characters count once (maxLength would count
     UTF-16 code units and silently cap emoji text short of the limit). */
  const draftCount = [...draft].length
  const replyDraftCount = [...(replyDraft?.text ?? '')].length
  const editDraftCount = [...(editDraft?.text ?? '')].length
  /* Curation and lock reasons cap at 1000 code points; the prompt enforces it. */

  const submit = async (body: string, replyToId: string | null) => {
    const comment = await board.create(body, replyToId)
    if (comment !== null) {
      if (replyToId === null) setDraft('')
      else setReplyDraft(null)
    }
  }

  const submitEdit = async (comment: CommunityComment, body: string) => {
    const updated = await board.edit(comment, body)
    if (updated !== null) setEditDraft(null)
  }

  const submitCurate = async (comment: CommunityComment, hidden: boolean, reason: string) => {
    const ok = await board.curate(comment, hidden, reason)
    if (ok) setCurateTarget(null)
  }

  const submitLock = async (locked: boolean, reason: string) => {
    const ok = await board.setAreaLocked(locked, reason)
    if (ok) setLockTarget(null)
  }

  const submitDelete = async (comment: CommunityComment) => {
    if (!(await confirm({ title: 'Delete this comment?', confirmLabel: 'Delete' }))) return
    await board.remove(comment)
  }

  /* CS-04 per-comment manage controls: author Edit/Delete on visible
     comments, curator Hide on visible and Restore on hidden tombstones.
     They share the comment's action row with Reply/Report; the curation
     decisions open the shared reason prompt. Nothing renders for a viewer
     without the capability flags (uniform concealment). */
  const manageButtons = (comment: CommunityComment) => {
    const editing = editDraft?.id === comment.id
    const editable = comment.state === 'visible'
    return (
      <>
        {comment.canEdit && editable ? (
          <button
            type="button"
            className="community-comment-action"
            data-testid={`comment-${comment.id}-edit`}
            aria-expanded={editing}
            onClick={() => setEditDraft(editing ? null : { id: comment.id, text: comment.body ?? '' })}
          >
            Edit
          </button>
        ) : null}
        {comment.canDelete && editable ? (
          <button
            type="button"
            className="community-comment-action"
            data-testid={`comment-${comment.id}-delete`}
            disabled={board.managePending}
            onClick={() => void submitDelete(comment)}
          >
            Delete
          </button>
        ) : null}
        {comment.canCurate && comment.state === 'visible' ? (
          <button
            type="button"
            className="community-comment-action"
            data-testid={`comment-${comment.id}-hide`}
            aria-haspopup="dialog"
            onClick={() => setCurateTarget({ comment, hidden: true })}
          >
            Hide
          </button>
        ) : null}
        {comment.canCurate && comment.state === 'hidden' ? (
          <button
            type="button"
            className="community-comment-action"
            data-testid={`comment-${comment.id}-unhide`}
            aria-haspopup="dialog"
            onClick={() => setCurateTarget({ comment, hidden: false })}
          >
            Restore
          </button>
        ) : null}
      </>
    )
  }

  /* The edit composer opens in place inside the comment body (it authors
     content) — the same .community-composer container every editor uses. */
  const editForm = (comment: CommunityComment) => editDraft?.id === comment.id ? (
    <form
      className="community-comments-composer community-composer"
      data-testid={`comment-${comment.id}-edit-form`}
      onSubmit={(event) => {
        event.preventDefault()
        const text = (editDraft?.text ?? '').trim()
        if (text.length === 0 || editDraftCount > COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS) return
        void submitEdit(comment, text)
      }}
    >
      <span className="avatar community-composer-avatar" aria-hidden>
        <AvatarImage url={user?.avatarUrl} initials={user?.initials ?? ''} />
      </span>
      <textarea
        className="community-comments-input"
        data-testid={`comment-${comment.id}-edit-input`}
        value={editDraft?.text ?? ''}
        rows={2}
        placeholder="Edit comment"
        aria-label="Edit comment"
        autoFocus
        onChange={(event) => setEditDraft({ id: comment.id, text: event.target.value })}
        disabled={board.managePending}
      />
      <div className="community-composer-foot">
        <CommunityCharCounter count={editDraftCount} max={COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS} testId={`comment-${comment.id}-edit-count`} />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid={`comment-${comment.id}-edit-cancel`}
          onClick={() => setEditDraft(null)}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          data-testid={`comment-${comment.id}-edit-submit`}
          disabled={board.managePending || (editDraft?.text ?? '').trim().length === 0
            || editDraftCount > COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS}
        >
          {board.managePending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  ) : null

  /* Reply composer: the same .community-composer container, flagged
     --reply for its top margin under the comment. */
  const replyForm = (comment: CommunityComment) => replyDraft?.id === comment.id ? (
    <form
      className="community-comments-composer community-composer community-comments-composer--reply"
      data-testid={`comment-${comment.id}-composer`}
      onSubmit={(event) => {
        event.preventDefault()
        const text = (replyDraft?.text ?? '').trim()
        if (text.length === 0 || replyDraftCount > COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS) return
        void submit(text, comment.id)
      }}
    >
      <span className="avatar community-composer-avatar" aria-hidden>
        <AvatarImage url={user?.avatarUrl} initials={user?.initials ?? ''} />
      </span>
      <textarea
        className="community-comments-input"
        data-testid={`comment-${comment.id}-input`}
        value={replyDraft?.text ?? ''}
        rows={2}
        placeholder="Write a reply…"
        aria-label="Write a reply"
        autoFocus
        onChange={(event) => setReplyDraft({ id: comment.id, text: event.target.value })}
        disabled={board.pending}
      />
      <div className="community-composer-foot">
        <CommunityCharCounter count={replyDraftCount} max={COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS} testId={`comment-${comment.id}-count`} />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setReplyDraft(null)}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          data-testid={`comment-${comment.id}-submit`}
          disabled={board.pending || (replyDraft?.text ?? '').trim().length === 0
            || replyDraftCount > COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS}
        >
          {board.pending ? 'Posting…' : 'Reply'}
        </button>
      </div>
    </form>
  ) : null

  return (
    <section className={rootClass} data-testid={testId}>
      <h2 className="community-comments-title">
        Comments
        {board.roots.length > 0 ? (
          <span className="community-comments-count">{board.roots.length}{board.nextCursor !== null ? '+' : ''}</span>
        ) : null}
      </h2>
      {board.message ? <span className="visually-hidden" aria-live="polite">{board.message}</span> : null}
      {/* CS-04: write outcomes (posted, updated, hidden, restored, locked…)
          were announced to assistive tech only, while the vote control shows
          its equivalent line visibly. Hard errors keep their own alert, so
          the guard stops the two rendering the same string twice. */}
      {board.outcome !== null && board.error === null ? (
        <p className="community-comments-note" role="status" data-testid={`${testId}-outcome`}>{board.outcome}</p>
      ) : null}

      {/* CS-04: a failed curator settings read is reported, not hidden —
          the lock controls stay absent until a successful read returns. */}
      {view?.canCurateComments === true && board.settings === null && board.settingsError !== null ? (
        <p className="community-comments-note" role="alert" data-testid={`${testId}-settings-error`}>
          {board.settingsError}
        </p>
      ) : null}

      {board.settings !== null ? (
        <div
          className={`community-comments-settings${areaLocked ? ' community-comments-settings--locked' : ''}`}
          data-testid={`${testId}-settings`}
        >
          {areaLocked ? (
            <p className="community-comments-note" role="status" data-testid={`${testId}-locked`}>
              <Icon name="lock" />
              Comments are locked{board.settings.reason !== null ? `: ${board.settings.reason}` : ''}
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid={`${testId}-lock`}
            aria-haspopup="dialog"
            disabled={board.managePending}
            onClick={() => setLockTarget(!areaLocked)}
          >
            {areaLocked ? 'Unlock comments' : 'Lock comments'}
          </button>
        </div>
      ) : null}

      {canComment ? (
        <form
          className="community-comments-composer community-composer"
          data-testid={`${testId}-composer`}
          onSubmit={(event) => {
            event.preventDefault()
            const text = draft.trim()
            if (text.length === 0 || draftCount > COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS) return
            void submit(text, null)
          }}
        >
          <span className="avatar community-composer-avatar" aria-hidden>
            <AvatarImage url={user?.avatarUrl} initials={user?.initials ?? ''} />
          </span>
          <textarea
            className="community-comments-input"
            data-testid={`${testId}-input`}
            value={draft}
            rows={2}
            placeholder="Write a comment…"
            aria-label="Write a comment"
            onChange={(event) => setDraft(event.target.value)}
            disabled={board.pending || areaLocked}
          />
          <div className="community-composer-foot">
            <CommunityCharCounter count={draftCount} max={COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS} testId={`${testId}-count`} />
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              data-testid={`${testId}-submit`}
              disabled={board.pending || areaLocked || draft.trim().length === 0
                || draftCount > COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS}
            >
              {board.pending ? 'Posting…' : 'Post'}
            </button>
          </div>
        </form>
      ) : isLoggedIn ? (
        /* R14-36: a signed-in viewer who cannot comment sees why instead of
           an empty space. Curators on a locked area already have the lock
           notice + unlock control above, so the generic note stays hidden
           for them. Unknown/newer reasons fall back to a neutral line. */
        areaLocked ? null : (
          <p className="community-comments-note" data-testid={`${testId}-denied`}>
            {view?.commentDeniedReason === 'locked'
              ? 'Comments are locked for this discussion.'
              : "Commenting isn't available right now."}
          </p>
        )
      ) : (
        /* Anonymous readers get the same composer frame: the input area is a
           placeholder line and the only foot action is the sign-in link.
           Same-origin path only, matching the safeReturnTo convention on
           /login. */
        <div className="community-comments-composer community-composer community-composer--guest" data-testid={`${testId}-composer`}>
          <span className="avatar community-composer-avatar community-composer-avatar--guest" aria-hidden>
            <Icon name="person" />
          </span>
          <p className="community-composer-placeholder">Sign in to join the discussion</p>
          <div className="community-composer-foot">
            <Link
              to={`/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`}
              className="btn btn-primary btn-sm community-comments-cta"
              data-testid={`${testId}-signin`}
            >
              Sign in
            </Link>
          </div>
        </div>
      )}

      {board.error ? (
        <p className="community-comments-note" role="alert" data-testid={`${testId}-error`}>{board.error}</p>
      ) : null}

      {board.roots.length === 0 && canComment && !areaLocked ? (
        <p className="community-comments-note community-comments-empty" data-testid={`${testId}-empty`}>Be the first to comment.</p>
      ) : null}
      <ol className="community-comments-list" data-testid={`${testId}-list`}>
        {board.roots.map((comment) => {
          const thread = board.replies.get(comment.id)
          const expanded = thread?.expanded === true
          const replying = replyDraft?.id === comment.id
          return (
            <li key={comment.id} id={`comment-${comment.id}`} className={commentClass(comment)} data-testid={`comment-${comment.id}`}>
              <CommentAvatar comment={comment} />
              <div className="community-comment-body">
                <CommentHead comment={comment} />
                <CommentText comment={comment} />
                {(canComment && comment.state === 'visible') || comment.replyCount > 0 || reportButton(comment) !== null
                  || hasManage(comment) ? (
                  <div className="community-comment-actions">
                    {canComment && comment.state === 'visible' ? (
                      <button
                        type="button"
                        className="community-comment-action community-comment-action--primary"
                        data-testid={`comment-${comment.id}-reply`}
                        aria-expanded={replying}
                        onClick={() => setReplyDraft(replying ? null : { id: comment.id, text: '' })}
                      >
                        <Icon name="chat" />
                        Reply
                      </button>
                    ) : null}
                    {comment.replyCount > 0 ? (
                      <button
                        type="button"
                        className="community-comment-action community-comment-action--thread"
                        data-testid={`comment-${comment.id}-thread`}
                        aria-expanded={expanded}
                        onClick={() => board.toggleReplies(comment.id)}
                      >
                        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
                        {expanded ? 'Hide replies' : `${plural(comment.replyCount, 'reply', 'replies')}`}
                      </button>
                    ) : null}
                    {reportButton(comment)}
                    {manageButtons(comment)}
                  </div>
                ) : null}
                {editForm(comment)}
                {replyForm(comment)}
                {expanded ? (
                  <ol className="community-comment-thread" data-testid={`comment-${comment.id}-replies`}>
                    {(thread?.items ?? []).map((reply) => (
                      <li key={reply.id} id={`comment-${reply.id}`} className={`${commentClass(reply)} community-comment--depth-${reply.depth}`} data-testid={`comment-${reply.id}`}>
                        <CommentAvatar comment={reply} />
                        <div className="community-comment-body">
                          <CommentHead
                            comment={reply}
                            replyingTo={reply.depth >= 2
                              ? (thread?.items ?? []).find((item) => item.id === reply.replyToId)?.author.displayName
                              : undefined}
                          />
                          <CommentText comment={reply} />
                          {reply.state === 'visible' || hasManage(reply) ? (
                            <div className="community-comment-actions">
                              {canComment && reply.state === 'visible' && reply.depth < 2 ? (
                                <button
                                  type="button"
                                  className="community-comment-action community-comment-action--primary"
                                  data-testid={`comment-${reply.id}-reply`}
                                  aria-expanded={replyDraft?.id === reply.id}
                                  onClick={() => setReplyDraft(replyDraft?.id === reply.id ? null : { id: reply.id, text: '' })}
                                >
                                  <Icon name="chat" />
                                  Reply
                                </button>
                              ) : null}
                              {reportButton(reply)}
                              {manageButtons(reply)}
                            </div>
                          ) : null}
                          {editForm(reply)}
                          {replyForm(reply)}
                        </div>
                      </li>
                    ))}
                    {thread?.loading ? (
                      <li className="community-comments-note" role="status">Loading replies…</li>
                    ) : null}
                    {thread?.error ? (
                      <li className="community-comments-note" role="alert">{thread.error}</li>
                    ) : null}
                    {thread?.nextCursor ? (
                      <li className="community-comment-thread-more">
                        <LoadMoreButton
                          className="community-comment-action community-comment-action--thread"
                          loading={thread.loadingMore}
                          onClick={() => board.loadMoreReplies(comment.id)}
                          status="Loading more replies"
                          data-testid={`comment-${comment.id}-replies-more`}
                        >
                          <Icon name="chevron-down" />
                          More replies
                        </LoadMoreButton>
                      </li>
                    ) : null}
                  </ol>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
      {board.nextCursor !== null ? (
        <LoadMoreButton
          className="btn btn-secondary btn-sm community-comments-more"
          loading={board.loadingMore}
          onClick={() => board.loadMore()}
          status="Loading more comments"
          data-testid={`${testId}-more`}
        >
          More comments
        </LoadMoreButton>
      ) : null}
      <CommunityReasonModal
        open={curateTarget !== null}
        title={curateTarget?.hidden === true ? 'Hide this comment?' : 'Restore this comment?'}
        confirmLabel={curateTarget?.hidden === true ? 'Hide' : 'Restore'}
        reasonLabel={curateTarget?.hidden === true ? 'Reason for hiding' : 'Reason for restoring'}
        pending={board.managePending}
        onSubmit={(reason) => {
          if (curateTarget !== null) void submitCurate(curateTarget.comment, curateTarget.hidden, reason)
        }}
        onClose={() => setCurateTarget(null)}
      />
      <CommunityReasonModal
        open={lockTarget !== null}
        title={lockTarget === true ? 'Lock comments?' : 'Unlock comments?'}
        confirmLabel={lockTarget === true ? 'Lock comments' : 'Unlock comments'}
        reasonLabel={lockTarget === true ? 'Reason for locking' : 'Reason for unlocking'}
        pending={board.managePending}
        onSubmit={(reason) => {
          if (lockTarget !== null) void submitLock(lockTarget, reason)
        }}
        onClose={() => setLockTarget(null)}
      />
      {reportCommentId !== null ? (
        <ReportContentDialog
          target={{ kind: 'comment', id: reportCommentId }}
          label="this comment"
          onClose={() => setReportCommentId(null)}
        />
      ) : null}
    </section>
  )
}

const COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS = 4_000

/** Whether a viewer holds any manage capability on the comment — keeps an
    otherwise-empty action row from rendering for plain readers. */
function hasManage(comment: CommunityComment): boolean {
  return (comment.state === 'visible' && (comment.canEdit === true || comment.canDelete === true || comment.canCurate === true))
    || (comment.state === 'hidden' && comment.canCurate === true)
}

function CommentAvatar({ comment }: { readonly comment: CommunityComment }) {
  return (
    <span className="avatar community-comment-avatar" aria-hidden>
      <AvatarImage
        url={comment.author.avatarUrl}
        initials={profileInitials(comment.author.displayName, comment.author.handle ?? '')}
      />
    </span>
  )
}

/** Tombstones dim their avatar through a modifier on the row itself. */
function commentClass(comment: CommunityComment): string {
  return `community-comment${comment.state === 'visible' ? '' : ' community-comment--tombstone'}`
}

/* Depth-2 replies name their parent inline after the author (the thread is
   flattened, so the arrow is what shows who is being answered). */
function CommentHead({ comment, replyingTo }: {
  readonly comment: CommunityComment
  readonly replyingTo?: string
}) {
  return (
    <div className="community-comment-head">
      <span
        className="community-comment-author"
        data-testid={`comment-${comment.id}-author`}
        title={comment.author.handle
          ? `${comment.author.displayName} (@${comment.author.handle})`
          : comment.author.displayName}
      >
        {comment.author.displayName}
      </span>
      {replyingTo !== undefined ? (
        <span className="community-comment-replying" title={replyingTo}>
          <Icon name="arrow-right" />
          <span className="visually-hidden">replying to </span>
          {replyingTo}
        </span>
      ) : null}
      {/* Dot and time wrap as one unit so a long name never strands the dot. */}
      <span className="community-comment-when">
        <span className="dot-sep" aria-hidden />
        <time
          className="community-comment-time"
          dateTime={comment.createdAt}
          title={formatDateTime(comment.createdAt)}
          aria-label={formatDateTime(comment.createdAt)}
        >
          {formatRelativeTime(comment.createdAt)}
        </time>
      </span>
    </div>
  )
}

function CommentText({ comment }: { readonly comment: CommunityComment }) {
  const tombstone = comment.state !== 'visible'
  return (
    <p className={`community-comment-text${tombstone ? ' community-comment-text--tombstone' : ''}`}>
      {tombstone
        ? (comment.state === 'deleted' ? 'Comment deleted' : 'Comment hidden')
        : comment.body}
    </p>
  )
}
