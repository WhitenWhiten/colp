import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getExploreCollections } from '../api'
import { dashboardModules, type Resource } from '../api/mock-data'
import { formatClockTime, formatWeekdayShortDate } from '../lib/formatDate'
import { useDashboardCollist } from '../lib/collistBinding'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { DashboardBoard } from './dashboard/DashboardBoard'
import { ModuleCatalogModal } from './dashboard/ModuleCatalogModal'
import { moduleById } from './dashboard/moduleState'
import { fillPinsFromExplore, publicOwnedPins, type PinnedPath } from './dashboard/pins'
import { useDashboardState, type Density } from './dashboard/useDashboardState'
import { FilterRail } from '../components/FilterRail'
// Route-owned stylesheets for the demo desk (see main.tsx). Same relative
// order as the old entry: dashboard-desk.css must follow cards.css (entry) and
// precede the widget-*.css chapters inside @layer components. The widget
// order is pinned by css-layers.contract.test.ts.
import '../styles/dashboard.css'
import '../styles/desk-themes.css'
import '../styles/dashboard-desk.css'
import '../styles/widget-search.css'
import '../styles/widget-sticky.css'
import '../styles/widget-todo.css'
import '../styles/widget-weather.css'
import '../styles/widget-collection-list.css'
import '../styles/widget-pomodoro.css'
import '../styles/widget-clock.css'
import '../styles/widget-quicklinks.css'
import '../styles/widget-habits.css'
import '../styles/widget-reading.css'
import '../styles/widget-ssh.css'
import '../styles/widget-heatmap.css'
import '../styles/widget-aichat.css'
import '../styles/widget-wordbook.css'
import '../styles/canvas-background.css'

function greetingForHour(h: number) {
  if (h < 5) return 'Late night'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 21) return 'Good evening'
  return 'Good night'
}

