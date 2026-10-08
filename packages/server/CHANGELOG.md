# Changelog

All notable changes to COLP Server are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

### Changed

### Fixed

### Security

### Upgrade notes

none

## [0.1.0]

### Added

- Self-hosted server.
- Username owner.
- Browser bookmark sync.
- MCP approval.
- Collection export.
- `colp-server ready` and `colp-server setup-token`.

### Changed

- Plain HTTP is allowed only on `127.0.0.1`, `localhost`, or `[::1]`, as COLP requires; the `http` profile publishes its port on 127.0.0.1. A LAN uses `tls-internal`.
- `backup.sh` writes `colp-backup-<timestamp>.dump`; `restore.sh` recreates the database and waits until the server is ready.
- An agent's trusted or manual policy belongs to the account that set it.

### Fixed

- Undo of a trusted agent plan refuses when the collection changed after the plan (sync, web edit, another agent) unless forced.
- The About page links to the shipped `CHANGELOG.md` and `INSTALL.md`.

### Security

- Plain HTTP stays off until `COLP_INSECURE_HTTP=true` acknowledges that transport.
- The first account needs the setup token printed in the server log, and the database admits only one owner.
- `COLP_MULTI_USER=true` is refused until invite codes ship in 0.3.0.

### Upgrade notes

none
