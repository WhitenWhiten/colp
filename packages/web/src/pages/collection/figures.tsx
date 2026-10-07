import { memo } from 'react'
import { useCountUp } from '../../lib/useCountUp'
import { pluralNoun } from '../../lib/plural'
import { formatCompactCount } from './format'

/**
 * The masthead's vital signs: a numeral over its noun. R15-32: each figure
 * is gated and pluralised on its real total, so the folder figure is in the
 * first paint instead of popping in once the count-up passes zero, and the
 * count-up re-renders only this list, not the whole page.
 */
export const CollectionFigures = memo(function CollectionFigures({ bookmarks, folders, views, followers }: {
  bookmarks: number
  folders: number
  views: number
  followers: number | null
}) {
  const bookmarkCount = useCountUp(bookmarks)
  const folderCount = useCountUp(folders)
  return (
    <ul className="collection-figures" aria-label="Collection figures">
      <li><strong data-collection-field="bookmarks">{bookmarkCount}</strong> <span>{pluralNoun(bookmarks, 'bookmark')}</span></li>
      {folders > 0 && (
        <li><strong>{folderCount}</strong> <span>{pluralNoun(folders, 'folder')}</span></li>
      )}
      {views > 0 && (
        <li>
          <strong data-collection-field="views">{formatCompactCount(views)}</strong> <span>{pluralNoun(views, 'view')}</span>
        </li>
      )}
      {followers != null && followers > 0 && (
        <li>
          <strong data-collection-field="followers">{formatCompactCount(followers)}</strong>
          {' '}<span>{pluralNoun(followers, 'follower')}</span>
        </li>
      )}
    </ul>
  )
})
