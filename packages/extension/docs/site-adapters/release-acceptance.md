# Bundled release and recovery acceptance

SA-08 evidence is recorded in [execution evidence](execution-evidence.md) and the [controlled](evidence/sa-08-controlled.json) / [real-site](evidence/sa-08-live.json) records. This qualifies the bundled Bilibili adapter, identity v1, positive observations and explicitly configured local archives. Negative readback, human-action proof, short links, non-video resources, space-origin injection and automatic destructive mirroring remain unavailable.

Adapters require Chromium **149+**. Chromium 149 in Linux/xvfb and Chrome 154 in ego-lite on macOS are the measured versions. Chrome 121–148 and other engines are explicitly unsupported for adapters; ordinary extension saving retains its own manifest minimum. The host rejects activation and source authority outside this range. This is not a claim that Chrome 121 or every intermediate browser was tested. Community execution has separate SA-09 evidence. Reviewed COLP Server source batches and device leases have separate [SA-10 evidence](evidence/sa-10-controlled.json) and a [versioned contract](cloud-contract-proposal.md); backend classification remains unavailable.

## Recovery behavior

Settings → Site adapters shows permission grants, the measured browser major, source connectivity, read failures/cooldowns, import coverage and queue state. Recovery inspection lists unknown/submitted native commands and blocked/detached/suppressed records. Recover existing commands uses the original durable commands, approvals and receipts. It cannot release a reservation or authorize a replacement create. Shared unknown folder commands still block every consumer. Missing native proof, root migration and copy consolidation require explicit review; automatic migration and consolidation are unavailable.

The private diagnostic opens the existing source database without requesting a version. A future schema is exported read only, including unknown stores. No reset, downgrade or command import exists. Export is bounded to 100 stores, 100,000 records and 32 MiB of record JSON. Undefined values and dates carry explicit path/type markers instead of being lost in JSON. Other unsupported structured-clone types or exceeded bounds produce a visible error and preserve the database; export never silently truncates evidence. Diagnostics contain private source data and local command receipts and should be kept private.

JSON bookmark backups carry a closed, versioned logical source section: connection/account references, copy-policy choice, mount/collection references, representation states and native **source references**. No device proof, generation, lease, credential, native command, import approval or executable outbox is portable. Old clients reject this extra section instead of silently enabling an incomplete layout. HTML retains the ordinary bookmark-only format. Unassociated ordinary copies still use explicit popup adoption; backup metadata never grants automatic ownership of them.

After the native bookmark import finishes, source metadata is restored disabled in a separate review record. The old account/root/native IDs do not become authority. Connect the matching account, select the restored root with live archiving off, and preview rebinding. Only the exact local-import mapping plus current device/date/kind/parent/canonical-item proof can be adopted. Adoption creates fresh local proof and zero native objects. Changed or missing copies, semantic associations requiring adoption, suppression and unresolved folder results remain in manual review. A separately reviewed action can retain that entire restored scope as blocked while independent new items/collections continue. These blocks stay scoped to the matching account and prevent accidental recreation. A second JSON backup preserves associations still awaiting review.

Deleting a proven local source root retains its source suppression. Once its absence is confirmed in the successful native tree snapshot, its nonexistent subtree no longer disables unrelated AI destinations. Foreign devices, missing proof and reused IDs with another creation date still fail closed.

## Acceptance matrix

Historical entries identify the task where each boundary was established; SA-08 adds recovery, supported-range and release checks. Fixture claims are distinct from real-site evidence.

