/* CS-02 community hot board. Renders the durable hot-v1 ranking
   (GET /api/v1/community/ranking) in strict server order — items are
   appended verbatim, never re-sorted client-side. The board is one stable
   control across states (loading / empty / error / unavailable) matching
   the CommunityVoteControl convention; when the community surface is not
   exposed it renders nothing so flag-off pages carry no stub. */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  isCommunityExposureEnabled,
  type CommunityRankingQueryParams,
  type CommunityTargetKind,
} from '../api'
import { useCommunityRanking } from '../lib/useCommunityRanking'
import { plural } from '../lib/plural'
import { EmptyState, LoadingState } from './EmptyState'
import { FilterRail } from './FilterRail'
import { LoadMoreButton } from './LoadMoreButton'

type BoardKind = 'all' | CommunityTargetKind

const KIND_OPTIONS: { value: BoardKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'collection', label: 'Collections' },
  { value: 'bookmark', label: 'Bookmarks' },
  { value: 'digest_series', label: 'Digests' },
  { value: 'digest_edition', label: 'Digest issues' },
]

const KIND_LABEL: Record<CommunityTargetKind, string> = {
  collection: 'Collection',
  bookmark: 'Bookmark',
  digest_series: 'Digest',
  digest_edition: 'Digest issue',
}

export function CommunityHotBoard({ tag, language, limit = 24, testId = 'community-hot-board' }: {
  /** Exact normalized topic tag forwarded from the host filter rail. */
  tag?: string
  language?: string
  limit?: number
  testId?: string
}) {
  const exposed = isCommunityExposureEnabled()
  const [kind, setKind] = useState<BoardKind>('all')
  const query: CommunityRankingQueryParams = {
    ...(kind === 'all' ? {} : { kind }),
    ...(tag ? { tag } : {}),
    ...(language ? { language } : {}),
    limit,
  }
  const board = useCommunityRanking(query)

  if (!exposed) return null

  if (board.unavailable) {
    return (
      <EmptyState
        className="empty-state--board"
        icon="compass"
        title="Hot ranking is not available yet"
        description="Sort by Recent or Popular instead."
        data-testid={testId}
      />
    )
  }

  return (
    <section className="community-hot-board" data-testid={testId} aria-label="Community hot ranking">
      <FilterRail
        className="view-switch"
        variant="segments"
        label="Ranking kind"
        testId={`${testId}-kinds`}
        value={kind}
        options={KIND_OPTIONS}
        onChange={setKind}
      />

      {board.error && board.items.length === 0 ? (
        <EmptyState
          className="empty-state--board"
          role="alert"
          icon="alert"
          title="Couldn't load the hot ranking"
          description={board.error}
          action={
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid={`${testId}-retry`}
              onClick={board.reload}
            >
              Try again
            </button>
          }
        />
      ) : board.loading && board.items.length === 0 ? (
        <LoadingState label="Loading hot ranking…" data-testid={`${testId}-loading`} />
      ) : board.items.length === 0 ? (
        <EmptyState
          className="empty-state--board"
          icon="search"
          title="Nothing is hot yet"
          description="Votes from the community will surface collections, bookmarks, and digests here."
          data-testid={`${testId}-empty`}
        />
      ) : (
        <>
          <ol className="community-hot-list" data-testid={`${testId}-list`}>
            {board.items.map((item, index) => (
              <li
                className="community-hot-item"
                key={`${item.target.kind}:${item.target.id}`}
                data-testid={`${testId}-item`}
              >
                <span className="community-hot-rank" aria-hidden="true" data-testid={`${testId}-rank`}>
                  {index + 1}
                </span>
                <span className="community-hot-body">
                  <Link to={item.href} className="community-hot-title" data-testid={`${testId}-title`}>
                    {item.title}
                  </Link>
                  <span className="community-hot-meta meta" data-testid={`${testId}-meta`}>
                    {KIND_LABEL[item.target.kind]}
                    {' · '}
                    {plural(item.up, 'upvote')}
                    {item.down > 0 ? ` · ${plural(item.down, 'downvote')}` : ''}
                  </span>
                </span>
                <span
                  className="community-hot-score"
                  data-testid={`${testId}-score`}
                >
                  {item.hot.toFixed(2)}
                </span>
              </li>
            ))}
          </ol>
          {board.error ? (
            <p className="community-hot-error meta" role="alert">{board.error}</p>
          ) : null}
          {board.hasMore ? (
            <div className="explore-more">
              <LoadMoreButton
                loading={board.loadingMore}
                onClick={board.loadMore}
                status="Loading more items"
                data-testid={`${testId}-more`}
              />
            </div>
          ) : (
            <p className="explore-end-notice meta">
              All {plural(board.items.length, 'item')} loaded
            </p>
          )}
        </>
      )}
    </section>
  )
}
