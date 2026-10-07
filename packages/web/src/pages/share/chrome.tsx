import { Link } from 'react-router-dom'

export function ShareProductStrip() {
  return (
    <section className="share-strip" data-testid="share-strip">
      <div className="share-strip-inner">
        <p className="eyebrow">Why Know-N</p>
        <p className="share-strip-line">
          Share knowledge the way you actually collect it: selective, structured, and still readable.
        </p>
        <div className="share-strip-points">
          <span>Extension sync</span>
          <span>Source-aware cards</span>
          <span>Follow collection updates</span>
          <span>Collection embeds</span>
        </div>
      </div>
    </section>
  )
}

export function ShareFooterCta({ collectionSlug }: { collectionSlug?: string }) {
  return (
    <section className="share-footer-cta">
      <div className="share-footer-cta-inner">
        <div>
          <p className="eyebrow">Start</p>
          <h2 className="display display-sm">
            {collectionSlug ? 'Open the path, or publish your own' : 'Make your bookmarks worth following'}
          </h2>
          <p className="lede mt-3">
            Sync from the browser, shape a collection, and ship a share link in minutes.
          </p>
        </div>
        <div className="share-cta">
          {collectionSlug ? (
            <>
              <Link to="/register" className="btn btn-primary btn-lg">
                Get started
              </Link>
              <Link to={`/c/${collectionSlug}`} className="btn btn-secondary btn-lg">
                Open collection
              </Link>
            </>
          ) : (
            <>
              <Link to="/onboarding" className="btn btn-primary btn-lg">
                Sync bookmarks
              </Link>
              <Link to="/register" className="btn btn-secondary btn-lg">
                Get started
              </Link>
            </>
          )}
          <Link to="/extension" className="btn btn-ghost btn-lg">
            Get extension
          </Link>
        </div>
      </div>
    </section>
  )
}
