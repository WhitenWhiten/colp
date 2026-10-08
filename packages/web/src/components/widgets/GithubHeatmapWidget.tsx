import { useMemo, useState } from 'react'
import { DATE_LOCALE } from '../../lib/formatDate'
import { plural } from '../../lib/plural'

type DayCell = {
  date: Date
  key: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

type Props = {
  resourceId: string
  handle?: string
}

const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', '']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Stable pseudo-random 0..1 from string */
function hash01(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

function levelFromCount(n: number): 0 | 1 | 2 | 3 | 4 {
  if (n <= 0) return 0
  if (n <= 2) return 1
  if (n <= 5) return 2
  if (n <= 9) return 3
  return 4
}

function buildYear(handle: string, end: Date): DayCell[] {
  const endDay = startOfDay(end)
  // GitHub-style: ~53 weeks ending on endDay's week (Sunday start)
  const endDow = endDay.getDay() // 0 Sun
  const gridEnd = new Date(endDay)
  // include full week of endDay
  gridEnd.setDate(gridEnd.getDate() + (6 - endDow))
  const gridStart = new Date(gridEnd)
  gridStart.setDate(gridStart.getDate() - 52 * 7 - 6)

  const cells: DayCell[] = []
  const cursor = new Date(gridStart)
  while (cursor <= gridEnd) {
    const key = dayKey(cursor)
    const future = cursor > endDay
    let count = 0
    if (!future) {
      const r = hash01(`${handle}:${key}`)
      // Sparse quiet days + occasional bursts
      if (r > 0.42) {
        const burst = hash01(`${handle}:b:${key}`)
        count = burst > 0.92 ? Math.floor(8 + burst * 12) : Math.floor(1 + r * 8)
        // Weekends quieter
        if (cursor.getDay() === 0 || cursor.getDay() === 6) {
          count = Math.max(0, count - 3)
        }
      }
    }
    cells.push({
      date: new Date(cursor),
      key,
      count,
      level: future ? 0 : levelFromCount(count),
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return cells
}

function formatLong(d: Date) {
  return d.toLocaleDateString(DATE_LOCALE, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function GithubHeatmapWidget({ resourceId, handle = 'alexchen' }: Props) {
  const [hover, setHover] = useState<DayCell | null>(null)
  const today = useMemo(() => startOfDay(new Date()), [])
  const cells = useMemo(() => buildYear(handle, today), [handle, today])

  const weeks = useMemo(() => {
    const cols: DayCell[][] = []
    for (let i = 0; i < cells.length; i += 7) {
      cols.push(cells.slice(i, i + 7))
    }
    return cols
  }, [cells])

  const monthLabels = useMemo(() => {
    const labels: { week: number; label: string }[] = []
    let lastMonth = -1
    weeks.forEach((week, wi) => {
      const first = week[0]
      if (!first) return
      const m = first.date.getMonth()
      if (m !== lastMonth) {
        labels.push({ week: wi, label: MONTHS[m] ?? '' })
        lastMonth = m
      }
    })
    return labels
  }, [weeks])

  const total = useMemo(() => cells.reduce((s, c) => s + c.count, 0), [cells])

  const streak = useMemo(() => {
    let s = 0
    for (let i = cells.length - 1; i >= 0; i--) {
      const c = cells[i]
      if (!c || c.date > today) continue
      if (c.count > 0) s++
      else if (c.date < today) break
    }
    return s
  }, [cells, today])

  const year = today.getFullYear()

  return (
    <div className="desk-widget desk-heatmap" data-resource={resourceId}>
      <div className="desk-widget-head">
        <div>
          <span className="desk-widget-title">{total.toLocaleString()} contributions</span>
          <p className="meta desk-hm-sub">
            @{handle} · last 12 months · demo seed
          </p>
        </div>
        <div className="desk-hm-stats">
          <span>
            <strong>{streak}</strong>
            <span className="meta"> day streak</span>
          </span>
          <span className="meta">{year}</span>
        </div>
      </div>

      <div className="desk-hm-scroll">
        <div className="desk-hm-grid-wrap">
          <div className="desk-hm-months" aria-hidden>
            {monthLabels.map((m) => (
              <span
                key={`${m.week}-${m.label}`}
                className="desk-hm-month desk-hm-month--col"
                style={{ ['--gh-col' as string]: m.week + 2 }}
              >
                {m.label}
              </span>
            ))}
          </div>

          <div className="desk-hm-body">
            <div className="desk-hm-wdays" aria-hidden>
              {WEEKDAYS.map((d, i) => (
                <span key={i} className="desk-hm-wday">
                  {d}
                </span>
              ))}
            </div>

            <div
              className="desk-hm-weeks"
              role="img"
              aria-label={`GitHub-style contribution heatmap for @${handle}, ${total} contributions in the last year`}
            >
              {weeks.map((week, wi) => (
                <div key={wi} className="desk-hm-week">
                  {week.map((cell) => {
                    const isFuture = cell.date > today
                    return (
                      <button
                        key={cell.key}
                        type="button"
                        className={`desk-hm-cell level-${cell.level} ${isFuture ? 'is-future' : ''}`}
                        data-level={cell.level}
                        aria-label={
                          isFuture
                            ? `${formatLong(cell.date)} · future`
                            : `${formatLong(cell.date)} · ${plural(cell.count, 'contribution')}`
                        }
                        disabled={isFuture}
                        onMouseEnter={() => !isFuture && setHover(cell)}
                        onMouseLeave={() => setHover(null)}
                        onFocus={() => !isFuture && setHover(cell)}
                        onBlur={() => setHover(null)}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="desk-hm-foot">
        <span className="desk-hm-tip meta" aria-live="polite">
          {hover
            ? `${plural(hover.count, 'contribution')} on ${formatLong(hover.date)}`
            : 'Hover a day · seeded demo data (not live GitHub)'}
        </span>
        <div className="desk-hm-legend" aria-hidden>
          <span className="meta">Less</span>
          {[0, 1, 2, 3, 4].map((lv) => (
            <span key={lv} className={`desk-hm-cell level-${lv} is-legend`} />
          ))}
          <span className="meta">More</span>
        </div>
      </div>
    </div>
  )
}
