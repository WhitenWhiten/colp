# Bilibili standalone feasibility evidence

Historical prototype evidence and repository review: October 23, 2026. Dated COLP integration results are appended below and tracked in execution-evidence.md. This record distinguishes the independent prototype's observed behavior from the host/runtime acceptance requirements in [the design](README.md#implementation-sequence-and-acceptance).

## Provenance and verification scope

The independent extension is at `/Users/whiten/bilibili-fav-extension`, version `0.1.0`. Its `README.md`, `docs/feasibility.md`, and `docs/verification-*.png` contain the original report and screenshots. These external working files are evidence inputs, not COLP release assets or a vendored dependency. This summary omits account identifiers, private collection names, and session data.

This path is machine-local and version `0.1.0` alone does not identify immutable source bytes. Before porting, SA-00 must record the inspected commit if available plus file digests for the API client, probe, bridge, and relevant tests, then commit sanitized fixtures with their observation date. A missing external checkout does not block host work against fixtures; it does block claims that the original implementation was reproduced. Later edits to that checkout do not change what this historical evidence established.

The originating agent tested a real signed-in account in ego-lite, Chromium 154 (ego `0.6.0.20`). This review inspected the prototype's source and verification record and reran `node --test tests/*.test.mjs`: 30 tests passed, zero failed. It did not repeat the signed-in browser experiment. The unit tests cover API normalization/retries, mapping, pagination, deduplication, renames, resume, cancellation, and manifest assertions; they do not exercise the live probe/background pipeline or COLP integration.

The prototype is independent of COLP: no COLP server, model, source ledger, automation rules, or native receipt/recovery integration was involved. Its minimum declared Chrome version is 121; the reported real-browser run on Chromium 154 does not verify every supported Chrome version.

## Observed results

| Capability | Recorded evidence | Interpretation |
| --- | --- | --- |
| Signed-in source discovery | `nav` identified the current account; folder enumeration returned 21 existing collections, including private collections | First-party page-session reads are feasible in the tested environment without copying cookies |
| Full projection | 21 collection folders and 4,911 bookmarks under the selected root's `bilibili` folder | Stable numeric collection IDs and usable item identities are available |
| Repeated full sync | `createdBookmarks: 0`, `createdFolders: 0`, no duplicate URLs within each destination collection | Prototype idempotency works for this repeated run |
| Live additions | Three additions to a new private test collection produced three bookmarks | One addition used the native site dialog; two used page-side calls to the same site endpoint. This is not three independent native-UI flow tests |
| Live then full sync | After two live additions: 22 collection folders, 4,913 bookmarks, then a full sync with `createdBookmarks: 0`, `skippedBookmarks: 5247` | Full sync reused the live-created folder and bookmarks |
| Final recorded tree | A third live addition brought the tree to 22 collection folders and 4,914 bookmarks | This final count followed the preceding full-sync measurement |
| Repeated live addition | `lastCreated: 0`, `lastSkipped: 1`; test folder stayed at three items | Repeated processing did not add another copy in that run |
| Manual folder rename | A renamed destination kept its manual title; `titleConflicts: 1` | The tested rename was preserved; the name was restored after testing |
| Cancellation | Stop produced `phase: cancelled`; existing bookmark count remained unchanged | Stopping preserved completed writes |

`skippedBookmarks` includes invalid/unusable returned items as well as existing URLs, so it is not a count of unique existing bookmarks and need not equal the native tree count. Missing detail responses are omitted separately by the current API client. Production reporting should distinguish existing, invalid, inaccessible/missing, unsupported, and failed items.

## Evaluated read and observation path

| Operation | Evaluated endpoint or mechanism |
| --- | --- |
| Current account | `GET /x/web-interface/nav` |
| Collection catalog | `GET /x/v3/fav/folder/created/list-all?up_mid=<mid>` |
| Collection member IDs | `GET /x/v3/fav/resource/ids?media_id=<id>&pn=<page>&ps=1000` |
| Item details | `GET /x/v3/fav/resource/infos?resources=<id:type,...>`, approximately 100 IDs per batch |
| Live hint | Bundled MAIN-world fetch/XHR wrappers observe the site's own `POST /x/v3/fav/resource/deal` |
| Live confirmation | Read collection IDs to confirm membership, then read item details before projection |

The read bridge runs in an ISOLATED content script on `www.bilibili.com` with `credentials: include`. The tested manifest grants the page origin, not background access to `api.bilibili.com`. This demonstrates a working page-side CORS/session combination in that environment; it does not prove background cookie behavior. COLP should implement a bounded bundled page reader first. A separate background reader requires its own evaluated credential policy and data-origin grant. Both expose named, validated operations rather than arbitrary URL/header/body forwarding.

