import { useCallback, useState } from 'react'
import { FilterRail } from '../../components/FilterRail'
import { useUiDensity } from '../../lib/useUiDensity'

/**
 * LP-07: the desk's single view control. Comfort/Compact stay the global UI
 * density; Gallery is a desk-only layout remembered per browser. One control,
 * never two selectors side by side.
 */
const GALLERY_KEY = 'known.library.gallery.v1'

function readGallery(): boolean {
  try {
    return window.localStorage.getItem(GALLERY_KEY) === 'true'
  } catch {
    return false
  }
}

export function useDeskGallery(): [boolean, (next: boolean) => void] {
  const [gallery, setGallery] = useState(readGallery)
  const update = useCallback((next: boolean) => {
    setGallery(next)
    try {
      if (next) window.localStorage.setItem(GALLERY_KEY, 'true')
      else window.localStorage.removeItem(GALLERY_KEY)
    } catch {
      /* per-browser convenience only */
    }
  }, [])
  return [gallery, update]
}

type DeskView = 'comfortable' | 'compact' | 'gallery'

export function LibraryViewSwitch({ gallery, onGallery }: {
  gallery: boolean
  onGallery: (next: boolean) => void
}) {
  const [density, setDensity] = useUiDensity()
  return (
    <FilterRail<DeskView>
      className="view-switch"
      variant="segments"
      label="View"
      value={gallery ? 'gallery' : density}
      options={[
        { value: 'comfortable', label: 'Comfort' },
        { value: 'compact', label: 'Compact' },
        { value: 'gallery', label: 'Gallery' },
      ]}
      onChange={(next) => {
        if (next === 'gallery') {
          onGallery(true)
          return
        }
        onGallery(false)
        setDensity(next)
      }}
    />
  )
}
