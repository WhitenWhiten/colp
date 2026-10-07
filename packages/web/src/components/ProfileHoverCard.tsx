import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import {
  isFollowExposureEnabled,
  productClient,
  type PublicProfileView,
} from '../api'
import { useAuth } from '../auth/AuthContext'
import { anchorPopover, popoverStyle, type AnchorPopoverPos } from '../lib/anchorPopover'
import { profileInitials } from '../lib/initials'
import { EXIT_DURATION_FAST_MS, useExitAnimation } from '../lib/useExitAnimation'
import { AvatarImage } from './AvatarImage'
import { FollowButton } from './FollowButton'

const OPEN_DELAY_MS = 240
const CLOSE_DELAY_MS = 140
const CARD_WIDTH = 340
const PROFILE_PAGE_LIMIT = 24
const FOLLOW_PAGE_LIMIT = 100
const FOLLOW_INVALIDATION_KEY = 'known.follow.invalidate.v1'
const FOLLOW_CHANNEL_NAME = 'known.follow.v1'

type HoverProfile = {
  profile: PublicProfileView
  collectionCount: string | null
}

type FollowCounts = {
  followers: string | null
  following: string | null
}

type HoverState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; value: HoverProfile }

/* Session caches shared by every hover trigger for the same profile, so
   re-hovering a curator never refetches. Failed reads are evicted to let the
   next hover retry. */
const profileCache = new Map<string, Promise<HoverProfile>>()
const countsCache = new Map<string, FollowCounts>()

function countLabel(count: number, nextCursor: string | null): string | null {
  return nextCursor ? null : String(count)
}

function loadHoverProfile(handle: string): Promise<HoverProfile> {
  const cached = profileCache.get(handle)
  if (cached) return cached
  const request = productClient
    .getPublicProfilePage(handle, { limit: PROFILE_PAGE_LIMIT }, { maxRetries: 0 })
    .then((page): HoverProfile => ({
      profile: page.profile,
      collectionCount: page.page.hasMore
        ? null
        : String(page.collections.length),
    }))
    .catch((error: unknown) => {
      profileCache.delete(handle)
      throw error
    })
  profileCache.set(handle, request)
  return request
}

/** Follower/following counts, readable only for signed-in principals. Fetched
   once per profile while a card is open; the same invalidation channel the
   Profile page uses busts the cache after any follow mutation. */
function useFollowCounts(profileId: string | null, active: boolean): FollowCounts | null {
  const { isLoggedIn, bootstrapping } = useAuth()
  const readable = !!profileId && isFollowExposureEnabled() && isLoggedIn && !bootstrapping
  const [counts, setCounts] = useState<FollowCounts | null>(
    () => (profileId ? countsCache.get(profileId) ?? null : null),
  )
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!readable || !profileId) return
    const invalidate = (candidate: string | null) => {
      if (candidate === profileId || candidate?.startsWith(`${profileId}:`)) {
        countsCache.delete(profileId)
        setCounts(null)
        setReloadKey((value) => value + 1)
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === FOLLOW_INVALIDATION_KEY) invalidate(event.newValue)
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(FOLLOW_CHANNEL_NAME)
    if (channel) {
      channel.onmessage = (event: MessageEvent<{ targetProfileId?: string }>) => {
        invalidate(event.data?.targetProfileId ?? null)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      channel?.close()
    }
  }, [readable, profileId])

  useEffect(() => {
    if (!readable || !profileId || !active) return
    const cached = countsCache.get(profileId)
    if (cached) {
      setCounts(cached)
      return
    }
    let live = true
    const controller = new AbortController()
    void Promise.all([
      productClient.getFollowersPage(profileId, { limit: FOLLOW_PAGE_LIMIT }, { signal: controller.signal, maxRetries: 0 }),
      productClient.getFollowingPage(profileId, { limit: FOLLOW_PAGE_LIMIT }, { signal: controller.signal, maxRetries: 0 }),
    ]).then(([followersPage, followingPage]) => {
      if (!live) return
      const next = {
        followers: countLabel(followersPage.items.length, followersPage.nextCursor),
        following: countLabel(followingPage.items.length, followingPage.nextCursor),
      }
      countsCache.set(profileId, next)
      setCounts(next)
    }).catch(() => {
      /* Counts are supplementary; the card stays useful without them. */
    })
    return () => {
      live = false
      controller.abort()
    }
  }, [readable, profileId, active, reloadKey])

  return readable ? counts : null
}

/**
 * Hover card anchored to a curator name/avatar trigger. The trigger is a
 * plain profile link (click navigates to /u/:handle); hovering or focusing it
 * opens a floating preview with the same identity block as the Profile hero:
 * avatar, name, handle, full bio (clamped), follow state, and public
 * collection count. Touch pointers skip the card and keep tap = navigate.
 */
