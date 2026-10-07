# StrictMode mount parity: migration record

Status: MIGRATION DONE 2026-09-17. The suite mounts under production's StrictMode
as of `012ea6029`, and that commit also fixed the production defects it exposed —
and every finding below is now closed. Each finding carries an explicit
**Status** line; trust that line, not this paragraph. Verified against
HEAD by an independent audit, which found the earlier prose inverted in both
directions (fixed ones marked open, open ones unmarked).

Round of 2026-09-18: `SM-3`/`SM-4`/`SM-5`/`SM-6`/`SM-7`/`SM-9` are each pinned by
a test that fails without the fix, and `SM-10` was established as not reachable —
see the Status lines for the commits.
Owner: frontend.

## What is wrong — RESOLVED, kept for the record

> **This section is history, not current state.** It described the tree before
> `012ea6029`, and it asserts the OPPOSITE of the code as it now stands: the helper
> wraps StrictMode OUTERMOST, matching `src/main.tsx`, and an executed probe shows an
> initial-mount fetch effect firing **2×** through the helper. An independent audit
> found this text still claiming 1× and still describing the nesting as defeated, so
> it is kept only to explain what the migration had to fix. Do not read it as a
> current defect.

`src/main.tsx` renders `<StrictMode><App /></StrictMode>` — StrictMode is the
outermost element. At the time this was written `src/test/render.tsx` wrapped
differently:

```
MemoryRouter > wrapper > ConfirmProvider > StrictMode > ui
```

React's double-invocation walk stops at the first non-strict fiber carrying pending
effects, so with StrictMode *inside* the providers the initial-mount effects of
everything below it ran once — a probe confirmed 1× through the helper against 2×
with StrictMode outermost. Mount-time double-fetch, double-subscribe and
missing-cleanup bugs were therefore invisible.

## SM-1 `Layout` focuses `main` on the initial load (skips its own guard)

**Status: FIXED** in `012ea6029` (announced-pageKey guard in `Layout.tsx`).

- File: `src/components/Layout.tsx` (`firstRouteRef` guard around line 97-105).
- Evidence: `src/components/Layout.test.tsx` "moves focus to main ... after a
  route change" asserts `document.activeElement` is NOT `#main` before any
  navigation. Under StrictMode it IS `#main`.
- Mechanism: the effect that skips the first route does
  `if (firstRouteRef.current) { firstRouteRef.current = false; return }`.
  StrictMode runs the effect, cleans it up, and runs it again. Leg 1 consumes the
  guard; leg 2 therefore focuses `main`. In production dev the user lands on `/`
  with focus already moved and the route announcement fired for the landing
  page — the exact "landing sticky hero reads as a non-zero progress bar"
  symptom the `preventScroll` comment says the code is avoiding.
- Minimal fix: make the guard survive StrictMode's double effect — latch it on a
  ref that is not reset per effect invocation, or key it on the first committed
  route (`useRef(location.pathname)`) rather than a boolean consumed by the
  effect body.

## Watch list
Files where the double mount may expose the same class of problem (effect with
no cleanup / one-shot guard): reported per group in
`/tmp/strictmode-group{1,2,3}.md` as they finish.

## SM-2 The email-verification link page hangs on "verifying"

**Status: FIXED** in `012ea6029` (the cross-run token ref was removed).

- File: `src/pages/EmailVerification.tsx` (token effect, ~line 104-128).
- Evidence: `src/pages/EmailVerification.test.tsx` "verifies a token from the
  email link and refreshes the session" never reaches the success panel
  (times out waiting for `[role="status"].auth-success`), and "shows a typed
  error for an invalid or expired token" gets no error text.
- Mechanism: two guards that disagree after a remount.
  `if (!token || verifiedTokenRef.current === token) return` is a REF, so it
  survives StrictMode's effect leg 2, but leg 1's `cancelled` flag is set by its
  own cleanup. Leg 1 sets the ref, starts the request, and is cancelled; leg 2
  returns early because the ref is already set. Whatever leg 1 got back is
  discarded by `if (cancelled) return`, so `setResult('success')` never runs and
  the page stays in the verifying state.
- Impact: in production dev the verify-email page never shows success or the
  typed error; the user is left on the spinner even though the request
  succeeded. Under StrictMode this is not a rare interleaving, it is every load.
- Minimal fix: make the two guards agree. Either keep the "already verified"
  fact in state that the retried effect re-reads, or let a second run proceed and
  rely only on the request-level cancellation:
  ```ts
  useEffect(() => {
    if (!token) return
    const alreadyDone = verifiedTokenRef.current === token
    verifiedTokenRef.current = token
    if (alreadyDone) return
    ...
  }, [token, refreshSession])
  ```
  is NOT enough — leg 2 must still be able to finish leg 1's work. Preferred:
  drop the ref guard and make the effect idempotent on `token` alone, so leg 2
  re-issues the request and its own `cancelled` flag is the only one that
  matters.

