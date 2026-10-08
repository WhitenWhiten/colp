import { useEffect, useState } from 'react'

/** Avatar image with an initials fallback; the fallback also applies when the
   image fails to load, and the failed state resets when the url changes.
   `fallbackClassName` keeps styled monogram treatments (profile/public hero)
   on the fallback span without hand-rolling the failure branch again. */
export function AvatarImage({
  url,
  initials,
  fallbackClassName,
}: {
  url?: string | null
  initials: string
  fallbackClassName?: string
}) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [url])

  if (url && !failed) {
    return <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  }

  return <span className={fallbackClassName} aria-hidden>{initials}</span>
}