export function ProfileHoverCard({
  handle,
  displayName,
  avatarUrl,
  profileId,
  children,
  className,
}: {
  handle: string
  displayName: string
  avatarUrl?: string | null
  profileId?: string | null
  children: ReactNode
  className?: string
}) {
  const triggerRef = useRef<HTMLAnchorElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<AnchorPopoverPos | null>(null)
  const [hover, setHover] = useState<HoverState>({ status: 'loading' })
  // Exit phase: the card fades out at the fast tier (matches its enter).
  const { mounted, closing } = useExitAnimation(open, EXIT_DURATION_FAST_MS)

  const profileUrl = `/u/${encodeURIComponent(handle)}`
  const ready = hover.status === 'ready' ? hover.value : null
  const targetProfileId = ready?.profile.profileId ?? profileId ?? null
  const counts = useFollowCounts(targetProfileId, open)

  const clearOpenTimer = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }
  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const scheduleOpen = useCallback(() => {
    clearCloseTimer()
    if (openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      setOpen(true)
    }, OPEN_DELAY_MS)
  }, [])

  const scheduleClose = useCallback(() => {
    clearOpenTimer()
    if (closeTimer.current !== null) return
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }, [])

  const cancelClose = useCallback(() => {
    clearCloseTimer()
  }, [])

  useEffect(() => () => {
    clearOpenTimer()
    clearCloseTimer()
  }, [])

  useLayoutEffect(() => {
    // Keep the last position while the exit animation plays; a reopen
    // recomputes it here before paint.
    if (!open) return
    const anchor = triggerRef.current
    if (!anchor) return
    setPos(anchorPopover(anchor.getBoundingClientRect(), {
      width: CARD_WIDTH,
      maxHeight: 320,
      gap: 8,
    }))
  }, [open])

  useEffect(() => {
    if (!open) return
    let live = true
    setHover((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    void loadHoverProfile(handle).then((value) => {
      if (live) setHover({ status: 'ready', value })
    }).catch(() => {
      if (live) setHover({ status: 'error' })
    })
    return () => {
      live = false
    }
  }, [open, handle])

  /* Hover cards dismiss on scroll/resize: the fixed panel would otherwise
     detach from an anchor that moved with the page. */
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onTriggerPointerEnter = (event: PointerEvent<HTMLAnchorElement>) => {
    if (event.pointerType === 'touch') return
    scheduleOpen()
  }

  const onTriggerBlur = (event: FocusEvent<HTMLAnchorElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && cardRef.current?.contains(next)) return
    scheduleClose()
  }

  const onCardBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && (cardRef.current?.contains(next) || triggerRef.current?.contains(next))) return
    scheduleClose()
  }

  const seedName = displayName.trim() || `@${handle}`
  const cardName = ready?.profile.displayName.trim() || seedName
  const cardHandle = ready?.profile.handle ?? handle
  const cardAvatarUrl = ready ? ready.profile.avatarUrl : (avatarUrl ?? null)
  const about = ready?.profile.about?.trim() ?? ''

  const card = mounted && pos && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={cardRef}
        className={`profile-hover-card${closing ? ' is-closing' : ''}`}
        style={popoverStyle(pos)}
        inert={closing || undefined}
        role="group"
        aria-label={`${cardName} — profile preview`}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onBlur={onCardBlur}
      >
        <div className="profile-hover-card-head">
          <Link to={profileUrl} className="profile-hover-card-avatar" aria-hidden tabIndex={-1}>
            <span className="avatar avatar-lg">
              <AvatarImage url={cardAvatarUrl} initials={profileInitials(cardName, cardHandle)} />
            </span>
          </Link>
          <div className="profile-hover-card-title">
            <Link to={profileUrl} className="profile-hover-card-name">{cardName}</Link>
            <span className="profile-hover-card-handle">@{cardHandle}</span>
          </div>
          <div className="profile-hover-card-follow">
            <FollowButton targetProfileId={targetProfileId} className="btn-sm" />
          </div>
        </div>
        {hover.status === 'loading' && (
          <div className="profile-hover-card-skeleton" aria-hidden="true">
            <span className="skeleton-block profile-hover-card-skeleton-line" />
            <span className="skeleton-block profile-hover-card-skeleton-line profile-hover-card-skeleton-line--short" />
          </div>
        )}
        {hover.status === 'error' && (
          <p className="profile-hover-card-bio profile-hover-card-bio--muted">
            Profile details are unavailable right now.
          </p>
        )}
        {ready && about ? (
          <p className="profile-hover-card-bio" title={about}>{about}</p>
        ) : null}
        {ready && (
          <div className="profile-hover-card-stats">
            {ready.collectionCount != null && <span><strong>{ready.collectionCount}</strong> Public collections</span>}
            {counts?.followers != null && <span><strong>{counts.followers}</strong> {counts.followers === '1' ? 'Follower' : 'Followers'}</span>}
            {counts?.following != null && <span><strong>{counts.following}</strong> Following</span>}
          </div>
        )}
      </div>,
      document.body,
    )
    : null

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- react-router Link renders a native anchor; hover open/close has keyboard parity via the onFocus/onBlur handlers on this same element */}
      <Link
        ref={triggerRef}
        to={profileUrl}
        className={`profile-hover-trigger${className ? ` ${className}` : ''}`}
        data-testid="profile-hover-trigger"
        onPointerEnter={onTriggerPointerEnter}
        onPointerLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={onTriggerBlur}
      >
        {children}
      </Link>
      {card}
    </>
  )
}
