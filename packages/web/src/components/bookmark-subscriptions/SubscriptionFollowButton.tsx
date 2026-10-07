import { useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'
import { popoverStyle } from '../../lib/anchorPopover'
import type { BookmarkSubscriptionSource } from '../../lib/bookmarkSubscriptionBridge'
import { onMenuLinkKeyDown } from '../../lib/menuKeys'
import { useAnchoredMenu } from '../../lib/useAnchoredMenu'
import { FollowWorkflowButton, type FollowWorkflowView } from '../FollowWorkflowButton'
import { Icon } from '../Icon'
import { SourceExitDialog } from './SourceExitDialog'
export function SubscriptionFollowButton({ source, workflow, className, testId }: { source: BookmarkSubscriptionSource; workflow: FollowWorkflowView; className?: string; testId: string }) {
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity), scope = identity + ':' + source.sourceType + ':' + source.sourceId
  const [opened, setOpened] = useState<string | null>(null)
  const toggle = async () => { if (workflow.following) setOpened(scope); else await workflow.toggle() }
  return <><FollowWorkflowButton workflow={{ ...workflow, toggle }} className={className} testId={testId} />{opened === scope && <SourceExitDialog key={scope} source={source} unfollow onClose={() => setOpened(null)} onCommitted={workflow.refresh} />}</>
}
/** The chevron half of the Subscribe control. Subscribing happens in the
    extension; the web side only ends subscriptions, so the one destructive
    action sits behind a worded menu item rather than a settings gear that
    never showed settings. */
export function SubscriptionOptionsMenu({ source }: { source: BookmarkSubscriptionSource }) {
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity), scope = identity + ':' + source.sourceType + ':' + source.sourceId
  const [opened, setOpened] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const triggerId = useId()
  const menu = useAnchoredMenu({ exemptRefs: [triggerRef] })
  if (!identity.startsWith('session:')) return null
  const toggle = () => menu.open ? menu.close() : menu.openAnchored(() => triggerRef.current?.getBoundingClientRect() ?? null, { width: 232, maxHeight: 200, align: 'end' })
  const unsubscribe = () => { menu.close(); triggerRef.current?.focus(); setOpened(scope) }
  return <>
    <button type="button" ref={triggerRef} id={triggerId} className="btn btn-ghost btn-sm subscribe-options" aria-haspopup="menu" aria-expanded={menu.open} aria-label="Bookmark subscription options" title="Bookmark subscription options" onClick={toggle}><Icon name="chevron-down" /></button>
    {menu.open && menu.anchorPos && createPortal(<div className="nav-dropdown subscribe-options-menu" role="menu" aria-labelledby={triggerId} tabIndex={-1} ref={menu.menuRef} style={popoverStyle(menu.anchorPos)}>
      <Link to="/extension" role="menuitem" tabIndex={-1} onKeyDown={onMenuLinkKeyDown} onClick={() => menu.close()}>Extension setup</Link>
      <button type="button" role="menuitem" tabIndex={-1} className="subscribe-options-danger" onClick={unsubscribe}>Unsubscribe on all browsers…</button>
    </div>, document.body)}
    {opened === scope && <SourceExitDialog key={scope} source={source} unfollow={false} onClose={() => setOpened(null)} />}
  </>
}