export function Dashboard() {
  useDocumentTitle('Dashboard')
  const {
    now,
    density,
    setDensity,
    moduleIds,
    themeMap,
    setThemeMap,
    addThemeByKind,
    setAddThemeByKind,
    isFullscreen,
    stackLayout,
    removeModule,
    addFromCatalog,
    restoreAll,
  } = useDashboardState()
  const [chromeOpen, setChromeOpen] = useState(false)
  const [marketOpen, setMarketOpen] = useState(false)

  const modules = useMemo(
    () => moduleIds.map((id) => moduleById(id)).filter((m): m is Resource => Boolean(m)),
    [moduleIds],
  )
  const collistModuleIds = useMemo(
    () => modules.filter((m) => m.type === 'collectionlist').map((m) => m.id),
    [modules],
  )
  const collist = useDashboardCollist(collistModuleIds)
  const ownedPins = useMemo(
    () => publicOwnedPins(collist.owned.items),
    [collist.owned.items],
  )
  const [explorePins, setExplorePins] = useState<PinnedPath[]>([])
  useEffect(() => {
    if (ownedPins.length >= 2) {
      setExplorePins([])
      return
    }
    const controller = new AbortController()
    setExplorePins([])
    void getExploreCollections({ limit: 8 }, { signal: controller.signal }).then(
      (page) => {
        if (controller.signal.aborted) return
        setExplorePins(fillPinsFromExplore(ownedPins, page.items).slice(ownedPins.length))
      },
      () => {
        if (controller.signal.aborted) return
        setExplorePins([])
      },
    )
    return () => controller.abort()
  }, [ownedPins])
  const pinnedPaths = useMemo(() => {
    if (ownedPins.length >= 2) return ownedPins
    const seen = new Set(ownedPins.map((pin) => pin.slug))
    const extra = explorePins.filter((pin) => !seen.has(pin.slug))
    return [...ownedPins, ...extra].slice(0, 2)
  }, [ownedPins, explorePins])

  const timeLabel = useMemo(() => formatClockTime(now), [now])
  const dateLabel = useMemo(() => formatWeekdayShortDate(now), [now])

  const greeting = greetingForHour(now.getHours())
  const moduleCount = modules.length
  const canEdit = !isFullscreen && density === 'desk'

  return (
    <div
      className={[
        'dashboard-page',
        `density-${density}`,
        isFullscreen ? 'is-browser-fullscreen' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {!isFullscreen && (
        <div className="dashboard-bar">
          <p className="meta dashboard-hint" role="status">
            This board is an experimental start page with demo modules, not live library analytics.
          </p>
          <div className="dashboard-bar-inner dashboard-bar-inner--wide">
            <div className="dashboard-identity">
              <div className="dashboard-clock" aria-live="polite">
                <strong>{timeLabel}</strong>
                <span className="meta">{dateLabel}</span>
              </div>
              <div>
                <p className="section-label dashboard-eyebrow">
                  Start page
                </p>
                <strong className="dashboard-title">{greeting} · Your board</strong>
                <p className="meta dashboard-hint">
                  {density === 'desk'
                    ? stackLayout
                      /* Stacked cards mount with editable={false} — don't
                         promise gestures the layout doesn't offer. */
                      ? `${moduleCount} modules · stacked view · card editing needs a wider screen`
                      : `${moduleCount} modules · drag · right-click color · × remove`
                    : `${moduleCount} modules · layout locked · chrome hidden`}
                </p>
              </div>
            </div>

            <div className="dashboard-actions">
              {/* R9-20: the segmented control is the shared FilterRail —
                  arrows roam+select, roving tabindex, one Tab stop. */}
              <FilterRail<Density>
                className="view-switch"
                variant="segments"
                label="Layout mode"
                value={density}
                options={[
                  {
                    value: 'desk',
                    label: 'Board',
                    title: stackLayout
                      ? 'Board view — card editing needs a wider screen'
                      : 'Edit layout: drag, resize, remove cards',
                  },
                  { value: 'focus', label: 'Focus', title: 'Use layout only: hide drag bars, no rearrange' },
                ]}
                onChange={setDensity}
              />
              <Link to="/library/new" className="btn btn-primary btn-sm">
                New collection
              </Link>
              {/* Deliberate native <details> disclosure: this secondary
                  overflow trades the full anchored-menu contract (outside-
                  click close, Esc, focus management) for zero JS — use
                  useAnchoredMenu when a menu needs the full contract. */}
              <details className="dashboard-overflow">
                <summary className="btn btn-ghost btn-sm">More</summary>
                <div className="dashboard-overflow-menu">
              <Link to="/classify" className="btn btn-secondary btn-sm">
                Classify inbox
              </Link>
              {density === 'desk' && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setMarketOpen(true)}
                  >
                    Add module
                  </button>
                  {moduleCount < dashboardModules.length && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={restoreAll}>
                      Restore all
                    </button>
                  )}
                </>
              )}
              <Link to="/feed" className="btn btn-ghost btn-sm">
                Feed
              </Link>
              <Link to="/notifications" className="btn btn-ghost btn-sm">
                Alerts
              </Link>
                </div>
              </details>
            </div>
          </div>

          {density === 'desk' && (
            <div className="dashboard-rail">
              <div className="dashboard-rail-inner">
                <span className="dashboard-rail-label">Pinned paths</span>
                <div className="dashboard-rail-chips" data-testid="dashboard-rail-chips">
                  {pinnedPaths.map((pin) => (
                    <Link key={pin.slug} to={`/c/${encodeURIComponent(pin.slug)}`} className="chip chip--rail">
                      <span className="dashboard-chip-title">{pin.title}</span>
                    </Link>
                  ))}
                  <Link to="/library" className="chip chip--rail chip--ghost">
                    Library
                  </Link>
                  <Link to="/sync" className="chip chip--rail chip--ghost">
                    Sync
                  </Link>
                  {/* chromeOpen only reaches CanvasBoard — in the stacked
                      layout the toggle would switch nothing. */}
                  {!stackLayout && (
                    <button
                      type="button"
                      className="chip chip--rail chip--ghost"
                      onClick={() => setChromeOpen((v) => !v)}
                    >
                      {chromeOpen ? 'Hide board tools' : 'Show board tools'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <DashboardBoard
        modules={modules}
        stackLayout={stackLayout}
        collist={collist}
        themeMap={themeMap}
        setThemeMap={setThemeMap}
        canEdit={canEdit}
        chromeOpen={chromeOpen}
        removeModule={removeModule}
        density={density}
        onAddModule={() => setMarketOpen(true)}
        restoreAll={restoreAll}
      />

      <ModuleCatalogModal
        open={marketOpen}
        onClose={() => setMarketOpen(false)}
        moduleIds={moduleIds}
        moduleCount={moduleCount}
        addThemeByKind={addThemeByKind}
        setAddThemeByKind={setAddThemeByKind}
        addFromCatalog={addFromCatalog}
        restoreAll={restoreAll}
      />
    </div>
  )
}