## SM-3 `sync/data.ts` paints a stale load error over live data

**Status: FIXED** in `012ea6029`; extended by `350cd7c6e` with a load generation, because `load('refresh')` runs with no signal.

- File: `src/pages/sync/data.ts` (`load()`, ~line 88-120), visible through
  `src/pages/sync/view.tsx:71` (`!loading && !loadError` gates the status).
- Found by: group 2 while re-fixturing `Sync.test.tsx`.
- Mechanism: only the SUCCESS path checks `signal?.aborted`. The `catch` returns
  early just for a `DOMException` named `AbortError`, and the `finally` checks
  only `mounted.current` — which the StrictMode remount sets back to `true`. A
  superseded read that rejects with a non-abort error therefore writes
  `loadError`, and the view then hides the status the LIVE read already loaded.
- Reachable in production, not just tests: `view.tsx:67` calls `load('refresh')`
  with no signal, so this is last-write-wins on every refresh.
- Evidence: mount-#1's read rejected 503 after live read #2 resolved a healthy
  status → `[role=alert]` "Sync status could not be loaded / Temporarily
  unavailable" and the "Work browser" replica row disappeared. The pre-existing
  test was green only because the error it asserted came from the aborted
  mount-#1 promise.
- Minimal fix: guard the catch and finally on the signal too —
  `catch { if (signal?.aborted) return ... }` and
  `finally { if (!signal?.aborted && mounted.current) ... }` — or use a
  request-generation counter owned by the effect.

## SM-4 `PrivacySection` keeps the previous account's filters (pre-existing)

**Status: FIXED** in `fe62f5cd1` — the load effect clears the drafts, ETag and
availability before its guard, so a slow or failed load for the new account can
no longer leave the previous account's filters on screen. Pinned by
`PrivacySection.test.tsx` 'clears the previous account filters when the next
account load fails' (fails on the parent with `expected [ 'acct-1', … ] to deeply
equal [ '', '', '', '' ]`).

- File: `src/components/settings/PrivacySection.tsx:23-49` (load effect) and
  `:51-69` (`save`).
- Not caused by StrictMode; found while migrating its test.
- The effect resets the four filter fields only for signed-out/no-account. On an
  `accountId` change the previous account's owners/tags/keywords/languages/etag
  stay in state until the new GET lands, and `save()` is neither cleared nor
  account-guarded — so account 2 can save account 1's filters during that
  window, unbounded on a slow network.
- Evidence: `#pref-tags` still read `first` after switching accounts with the
  request in flight.
- Minimal fix: clear the fields and etag on `accountId` change, or gate the form
  on a per-account loaded marker (the pattern `useProfileData.ts:150-154` uses).

## SM-5 `write-approvals/data.ts` runs recovery from the superseded mount pass

**Status: FIXED** in `012ea6029` (signal guard in the catch).

- File: `src/pages/write-approvals/data.ts:110-121`.
- Same shape as SM-3: the success path checks `signal?.aborted` (:103), the catch
  does not — it drops only a `DOMException` named `AbortError`, and
  `mounted.current` is a shared ref the second mount setup resets to `true`. A
  rejected request from the discarded pass therefore still runs
  `setLoadError` / `setMissingDetail` / `redirectToLogin()`.
- Impact: stale error copy, or a spurious bounce to `/login`, while a fresh
  request is in flight.
- Evidence: `getWriteApprovalPage.mockRejectedValueOnce(404)` plus a succeeding
  base left "Write approvals are not available yet" on screen although the live
  read returned a full page.
- Minimal fix: `if (signal?.aborted) return` as the first statement of the catch.

## SM-6 `collection-editor/data.ts` misreports a hydration failure as a load failure

**Status: FIXED** in `618270ca9` (hydrated inside its own try, error surfaced rather than swallowed).

- File: `src/pages/collection-editor/data.ts:53` (pre-existing, not StrictMode).
- `onSnapshotReadyRef.current(snap, ...)` is called INSIDE the `try` that
  classifies load failures, so an exception while hydrating a SUCCESSFUL snapshot
  renders "Could not load collection" with the raw internal message instead of
  surfacing the hydration error for what it is.
- Minimal fix: move the callback out of the load-classifying try.

## SM-7 Low: two components apply results without an aborted check

**Status: FIXED** (round of 2026-09-18). `FaviconSection` and
`FaviconSourceControl` carry post-await/generation guards, and the unmount hole
is closed: the mount effect's cleanup now bumps the generation and drops
`refreshing`, which is the condition the poll loop itself checks. The abort only
covers the fetch, and clearing the timer only covers the wait pending at that
moment — a poll in flight when the view closed resolved into `continue`,
installed a FRESH timer and kept polling a closed view until the job reached a
terminal status. Pinned by `FaviconSourceControl.test.tsx` 'closing the inspector
stops the refresh poll', which fails on the previous code with
`expected "spy" to be called 1 times, but got 2 times`.

