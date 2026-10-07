import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { getSharedMemberDigests, type MemberDigestSource } from '../../api/memberDigestClient'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'
import { EmptyState } from '../EmptyState'
import { SubscribeButton } from './SubscribeButton'
export function SharedDigests() {
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const [state, setState] = useState<{ identity: string; items: MemberDigestSource[]; cursor: string | null; error: boolean }>({ identity, items: [], cursor: null, error: false })
  const [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setState({ identity, items: [], cursor: null, error: false })
    void getSharedMemberDigests({ signal: controller.signal }).then(page => { if (!controller.signal.aborted) setState({ identity, items: page.items, cursor: page.nextCursor, error: false }) }).catch(() => { if (!controller.signal.aborted) setState({ identity, items: [], cursor: null, error: true }) }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [identity, attempt])
  const current = state.identity === identity ? state : { identity, items: [], cursor: null, error: false }
  const more = async () => { if (!current.cursor) return; setBusy(true); try { const page = await getSharedMemberDigests({ cursor: current.cursor }); if (privateSessionIdentity() === identity) setState({ identity, items: [...current.items, ...page.items], cursor: page.nextCursor, error: false }) } catch { setState(value => ({ ...value, error: true })) } finally { setBusy(false) } }
  return <section className="shared-digests" aria-label="Digests shared with me"><h2>Shared with me</h2><p className="shared-digests-note">Active series members can read published issues when the source collection is also readable.</p>
    {current.items.map(source => <article className="digest-entry" key={source.sourceId}><Link className="digest-entry-title" to={'/library/digests/' + encodeURIComponent(source.sourceId) + '/read'}>{source.title}</Link><SubscribeButton sourceType="digest_series" sourceId={source.sourceId} /></article>)}
    {busy && <p className="shared-digests-note" role="status">Loading shared digests…</p>}
    {!busy && !current.error && current.items.length === 0 && <p className="shared-digests-note">No shared readable digests.</p>}
    {current.error && <EmptyState className="empty-state--compact" role="alert" icon="alert" title="Couldn't load shared digests" description="Check your connection and try again." action={<button className="btn btn-secondary btn-sm" type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>} />}
    {current.cursor && <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => void more()}>More shared digests</button>}
  </section>
}