The original `resource/list` approach hit HTTP 412 after approximately 129 rapid requests at a 200 ms interval. The replacement used roughly 1,000 IDs per page, 100 details per batch, and a 1.5 second request interval. The recorded 21-collection run needed 69 detail batches plus approximately 25 ID-page requests and completed without another observed 412. This is one successful pacing observation, not a guaranteed rate limit or evidence of continuing endpoint compatibility. Retain bounded queues, backoff, visible pause, and challenge/authentication failure handling.

The site may return `code: 0` before a fresh membership read sees an addition. The prototype invalidates its ID cache and retries confirmation twice with 1.5 second waits. Production must retain present/absent/unknown semantics; a failed, partial, or inaccessible read cannot prove absence.

The MAIN probe projects resource ID/type, added/removed collection IDs, and business response code. It does not replay favorite writes or forward cookies/CSRF. Its messages remain forgeable page evidence: readback establishes current membership, not proof of a new human action. In the prototype only additions cause writes. Worker, WebSocket, iframe, previously captured function references, and late injection can bypass fetch/XHR wrappers; expose degraded live coverage and offer explicit reconciliation/import.

`media_count` includes unavailable entries. Detail responses may omit IDs or return invalid markers/titles, so fewer bookmarks than the source count is expected. The report observed `attr` values 1 and 9 alongside invalid entries, but the implementation explicitly checks `attr === 9` or the invalid-title sentinel. It does not reject every `attr === 1` item. Capture sanitized fixtures and establish field semantics before broadening the production filter. The real account contained videos (`type=2`); other content types have unit-level examples only.

## Required changes when integrating with COLP

1. **Preserve observations during imports.** `processLiveFavorite` currently returns when `activeRun` exists. An addition to an already-scanned collection can be missed until another sync. Durably accept/acknowledge observations and merge them through the source ledger and shared reservations; test an addition after that collection's scan and before run completion.
2. **Separate discovery from writes.** The prototype creates native folders/bookmarks as it scans. COLP discovery and page acknowledgments must produce zero import writes; freeze a preview, obtain exact approval, then execute its effects through capture/native recovery. Live automation requires its independently enabled policy.
3. **Use stable recovery semantics.** The saved `nextPage` is an offset into a list fetched again on restart. Matching `media_count` does not establish unchanged membership/order. Use restart-and-deduplicate by stable item/collection identity unless a stable cursor/snapshot or a durably frozen enumerated set is available. Await durable checkpoints before acknowledging progress.
4. **Keep ownership and source identity explicit.** The prototype adopts matching folder names and deduplicates URLs inside each folder. COLP requires account-scoped connections, content identity, native creation receipts or explicit adoption, and manual move/deletion protection. A same-name folder or equal URL does not grant management authority.
5. **Recover accepted work and unknown native outcomes.** The prototype uses worker-global live queues/deduplication and best-effort storage callbacks. Port or timer activity is not a durability guarantee. COLP must persist observations, commands, folder reservations, and receipts, and recover after termination without blind creates.
6. **Keep page/host authority separate.** Reuse endpoint projections and sanitized fixtures, not direct bookmark writes or the prototype's broader page bridge. Apply sender/document/route/installation validation, scoped recipe authorization, bounded schemas, and revocation. Do not infer source trust or model consent from a probe message.
7. **Bound each read and report incomplete results.** The prototype loads a collection's ID list before slicing detail batches; duplicate-only pages and a page ceiling can end that loop. Its bridge also reads the full response text before checking size. Production needs bounded response consumption, incremental transport pages, explicit incomplete/error outcomes, and one paced connection queue across live/import/tab activity. A missing row in best-effort pagination cannot establish absence. See the [reader implementation decisions](implementation-plan.md#bilibili-reader-implementation-decisions).

## Remaining acceptance gates

The evidence closes the basic question of whether a signed-in Bilibili favorites-to-bookmarks flow and live additions can work. At the proposal baseline, phase A was partial and phases B/C and community execution were unimplemented. Current implementation results are separate from that prototype evidence.