| Case | Evidence and result |
| --- | --- |
| 1 | SA-05 rule layout; SA-06 controlled import/live; SA-08 native favorite to the selected temporary root: one folder and one bookmark, without an ordinary default-folder dependency. |
| 2 | SA-05 edge admission and SA-07 both/single-copy fixtures: B/C copies, primary selection and unavailable-primary review. |
| 3 | SA-07 controlled real toolbar popup: both action orders under all three policies. |
| 4 | SA-03 receipts/reservations, SA-06 live/import replay, SA-07 semantic idempotency. No URL/title-based replacement. |
| 5 | SA-00/SA-02 closed wire, probe and reader fixtures; SA-02 native cancellation/failure evidence. A successful HTTP status alone never establishes success. |
| 6 | SA-05 identity/rename/same-name/native-edit fixtures; SA-04/SA-08 controlled manual folder rename blocks later writes. |
| 7 | SA-03 baseline/live overlays and conflict tests; SA-06 partial/frozen import and late-page rejection. No negative inference. |
| 8 | SA-01/SA-02 controlled actual SPA/BFCache, worker restart and revocation; transport/ledger stale-account fixtures. |
| 9 | SA-00/SA-01 closed ingress and sender/world checks; MAIN hints lack host spending authority. |
| 10 | SA-07 destination-policy/cache/in-flight tests and controlled semantic provider; SA-08 proven-deletion/reused-ID regression. |
| 11 | SA-07 explicit mounted-folder pick in the actual toolbar popup; existing personal/subscription/managed destination guards remain exercised by the focused regressions. |
| 12 | SA-04 worker cuts around native submission/create/receipt; SA-08 recovery inspector visibly retains `unknown` and blocks replacement. Classification restart/revocation is covered by SA-07 local capture tests. |
| 13 | SA-01/SA-02 signed-out/offline reader tests; SA-07 provider failure retains both archive and saved semantic content. |
| 14 | SA-05 global/list/rule/source fences; SA-07 late semantic move after source disable; SA-08 browser-range authority fence. |
| 15 | SA-05/SA-07 rejection remains. SA-10 real COLP Server/PostgreSQL/xvfb Chromium: B-only admission, exact final parent and canonical mutation receipts, rollback, immutable replay/conflict, cancellation, lost-response/worker-cut recovery, two browser profiles, independent device approval/epoch transfer, shared canonical copy and zero models. Older/missing profiles, partial mappings, single-copy cloud semantic policies and backend classification reject explicitly. |
| 16 | SA-09 verifies named worlds, immediate execution, actual toggle revocation, extension version replacement, SPA and actual BFCache on Chromium 149. Chrome 121–148 is explicitly unsupported; no older-browser branch is claimed tested. See [community evidence](community-packages.md). |
| 17 | SA-03 atomic item/folder reservation and contradictory reports; SA-06 acknowledged-page replay and live/import race; SA-07 simultaneous semantic/source intents. |
| 18 | SA-05 identity/date/manual-ownership review; SA-08 cross-profile native import, disabled restore, matching account/root proof, stale preview and unresolved-copy blocks. Native-site removal retained its archive. |
| 19 | SA-04 controlled automatic saving/tag mode with zero provider requests; SA-06 live/import zero model calls; SA-08 real saved task has classification `none` and automatic intent false. |
| 20 | SA-05 v1/v2 migration and rollback/re-upgrade tests, ordinary order/sets/roles and snapshot invalidation. |
| 21 | SA-03/SA-04 shared-folder consumers, cancellation and unknown-result tests; SA-08 exposes the retained blocked state. |
| 22 | SA-07 popup-first av/BV identity, URL variants, explicit adoption and account takeover fences. Unresolved short links remain unavailable for automatic association. |
| 23 | SA-02 positive/unknown reader; SA-03 concurrent/conflicting ledger facts. Negative readback is explicitly unavailable, so unresolved conflicts stay unresolved. |
| 24 | SA-05 B-only/B–C roots, first-match blocking/shadowing; SA-07 unavailable primary review. |
| 25 | SA-06 controlled scan/ack/preview zero writes, partial coverage, exact approval, stale refresh, cancellation and restart/deduplication; SA-08 review reasons are retained per frozen edge. |

## Rollback and operational limits

Disable source admission first and retain issued native commands and receipts. A build that cannot understand source schema v2 must use the read-only diagnostic path; never erase data or lower generations to force activation. v3 source rules never run in an older v2 evaluator. Restored unknown commands are diagnostic evidence only; no backup path can replay them. Local source authority remains outside COLP sync. Community and cloud activation require their own task acceptance and are not implied by this bundled release.

Temporary test containers, browser contexts and local profiles are removed by their harnesses; no test server remains. Real-site changes use only a dedicated temporary collection and local root. The private cleanup record stays outside the repository; committed evidence contains aggregate results, without account IDs, private titles or full site responses.
