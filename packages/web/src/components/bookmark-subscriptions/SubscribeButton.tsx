import { SubscriptionOptionsMenu } from './SubscriptionFollowButton'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { openBookmarkSubscription, subscriptionDeployment, type BookmarkSubscriptionSource } from '../../lib/bookmarkSubscriptionBridge'
import { useToast } from '../AppToast'
import { Icon } from '../Icon'
import { Modal } from '../Modal'
import { BodyPortal } from '../BodyPortal'
import { Stepper } from '../Stepper'

/** The control mounts in masthead action rows and list entries, so it only ever
    renders buttons in place: the hand-off result goes to a toast and the setup
    guidance to a dialog, never as loose text beside the button. */
export function SubscribeButton(source: BookmarkSubscriptionSource) {
  const location = useLocation()
  const { toast } = useToast()
  const [opening, setOpening] = useState(false)
  const [setup, setSetup] = useState<'closed' | 'open' | 'retried'>('closed')
  const request = useRef(crypto.randomUUID())
  const version = useRef(0)
  useEffect(() => { version.current++; request.current = crypto.randomUUID(); setOpening(false); setSetup('closed'); const epoch = version.current; return () => { version.current = epoch + 1 } }, [source.sourceId, source.sourceType])
  const open = async (retry: boolean) => {
    const current = version.current
    setOpening(true)
    const result = await openBookmarkSubscription(source, request.current)
    if (current !== version.current) return
    setOpening(false)
    if (result === 'accepted') { setSetup('closed'); toast("Continue setup in the extension. Bookmarks aren't on yet.") }
    else setSetup(retry ? 'retried' : 'open')
  }
  const store = subscriptionDeployment().storeUrl
  return (
    <span className="subscribe-control" data-testid="subscribe-control">
      <button type="button" className="btn btn-ghost btn-sm" disabled={opening} onClick={() => void open(false)}>
        {opening && setup === 'closed' ? 'Opening extension…' : 'Subscribe to bookmarks'}
      </button>
      <SubscriptionOptionsMenu source={source} />
      {/* Portaled so .page-head p and phone .social-actions .btn rules cannot restyle the dialog. */}
      <BodyPortal>
        <Modal open={setup !== 'closed'} onClose={() => setSetup('closed')} label="Continue in the extension" title="Continue in the extension">
          <p className="subscribe-setup-lede">Bookmark subscriptions are set up in the Know-N browser extension, and it didn't respond in this browser.</p>
          <Stepper
            className="subscribe-setup-steps"
            label="Extension setup steps"
            items={[
              store
                ? { key: 'install', title: 'Install', body: 'Add the Know-N extension to this browser. Skip this if it is already installed.' }
                : { key: 'install', title: 'Set up', body: 'Open Extension setup to add the Know-N extension to this browser.' },
              { key: 'sign-in', title: 'Sign in', body: 'Open the extension and sign in with this account.' },
              store
                ? { key: 'continue', title: 'Continue', body: 'Come back to this tab and choose Continue in extension.' }
                : { key: 'continue', title: 'Continue', body: 'Come back to this page and choose Subscribe to bookmarks again.' },
            ]}
          />
          {setup === 'retried' && !opening && <p className="field-error subscribe-setup-alert" role="alert"><Icon name="alert" />The extension still didn't respond. Check that it is installed and signed in, then try again.</p>}
          <div className="row row-wrap subscribe-setup-actions">
            {store
              ? <a className="btn btn-secondary" href={store} target="_blank" rel="noopener noreferrer">Install extension</a>
              : <Link className="btn btn-secondary" to={'/extension?return=' + encodeURIComponent(location.pathname + location.search)}>Extension setup</Link>}
            <button type="button" className="btn btn-primary" disabled={opening} onClick={() => void open(true)}>{opening ? 'Opening extension…' : 'Continue in extension'}</button>
          </div>
        </Modal>
      </BodyPortal>
    </span>
  )
}
