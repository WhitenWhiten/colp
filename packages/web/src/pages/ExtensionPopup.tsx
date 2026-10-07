import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { BrandName } from '../components/Brand'
import { EmptyState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { useOwnedCollections } from '../lib/useOwnedCollections'
import { loginPath } from '../lib/chrome'
// Route-owned stylesheet (see main.tsx); ships with this chunk.
import '../styles/extension.css'

const SIGN_IN_MESSAGE = 'Sign in to view your collections'

export function ExtensionPopup() {
  const { user } = useAuth()
  const location = useLocation()
  const owned = useOwnedCollections()
  const handle = user?.handle ? `@${user.handle}` : null
  // The real popup opens on the collection it last saved to; the preview
  // shows the first owned one.
  const selectedTitle = owned.items[0]?.collection.title ?? null
  const needsSignIn = owned.message === SIGN_IN_MESSAGE

  return (
    <div className="ext-popup-page">
      <div className="ext-popup-stage">
        <PageHead
          eyebrow="Browser extension"
          title="Capture popup"
          documentTitle="Extension popup"
          lede="A labeled preview of the installed capture popup. Name and URL stay empty here — only the extension can read the tab you have open."
        >
          <div className="row ext-popup-links">
            <Link to="/extension" className="btn btn-secondary btn-sm">
              Install page
            </Link>
            <Link to="/classify" className="btn btn-ghost btn-sm">
              Full classify queue
            </Link>
            <Link to="/sync" className="btn btn-ghost btn-sm">
              Sync center
            </Link>
          </div>
        </PageHead>

        <div className="ext-popup-chrome" role="dialog" aria-label="Know-N extension">
          <div className="ext-popup-bar">
            <strong><BrandName /></strong>
            {handle && (
              <span className="meta ext-popup-user handle-text">
                {handle}
              </span>
            )}
          </div>
          <div className="ext-popup-body">
            <div className="ext-popup-permission">
              <span>Allow bookmark access so the extension can save pages.</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled
                aria-label="Allow (preview only)"
              >
                Allow
              </button>
            </div>
            {/* Same page card as the real popup: icon, title and URL, no field labels. */}
            <div className="ext-tab-preview" data-testid="ext-tab-preview">
              <Icon name="file" />
              <strong>Page title from your open tab</strong>
              <span className="meta">https://example.com/article</span>
            </div>
            <p className="meta m-0">
              Preview only. The installed extension reads the page you have open.
            </p>

            {owned.state === 'ready' && owned.items.length > 0 ? (
              <>
                <div className="ext-popup-dest" data-testid="ext-popup-dest">
                  <span id="ext-save-dest-label">Save to</span>
                  <span>{selectedTitle ?? 'Choose a collection'} › Bookmarks bar</span>
                  <Icon name="chevron-down" />
                </div>
                <p className="meta m-0 ext-popup-local">
                  Folders that don't sync to Know-N can still save on this device.
                </p>

                <div className="ext-popup-meta">
                  <Link to="/extension" className="btn btn-ghost btn-sm ext-popup-more">
                    <Icon name="settings" />
                    More options
                  </Link>
                </div>

                <div className="row gap-hair-45">
                  <Link to="/extension" className="btn btn-primary ext-popup-save">
                    Install the extension
                  </Link>
                  <Link to="/classify" className="btn btn-secondary btn-sm">
                    Queue
                  </Link>
                </div>
                <p className="meta m-0">
                  Saving the current tab needs the browser extension.
                </p>
              </>
            ) : (
              <EmptyState
                role={owned.state === 'error' && !needsSignIn ? 'alert' : 'status'}
                icon="folder"
                title={owned.message}
                action={
                  needsSignIn ? (
                    <Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary btn-sm">Sign in</Link>
                  ) : owned.state === 'error' ? (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => { void owned.reload() }}>
                      Try again
                    </button>
                  ) : (
                    <Link to="/extension" className="btn btn-secondary btn-sm">Install page</Link>
                  )
                }
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
