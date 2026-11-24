import { subscriptionDeployment } from '../lib/bookmarkSubscriptionBridge'
import { Link, useSearchParams } from 'react-router-dom'
import { CopyField } from '../components/CopyField'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { Stepper } from '../components/Stepper'
import '../styles/extension.css'

/** INSTALL.md §5: the extension connects to this server by its address. */
function setupSteps(origin: string, storeUrl: string | null) {
  return [
  {
    title: 'Install',
    body: storeUrl ? (
      <>
        <p className="stepper-text">Install the Know-N browser extension from the Chrome Web Store.</p>
        <div className="extension-step-actions">
          <a className="btn btn-primary btn-sm" href={storeUrl} target="_blank" rel="noopener noreferrer">Install extension</a>
        </div>
      </>
    ) : 'Install the Know-N browser extension in your browser.',
  },
  {
    title: 'Connect this server',
    body: (
      <>
        <p className="stepper-text">Open Options → Account → Server in the extension, paste this server’s address, and allow access to this server when asked.</p>
        {origin ? <CopyField className="extension-origin" label="Server address" value={origin} /> : null}
      </>
    ),
  },
  {
    title: 'Sign in',
    body: 'Sign in with the username and password you use here.',
  },
  {
    title: 'Start syncing',
    body: 'Review the first sync and untick any folder you want to keep on this browser only. Repeat in each browser.',
  },
  ]
}

export function Extension({ origin }: { origin?: string } = {}) {
  const [params] = useSearchParams()
  const serverOrigin = origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  const candidate = params.get('return')
  // The source pages that mount SubscribeButton: /c/:slug, /library/*.
  const returnPath = candidate && /^\/(?:library|c)(?:\/|\?|$)/.test(candidate) && !/[\\\u0000-\u001f]/.test(candidate) ? candidate : null
  // D-26: no store listing exists yet — the install link stays a mock until
  // VITE_KNOWN_EXTENSION_STORE_URL points at a real store page.
  const storeUrl = subscriptionDeployment().storeUrl
  const steps = setupSteps(serverOrigin, storeUrl)
  return (
    <PageShell sections>
      <PageSection>
        <PageHead
          as="header"
          layout="split"
          variant="workbench"
          eyebrow="Tools"
          title="Connect a browser"
          documentTitle="Connect a browser"
          lede="The Know-N browser extension keeps a browser’s bookmarks in sync with your library on this server."
          actions={(
            <>
              {storeUrl && <a className="btn btn-primary btn-sm" href={storeUrl} target="_blank" rel="noopener noreferrer">Install extension</a>}
              {returnPath && <Link className="btn btn-secondary btn-sm" to={returnPath}>Return to source and continue setup</Link>}
              <Link to="/sync" className="btn btn-secondary btn-sm">Open sync center</Link>
              <Link to="/import" className="btn btn-secondary btn-sm">Import bookmarks</Link>
            </>
          )}
        />
      </PageSection>

      {/* Steps and permissions side by side from 1100px, like Agents and Import. */}
      <PageSection className="extension-layout">
        <Stepper
          className="panel extension-steps"
          label="Setup steps"
          items={steps.map((s) => ({ key: s.title, title: s.title, body: s.body }))}
        />

        <aside className="extension-aside" aria-label="Permissions">
          <h2>Permissions</h2>
          <ul className="benefit-list">
            <li><Icon name="check" /> Reads and syncs bookmark folders only after you grant permission</li>
            <li><Icon name="check" /> Never uploads folders you keep on the browser</li>
            <li><Icon name="check" /> Syncs only with your library on this server</li>
            <li><Icon name="check" /> Optional: save the page you have open into your library or a browser folder</li>
          </ul>
        </aside>
      </PageSection>
    </PageShell>
  )
}
