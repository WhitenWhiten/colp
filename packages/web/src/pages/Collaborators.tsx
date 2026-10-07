import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { isProductApiError, productClient } from '../api'
import { getSessionSnapshot, subscribeSession } from '../api/sessionStore'
import { useAuth } from '../auth/AuthContext'
import { Breadcrumb } from '../components/Breadcrumb'
import { useToast } from '../components/AppToast'
import { AvatarImage } from '../components/AvatarImage'
import { useConfirm } from '../components/ConfirmModal'
import { LoadingState } from '../components/EmptyState'
import { Icon } from '../components/Icon'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RolePick, type InviteRoleLabel } from '../components/RolePick'
import { RouteState } from '../components/RouteState'
import { formatDate } from '../lib/formatDate'
import { plural } from '../lib/plural'
import { useRouteData } from '../lib/useRouteData'
import '../styles/collab.css'

type MembersPage = Awaited<ReturnType<typeof productClient.listCollectionMembers>>
type GrantRole = 'editor' | 'viewer'

function PermissionMark({ allowed }: { allowed: boolean }) {
  return (
    <span className={allowed ? 'collab-perm-yes' : 'collab-perm-no'}>
      {allowed ? <Icon name="check" /> : null}
      <span className="visually-hidden">{allowed ? 'Allowed' : 'Not allowed'}</span>
    </span>
  )
}

function privateIdentity() {
  const snapshot = getSessionSnapshot()
  return `${snapshot.me?.account.id ?? 'anonymous'}:${snapshot.sessionEpoch}`
}

function toApiRole(label: InviteRoleLabel): GrantRole {
  return label === 'Editor' ? 'editor' : 'viewer'
}

function toUiRole(role: 'owner' | GrantRole): string {
  if (role === 'owner') return 'Owner'
  return role === 'editor' ? 'Editor' : 'Viewer'
}

function inviteName(email: string) {
  return email.split('@')[0] || email
}

