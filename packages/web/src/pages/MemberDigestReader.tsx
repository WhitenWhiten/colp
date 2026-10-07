import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Breadcrumb } from '../components/Breadcrumb'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { SubscribeButton } from '../components/bookmark-subscriptions/SubscribeButton'
import { getMemberDigest, getMemberDigestIssue, MemberDigestError, type MemberDigestIssue, type MemberDigestSeries } from '../api/memberDigestClient'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { usePageMeta } from '../lib/usePageMeta'
import { formatDate } from '../lib/formatDate'
import { MemberDigestContent } from '../components/bookmark-subscriptions/MemberDigestContent'
import '../styles/reports.css'

type View = { identity: string; key: string } & ({ state: 'ready'; data: MemberDigestSeries | MemberDigestIssue } | { state: 'error'; status: number } | { state: 'loading' })
export function MemberDigestReader() {
  const { id = '', editionId } = useParams(), location = useLocation(), auth = useAuth()
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const key = id + '/' + (editionId ?? '')
  const currentScope = useRef(''); currentScope.current = identity + ':' + key
  const [view, setView] = useState<View>({ identity, key, state: 'loading' }), [attempt, setAttempt] = useState(0)
  const [moreBusy, setMoreBusy] = useState(false), [moreError, setMoreError] = useState(false)
  usePageMeta({ robots: 'noindex', canonicalPath: null, description: '' }, 'Member digest — Know-N')
  useEffect(() => {
    const controller = new AbortController(); setView({ identity, key, state: 'loading' }); setMoreError(false); setMoreBusy(false)
    if (!auth.isLoggedIn || auth.bootstrapping) return () => controller.abort()
    const pending = editionId ? getMemberDigestIssue(id, editionId, controller.signal) : getMemberDigest(id, { signal: controller.signal })
    void pending.then(data => { if (!controller.signal.aborted) setView({ identity, key, state: 'ready', data }) }).catch(error => { if (!controller.signal.aborted) setView({ identity, key, state: 'error', status: error instanceof MemberDigestError ? error.status : 0 }) })
    return () => controller.abort()
  }, [id, editionId, identity, key, auth.isLoggedIn, auth.bootstrapping, attempt])
  if (auth.bootstrapping) return <PageShell variant="narrow"><LoadingState label="Checking session…" /></PageShell>
  if (!auth.isLoggedIn) return <PageShell variant="narrow"><EmptyState title="Sign in to read this digest" description="The current account must be a member of this series and able to read its source content." action={<Link className="btn btn-primary" to={'/login?returnTo=' + encodeURIComponent(location.pathname)}>Sign in</Link>} /></PageShell>
  const current = view.identity === identity && view.key === key ? view : null
  if (!current || current.state === 'loading') return <PageShell variant="narrow"><LoadingState label="Loading member digest…" /></PageShell>
  if (current.state === 'error') return <PageShell variant="narrow"><EmptyState role={current.status === 0 || current.status >= 500 ? 'alert' : 'status'} title={current.status === 401 ? 'Sign in again to read this digest' : [403,404].includes(current.status) ? 'Digest unavailable' : "Couldn't load this digest"} description="Series membership and source reading access are checked independently. Draft, withdrawn, archived and unreadable content is not available here." action={current.status === 401 ? <Link className="btn btn-primary" to={'/login?returnTo=' + encodeURIComponent(location.pathname)}>Sign in</Link> : <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAttempt(value => value + 1)}>Try again</button>} suggestions={<Link className="btn btn-ghost btn-sm" to="/library/digests">Back to digests</Link>} /></PageShell>
  const { data } = current, series = data.series, issue = 'edition' in data ? data : null
  const root = '/library/digests/' + encodeURIComponent(id)
  const loadMore = async () => {
    if (!('editions' in data) || !data.nextCursor) return
    const scope = currentScope.current
    setMoreBusy(true); setMoreError(false)
    try { const next = await getMemberDigest(id, { cursor: data.nextCursor }); if (privateSessionIdentity() === identity && currentScope.current === scope) setView({ identity, key, state: 'ready', data: { ...next, editions: [...data.editions, ...next.editions] } }) } catch { if (currentScope.current === scope) setMoreError(true) } finally { if (currentScope.current === scope) setMoreBusy(false) }
  }
  return <PageShell variant="grid"><div className="report-layout"><article className="report-edition">
    <PageHead layout="masthead" breadcrumb={<Breadcrumb items={[{ label: 'Digests', to: '/library/digests' }, ...(issue ? [{ label: series.title, to: root + '/read' }] : []), { label: issue?.edition.title ?? series.title }]} />} title={issue?.edition.title ?? series.title} documentTitle="Member digest" eyebrow="Shared digest" afterTitle={series.owner?.displayName ? <span className="meta">By {series.owner.displayName}</span> : undefined} actions={<SubscribeButton sourceType="digest_series" sourceId={id} />} />
    {issue ? <>
      <p><time dateTime={issue.edition.publishedAt}>{formatDate(issue.edition.publishedAt)}</time> · Live source content</p>
      <MemberDigestContent issue={issue} />
      <Link to={root + '/read'}>All readable issues</Link>
    </> : 'editions' in data && <section aria-label="Readable published issues">
      {data.editions.length === 0 && <EmptyState title="No readable published issues" description="Only published issues whose source you can read are included." />}
      {data.editions.map(edition => <article className="digest-entry" key={edition.editionId}><div className="digest-entry-head"><Link className="digest-entry-title" to={root + '/issues/' + encodeURIComponent(edition.editionId) + '/read'}>{edition.title}</Link><time className="meta" dateTime={edition.publishedAt}>{formatDate(edition.publishedAt)}</time></div></article>)}
      {data.nextCursor && <button type="button" className="btn btn-secondary" disabled={moreBusy} onClick={() => void loadMore()}>More issues</button>}
      {moreError && <p role="alert">Couldn't load more issues.</p>}
    </section>}
  </article></div></PageShell>
}
