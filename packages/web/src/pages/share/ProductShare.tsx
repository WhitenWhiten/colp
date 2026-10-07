import { Link } from 'react-router-dom'
import { useExplorePreview } from '../../lib/useExplorePreview'
import { ShareFooterCta, ShareProductStrip } from './chrome'
import { Icon } from '../../components/Icon'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { usePageMeta } from '../../lib/usePageMeta'
import { plural } from '../../lib/plural'

const productBeats = [
  {
    n: '01',
    title: 'Turn folders into paths',
    body: 'Private browser folders become public collections with a curator voice, tags, and a clear reading order.',
  },
  {
    n: '02',
    title: 'Share one link',
    body: 'Send a Know-N URL. Recipients open Board, List, or Graph, then follow future updates.',
  },
  {
    n: '03',
    title: 'Stay source-aware',
    body: 'GitHub, arXiv, Zhihu, Substack, YouTube: each card surfaces the signals people actually scan for.',
  },
]

const reasons = [
  { title: 'For learners', body: 'Skip scattered tabs. Follow a path someone already walked.' },
  { title: 'For curators', body: 'Publish once. Grow followers and keep a living collection.' },
  { title: 'For teams', body: 'Share onboarding stacks, research trails, and design references without another wiki.' },
]

export function ProductShare() {
  useDocumentTitle('Share')
  usePageMeta({
    description: 'Share curated bookmark collections and learning paths with one Know-N link.',
    canonicalPath: '/share',
  }, 'Share — Know-N')
  const { items: spotlight } = useExplorePreview(3)
  const first = spotlight[0]
  const liveShareTo = first ? `/share/${first.slug}` : '/explore'

  return (
    <div className="share-page" data-testid="share-page">
      <section className="share-hero" data-testid="share-hero">
        <div className="share-hero-inner share-hero-inner--product">
          <div className="share-hero-copy rise">
            <p className="eyebrow">Know-N · Share</p>
            <h1 className="display display-lg">
              Your bookmarks,{' '}
              <span className="serif-em">shared as paths</span>
            </h1>
            <p className="lede">
              Know-N turns private folders into public collections people can follow and study. One link.
              Source-aware cards for shared bookmarks, not another dump of tabs.
            </p>
            <div className="share-cta">
              <Link to="/onboarding" className="btn btn-primary btn-lg">
                Publish your first path
              </Link>
              <Link to={liveShareTo} className="btn btn-secondary btn-lg">
                See a live share page
              </Link>
              <Link to="/explore" className="btn btn-ghost btn-lg">
                Browse collections
              </Link>
            </div>
            <div className="share-signal-row" aria-label="Share benefits">
              <div>
                <strong>One URL</strong>
                <span>Portable share link</span>
              </div>
              <div>
                <strong>Board · List · Graph</strong>
                <span>Three ways to read</span>
              </div>
              <div>
                <strong>Stay current</strong>
                <span>Follow updates</span>
              </div>
            </div>
          </div>

          <div className="share-promo-stage" aria-hidden inert>
            <div className="share-promo-card share-promo-card--main">
              <span className="chip chip-accent">Shared path</span>
              <strong>{first?.title ?? 'Shared collection'}</strong>
              <span className="meta">
                {first ? `${first.curator} · ${plural(first.links, 'link')}` : 'One URL · Board · Graph'}
              </span>
              <div className="share-promo-mini-rows">
                <span>GitHub · radix-ui / primitives</span>
                <span>YouTube · Inventing on Principle</span>
                <span>Article · Layout as system</span>
              </div>
            </div>
            <div className="share-promo-card share-promo-card--float">
              <span className="eyebrow m-0">
                Link
              </span>
              <code>know-n.com/share/…</code>
            </div>
          </div>
        </div>
      </section>

      <section className="share-section">
        <div className="share-section-inner">
          <div className="section-head section-head--flush">
            <div>
              <p className="eyebrow">How sharing works</p>
              <h2 className="display display-sm">From private folder to public path</h2>
            </div>
          </div>
          <div className="share-beats">
            {productBeats.map((beat) => (
              <article key={beat.n} className="share-beat">
                <span className="share-beat-n" aria-hidden>
                  {beat.n}
                </span>
                <h3>{beat.title}</h3>
                <p>{beat.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="share-section share-section--muted">
        <div className="share-section-inner">
          <div className="section-head section-head--flush">
            <div>
              <p className="eyebrow">Who it is for</p>
              <h2 className="display display-sm">Built for people who curate</h2>
            </div>
          </div>
          <div className="share-reasons">
            {reasons.map((reason) => (
              <article key={reason.title} className="share-reason">
                <h3>{reason.title}</h3>
                <p>{reason.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="share-section">
        <div className="share-section-inner">
          <div className="section-head section-head--flush">
            <div>
              <p className="eyebrow">Spotlight</p>
              <h2 className="display display-sm">Collections ready to share</h2>
            </div>
            <Link to="/explore" className="btn btn-secondary btn-sm">
              Explore all
            </Link>
          </div>
          <div className="share-spotlight-grid" data-testid="share-spotlight-grid">
            {spotlight.map((item) => (
              <Link key={item.id} to={`/share/${item.slug}`} className="share-spotlight-card">
                <div>
                  <div className="share-tag-row">
                    {item.tags.slice(0, 2).map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
                <div className="share-spotlight-foot">
                  <span className="meta">
                    {item.curator} · {plural(item.links, 'link')}
                  </span>
                  <span className="share-spotlight-cta">View share page <Icon name="arrow-right" /></span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <ShareProductStrip />
      <ShareFooterCta />
    </div>
  )
}
