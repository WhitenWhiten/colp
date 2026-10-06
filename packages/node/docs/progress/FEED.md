# Feed Progress

## Queue (release-first)

Ordered for delivery stage `feed-release` / `initialMode: 'release'`. Live-mode
fine-grained Node event merge is out of scope until every FEED-* evidence
passes. Pre-existing `src/feed/index.ts` stubs and any prior FEED-0010 schema
mapping were re-verified by the evidence tests below.

| ID | Level | Evidence test ID | Status |
|---|---|---|---|
| FEED-0001 | MUST | `feed.event-contracts` | accepted |
| FEED-0002 | MUST | `feed.cursor` | accepted |
| FEED-0003 | MUST_NOT | `feed.projection` | accepted |
| FEED-0010 | MUST | `feed.bookmark-url-safety` | accepted |
| FEED-0004 | MUST | `feed.release-snapshot` | accepted |
| FEED-0008 | MUST | `feed.client-poll` | accepted |
| FEED-0009 | SHOULD | `feed.client-merge` | accepted |
| FEED-0005 | MAY | `feed.json-feed` | accepted |
| FEED-0006 | MAY | `feed.atom` | accepted |
| FEED-0007 | MAY | `feed.websub` | accepted |

## FEED-0001

- Level: MUST
- Status: accepted
- Implementation: `src/feed/event-contracts.ts` `discriminateFeedEvent`; Schema `$defs.feedEvent`; public package subpath at `src/feed/index.ts`; package-level `supportedProfiles` includes `feed` after the Clean HEAD release-evidence gate passed.
- Evidence tests: `feed.event-contracts` (`tests/feed/feed-0001-event-contracts.test.ts`)
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy FEED-0001 feed event data contracts`
- Protocol-Correction: no
- Host-owned residual risk: host must only emit events that pass this boundary before HTTP serialization.

## FEED-0002

- Level: MUST
- Status: accepted
- Implementation: `src/feed/cursor.ts` HMAC Feed cursor (`fdc1.p`), scope binding, exclusive advance, `410 feed_cursor_expired` recovery helper
- Evidence tests: `feed.cursor` (`tests/feed/feed-0002-cursor.test.ts`); query mutual exclusion in `tests/feed/feed-query.test.ts`
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy FEED-0002 feed cursor contracts`
- Protocol-Correction: no
- Host-owned residual risk: host owns key material lifecycle, durable event-log positions, and expiry detection before encoding recovery Snapshot URLs.

## FEED-0003

- Level: MUST_NOT
- Status: accepted
- Implementation: `src/feed/projection.ts` reuses Publication public projection; fail-closed page projection
- Evidence tests: `feed.projection` (`tests/feed/feed-0003-projection.test.ts`)
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy FEED-0003 feed projection redaction`
- Protocol-Correction: no
- Host-owned residual risk: host must pass audited public extension allowlists; default is fail-closed empty.

## FEED-0010

- Level: MUST
- Status: accepted
- Implementation: `src/feed/bookmark-url.ts` omit/redact unsafe Bookmark navigation URLs
- Evidence tests: `feed.bookmark-url-safety` (`tests/feed/feed-0010-bookmark-url-safety.test.ts`) plus existing semantic snapshot dual-tag coverage
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy FEED-0010 feed bookmark URL safety`
- Protocol-Correction: no
- Host-owned residual risk: none beyond applying this projector before wire emission.

## FEED-0004

- Level: MUST
- Status: accepted
- Implementation: `src/feed/release-snapshot-guards.ts` shared immutable URL + digest shape; enforced on primary wire via `discriminateFeedEvent` for `release.published`; builder `buildReleasePublishedFeedEvent` in `release-event.ts`; projection fails closed through discrimination
- Evidence tests: `feed.release-snapshot` (`tests/feed/feed-0004-release-snapshot.test.ts`) — includes `discriminateFeedEvent` / `projectFeedEvent` rejection of mutable collection `/snapshot`
- Acceptance count: 2
- Commit subject: `fix(colp): enforce FEED-0004 release snapshot on feed discrimination`
- Protocol-Correction: no
- Host-owned residual risk: host must resolve real immutable Release Snapshot URLs and digests from durable release metadata.

## FEED-0008

- Level: MUST
- Status: accepted
- Implementation: `src/feed/client-poll.ts` minPoll/ETag/429/5xx backoff controller
- Evidence tests: `feed.client-poll` (`tests/feed/feed-0008-client-poll.test.ts`)
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy FEED-0008 client poll backoff`
- Protocol-Correction: no
- Host-owned residual risk: host supplies HTTP transport, clock, and Manifest limit values.

## FEED-0009

- Level: SHOULD
- Status: accepted
- Implementation: `src/feed/client-merge.ts` multi-subscription merge into instance-level plan
- Evidence tests: `feed.client-merge` (`tests/feed/feed-0009-client-merge.test.ts`)
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy FEED-0009 feed subscription merge`
- Protocol-Correction: no
- Host-owned residual risk: host schedules the single instance poll and fans out routed events.

## FEED-0005

- Level: MAY
- Status: accepted
- Implementation: `src/feed/json-feed.ts` JSON Feed 1.1 mapper with `_collection_protocol` extension
- Evidence tests: `feed.json-feed` (`tests/feed/feed-0005-json-feed.test.ts`)
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy FEED-0005 JSON Feed representation`
- Protocol-Correction: no
- Host-owned residual risk: optional alternate representation; not for bidirectional sync.

## FEED-0006

- Level: MAY
- Status: accepted
- Implementation: `src/feed/atom.ts` Atom 1.0 mapper (stable entry ids, related/alternate links)
- Evidence tests: `feed.atom` (`tests/feed/feed-0006-atom.test.ts`)
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy FEED-0006 Atom representation`
- Protocol-Correction: no
- Host-owned residual risk: optional alternate representation only.

## FEED-0007

- Level: MAY
- Status: accepted
- Implementation: `src/feed/websub.ts` HTTPS WebSub hub declaration (no network delivery)
- Evidence tests: `feed.websub` (`tests/feed/feed-0007-websub.test.ts`)
- Acceptance count: 1
- Commit subject: `feat(colp): satisfy FEED-0007 WebSub hub declaration`
- Protocol-Correction: no
- Host-owned residual risk: real hub network delivery and subscriber notifications are host-owned.

## Residual risk (shared)

- Host owns durable event-log storage, cursor key material lifecycle, CDN
  invalidation, and real WebSub hub network delivery.
- Package subpath `./feed` is public in `package.json` with ESM, CommonJS, and
  TypeScript declaration conditions. Package-level `supportedProfiles` includes
  `feed`.
- Deployment Manifest `feed` claims remain separate: the deployment must expose
  the required Feed endpoints and runtime port and pass the package-owned
  black-box probes. Canonical example Manifests remain unclaimed.
- Feed is included in the default coverage surface with explicit domain
  thresholds: Statements 90%, Branches 90%, Functions 95%, and Lines 95%.
- The orphan Evidence IDs have been resolved. The Release Evidence Gate owns a
  complete Vitest run, requires the Feed -> Publication -> Core Required closure,
  and validates the repository-tracked certificate against the current source.
- `src/conformance/generated/evidence.json` records the earlier tested source
  revision; only that certificate and generated traceability may change afterward.
