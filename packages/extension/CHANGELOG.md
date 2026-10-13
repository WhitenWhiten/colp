# Changelog

All notable changes to the Know-N browser extension are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The extension has its own version, separate from COLP Server and `@know-n/colp`; `package.json` and `manifest.base.json` carry it, and an `extension-vX.Y.Z` tag publishes a release with the store zip.

## [Unreleased]

### Changed

- The source moved from the private Know-N repository into `packages/extension` of the COLP repository. It builds from this repository alone: Know-N's design tokens, styles, icon paths and wordmark are copied into `design/`, the capture metrics into `src/capture/statistics.ts`, and the API types come from `packages/server`. Browser tests run against COLP Server by default.
- `npm run package` builds, scans and zips the production extension; `.github/workflows/colp-extension-release.yml` attaches that zip to a GitHub release for each `extension-v*` tag.

### Fixed

- A second browser joining a collection no longer uploads the bookmarks it downloads during its first sync. While sync recovery or a first-sync Snapshot was being applied, the browser's own bookmark creates, moves and reorders were recorded as local edits, so each downloaded bookmark came back as a duplicate, and later deletes or restores from other browsers stopped syncing. These events are again left to the tree check that runs when recovery ends; removals and content changes made meanwhile are still kept.
- Opening Options or the popup no longer starts a sync run each time the sync status is shown. Only a first sync that is still running is pushed along by status reads; before, a page refresh could queue many runs back to back.
