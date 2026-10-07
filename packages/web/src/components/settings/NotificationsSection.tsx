import { Link } from 'react-router-dom'
import { isCommunityExposureEnabled } from '../../api'
import { useCommunityNotificationCenter } from '../../lib/useCommunityNotificationCenter'
import type { useNotificationCenter } from '../../lib/useNotificationCenter'

type Props = {
  /** The dialog-level notification center (fetched eagerly on dialog open). */
  notifications: ReturnType<typeof useNotificationCenter>
}

/** Settings → Notifications: in-app preference toggle + link to the center. */
export function NotificationsSection({ notifications }: Props) {
  const communityExposed = isCommunityExposureEnabled()
  const community = useCommunityNotificationCenter({
    enabled: communityExposed,
    includePreference: true,
    limit: 1,
  })

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Notifications</h3>
        <p className="meta">
          How Notification center updates reach you.
        </p>
      </div>
      <div className="stack gap-1">
        {notifications.preference && (
          <div className="toggle-row" data-testid="in-app-preference">
            <div>
              <strong>In-app notifications</strong>
              <span className="meta">Receive Notification center updates.</span>
            </div>
            <div className="row">
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-label="In-app notifications"
                aria-checked={notifications.preference.enabled}
                disabled={notifications.pending !== null}
                onClick={() => notifications.setPreference(!notifications.preference!.enabled)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={notifications.pending !== null}
                onClick={notifications.resetPreference}
              >
                Use default
              </button>
            </div>
          </div>
        )}
        {communityExposed && community.preference && (
          <div className="toggle-row" data-testid="community-preference">
            <div>
              <strong>Community replies</strong>
              <span className="meta">Notify me when someone replies to my comments or targets.</span>
            </div>
            <div className="row">
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-label="Community reply notifications"
                aria-checked={community.preference.data.enabled}
                disabled={community.pending !== null}
                onClick={() => community.setPreference(!community.preference!.data.enabled)}
              />
            </div>
          </div>
        )}
        {community.mutationError ? (
          <p className="field-error" role="alert">Couldn't save your change. Try again.</p>
        ) : null}
        <p className="meta">
          Follow collection updates and in-app delivery are managed here and in the
          notification center. There is no separate product-tips preference.
        </p>
        <Link to="/notifications" className="btn btn-ghost btn-sm">
          Open notification center
        </Link>
      </div>
    </section>
  )
}
