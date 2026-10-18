# Changelog

All notable changes to the Know-N browser extension are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The extension has its own version, separate from COLP Server and `@know-n/colp`; `package.json` and `manifest.base.json` carry it, and an `extension-vX.Y.Z` tag publishes a release with the store zip.

## [Unreleased]

### Added

- The extension tells the server's Sync center how its sync stands: syncing, degraded (some items set aside), stopped (with the reason code) or paused. It reports after every sync pass when something changed and at least every 15 minutes, through `POST /colp/v0.1/sync/replica-health`. A stopped engine still reports, and the report is the only request it makes: it needs no Sync Session and renews nothing. While paused it names no bookmarks; after a deliberate disconnect it reports nothing. A server without the route is asked again after six hours.
- Sync can hold one change aside without stopping the rest. A held change (`set_aside`) keeps its reason, is reported to the Sync center like a refused one, and never stalls the changes behind it: the push lane skips it and the next sequence realign moves it after the surviving work. Only a change that was never sent can be held. Releasing it returns it to the end of the lane, in its original order, with a fresh sequence and idempotency key.

### Changed

- The source moved from the private Know-N repository into `packages/extension` of the COLP repository. It builds from this repository alone: Know-N's design tokens, styles, icon paths and wordmark are copied into `design/`, the capture metrics into `src/capture/statistics.ts`, and the API types come from `packages/server`. Browser tests run against COLP Server by default.
- `npm run package` builds, scans and zips the production extension; `.github/workflows/colp-extension-release.yml` attaches that zip to a GitHub release for each `extension-v*` tag.

### Fixed

- A second browser joining a collection no longer uploads the bookmarks it downloads during its first sync. While sync recovery or a first-sync Snapshot was being applied, the browser's own bookmark creates, moves and reorders were recorded as local edits, so each downloaded bookmark came back as a duplicate, and later deletes or restores from other browsers stopped syncing. Unmapped snapshot creates wait for the tree check when recovery ends; mapped moves, reorders, removals and content changes remain durable, with projection echoes filtered before upload.
- Opening Options or the popup no longer starts a sync run each time the sync status is shown. Only a first sync that is still running is pushed along by status reads; before, a page refresh could queue many runs back to back.
- Same-folder sorting during sync recovery now survives worker restart and uploads after recovery, instead of being discarded.
- Changing or testing an AI provider preserves host permissions shared with the active COLP Server, including managed servers and different ports on the same host.
- A bookmarklet or unsupported history URL no longer blocks the entire JSON backup. Supported data is exported and the dialog reports skipped records, with HTML export available to preserve the skipped bookmarks.
