import { subscriptionDeployment } from '../lib/bookmarkSubscriptionBridge'
import { Link, useSearchParams } from 'react-router-dom'
import { CopyField } from '../components/CopyField'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { Stepper } from '../components/Stepper'
import '../styles/extension.css'

/** INSTALL.md §5: the extension connects to this server by its origin. */
function setupSteps(origin: string) {
  return [
  {
    n: '01',
    title: 'Install',
    body: 'Install the Know-N browser extension from the Chrome Web Store.',
  },
  {
    n: '02',
    title: 'Connect this server',
    body: (
      <>
        <p className="stepper-text">In the extension, open Options → Account → Server and enter this server’s address. Grant access to the origin when asked.</p>
        {origin ? <CopyField className="extension-origin" label="Server address" value={origin} /> : null}
      </>
    ),
  },
  {
    n: '03',
    title: 'Sign in',
    body: 'Sign in with the username and password you use here.',
  },
  {
    n: '04',
    title: 'Choose folders',
    body: 'Pick a collection and the browser folders to sync. Repeat in each browser; they converge within a minute.',
  },
  ]
}

export function Extension({ origin }: { origin?: string } = {}) {
  const [params] = useSearchParams()
  const serverOrigin = origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  const steps = setupSteps(serverOrigin)
  const candidate = params.get('return')
  // The source pages that mount SubscribeButton: /c/:slug, /library/*.
  const returnPath = candidate && /^\/(?:library|c)(?:\/|\?|$)/.test(candidate) && !/[\\\u0000-\u001f]/.test(candidate) ? candidate : null
  // D-26: no store listing exists yet — the install link stays a mock until
  // VITE_KNOWN_EXTENSION_STORE_URL points at a real store page.
  const storeUrl = subscriptionDeployment().storeUrl
  return (
    <PageShell sections>
      <PageSection>
        <PageHead
          eyebrow="Tools"
          title="Connect a browser"
          documentTitle="Extension"
          lede="The Know-N browser extension syncs browser folders into collections you own on this server. You choose the folders; conflicts are kept for you to resolve."
        />
        <div className="cta-row extension-cta">
          {storeUrl && <a className="btn btn-primary btn-lg" href={storeUrl} target="_blank" rel="noopener noreferrer">Install extension</a>}
          {returnPath && <Link className="btn btn-secondary" to={returnPath}>Return to source and continue setup</Link>}
          <Link to="/sync" className="btn btn-secondary">
            Open sync center
          </Link>
          <Link to="/import" className="btn btn-ghost">
            Import bookmarks
          </Link>
        </div>
      </PageSection>

      <Stepper
        className="page-shell-inner panel extension-steps"
        label="Setup steps"
        items={steps.map((s) => ({ key: s.n, index: s.n, title: s.title, body: s.body }))}
      />

      <PageSection className="panel panel-pad" role="region" aria-label="Permissions">
        <h3 className="section-label">Permissions</h3>
        <ul className="benefit-list">
          <li><Icon name="check" /> Read bookmark folders after you grant bookmark access</li>
          <li><Icon name="check" /> Optional: save the page you have open into a collection you own</li>
          <li><Icon name="check" /> Optional: allow bookmark access so saves can land in a browser folder</li>
          <li><Icon name="check" /> Never uploads folders you did not select</li>
          <li><Icon name="check" /> Sync uses collections you own on this server</li>
        </ul>
      </PageSection>
    </PageShell>
  )
}
