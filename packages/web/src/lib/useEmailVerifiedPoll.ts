import { useCallback, useEffect, useState } from 'react'

/* R15-15: the check-your-email screen used to poll the session every 3 s
   forever, even hidden and after verification, overlapping requests and
   spending the per-IP auth bucket that sign-out also uses. */
export const VERIFIED_POLL_INITIAL_MS = 3_000
export const VERIFIED_POLL_MAX_MS = 30_000
export const VERIFIED_POLL_GIVE_UP_MS = 10 * 60_000
const BACKOFF = 1.5

/**
 * Polls `isVerified` while `active`: one request at a time, backing off
 * 3 s → 30 s, paused while the tab is hidden (checked once on return and on
 * focus), stopped once verified, and given up after 10 minutes until the
 * reader asks to check again.
 */
export function useEmailVerifiedPoll(active: boolean, isVerified: () => Promise<boolean>) {
  const [verified, setVerified] = useState(false)
  const [gaveUp, setGaveUp] = useState(false)
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (!active || verified || gaveUp) return
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let delay = VERIFIED_POLL_INITIAL_MS
    const startedAt = Date.now()

    const clear = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    const schedule = () => {
      clear()
      if (cancelled || document.visibilityState === 'hidden') return
      if (Date.now() - startedAt >= VERIFIED_POLL_GIVE_UP_MS) {
        setGaveUp(true)
        return
      }
      timer = setTimeout(() => void check(), delay)
      delay = Math.min(VERIFIED_POLL_MAX_MS, Math.round(delay * BACKOFF))
    }
    const check = async () => {
      if (cancelled || inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      clear()
      try {
        if (await isVerified()) {
          if (!cancelled) setVerified(true)
          return
        }
      } catch {
        // Stay on the check-your-email copy; the next check may succeed.
      } finally {
        inFlight = false
      }
      schedule()
    }
    const onReturn = () => {
      if (document.visibilityState === 'visible') void check()
      else clear()
    }

    void check()
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('focus', onReturn)
    return () => {
      cancelled = true
      clear()
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('focus', onReturn)
    }
  }, [active, verified, gaveUp, round, isVerified])

  const checkAgain = useCallback(() => {
    setGaveUp(false)
    setRound((value) => value + 1)
  }, [])

  return { verified, gaveUp, checkAgain }
}
