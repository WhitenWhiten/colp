import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { FilterRail } from '../components/FilterRail'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
// Route-owned stylesheet (see main.tsx); ships with this chunk.
import '../styles/demos.css'

type DemoGroup = 'Capture' | 'Organize' | 'Publish' | 'Follow' | 'System'

const demos: Array<{
  to: string
  title: string
  body: string
  group: DemoGroup
  meta: string
  /** True for entries that render mock-only sandboxes under /demo (no Product API). */
  sandbox?: boolean
}> = [
  { to: '/today', title: 'Today library review', body: 'Review focus reading, new captures, sync conflicts, and curator updates.', group: 'Organize', meta: 'Daily loop' },
  { to: '/notifications?filter=collection', title: 'Collection changes', body: 'Live notification center filter for followed collection changes.', group: 'Follow', meta: 'Live inbox' },
  { to: '/extension/popup', title: 'Extension capture popup', body: 'Save the active tab with a folder match and visibility choice.', group: 'Capture', meta: 'Browser flow' },
  { to: '/import', title: 'Import wizard', body: 'Map Pocket, Raindrop, or bookmark HTML into Know-N folders.', group: 'Capture', meta: '4 steps' },
  { to: '/sync', title: 'Sync center', body: 'Choose mirrored folders and resolve three-way conflicts.', group: 'System', meta: 'Conflict states' },
  { to: '/classify', title: 'Classify inbox', body: 'Review unfiled root bookmarks and file them into existing folders by lexical overlap.', group: 'Organize', meta: 'Batch action' },
  { to: '/ai/organize', title: 'AI organization plan', body: 'Preview every move before applying a multi-folder cleanup.', group: 'Organize', meta: 'Reversible' },
  { to: '/library', title: 'Collection editor', body: 'Sequence a path and inspect the publish diff.', group: 'Publish', meta: 'Owner view' },
  { to: '/library', title: 'Collection version history', body: 'Compare change sets and restore an earlier release.', group: 'Publish', meta: 'Traceable' },
  { to: '/library', title: 'Collaborators and permissions', body: 'Invite contributors, assign roles, and review shared editing activity.', group: 'Publish', meta: 'Editor and Viewer' },
  { to: '/explore', title: 'Share and embed', body: 'Open public collections, then share or embed a public path.', group: 'Publish', meta: 'Distribution' },
  { to: '/explore', title: 'Permission roles', body: 'Public paths show visitor access. Sign in to manage Editor and Viewer roles on collections you own.', group: 'Publish', meta: 'Live roles' },
  { to: '/explore', title: 'Guided reading path', body: 'Open a public collection and read it as a path.', group: 'Follow', meta: 'Reader view' },
  { to: '/explore', title: 'Reading view', body: 'Read in focus mode, highlight passages, and save private notes from a live collection.', group: 'Follow', meta: 'Deep reading' },
  { to: '/feed?empty=1', title: 'Empty following feed', body: 'See the activation path before a reader follows a curator.', group: 'Follow', meta: 'Empty state' },
  { to: '/notifications', title: 'Notification center', body: 'Scan follows, sync results, path updates, and creator events. Community reply unread is merged into the bell.', group: 'Follow', meta: 'Mixed states' },
  { to: '/explore', title: 'Community hot board', body: 'Rank public collections, bookmarks, and digests by vote heat. Hidden and delisted targets must not appear.', group: 'Follow', meta: 'Live ranking' },
  { to: '/c/llm-learning-path', title: 'Collection comments and votes', body: 'Flagship thread: roots, nested replies, author tombstone, curator hide, and a long mixed-script comment.', group: 'Follow', meta: 'Community thread' },
  { to: '/c/frontend-engineering', title: 'Curator-locked comments', body: 'Owner locked the comment area. New writes should 403; existing comments stay readable.', group: 'Follow', meta: 'Comment lock' },
  { to: '/c/indie-toolbox', title: 'Officially hidden collection', body: 'hide_public: anonymous direct URL conceals; owner can still manage and appeal.', group: 'Follow', meta: 'Governance hide' },
  { to: '/c/sasha-brutalism', title: 'Delisted collection', body: 'delist: Explore and ranking drop the card; the known URL still opens.', group: 'Follow', meta: 'Governance delist' },
  { to: '/explore', title: 'Curator profile', body: 'Open a public collection, then follow its curator from the live profile.', group: 'Follow', meta: 'Public profile' },
  { to: '/creator', title: 'Publishing insights', body: 'Inspect collection discovery, preview opens, and top resources.', group: 'Publish', meta: 'Analytics' },
  { to: '/demo/dashboard', title: 'Start-page board', body: 'Arrange modules and add new tools from the module catalog.', group: 'System', meta: 'Custom layout', sandbox: true },
  { to: '/demo/ai/chat', title: 'Grounded collection chat', body: 'Ask questions with collection context and inspect source citations.', group: 'System', meta: 'Citations', sandbox: true },
  { to: '/demo/library?empty=1', title: 'Empty library', body: 'Start from zero with clear capture, import, and discovery actions.', group: 'System', meta: 'First run', sandbox: true },
  { to: '/library/health', title: 'Library link health', body: 'Detect broken, redirected, and duplicate bookmarks in bulk.', group: 'System', meta: 'Maintenance' },
  { to: '/export', title: 'Data export and migration', body: 'Create JSON export jobs of your owned live library, including private titles. Shared libraries are not included.', group: 'System', meta: 'JSON export' },
  { to: '/moderation/reports', title: 'My moderation reports', body: 'Reporter inbox: submitted, in review, resolved, and dismissed cases across collections, comments, and accounts.', group: 'System', meta: 'Governance' },
  { to: '/moderation/appeals', title: 'My moderation appeals', body: 'Owner appeals against official hide, including a submitted indie-toolbox appeal.', group: 'System', meta: 'Governance' },
  { to: '/admin/moderation/cases', title: 'Official moderation cases', body: 'Default demo login is a moderator. Reviewer-only: zhou.mengjie@example.com. No role: wang.siyuan@example.com.', group: 'System', meta: 'Official console' },
]

