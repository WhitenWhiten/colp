# Changelog

All notable changes to the Know-N browser extension are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The extension has its own version, separate from COLP Server and `@know-n/colp`; `package.json` and the display version in `manifest.base.json` carry it. An `extension-vX.Y.Z` or `extension-vX.Y.Z-rc.N` tag publishes a GitHub release with the extension ZIP.

## [Unreleased]

## [0.1.0-rc.6] - 2026-10-29

### Added

- Options › Automations › Activity shows an agent's change plan waiting for your approval as "Claude wants your approval", with the plan's summary beneath; the row opens the web inbox like the other activity rows. Requires a server that sends `approval_requested` activity; older servers are read as before.
- Add-on packages are full site adapters for any HTTPS site. An installed package's site joins the Sites list in Settings › Site adapters and is turned on, connected, mapped to a folder, saved live and imported like a built-in site. Its code runs in its own user-script world, and an update runs in a new one. `scripts/pack-site-adapter.mjs` builds a package from a folder; see `docs/site-adapters/community-packages.md`.

### Removed

- The hint-only package format, which could only pass hints to the built-in Bilibili reader and otherwise ran in inspector mode. Such packages stay listed but no longer run; install an updated package to use the site.

### Fixed

- The toolbar count keeps working when the server's newest activity is of a kind this version cannot show yet. Such a summary used to be rejected as invalid, which left the count stale and slowed the next checks; now only that newest row is left out.

### Upgrade notes

Update COLP Server to `0.1.0-rc.16` alongside this extension: the Activity row
for an agent plan waiting for approval needs the server's `approval_requested`
activity. Chrome uses numeric version `0.1.0.6` and displays `0.1.0-rc.6`.
Install the GitHub ZIP as an unpacked extension.

## [0.1.0-rc.5] - 2026-10-27

### Added

- Site adapter authors can declare an icon for the Sites list, page header and installed package rows. Bundled sites use the supported site's browser favicon by default and may supply a packaged asset or audited HTTPS image; community packages use the favicon or a self-contained image data URL. A failed image falls back to the favicon and then the site's first letter.

### Changed

- Managed site copies wait while Sync is pending or recovering and re-check that state immediately before saving, so an approved import resumes automatically instead of failing or forcing recovery. The extension requires a server that advertises `managedCreateEffects`.

### Fixed

- Reconnecting a site reuses an open tab, resumes the paused check, cancels the previous page request and clears its deadline, so the check no longer waits on a stale read.
- Confirming an existing mapping uses the retained account collections and the confirmed account's generation, so choosing a local folder no longer requires an open website tab. A changed account or session is reported instead of saving with stale authorization.
- Import previews keep their frozen scope without copying every plan ID into each progress checkpoint. Mapping, permission and automation problems block approval with their specific reason, while review counts and samples remain available.
- Folder destination checks are shared by the items in a collection, and each effect is still authorized immediately before execution.

### Upgrade notes

Update COLP Server to `0.1.0-rc.15` alongside this extension: managed site
copies now require the server's `managedCreateEffects` Sync profile, and the
connection recovery and import authorization flow use the current server
contracts. Chrome uses numeric version `0.1.0.5` and displays `0.1.0-rc.5`.
Install the GitHub ZIP as an unpacked extension.

## [0.1.0-rc.4] - 2026-10-27

### Added

- The Site adapters page shows one mapping table per configured source: each selected collection with its save location and confirmed bookmark count, including missing destinations and copies kept elsewhere. Source, destination and the current operation are configured and reviewed in one place.
- The current read, preview or save task uses the same progress card and actions as Sync Import. Previews are prepared in the background, an approved save continues after settings are closed, and a stopped task keeps its read and confirmed counts.
- A bounded operation record keeps reading, approval, confirmed saves, stopping and waiting across settings closes and worker restarts. A problem explains what happened and what to do next, and a redacted diagnostic report can be copied per incident.