export function Collaborators() {
  const { id: collectionId = '' } = useParams()
  const navigate = useNavigate()
  const { bootstrapping } = useAuth()
  const [identity, setIdentity] = useState(privateIdentity)
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [inviteRole, setInviteRole] = useState<InviteRoleLabel>('Editor')
  const removeButtons = useRef(new Map<string, HTMLButtonElement | null>())
  const [busyKeys, setBusyKeys] = useState<Record<string, true>>({})
  const { toast, success, error } = useToast()
  const confirm = useConfirm()

  useEffect(() => subscribeSession(() => setIdentity(privateIdentity())), [])

  // The cache key carries the private identity: a sign-in / sign-out or a
  // security-epoch bump reloads, and one account never paints another's list.
  const route = useRouteData<MembersPage>({
    cacheKey: `collaborators:${collectionId}:${identity}`,
    enabled: !bootstrapping && collectionId !== '',
    load: async (signal) => {
      const data = await productClient.listCollectionMembers(collectionId, { signal, maxRetries: 0 })
      if (data.collection.id !== collectionId) {
        throw new Error(`members page for ${data.collection.id} answered a request for ${collectionId}`)
      }
      return data
    },
    fallbackError: 'Check your connection and try again.',
  })
  const page = route.data ?? null
  const load = route.reload
  const latestPage = useRef(page)
  latestPage.current = page

  /** Functional update against the latest painted page, scoped to this collection. */
  const updatePage = (fn: (current: MembersPage) => MembersPage) => {
    const current = latestPage.current
    if (!current || current.collection.id !== collectionId) return
    const next = fn(current)
    latestPage.current = next
    route.setData(next)
  }

  const mutationIntent = (scope: string) => ({
    intentId: productClient.mutationIntentKey(scope, productClient.newCommandId()),
  })

  const markBusy = (key: string) => setBusyKeys((current) => ({ ...current, [key]: true }))
  const clearBusy = (key: string) => setBusyKeys((current) => {
    const next = { ...current }
    delete next[key]
    return next
  })

  const invite = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = email.trim()
    if (!trimmed || !trimmed.includes('@')) {
      setEmailError('Enter a valid email address')
      return
    }
    setEmailError(null)
    if (!page || busyKeys.invite) return
    const apiRole = toApiRole(inviteRole)
    markBusy('invite')
    try {
      const created = await productClient.inviteCollectionMember(
        collectionId,
        { email: trimmed, role: apiRole },
        page.policyEtag,
        mutationIntent('invite-collection-member'),
      )
      setEmail('')
      success(`Invitation sent as ${inviteRole}`)
      updatePage((current) => ({
        ...current,
        policyEtag: created.policyEtag,
        invites: [
          ...current.invites,
          {
            inviteId: created.inviteId,
            email: trimmed,
            role: created.role,
            createdAt: new Date().toISOString(),
            expiresAt: created.expiresAt,
          },
        ],
      }))
    } catch (err) {
      if (isProductApiError(err) && err.status === 409) {
        error(err.recoveryHint)
        return
      }
      error(isProductApiError(err) ? err.recoveryHint : 'Could not send invitation')
    } finally {
      clearBusy('invite')
    }
  }

  const changeRole = async (subjectId: string, label: InviteRoleLabel) => {
    if (!page || busyKeys[`role:${subjectId}`]) return
    const previous = page.members.find((member) => member.subjectId === subjectId)
    if (!previous || previous.role === 'owner') return
    const nextRole = toApiRole(label)
    if (previous.role === nextRole) return
    const etag = page.policyEtag
    markBusy(`role:${subjectId}`)
    updatePage((current) => ({
      ...current,
      members: current.members.map((member) => (
        member.subjectId === subjectId ? { ...member, role: nextRole } : member
      )),
    }))
    try {
      const result = await productClient.updateCollectionMemberRole(
        collectionId,
        subjectId,
        { role: nextRole },
        etag,
        mutationIntent('update-collection-member-role'),
      )
      toast(`Role changed to ${label}`)
      updatePage((current) => ({
        ...current,
        policyEtag: result.policyEtag,
        members: current.members.map((member) => (
          member.subjectId === subjectId ? { ...member, role: result.role } : member
        )),
      }))
    } catch (err) {
      updatePage((current) => ({
        ...current,
        members: current.members.map((member) => (
          member.subjectId === subjectId ? { ...member, role: previous.role } : member
        )),
      }))
      error(isProductApiError(err) ? err.recoveryHint : 'Could not change role')
    } finally {
      clearBusy(`role:${subjectId}`)
    }
  }

  const confirmRemove = async (kind: 'member' | 'invite', targetId: string) => {
    if (!page || busyKeys[`remove:${targetId}`]) return
    const leaving = kind === 'member' && targetId === page.caller.subjectId
    markBusy(`remove:${targetId}`)
    try {
      if (kind === 'invite') {
        await productClient.revokeCollectionInvite(
          collectionId,
          targetId,
          page.policyEtag,
          mutationIntent('revoke-collection-invite'),
        )
        updatePage((current) => ({
          ...current,
          invites: current.invites.filter((invite) => invite.inviteId !== targetId),
        }))
        toast('Invitation cancelled')
      } else {
        await productClient.removeCollectionMember(
          collectionId,
          targetId,
          page.policyEtag,
          mutationIntent('remove-collection-member'),
        )
        if (leaving) {
          navigate('/library')
          toast('You left the collection')
        } else {
          updatePage((current) => ({
            ...current,
            members: current.members.filter((member) => member.subjectId !== targetId),
          }))
          toast('Collaborator removed')
        }
      }
    } catch (err) {
      error(isProductApiError(err) ? err.recoveryHint : 'Could not remove collaborator')
    } finally {
      clearBusy(`remove:${targetId}`)
    }
  }

  const collectionTitle = page?.collection.title || 'Collection'
  const canManage = page?.caller.canManage === true
  const ownerCount = page?.members.filter((member) => member.role === 'owner').length ?? 0
  const pendingCount = page?.invites.length ?? 0
  const collaboratorCount = (page?.members.length ?? 0) + pendingCount

  // Destructive removals ask through the shared danger modal (Cancel, then
  // the red action); a cancel hands focus back to the row's trigger.
  const requestRemove = async (kind: 'member' | 'invite', rowId: string, isSelf: boolean, name: string) => {
    const ok = await confirm({
      title: isSelf ? 'Leave this collection?' : kind === 'invite' ? `Cancel the invitation for ${name}?` : `Remove ${name}'s access?`,
      body: isSelf ? "You'll lose access." : kind === 'invite' ? 'The invitation link stops working.' : `${name} loses access to this collection.`,
      confirmLabel: isSelf ? 'Leave' : kind === 'invite' ? 'Cancel invitation' : 'Remove',
      cancelLabel: kind === 'invite' ? 'Keep' : 'Cancel',
    })
    if (ok) await confirmRemove(kind, rowId)
    else queueMicrotask(() => removeButtons.current.get(rowId)?.focus())
  }

  const removeControls = (rowId: string, kind: 'member' | 'invite', isSelf: boolean, name: string) => (
    <button type="button" className="btn btn-danger-ghost btn-sm collab-remove" disabled={Boolean(busyKeys[`role:${rowId}`] || busyKeys[`remove:${rowId}`])}
      ref={(node) => { removeButtons.current.set(rowId, node) }}
      aria-label={isSelf ? 'Leave collection' : kind === 'invite' ? `Cancel invitation for ${name}` : `Remove ${name}`}
      onClick={() => void requestRemove(kind, rowId, isSelf, name)}>{isSelf ? 'Leave collection' : kind === 'invite' ? 'Cancel invitation' : 'Remove'}</button>
  )

  return (
    <PageShell variant="grid">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Library', to: '/library' },
              { label: collectionTitle, to: `/library/${collectionId}` },
              { label: 'Collaborators' },
            ]}
          />
        }
        title="Collaborators"
        documentTitle="Collaborators"
        lede="Invite collaborators, choose the narrowest useful role, and review every shared edit."
        actions={
          <>
            <Link to={`/library/${collectionId}/history`} className="btn btn-ghost btn-sm">Version history</Link>
          </>
        }
      />

      {bootstrapping || route.status === 'loading' ? (
        <LoadingState label="Loading collaborators…" />
      ) : route.status === 'auth' ? (
        <RouteState
          kind="auth"
          icon="collection"
          title="Sign in to manage collaborators"
          description="You need to be signed in to manage collaborators."
        />
      ) : route.status === 'forbidden' ? (
        <RouteState
          kind="forbidden"
          icon="collection"
          title="Collaborators are not available"
          description="You do not have access to manage or view members of this collection."
        />
      ) : route.status === 'unavailable' ? (
        <RouteState
          kind="unavailable"
          icon="collection"
          title="Collection not found"
          description="This collection was not found or is not available to this account."
        />
      ) : route.status === 'error' || !page ? (
        <RouteState
          kind="error"
          icon="collection"
          title="Couldn't load collaborators"
          description={route.error ?? 'Check your connection and try again.'}
          onRetry={() => void load()}
        />
      ) : (
        <div className="collab-layout">
          <div>
            {canManage && (
              <form className="collab-invite" noValidate onSubmit={(event) => void invite(event)}>
                <div>
                  <p className="section-label">Invite someone</p>
                  <h2>Add a collaborator</h2>
                  <p>Invitations expire after seven days. Roles can be changed at any time.</p>
                </div>
                <div className="collab-invite-fields">
                  <div className="field">
                    <label htmlFor="invite-email">Email address</label>
                    <input
                      id="invite-email"
                      type="email"
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value)
                        setEmailError(null)
                      }}
                      placeholder="name@example.com"
                      disabled={Boolean(busyKeys.invite)}
                      aria-invalid={emailError ? true : undefined}
                      aria-describedby={emailError ? 'collab-email-error' : undefined}
                    />
                    {emailError && (
                      <p className="field-error" role="alert" id="collab-email-error">{emailError}</p>
                    )}
                  </div>
                  <div className="field">
                    <label id="invite-role-label">Role</label>
                    <RolePick
                      id="invite-role"
                      labelledBy="invite-role-label"
                      value={inviteRole}
                      disabled={Boolean(busyKeys.invite)}
                      onChange={setInviteRole}
                    />
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={Boolean(busyKeys.invite)}>
                    {busyKeys.invite ? 'Sending…' : 'Send invitation'}
                  </button>
                </div>
              </form>
            )}

            <section className="collab-members">
              <div className="section-head section-head--split">
                <div>
                  <p className="section-label">People with access</p>
                  <h2>{plural(collaboratorCount, 'collaborator')}</h2>
                </div>
                <span>{plural(ownerCount, 'owner')} · {pendingCount} pending</span>
              </div>
              <div className="collab-member-list">
                {page.members.map((member) => {
                  const isOwner = member.role === 'owner'
                  const isSelf = member.subjectId === page.caller.subjectId
                  const canRemove = !isOwner && (canManage || (isSelf && page.caller.canLeave))
                  return (
                    <article className="collab-member" key={member.subjectId}>
                      <span className="avatar avatar-md" aria-hidden>
                        <AvatarImage url={member.avatarUrl} initials={member.initials} />
                      </span>
                      <div className="collab-member-copy">
                        <span><strong>{member.displayName}</strong></span>
                        <small>{member.email ? `${member.email} · ` : ''}Joined {formatDate(member.grantedAt)}</small>
                      </div>
                      {isOwner ? (
                        <span className="collab-owner" data-testid="collab-owner">Owner</span>
                      ) : canManage ? (
                        <RolePick
                          label={`Role for ${member.displayName}`}
                          value={toUiRole(member.role) as InviteRoleLabel}
                          disabled={Boolean(busyKeys[`role:${member.subjectId}`])}
                          onChange={(role) => void changeRole(member.subjectId, role)}
                        />
                      ) : (
                        <span className="collab-role">{toUiRole(member.role)}</span>
                      )}
                      {canRemove && removeControls(member.subjectId, 'member', isSelf, member.displayName)}
                    </article>
                  )
                })}
                {page.invites.map((inviteItem) => (
                  <article className="collab-member" key={inviteItem.inviteId}>
                    <span className="avatar avatar-md" aria-hidden>{inviteItem.email.slice(0, 2).toUpperCase()}</span>
                    <div className="collab-member-copy">
                      <span><strong>{inviteName(inviteItem.email)}</strong><em>Pending</em></span>
                      <small>{inviteItem.email} · Invite sent {formatDate(inviteItem.createdAt)}</small>
                      <small>Expires {formatDate(inviteItem.expiresAt)}</small>
                    </div>
                    <span className="collab-role">{toUiRole(inviteItem.role)}</span>
                    {canManage && removeControls(inviteItem.inviteId, 'invite', false, inviteItem.email)}
                  </article>
                ))}
              </div>
            </section>
          </div>

          <aside className="collab-rail">
            <section className="collab-permissions" data-testid="collab-permissions">
              <h3 className="section-label">Role guide</h3>
              <table className="collab-matrix">
                <caption className="visually-hidden">What each role can do</caption>
                <thead>
                  <tr>
                    <th scope="col"><span className="visually-hidden">Role</span></th>
                    <th scope="col">Edit</th>
                    <th scope="col">View</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Editor</th>
                    <td><PermissionMark allowed /></td>
                    <td><PermissionMark allowed /></td>
                  </tr>
                  <tr>
                    <th scope="row">Viewer</th>
                    <td><PermissionMark allowed={false} /></td>
                    <td><PermissionMark allowed /></td>
                  </tr>
                </tbody>
              </table>
            </section>
          </aside>
        </div>
      )}
    </PageShell>
  )
}
