import { useEffect, useRef, useState } from 'react'
import { languageLabel } from '../lib/languages'
import { Link, useSearchParams } from 'react-router-dom'
import { isCommunityExposureEnabled } from '../api'
import { CollectionCard } from '../components/CollectionCard'
import { CommunityHotBoard } from '../components/CommunityHotBoard'
import { EmptyState } from '../components/EmptyState'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { SkeletonCardGrid } from '../components/RouteLoading'
import { ReportSeriesCard } from '../components/ReportSeriesCard'
import { SelectMenu, type SelectMenuOption } from '../components/SelectMenu'
import { TabList } from '../components/TabList'
import { plural } from '../lib/plural'
import { useExploreFeed, type ExploreFeedSort } from '../lib/useExploreFeed'
// Shared digest stylesheet for the digest nameplates in the merged grid
// (css-layers contract lists Explore.tsx as an importer); ships with this
// route chunk.
import '../styles/reports.css'

const topics = ['All', 'Design', 'Engineering', 'ML', 'Culture']
const SORT_KEY = 'known.explore.sort.v1'

type Sort = ExploreFeedSort | 'hot'
type ExploreKind = 'collections' | 'paths' | 'digests'

function loadSort(communityExposed: boolean): Sort {
  try {
    const raw = localStorage.getItem(SORT_KEY)
    if (raw === 'updated' || raw === 'popular' || raw === 'links') return raw
    // 'hot' is the community ranking board, not an Explore feed sort; it is
    // only a valid selection while the community surface is exposed.
    if (raw === 'hot' && communityExposed) return raw
  } catch {
    /* ignore */
  }
  return 'updated'
}

/* The board mixes collections, paths and digests; the empty state names the
   segment the reader is looking at rather than assuming collections. */
const EMPTY_TITLE: Record<ExploreKind, string> = {
  collections: 'No collections match',
  paths: 'No paths match',
  digests: 'No digests yet',
}

const LOADING_LABEL: Record<ExploreKind, string> = {
  collections: 'Loading collections…',
  paths: 'Loading paths…',
  digests: 'Loading digests…',
}

const ERROR_TITLE: Record<ExploreKind, string> = {
  collections: "Couldn't load collections",
  paths: "Couldn't load paths",
  digests: "Couldn't load digests",
}

