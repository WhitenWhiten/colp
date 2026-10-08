import { useEffect, useMemo, useState } from 'react'
import { formatClockTimeWithSeconds, formatLongDate, formatTimeZoneName } from '../../lib/formatDate'

type Props = { resourceId: string }

export function DeskClockWidget({ resourceId }: Props) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const tick = () => setNow(new Date())
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])

  const time = useMemo(() => formatClockTimeWithSeconds(now), [now])
  const date = useMemo(() => formatLongDate(now), [now])
  const zone = useMemo(() => formatTimeZoneName(now), [now])

  const greeting =
    now.getHours() < 5
      ? 'Late night notes'
      : now.getHours() < 12
        ? 'Morning focus'
        : now.getHours() < 17
          ? 'Afternoon stretch'
          : now.getHours() < 21
            ? 'Evening wind-down'
            : 'Night notes'

  return (
    <div className="desk-widget desk-clock" data-resource={resourceId}>
      <p className="desk-clock-kicker meta">{greeting}</p>
      <time className="desk-clock-time" dateTime={now.toISOString()}>
        {time}
      </time>
      <p className="desk-clock-date">{date}</p>
      {zone && <p className="desk-clock-zone meta">{zone}</p>}
    </div>
  )
}