### Changed

- Site configuration reuses the setup form in a dialog. Single-list, page, account and observation-only sources share the same components and hide fields they do not use; advanced COLP Server, recovery and add-on tools are folded below the main view.
- An uncertain save checks the original approved command before continuing instead of creating a replacement command or asking for a broader approval.

### Fixed

- Multi-tab imports keep their document-local read cursor through repeated lease renewals, so a worker restart or a second tab no longer restarts the read or mixes pages from another source document.
- Item reviews keep their reasons, preserved local changes and original-operation recovery actions together with the affected source items.

### Upgrade notes

Update COLP Server to `0.1.0-rc.14` alongside this extension for the current
site adapter view and the server gallery covers. Chrome uses numeric version
`0.1.0.4` and displays `0.1.0-rc.4`. Install the GitHub ZIP as an unpacked
extension.

## [0.1.0-rc.3] - 2026-10-26

### Added

- Site collections save source copies through ordinary bookmark sync and schedule independent semantic copies with durable retries, destination-aware identities and coordination across replicas.
- **Check again** previews collection differences for approval. Users can restore a deleted copy, link an existing candidate, choose a source title or move an eligible item; previous checks retain results, retry and undo controls.

### Changed

- Reconciliation previews and history use bounded pages. Pending work and ownership lookups use indexes so larger libraries do not repeatedly scan all prior work.
- Site adapters declare source archive, semantic copy and reconciliation capabilities explicitly.

### Fixed

- Reconciliation preserves personal edits, shared copies, mapped folders and protected descendants, rechecks source membership and remote changes before dispatch, and records results before finalizing associations.
- Rule replacement, portable backups and destination reuse preserve copy identities and independent source and semantic scopes. Undo restores prior association choices without immediately recreating opted-out copies.
- Portable backup exports each stable mapping alias once.

### Upgrade notes

Update COLP Server to `0.1.0-rc.13` alongside this extension for managed site
copies and collection reconciliation. Chrome uses numeric version `0.1.0.3`
and displays `0.1.0-rc.3`. Install the GitHub ZIP as an unpacked extension.

## [0.1.0-rc.2] - 2026-10-25

### Changed

- Folder pickers show an expandable tree with recent subfolders, making the same folders easier to find when saving, managing bookmarks or configuring site adapters.
- Settings, automation hints, Help and popup risk details use shorter labels, quieter empty states and consistent disclosure chevrons.

- The Site adapters page has a sidebar of sites and Add-on packages, and Sync, COLP Server and Recovery tabs for each site. Sync has three steps: connect the account, choose collections and a folder, and bring in existing favorites.
  - Collections are a checkbox list that the page reads on its own once the account is connected, page after page.
  - The folder is chosen with the same folder picker as the rest of the extension, which can also make a folder named after the site.
  - Start syncing also starts the scan of existing favorites, except for a restored archive that is still waiting for rebinding. A finished scan becomes its list on its own, and nothing is added until you approve it.
  - A refused step says what to do in a toast instead of leaving the page unchanged.

### Fixed

- Saving a page while its site archive is still finishing now completes when both source and semantic copies are enabled, instead of getting stuck as unsubmitted.
- Saving site archive settings no longer fails after browsing on the site. The collections read for an account stay usable when the site's tab reloads or moves to another page.

## [0.1.0-rc.1] - 2026-10-24


### Added

- First GitHub pre-release alongside COLP Server 0.1.0-rc.11, including the current local-first bookmark manager, sync recovery and reusable site adapters. Site adapters capture, read back and manage source archives through capability-based workflows and private server receipts.