export function Explore() {
  const communityExposed = isCommunityExposureEnabled()
  const [searchParams, setSearchParams] = useSearchParams()
  const kindParam = searchParams.get('kind')
  const kind: ExploreKind =
    kindParam === 'paths' || kindParam === 'digests' ? kindParam : 'collections'
  const topic = searchParams.get('topic') ?? 'All'
  const language = searchParams.get('lang') ?? ''
  const updateParams = (patch: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '' || (key === 'topic' && value === 'All') || (key === 'kind' && value === 'collections')) next.delete(key)
        else next.set(key, value)
      }
      return next
    }, { replace: true })
  }
  const setTopic = (value: string) => updateParams({ topic: value })
  const setLanguage = (value: string) => updateParams({ lang: value })
  const [sort, setSort] = useState<Sort>(() => loadSort(communityExposed))
  // The hot board is a separate ranked feed; the Explore feed keeps the last
  // non-hot sort so toggling Hot and back restores the board the user left.
  const feedSortRef = useRef<ExploreFeedSort>(sort === 'hot' ? 'updated' : sort)
  if (sort !== 'hot') feedSortRef.current = sort
  // Digests carry no topics: under the Digests segment the topic rail turns
  // inert (aria-disabled) and digests mix in regardless of the stale chip.
  const feed = useExploreFeed({
    sort: feedSortRef.current,
    tag: topic,
    language: language.trim() || undefined,
    includeDigests: kind === 'digests' || topic === 'All',
  })
  const hotMode = sort === 'hot' && communityExposed

  /* The language picker's options come from the directory's own rows — each
     collection/digest payload carries its BCP tag, so the select only ever
     offers languages actually present. Tags accumulate across reloads so a
     filtered board does not collapse the option list to the selection. */
  const [languages, setLanguages] = useState<string[]>([])
  useEffect(() => {
    const discovered = feed.items
      .map((item) => item.payload.language)
      .filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
    if (discovered.length === 0) return
    setLanguages((prev) => {
      const merged = new Set(prev)
      let changed = false
      for (const tag of discovered) {
        if (!merged.has(tag)) {
          merged.add(tag)
          changed = true
        }
      }
      return changed
        ? [...merged].sort((a, b) => languageLabel(a).localeCompare(languageLabel(b)))
        : prev
    })
  }, [feed.items])

  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort)
    } catch {
      /* ignore */
    }
  }, [sort])

  const visible = feed.items.filter((item) =>
    kind === 'collections' ? item.kind === 'collection'
      : kind === 'paths' ? item.kind === 'path'
        : item.kind === 'digest')
  const countNoun = kind === 'digests' ? 'digest' : kind === 'paths' ? 'path' : 'collection'
  const filtered = topic !== 'All' || Boolean(language)

  /* Tab counts come from the merged board already loaded — the best number
     the data can give; '+' marks that more pages exist beyond it. A zero
     with more pages to come is not a count at all, so it shows none rather
     than "0+" (R12-11). */
  const counts = {
    collections: feed.items.filter((item) => item.kind === 'collection').length,
    paths: feed.items.filter((item) => item.kind === 'path').length,
    digests: feed.items.filter((item) => item.kind === 'digest').length,
  }
  const showCounts = !feed.hasMore || feed.items.length > 0
  const tabCount = (count: number) => (
    showCounts && (count > 0 || !feed.hasMore)
      ? <span className="tab-count">{count}{feed.hasMore ? '+' : ''}</span>
      : null
  )
  const boardRef = useRef<HTMLDivElement>(null)
  /* A filter switch pulls the refreshed board back into view — but mounting
     is not a switch, so entering /explore stays at the top of the page.
     Comparing the last values (rather than a mounted flag) keeps the
     StrictMode double-run from counting as a change. */
  const lastFiltersRef = useRef({ topic, language })
  useEffect(() => {
    const last = lastFiltersRef.current
    lastFiltersRef.current = { topic, language }
    if (last.topic === topic && last.language === language) return
    boardRef.current?.scrollIntoView({ block: 'start' })
  }, [topic, language])

  const sortOptions: SelectMenuOption<Sort>[] = [
    { value: 'updated', label: 'Recent' },
    { value: 'popular', label: 'Popular' },
    { value: 'links', label: 'Most bookmarks' },
    // CS-02: community hot-v1 ranking is a distinct board,
    // never merged into or substituted for the popular sort.
    ...(communityExposed ? [{ value: 'hot' as const, label: 'Hot' }] : []),
  ]
  // Internal value stays 'All' — useExploreFeed treats it as "no tag"; only
  // the display copy reads "Any topic".
  const topicOptions: SelectMenuOption<string>[] = topics.map((item) => ({
    value: item,
    label: item === 'All' ? 'Any topic' : item,
  }))
  const languageOptions: SelectMenuOption<string>[] = [
    { value: 'any', label: 'Any language' },
    ...languages.map((tag) => ({ value: tag, label: languageLabel(tag) })),
    ...(language !== '' && !languages.includes(language)
      ? [{ value: language, label: languageLabel(language) }]
      : []),
  ]

  return (
    <PageShell variant="bare" className="explore-page">
      <div className="explore-bar" data-testid="explore-page-head">
        <PageHead
          variant="editorial"
          title="Explore"
          documentTitle="Explore"
          meta={{
            description: 'Explore public collections and curated learning paths on Know-N.',
            canonicalPath: '/explore',
          }}
        />
        <div className="explore-bar-actions">
          <SelectMenu
            label="Sort"
            prefix="Sort:"
            value={sort}
            options={sortOptions}
            onChange={setSort}
            testId="explore-sort"
          />
          <SelectMenu
            label="Topic"
            prefix="Topic:"
            value={topic}
            options={topicOptions}
            onChange={setTopic}
            testId="explore-topic"
            disabled={kind === 'digests' && !hotMode}
          />
          {communityExposed ? (
            <SelectMenu
              label="Language"
              prefix="Language:"
              value={language || 'any'}
              options={languageOptions}
              onChange={(value) => setLanguage(value === 'any' ? '' : value)}
              testId="explore-language"
            />
          ) : null}
        </div>
      </div>

      {!hotMode ? (
        <TabList<ExploreKind>
          label="Kind"
          className="tab-rail"
          value={kind}
          options={[
            { id: 'collections', label: <>Collections {tabCount(counts.collections)}</> },
            { id: 'paths', label: <>Paths {tabCount(counts.paths)}</> },
            ...(feed.digestsAvailable
              ? [{ id: 'digests' as const, label: <>Digests {tabCount(counts.digests)}</> }]
              : []),
          ]}
          tabIdFor={(id) => `explore-tab-${id}`}
          panelIdFor={() => 'explore-board'}
          onChange={(next) => updateParams({ kind: next })}
          testId="explore-kind"
        />
      ) : null}

      {hotMode ? (
        // CS: ranking tag matching is trim+NFC but case-sensitive, so the
        // topic chip text goes through unchanged — 'ML' must not become 'ml'.
        <CommunityHotBoard
          tag={topic === 'All' ? undefined : topic}
          language={language.trim() || undefined}
        />
      ) : (
        <div id="explore-board" role="tabpanel" aria-labelledby={`explore-tab-${kind}`} ref={boardRef}>
          {feed.error && visible.length === 0 ? (
            <EmptyState
              className="empty-state--board"
              role="alert"
              icon="alert"
              title={ERROR_TITLE[kind]}
              action={
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={feed.reload}
                >
                  Try again
                </button>
              }
            />
          ) : feed.loading && visible.length === 0 ? (
            /* R15-14: the same card grid as the route skeleton, so the
               board does not collapse to one line and jump when it lands. */
            <div role="status" data-testid="explore-loading-state">
              <span className="visually-hidden">{LOADING_LABEL[kind]}</span>
              <SkeletonCardGrid />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              className="empty-state--board"
              icon="search"
              title={
                feed.hasMore ? 'No items to show yet'
                  : kind === 'digests' ? EMPTY_TITLE.digests
                  : filtered ? EMPTY_TITLE[kind]
                    : kind === 'collections' ? 'No public collections yet' : 'No public paths yet'
              }
              description={
                feed.hasMore ? 'Keep browsing to look for more items.'
                  : kind === 'digests'
                  ? 'Curators have not published public digests yet.'
                  : filtered
                    ? language ? 'Try another topic or language.' : 'Try another topic.'
                    : 'Nothing has been published here yet.'
              }
              action={
                kind === 'digests' ? (
                  <Link to="/reports" className="btn btn-secondary btn-sm">Browse all digests</Link>
                ) : filtered ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => updateParams({ topic: null, lang: null })}
                  >
                    Reset filters
                  </button>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="collection-grid" data-testid="collection-grid">
                {visible.map((item) => (
                  item.kind === 'digest'
                    ? <ReportSeriesCard key={`digest-${item.payload.id}`} series={item.payload} />
                    : <CollectionCard key={item.payload.id} c={item.payload} />
                ))}
              </div>
              {!feed.hasMore && (
                <p className="explore-end-notice meta">
                  All {plural(visible.length, countNoun)} loaded
                </p>
              )}
            </>
          )}
          {feed.hasMore && (visible.length > 0 || (!feed.loading && !feed.error)) && (
            <div className="explore-more">
              <LoadMoreButton
                loading={feed.loadingMore}
                onClick={feed.loadMore}
                status="Loading more items"
              />
            </div>
          )}
        </div>
      )}
    </PageShell>
  )
}
