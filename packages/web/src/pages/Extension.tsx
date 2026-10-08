import { DEMO_ROUTES_ENABLED } from '../lib/demoRoutes'
import { isSelfHostedEdition, isSelfHostedPathEnabled } from '../lib/edition'
import { subscriptionDeployment } from '../lib/bookmarkSubscriptionBridge'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { Stepper } from '../components/Stepper'
// Shared with the popup preview route (see main.tsx); ships in that chunk.
import '../styles/extension.css'

const steps = [
  {
    n: '01',
    title: 'Install',
    body: 'Install the Know-N browser extension, then return here to finish setup.',
  },
  {
    n: '02',
    title: 'Sign in',
    body: 'Connect the same account you use on know-n.com so folders can sync into collections you own.',
  },
  {
    n: '03',
    title: 'Choose folders',
    body: 'Select which local folders leave the browser. Unsorted can stay private.',
  },
  {
    n: '04',
    title: 'Save pages',
    body: 'The toolbar popup saves the tab you have open into a collection you own.',
  },
]

/** INSTALL.md §5: the extension connects to this server by its origin. */
const selfHostedSteps = [
  {
    n: '01',
    title: 'Install',
    body: 'Install the Know-N browser extension from the Chrome Web Store.',
  },
  {
    n: '02',
    title: 'Connect this server',
    body: 'In the extension, open Options → Account → Server and enter this page’s address. Grant access to the origin when asked.',
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

export function Extension() {
  const selfHosted = isSelfHostedEdition()
  const [params] = useSearchParams()
  const candidate = params.get('return')
  // The source pages that mount SubscribeButton: /c/:slug, /reports/*, /library/*.
  const returnPath = candidate && /^\/(?:library|c|reports)(?:\/|\?|$)/.test(candidate) && !/[\\\u0000-\u001f]/.test(candidate) ? candidate : null
  // D-26: no store listing exists yet — the install link stays a mock until
  // VITE_KNOWN_EXTENSION_STORE_URL points at a real store page.
  const storeUrl = subscriptionDeployment().storeUrl
  return (
    <PageShell sections>
      <PageSection>
        <PageHead
          eyebrow="Tools"
          title={selfHosted ? 'Connect a browser' : 'Install the Know-N extension'}
          documentTitle="Extension"
          lede={selfHosted
            ? 'The Know-N browser extension syncs browser folders into collections you own on this server. You choose the folders; conflicts are kept for you to resolve.'
            : 'Sync local bookmarks into collections you own. Selective folders, conflict-aware, under your control. Read-only subscriptions can also bring followed and shared content into a separate browser folder.'}
        />
        <div className="cta-row">
          {storeUrl && <a className="btn btn-primary btn-lg" href={storeUrl} target="_blank" rel="noopener noreferrer">Install extension</a>}
          {returnPath && <Link className="btn btn-secondary btn-lg" to={returnPath}>Return to source and continue setup</Link>}
          {isSelfHostedPathEnabled('/onboarding') && (
            <Link to="/onboarding" className="btn btn-primary btn-lg">
              Open setup wizard
            </Link>
          )}
          {DEMO_ROUTES_ENABLED && !selfHosted && (
            <Link to="/extension/popup" className="btn btn-secondary btn-lg">
              Preview capture popup
            </Link>
          )}
          <Link to="/sync" className={selfHosted ? 'btn btn-secondary btn-lg' : 'btn btn-ghost btn-lg'}>
            Open sync center
          </Link>
        </div>
      </PageSection>

      <Stepper
        className="page-shell-inner panel extension-steps"
        label="Setup steps"
        items={(selfHosted ? selfHostedSteps : steps).map((s) => ({ key: s.n, index: s.n, title: s.title, body: s.body }))}
      />

      <PageSection className="panel panel-pad" role="region" aria-label="Permissions">
        <h3 className="section-label">Permissions</h3>
        <ul className="benefit-list">
          <li><Icon name="check" /> Read bookmark folders after you grant bookmark access</li>
          <li><Icon name="check" /> Optional: save the page you have open into a collection you own</li>
          <li><Icon name="check" /> Optional: allow bookmark access so saves can land in a browser folder</li>
          <li><Icon name="check" /> Never uploads folders you did not select</li>
          <li><Icon name="check" /> {selfHosted
            ? 'Sync uses collections you own on this server'
            : 'Personal sync uses collections you own; read-only subscriptions never upload edits to their source'}</li>
        </ul>
        <div className="row extension-actions">
          {isSelfHostedPathEnabled('/classify') && (
            <Link to="/classify" className="btn btn-ghost btn-sm">
              Classify inbox
            </Link>
          )}
          <Link to="/import" className="btn btn-ghost btn-sm">
            Import bookmarks
          </Link>
        </div>
      </PageSection>
    </PageShell>
  )
}
