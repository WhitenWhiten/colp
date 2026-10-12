# Changelog

All notable changes to the Know-N browser extension are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The extension has its own version, separate from COLP Server and `@know-n/colp`; `package.json` and `manifest.base.json` carry it, and an `extension-vX.Y.Z` tag publishes a release with the store zip.

## [Unreleased]

### Changed

- The source moved from the private Know-N repository into `packages/extension` of the COLP repository. It builds from this repository alone: Know-N's design tokens, styles, icon paths and wordmark are copied into `design/`, the capture metrics into `src/capture/statistics.ts`, and the API types come from `packages/server`. Browser tests run against COLP Server by default.
- `npm run package` builds, scans and zips the production extension; `.github/workflows/colp-extension-release.yml` attaches that zip to a GitHub release for each `extension-v*` tag.