const groups: Array<'All' | DemoGroup> = ['All', 'Capture', 'Organize', 'Publish', 'Follow', 'System']
const GROUP_ORDER: DemoGroup[] = ['Capture', 'Organize', 'Publish', 'Follow', 'System']

export function DemoHub() {
  const [group, setGroup] = useState<(typeof groups)[number]>('All')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return demos.filter((demo) => {
      const matchesGroup = group === 'All' || demo.group === group
      const matchesQuery = !needle || `${demo.title} ${demo.body} ${demo.group}`.toLowerCase().includes(needle)
      return matchesGroup && matchesQuery
    })
  }, [group, query])

  const directoryRows = useMemo(() => {
    if (!(group === 'All' && !query.trim())) {
      return filtered.map((demo, index) => ({ type: 'row' as const, demo, index }))
    }
    const rows: Array<
      | { type: 'heading'; heading: DemoGroup }
      | { type: 'row'; demo: (typeof demos)[number]; index: number }
    > = []
    let index = 0
    for (const heading of GROUP_ORDER) {
      const items = filtered.filter((demo) => demo.group === heading)
      if (items.length === 0) continue
      rows.push({ type: 'heading', heading })
      for (const demo of items) {
        rows.push({ type: 'row', demo, index })
        index += 1
      }
    }
    return rows
  }, [filtered, group, query])

  return (
    <PageShell>
      <header className="demo-directory-head">
        <PageHead
          className="page-head--editorial"
          eyebrow="Interactive product map"
          title="Explore Know-N by workflow"
          documentTitle="Demos"
          lede="A guided map of live product flows. Entries tagged Mock are client-only sandboxes — nothing you click there touches the Product API."
        />
        <aside className="demo-walkthrough" aria-label="Recommended walkthrough">
          <span>Recommended walkthrough</span>
          <ol>
            <li><Link to="/extension/popup">Capture a source</Link></li>
            <li><Link to="/classify">Review its placement</Link></li>
            <li><Link to="/explore">Publish the path</Link></li>
          </ol>
        </aside>
      </header>

      <section className="demo-directory-shell" aria-label="Product demo directory">
        <div className="demo-directory-toolbar">
          <label className="search-field demo-search">
            <span aria-hidden><Icon name="search" /></span>
            <span className="visually-hidden">Search product demos</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search flows, states, or roles" />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
                <Icon name="cross" />
              </button>
            )}
          </label>
          <span className="demo-result-count" aria-live="polite">{filtered.length} of {demos.length} flows</span>
        </div>

        <FilterRail
          className="demo-filter-row"
          variant="segments"
          label="Filter demos"
          value={group}
          options={groups.map((item) => ({ value: item, label: item }))}
          onChange={setGroup}
        />

        <div className="demo-directory-list">
          {directoryRows.map((row) => (
            row.type === 'heading' ? (
              <h2 key={`group-${row.heading}`} className="demo-group-heading">{row.heading}</h2>
            ) : (
              <Link key={row.demo.title} to={row.demo.to} className="demo-directory-row">
                <span className="demo-row-index">{String(row.index + 1).padStart(2, '0')}</span>
                <span className="demo-row-copy">
                  <strong>{row.demo.title}</strong>
                  <span>{row.demo.body}</span>
                </span>
                <span className="demo-row-meta">
                  <em>{row.demo.group}</em>
                  {row.demo.meta}
                  {row.demo.sandbox && <span className="chip demo-row-sandbox">Mock</span>}
                </span>
                <span className="demo-row-arrow" aria-hidden><Icon name="arrow-right" /></span>
              </Link>
            )
          ))}
          {filtered.length === 0 && (
            <div className="demo-directory-empty" role="status">
              <strong>No matching flow</strong>
              <p>Try a broader term or clear the current category.</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setGroup('All'); setQuery('') }}>Clear filters</button>
            </div>
          )}
        </div>
      </section>
    </PageShell>
  )
}