- The extension tells the server's Sync center how its sync stands: syncing, degraded (some items set aside), stopped (with the reason code) or paused. It reports after every sync pass when something changed and at least every 15 minutes (every 5 while something needs attention), through `POST /colp/v0.1/sync/replica-health`. A stopped engine still reports, and the report is the only request it makes: it needs no Sync Session and renews nothing. While paused it names no bookmarks; after a deliberate disconnect it reports nothing. A server without the route is asked again after six hours.
- The Sync center can fix a browser from the server. Each report says what the browser can do now: Retry for a stop a manual wake may end, Reset sync while the replica is frozen (the same check as the extension's own Reset button), and Try again for a save held for its own placement or identity, which goes through every placement and identity check again. The extension runs a command from the report response only if the report it answers still offers it, never runs one twice (it keeps every command it has seen), and reports the result in its next report; a command it saw but never finished is reported as interrupted. After a reset from the server, the old replica's last report says so (`replica_rebuilt`) and carries the result; the browser then asks for setup as after a local reset.
- Sync can hold one change aside without stopping the rest. A held change (`set_aside`) keeps its reason, is reported to the Sync center like a refused one, and never stalls the changes behind it: the push lane skips it and the next sequence realign moves it after the surviving work. Only a change that was never sent can be held. A released change rejoins the lane in its own slot, with its own bytes, so the server lane never sees a hole.
- A conflict holds only the bookmark it is about. The server has already consumed a conflicted change's sequence, so later changes to other bookmarks keep uploading; later changes to the same bookmark, or inside a create that is still in conflict, are held (`conflict_hold`) and listed in the Sync center. When the resolution arrives through Pull they upload in their original order. Before, one conflict stopped every later upload from the browser until someone resolved it.
- A remote bookmark or folder this browser cannot store (a title too long for a record, a field over its limit, a value the store refuses) is set aside instead of stopping Pull. It is checked before anything is written to the browser, so no unmapped bookmark is left behind; the rest of the page applies and the cursor moves on. Later changes about it, and bookmarks created inside it (`parent_set_aside`), wait with it; deleting it on the server closes it, and a replica rebuild decides it again. Each one is listed in the Sync center. Before, the page stayed staged and Pull retried the same failure forever.
- A save whose place can't be proven no longer stops sync. If its folder was deleted (`create_placement_parent_deleted`) or its position can't be confirmed (`create_placement_unproven`), the save is set aside unchanged and listed in the Sync center; it was never accepted, so nothing is sent twice. A save that matches more than one placement reservation, or a reservation for another collection (`recovery_identity_unproven`), is captured where the browser put it and held the same way; a later save next to it is placed by its folder instead of waiting for it. A deleted bookmark that can't be matched to the library (`deletion_identity_unproven`) deletes nothing anywhere else and is reported as one item. Later changes to a held bookmark wait with it (`dependency_hold`) and follow it once it is released; every other save keeps uploading. Before, each of these froze the whole replica.
- One remote change this browser can't apply no longer stops Pull. An event about a node this browser has no mapping for, or whose bookmark is gone from the browser, is set aside with that node before anything is written; the rest of the page applies, the cursor moves on, and the Ack names each set-aside node in `warnings` (`apply_set_aside` or `record_invalid`, `path: /nodes/{id}`, within the server's default budget of 8). A page that is itself broken still stops: bad digests, order or chain, a child placed before its parent, or an anchor in the wrong folder. A remote delete never removes a bookmark whose change is held on this browser; it stays in place, outside sync. More than 200 set-aside items stop the replica with its own message ("it set aside too many items"), so divergence stays bounded.
- The Status tab explains every sync code in plain words, in English and Chinese; the code appears in brackets only when the sentence cannot say how the problem ends. Each held or set-aside item is its own row naming the bookmark, with Try again and Dismiss (Dismiss closes the item and keeps this browser's version; nothing is deleted). Try again for all and Dismiss all cover every item of a kind, and from 150 open items the card warns that sync stops above 200. Retry sync now waits for its pass and says whether anything changed.
- A watchdog notices stalls that no error names. When the oldest change waiting to upload has not moved for 10 minutes, or no sync pass has finished for an hour, and nothing else explains it, the chip says "Sync is stuck" or "Sync hasn't completed in a while" and the Sync center is told. The Status card also says when sync last worked, when it retries after a pause, when its health reports are not reaching the server, and when this computer's clock is more than two minutes off the server's.
- "Reset sync on this device" is offered from every stuck state. When an upload's outcome is unknown, the server retires the old replica first (this needs a connection), so that change is neither lost nor sent twice. A reset that cannot finish can be cancelled until anything has been archived. A sync database that cannot be used (written by a newer version of the extension, damaged, or on a failing disk) is named on the Status card with "Reset local sync data", which saves a copy of the unsent changes it can still read before it starts over; nothing is deleted if that copy cannot be saved.
- The list of bookmarks not included in sync shows an example for addresses and titles that cannot be synced: its title, or its host when it has none, never the full address.

### Changed

- GitHub CD accepts RC tags, checks the full display version against the package and changelog, builds and scans the production ZIP, and marks RC releases as pre-releases without moving latest. This RC uses numeric Chrome version `0.1.0.1` and display version `0.1.0-rc.1`; install it unpacked from the GitHub ZIP. The final release reserves numeric revision 65535 so it upgrades every RC.
- The extension uses the published `@know-n/colp` 0.3.0 release.

- The source moved from the private Know-N repository into `packages/extension` of the COLP repository. It builds from this repository alone: Know-N's design tokens, styles, icon paths and wordmark are copied into `design/`, the capture metrics into `src/capture/statistics.ts`, and the API types come from `packages/server`. Browser tests run against COLP Server by default.
- `npm run package` builds, scans and zips the production extension; `.github/workflows/colp-extension-release.yml` attaches that zip to a GitHub release for each `extension-v*` tag.

### Fixed

- Engine status can read an existing paused or offline replica without a cached Sync Session. It keeps the full local identity and reports `sessionReady: false` without renewing a Session or resuming sync.
- Resetting sync preserves the retired replica’s confirmed bookmark identities as same-profile merge hints, including distinct identical bookmarks. Initial Snapshot projection now matches the existing native tree before creating remote-only items, preventing an unchanged folder tree from being downloaded and uploaded a second time.
- Duplicate bookmarks sync as independent occurrences without a review decision. Old duplicate-only review reports no longer keep first sync, progress, diagnostics, or replica health in an attention state. Actual merge differences retain their own review, and review-only issues no longer offer Reset sync.
- Open sync issues now keep the popup status and progress card at Action required, including when the engine is sleeping and independent changes can still sync. Completing a remote reset reopens folder setup on an already open settings page. An interrupted reset retains its recovery journal across browser-session credential loss and restores the credential before resuming.
- Pin and unpin sorting is retried when sync takes ownership of native bookmark order after placement has started. The saved pin flag is retained while placement waits for sync to release the order.
- Import bookmarks reopens correctly when a deep link or toolbar click arrives before the previous dialog's queued close event. A late close event cannot clear the newly opened dialog.
- Missing, deleted, moved, or orphaned sorting neighbours no longer hold later saves in their folder. Server-confirmed Reset sync can archive uncertain uploads and corrupt diagnostic records after the server retires the old replica; local bookmarks and library data remain intact. Interrupted resets resume from the durable journal, including identity rotation before registration, and the health heartbeat retries registration when connectivity returns.

- A second browser joining a collection no longer uploads the bookmarks it downloads during its first sync. While sync recovery or a first-sync Snapshot was being applied, the browser's own bookmark creates, moves and reorders were recorded as local edits, so each downloaded bookmark came back as a duplicate, and later deletes or restores from other browsers stopped syncing. Unmapped snapshot creates wait for the tree check when recovery ends; mapped moves, reorders, removals and content changes remain durable, with projection echoes filtered before upload.
- Opening Options or the popup no longer starts a sync run each time the sync status is shown. Only a first sync that is still running is pushed along by status reads; before, a page refresh could queue many runs back to back.
- Same-folder sorting during sync recovery now survives worker restart and uploads after recovery, instead of being discarded.
- Changing or testing an AI provider preserves host permissions shared with the active COLP Server, including managed servers and different ports on the same host.
- A bookmarklet or unsupported history URL no longer blocks the entire JSON backup. Supported data is exported and the dialog reports skipped records, with HTML export available to preserve the skipped bookmarks.
- Sync judges Session and sign-in expiry by the server's clock. A computer clock 15 minutes or more ahead used to reject every new Session and stop sync with a message that never mentioned the clock; a clock running behind kept using an expired Session.
- A save placed next to a bookmark that another device deleted or moved no longer blocks every later upload. The save drops the neighbour this browser no longer has, and after five refusals it is placed without neighbours.
- A connection that drops while a response downloads, a server error or timeout, and a sign-in the server no longer accepts while changes download now retry or renew the sign-in instead of stopping or freezing sync. A response with a field this version does not know says that the extension and server versions do not match, instead of reading as corrupt data.
- When Chrome refuses to apply one change from the library (a missing parent, an index that raced a local edit, a root or managed folder, a folder moved into its own subfolder), that bookmark is set aside after three attempts and the rest of the page applies. Chrome's own wording ("Can't find parent bookmark for id.", "Can't modify the root bookmark folders.") is recognised, and Chrome's bookmark write quota is waited out instead of failing. During a first sync or a recovery, one bookmark that cannot be created no longer stops the others.
- A stopped sync checks again by itself after 5 minutes, 15 minutes, an hour and then every 6 hours, instead of waiting for a bookmark edit or a browser restart. A wait that makes no progress for 20 attempts is named, and a long outage is polled less often (at most every 15 minutes). Retry sync on a download that failed its checks requests it once more from the last confirmed position.
- An upload that a proxy or firewall refuses without explanation is held as one item after five refusals instead of freezing sync. A local upload policy refusal, a saved change that can no longer be read and a tags change after metadata consent was withdrawn are held the same way. Retry sync sends a waiting upload at once.
- An expired or revoked sign-in keeps this browser's sync replica, so signing in again as the same account resumes it instead of starting a new first sync. Another account signing in after a browser restart gets its own replica instead of inheriting one the server refuses. The Account page, the Sync tab and the sidebar say why sign-in ended ("Your session expired", "Your access was revoked") until the next sign-in; a sign-in whose sync setup failed shows as signed in with the failure; a server that cannot be reached when the browser starts no longer signs the browser out.
- Bookmark access removed after setup now reads "Bookmark access needed" instead of "Synced", and removed access to the server's site shows an Allow access button. A step of a sync pass that fails (for example resuming a reset or the metadata pass) is recorded and shown after three passes while the rest of the pass runs; a reset that fails no longer silences sync.
- A library above a Snapshot size limit set by the server operator says so instead of offering a reset that cannot help. A full disk and other browser storage failures are named instead of being reported as network outages.
- Chrome's own spelling of an address (a trailing slash, a default port) is no longer mistaken for a local edit, so remote deletes and title changes of such bookmarks apply. Changes from another device inside a large folder deleted here settle with the folder.
- First sync and recovery of large libraries no longer read the whole library for each bookmark; an 800-bookmark Pull on the test store went from about four minutes to 21 seconds.

## [0.1.2] - 2026-10-21

### Fixed

- Snapshot recovery refreshes server revision fences for pending local moves while preserving native placement and queued operation identities. Requests with uncertain outcomes retain their original replay bytes.
- Moves repeatedly refused with `revision_conflict` or `position_context_stale` read a complete authenticated Snapshot for fresh node, parent and anchor authority, even when incremental Pull has nothing to return. This read does not apply browser changes or advance the Pull cursor.
- Repeated move conflicts now appear in browser attention and server health reports instead of showing zero issues indefinitely.