Use these gate IDs in [implementation evidence](implementation-plan.md#validation-commands-and-evidence). The table records the original required gates; current supported/limited capabilities are summarized below and in execution evidence. Prototype support is listed separately. A declared unavailable capability must stay disabled and visible, not be counted as a successful supported flow.

| Gate | Existing support | Required acceptance / task |
| --- | --- | --- |
| A1 Native interaction and failure | One native video-dialog addition; two direct page-side additions | Video and list-page dialogs; B/C together, B-to-C, existing multi-membership, cancel, HTTP-200 business failure, slow/duplicate/out-of-order results. SA-02. |
| A2 Identity and account binding | Numeric collection IDs and signed-in account detection | Popup-first item identity, URL variants/unresolved links, account changes, signed-out/expired sessions, and explicit cross-account adoption. SA-02, with binding integration in SA-07. |
| A3 Bounded enumeration | Large API scan with observed pacing | Sanitized catalog/ID/detail fixtures; page splitting, byte/deadline/page budgets, missing/invalid/unsupported details, 412/429 pause, changed-count and same-count reordered restart. SA-02; durable recovery in SA-06. |
| A4 Fresh membership readback | Positive additions confirmed after invalidating the ID cache | Present/absent/unknown results with fresh scoped evidence; partial/inaccessible data cannot prove absence; a concurrent observation prevents stale resolution. SA-02/SA-03. Keep negative readback unavailable until proved. |
| A5 Browser lifecycle and ingress | Prototype runs in Chromium 154 | Controlled worlds/sender checks, top-level scope, SPA, BFCache, lease invalidation, permission removal, and supported-version evidence. SA-01/SA-08. Community worlds/toggles are a separate phase D gate. |
| A6 Collection/resource semantics | Unit examples for same-name folders, renames, and resource normalization | Native rename and same-name identity, removal facts with archive retention, and explicit unsupported results for unverified resource types. SA-02/SA-05. Non-video support is deferred until separately validated. |
| B1 Durability and concurrency | Prototype worker globals/checkpoints; no COLP recovery proof | Worker termination, lost acknowledgments, live events during imports, shared folder creation, unknown native results, manual edits, and suppression. SA-03–SA-06. |
| B2 Import and rules | Prototype writes during scan | COLP scan/preview/approval with zero preapproval writes, v3 admission/migration, exact scope, stale preview, partial coverage, and cancellation. SA-05/SA-06. |
| C1 Semantic integration | No COLP or model integration | Both save orders under all copy policies, explicit adoption, AI subtree exclusion, independent provider failures, and zero source-archive model calls. SA-07. |
| D1 Community execution | None; bundled prototype only | Separate package/version provenance, USER_SCRIPT isolation, surviving old scripts, updates and revocation. SA-09, deferred from the bundled release. |

Sanitized fixtures should preserve observed response shapes and failure/coverage distinctions without copying account IDs, private collection names, session tokens, or complete network traffic. No live source action, bookmark mutation, or browser test was performed as part of this documentation backfill.

## COLP reader integration — October 24, 2026

SA-02 now has a durable confirmation queue and bounded bundled reader. It is complete for the following explicitly limited capability set, not a claim that all proposed A–C features or every matrix variant is supported. See [execution evidence](execution-evidence.md#sa-02--reader-and-confirmation-completion-with-explicit-limits) for exact commands, artifacts and sanitized real-site results.

| Gate | Current COLP result / limit |
| --- | --- |
| A1 | Native video-dialog B addition, C addition, B-to-C, simultaneous B+C, and cancellation exercised in ego-lite. A successful hint authorizes only paced reads. Fresh positives become `membership.observed`; human-action proof and `favorite.confirmed` emission are unavailable. Failed/late/duplicate/challenge cases have fixtures; real business failures are not claimed. List pages on `space.bilibili.com` are outside the granted/injected origin and unavailable. |
| A2 | Numeric aid identity and canonical av links; BV resolution uses fixed page-side `view?bvid=…`, requiring matching bvid, safe aid and published state 0. Parameterized av/BV variants are covered. Short links, non-video identity, unconnected/signed-out page resolution and automatic cross-account adoption remain unavailable. Popup-first binding/adoption belongs to SA-07. |
| A3 | Bounded catalog/IDs/details and streamed JSON, omissions, deadlines, retry/pacing/cooldown, replay and stale cursors covered. Real catalog traversal and bounded item pages work. Full-account import/restart approval is not enabled; SA-06 owns that gate. |
| A4 | Fresh positive or unknown results only. A native B-to-C action records positive C while removal evidence stays uncertain. Negative membership readback remains unavailable, including after complete best-effort enumeration. Ledger concurrency protection is covered by SA-03. |
| A5 | Controlled Chromium 149/Linux/xvfb ingress, world isolation, SPA and actual BFCache pass; real Chrome 154/macOS positive reads pass. Chrome 121 and community world/toggle behavior are not verified by these results; SA-08/SA-09 must gate unsupported versions/capabilities. |
| A6 | Real temporary collection rename preserved its ID; two equal display names retained distinct IDs in a fresh catalog read. Test collections were removed afterward. Only type 2 video resources are supported; invalid/missing/non-video records stay separate. Native source-folder automatic renaming is unavailable; SA-05 retains its immutable creation binding and local ownership. Archive retention/manual-edit behavior has controlled SA-03–SA-05 evidence; real native archive smoke follows SA-08. |

The original prototype was temporarily disabled during native favorite changes and restored to its previous enabled state afterward. The two dedicated test collections and their temporary memberships were deleted. Final catalog count returned to 22, with neither test ID present. COLP had no bookmarks grant during this read-only real-site acceptance. No real user's bookmark tree, model endpoint, original favorite membership or unrelated collection was changed by COLP.
