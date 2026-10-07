import { useCallback, useEffect, useMemo, useRef } from 'react'
import { plural } from '../../lib/plural'
import { useDeskStorage } from '../../lib/useDeskStorage'

type Mode = 'focus' | 'short' | 'long'

type PomodoroState = {
  mode: Mode
  remaining: number
  running: boolean
  completedFocus: number
  endsAt: number | null
}

const DURATIONS: Record<Mode, number> = {
  focus: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
}

const MODE_LABEL: Record<Mode, string> = {
  focus: 'Focus',
  short: 'Short break',
  long: 'Long break',
}

function storageKey(id: string) {
  return `known.desk.pomodoro.${id}.v1`
}

function baseState(): PomodoroState {
  return {
    mode: 'focus',
    remaining: DURATIONS.focus,
    running: false,
    completedFocus: 0,
    endsAt: null,
  }
}

function normalizeState(stored: unknown): PomodoroState {
  const p = stored as Partial<PomodoroState>
  const mode = p.mode === 'short' || p.mode === 'long' || p.mode === 'focus' ? p.mode : 'focus'
  let remaining =
    typeof p.remaining === 'number' && p.remaining >= 0 ? Math.floor(p.remaining) : DURATIONS[mode]
  let running = Boolean(p.running)
  let endsAt = typeof p.endsAt === 'number' ? p.endsAt : null
  if (running && endsAt) {
    remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
    if (remaining === 0) {
      running = false
      endsAt = null
    }
  } else {
    endsAt = null
    running = false
  }
  return {
    mode,
    remaining,
    running,
    completedFocus:
      typeof p.completedFocus === 'number' && p.completedFocus >= 0
        ? Math.floor(p.completedFocus)
        : 0,
    endsAt,
  }
}

function formatTime(sec: number) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

type Props = { resourceId: string }

export function PomodoroWidget({ resourceId }: Props) {
  const { value: state, update: commit } = useDeskStorage<PomodoroState>({
    storageKey: storageKey(resourceId),
    fallback: baseState,
    normalize: normalizeState,
  })
  const audioTried = useRef(false)

  const chime = useCallback(() => {
    if (audioTried.current) return
    audioTried.current = true
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 660
      gain.gain.value = 0.04
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6)
      osc.stop(ctx.currentTime + 0.65)
      window.setTimeout(() => void ctx.close(), 800)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (!state.running) return
    const id = window.setInterval(() => {
      commit((prev) => {
        if (!prev.running) return prev
        const left = prev.endsAt
          ? Math.max(0, Math.ceil((prev.endsAt - Date.now()) / 1000))
          : Math.max(0, prev.remaining - 1)
        if (left > 0) return { ...prev, remaining: left }
        // Session complete
        chime()
        audioTried.current = false
        const doneFocus = prev.mode === 'focus' ? prev.completedFocus + 1 : prev.completedFocus
        const nextMode: Mode =
          prev.mode === 'focus' ? (doneFocus % 4 === 0 ? 'long' : 'short') : 'focus'
        return {
          mode: nextMode,
          remaining: DURATIONS[nextMode],
          running: false,
          completedFocus: doneFocus,
          endsAt: null,
        }
      })
    }, 250)
    return () => window.clearInterval(id)
  }, [state.running, commit, chime])

  const total = DURATIONS[state.mode]
  const progress = useMemo(
    () => Math.min(1, Math.max(0, 1 - state.remaining / total)),
    [state.remaining, total],
  )

  const setMode = (mode: Mode) => {
    commit(() => ({
      mode,
      remaining: DURATIONS[mode],
      running: false,
      completedFocus: state.completedFocus,
      endsAt: null,
    }))
  }

  const toggle = () => {
    commit((prev) => {
      if (prev.running) {
        const left = prev.endsAt
          ? Math.max(0, Math.ceil((prev.endsAt - Date.now()) / 1000))
          : prev.remaining
        return { ...prev, running: false, remaining: left, endsAt: null }
      }
      const remaining = prev.remaining > 0 ? prev.remaining : DURATIONS[prev.mode]
      return {
        ...prev,
        running: true,
        remaining,
        endsAt: Date.now() + remaining * 1000,
      }
    })
  }

  const reset = () => {
    commit((prev) => ({
      ...prev,
      remaining: DURATIONS[prev.mode],
      running: false,
      endsAt: null,
    }))
  }

  return (
    <div className="desk-widget desk-pomodoro" data-resource={resourceId}>
      <div className="desk-pomo-modes" role="group" aria-label="Timer mode">
        {(['focus', 'short', 'long'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className="desk-pomo-mode"
            aria-pressed={state.mode === m}
            onClick={() => setMode(m)}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      <div className="desk-pomo-ring">
        <svg viewBox="0 0 120 120" aria-hidden>
          <circle className="desk-pomo-track" cx="60" cy="60" r="52" />
          <circle
            className="desk-pomo-progress"
            cx="60"
            cy="60"
            r="52"
            strokeDasharray={`${(progress * 326.7).toFixed(1)} 326.7`}
          />
        </svg>
        <div className="desk-pomo-readout">
          <strong className="desk-pomo-time">{formatTime(state.remaining)}</strong>
          <span className="meta">{MODE_LABEL[state.mode]}</span>
        </div>
      </div>

      <div className="desk-pomo-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={toggle}>
          {state.running ? 'Pause' : state.remaining < total ? 'Resume' : 'Start'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
          Reset
        </button>
        <span className="desk-pomo-count meta" title="Completed focus sessions">
          {plural(state.completedFocus, 'focus', 'focuses')}
        </span>
      </div>
    </div>
  )
}
