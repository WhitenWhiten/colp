import { useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type FaviconIconJob } from '../../api'

export function isFaviconJobTerminal(status: FaviconIconJob['status']): boolean {
  return status !== 'pending' && status !== 'running'
}

/** Discover server work on every Settings visit, including work started in another tab. */
export function useFaviconJobActivity(startedJobId: string | null) {
  const [job, setJob] = useState<FaviconIconJob | null>(null)
  const [activeJobs, setActiveJobs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const watchedJob = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let polling = false
    if (startedJobId !== null) watchedJob.current = startedJobId
    const poll = async () => {
      if (signal.aborted || polling) return
      polling = true
      let stopped = false
      try {
        if (document.visibilityState === 'hidden') return
        const activity = await productClient.getMyFaviconJobActivity({ signal, maxRetries: 0 })
        if (signal.aborted) return
        setActiveJobs(activity.activeJobs)
        if (activity.job !== null) {
          watchedJob.current = activity.job.id
          setJob(activity.job)
        } else if (watchedJob.current !== null) {
          try {
            const finished = await productClient.getMyFaviconJob(watchedJob.current, { signal, maxRetries: 0 })
            if (!signal.aborted) setJob(finished)
            if (isFaviconJobTerminal(finished.status)) watchedJob.current = null
          } catch (readError) {
            if (!isProductApiError(readError) || readError.status !== 404) throw readError
            watchedJob.current = null
            if (!signal.aborted) setJob(null)
          }
        }
        failures = 0
        setError(null)
      } catch (pollError) {
        if (signal.aborted) return
        if (isProductApiError(pollError) && [401, 403, 404].includes(pollError.status)) {
          setJob(null)
          setError(null)
          setActiveJobs(0)
          stopped = true
          return
        }
        failures += 1
        setError('Icon progress is temporarily unavailable. Retrying…')
      } finally {
        polling = false
        if (!signal.aborted) setChecking(false)
        if (!signal.aborted && !stopped) timer = setTimeout(() => { void poll() }, Math.min(5_000 * 2 ** failures, 30_000))
      }
    }
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') {
        clearTimeout(timer)
        void poll()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [startedJobId])

  return { job, activeJobs, error, checking }
}