- `src/components/FaviconSourceControl.tsx:44,117-128` — shared `activeRef` is
  reset to `true` by the second setup, so it cannot distinguish the torn-down
  pass; only the AbortController prevents a stale apply.
- `src/components/FaviconSection.tsx:136-142,155-159` — no post-await
  `signal.aborted` check before applying the loaded policy.
- Minimal fix: check `signal.aborted` after the await, before applying.

## SM-8 Suite hazard: `vi.clearAllMocks()` does not clear once-implementations

**Status: ADDRESSED** — the mount-time `mock*Once` queues that triggered it were replaced with endpoint-described fixtures during the migration.

- Group 1 traced a leftover `mockRejectedValueOnce(412)` from one
  `useReadingProgress` test being consumed by the NEXT test's first write.
- Any test leaving a mount-time `mock*Once` queue is order-sensitive. The
  migration replaced the mount-time queues with endpoint-described fixtures,
  which removes the instance, but the hazard is worth stating: a queue installed
  for a mount must be consumed or reset.

## SM-9 Authority reads with no AbortSignal (three hooks)

**Status: FIXED** in `6f67cb6f3` — every effect-scoped read in the three hooks
takes a signal (authority + cursor page + per-root replies in
`useCommunityComments`), aborted on scope change and unmount, with
aborted-or-superseded guards before each setState. Mutations and their ETag reads
are deliberately NOT cancelled (durable intent/receipt writes). Pinned by
`useCommunityComments.test.tsx` + the two follow-hook suites: 6 cases fail on the
parent with `expected undefined to be an instance of AbortSignal`, and the replies
case fails with `expected 'root-1:true' to be ''` (a late page painted into the
target that replaced it).

- `src/lib/useCommunityComments.ts:250-266` — the mount authority effect has no
  cleanup and passes no signal; `readAuthority` (:213) calls
  `resolveCommunityTarget(query, {maxRetries:0})` at :219 and `loadRoots` at
  :154-167 without one. The older generation is dropped by the `operation` fence
  (:224,:234) but never cancelled.
- `src/lib/useCollectionFollowWorkflow.ts:105-110` and
  `src/lib/useReportFollowWorkflow.ts:110-115` — same class, no cleanup and no
  signal (:61 and :66).
- Evidence: at baseline each mount produced 2 reads (pre-migration 1). The
  duplicate is dev-only because production mounts once, and the result is
  discarded by the generation fence, so this is wasted work rather than wrong
  data. Sibling modules do abort: `useProfileData.ts:76+:114-122`,
  `useCommunityNotificationCenter.ts:85-87+:197-204`, `AuthContext.tsx:229`.
- Minimal fix: AbortController in the effect, thread the signal into both calls,
  `return () => controller.abort()`.

## SM-10 `useNotificationCenter` dedupes within a subscription, not across a remount

**Status: NOT REACHABLE** (round of 2026-09-18; the finding is a misreading).
`useNotificationCenter.ts:47` is a local of the pure `mergeUnique(first, second)`
whose caller passes `current.items` — the list already on screen — so rebuilding
it per call IS the cross-call dedupe; the only effect-scoped set (`seenMessages`)
dedupes refresh NONCES, and its effect re-runs only on an `enabled` flip and
StrictMode's mount double-invoke, where the set is necessarily empty. Hoisting
`seen` into a component-lifetime ref was measured to be HARMFUL: the existing
pagination test then fails with `expected [] to deeply equal [ 'one', 'two',
'three' ]`. `8722a825e` pins the correct semantics ("already on screen", not "ever
seen") so the hoist cannot be applied silently.

- `src/lib/useNotificationCenter.ts:198-210` — `lastRefreshAt` and
  `seenMessages` are effect-closure locals, so StrictMode's remount resets them:
  a refresh delivered on both transports is deduped inside one subscription but
  not across the remount.
- Dev-only, no production impact. Minimal fix: hoist both into refs.

## SM-11 `CollectionShare` copy timer is never cleared

**Status: FIXED** in `d47773fda` (NOT in `012ea6029`).

- `src/pages/share/CollectionShare.tsx:143` — `window.setTimeout(() =>
  setCopied(false), 2000)` from a click handler with no unmount cleanup.
  Pre-existing and not StrictMode-exposed.
- Minimal fix: keep the timer id in a ref and clear it on unmount.

## How to verify a fix

An initial-mount effect must be observed twice through the helper. The probe:

```tsx
const calls: number[] = []
function Probe(): null {
  useEffect(() => { calls.push(1) }, [])
  return null
}
mountTree(<Probe />)
await waitForDom(() => calls.length === 2)
```
