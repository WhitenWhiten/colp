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
    title: 'Install',
    body: 'Install the Know-N browser extension from the Chrome Web Store.',
  },
  {
    title: 'Connect this server',
    body: (
      <>
        <p className="stepper-text">In the extension, open Options → Account → Server and enter this server’s address. Grant access to the origin when asked.</p>
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
    body: 'Review the first sync. Every folder syncs with your library; untick any you want to keep on this browser only. Repeat in each browser; they converge within a minute.',
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
          as="header"
          layout="split"
          variant="workbench"
          eyebrow="Tools"
          title="Connect a browser"
          documentTitle="Connect a browser"
          lede="The Know-N browser extension keeps a browser’s bookmarks in sync with your library on this server. Any folder can stay on the browser only; conflicts are kept for you to resolve."
          actions={(
            <>
              {storeUrl && <a className="btn btn-primary btn-sm" href={storeUrl} target="_blank" rel="noopener noreferrer">Install extension</a>}
              {returnPath && <Link className="btn btn-secondary btn-sm" to={returnPath}>Return to source and continue setup</Link>}
              <Link to="/sync" className="btn btn-secondary btn-sm">Open sync center</Link>
              <Link to="/import" className="btn btn-ghost btn-sm">Import bookmarks</Link>
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
            <li><Icon name="check" /> Read bookmark folders after you grant bookmark access</li>
            <li><Icon name="check" /> Never uploads folders you keep on the browser</li>
            <li><Icon name="check" /> Syncs only with your library on this server</li>
            <li><Icon name="check" /> Optional: save the page you have open into your library</li>
            <li><Icon name="check" /> Optional: allow bookmark access so saves can land in a browser folder</li>
          </ul>
        </aside>
      </PageSection>
    </PageShell>
  )
}
