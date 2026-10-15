# Evidence Register, Design Decisions, Gates and Open Questions

**Review date:** 2026-10-12. **Version:** 0.2.1-design. Repository facts are inspected source evidence; proposed modules, tables, APIs, limits and policies elsewhere in this pack are design decisions. No server, browser integration or hosted-bot lifecycle was executed to produce these documents. The two external references W01 and W02 were re-read on the review date.

## Repository evidence (inherited baseline register; review status below)

| ID | Inspected source | Established fact |
|---|---|---|
| R01 | COLP `main` at `2ee8397` (2026-10-12) | Current reviewed COLP baseline (previous pack: `09334ab`) |
| R02 | Know-N at `28acb4965` (2026-10-12) | Current reviewed extension baseline (previous: `3cbb670`); private repository |
| R03 | `packages/server/src/modules/collections/application/canonical-mutation.ts` | Frozen `CANONICAL_MUTATION_WRITE_ORDER` ending in `outbox`; ordinal advances by exactly one under the collection lock |
| R04 | `packages/server/src/infrastructure/outbox/router.ts` | `handlerMode` `projection_latest_only` / `delivery_each_event`; `sideEffectDurability`; closed `routeClass` union (`projection`, `publication_cache_purge`, `report_public_surface_purge`); transient routes refused in production |
| R05 | `packages/server/src/infrastructure/outbox/mcp-change-signal-sink.ts` | Post-projection best-effort resource hints |
| R06 | `packages/node/src/shared/mcp-sdk-boundary.ts` | Pinned SDK imports, schema allowlist, protocol `2026-07-28` |
| R07 | `packages/server/src/modules/mcp/agent-plan-policy.ts` | `manual`/`trusted` per agent; reversible set `create_node, update_node, move_node, reorder, reorder_children, create_annotation, update_annotation`; version captured per committed plan |
| R08 | `Known-Extension/src/save-entry.ts` | Every popup, shortcut, context-menu and window-tab save creates a native bookmark through one path with a reserved placement intent (`bookmark-create-placement`) |
| R09 | `Known-Extension/src/classification-local-preview.ts` | Folder and tags requested separately (`requested: {folder, tags}`); foreground-only; spent command markers in session storage; Cloudflare Jev provider |
| R10 | `Known-Extension/src/classification-local-session.ts` | Local key in `storage.local`; missing key or grant never selects cloud |
| R11 | `packages/server/openapi/colp-server-v1.yaml` | OpenAPI 3.1.0 Product surface, 16k lines, separate from COLP and MCP |
| R12 | `packages/server/package.json` | `openapi:lint`, `openapi:catalog`, `openapi:examples`, `openapi:generate`, `openapi:drift`, `openapi:breaking`, `openapi:ci`, `runtime:manifest:check`, `check:imports`, `test:unit`, `test:integration:file` |
| R13 | `packages/server/src/transport/product-error.ts`, `product-codes.ts` | Closed `error` envelope with `recovery`, `precondition`, `currentEtag`, `fieldErrors`; closed code registry |
| R14 | `packages/server/src/infrastructure/egress/hardened-egress.ts` | DNS/IP classification, pinned connection, explicit redirect policy |
| R15 | `Known-Extension/src/bookmark-node-identity.ts` | Native/COLP identity separation with generation checks |
| R16 | `packages/server/src/modules/mcp/application-context.ts`, `application-catalog.ts` | Principal, client, binding and scopes boundary; descriptor-based tool catalog; `compatOnly` surface |
| R17 | `packages/server/src/infrastructure/outbox/collection-mutation-events.ts` | Closed node event payloads; creation v1 lacks full URL and ancestry facts |
| R18 | `Known-Extension/src/generated/classification/index.ts` | Backend-generated policy sharing already exists |
| R19 | `packages/server/src/transport/product-route-manifest.ts` | `CLASSIFICATION_PRUNED_OPERATION_IDS`: server classification runs, provider profiles, classify inbox and credits are pruned in the self-hosted edition; BYOK profile routes hard-gated by `KNOWN_FEATURE_CLASSIFICATION_BYOK` |
| R20 | `~/known/colp-server/03-decisions.md` D8, D28(b)(d) | Trusted mode auto-approves reversible plans with a version and Undo; policy keyed `(principal_id, client_id)`; Undo refuses when the content revision moved |
| R21 | `Known-Extension/src/bookmark-event-ingress.ts`, `bookmark-event-create-placement.ts` | Observed creations are classified against mounts, privacy and placement intents; unproven identity freezes recovery instead of guessing |
| R22 | `Known-Extension/src/capture/contracts.ts`, `capture/automatic.ts`, `sw/capture.ts` | Durable `CaptureTask` with `automaticIntent`, `manualFence`, `classification` state, `local` automatic intent with a spent `commandId`; periodic alarm recovers after crash |
| R23 | `packages/server/src/transport/session-cookie.ts`, `transport/auth/origin-csrf.ts`, `bootstrap/config-http-security.ts` | Cookie `__Host-known_session` (TLS) or `known_session` (acknowledged plain HTTP); `requireAllowedOrigin` plus `x-csrf-token` on cookie writes; `Known-Command-Id` header |
| R24 | `packages/server/openapi/README.md`, `openapi/fragments/`, `packages/web/scripts/generate-openapi-types.mjs` | Fragments are bundled into `colp-server-v1.yaml`; the web generates `src/generated/colp-server-v1.ts` from the bundle; baselines and breaking checks govern changes |
| R25 | `packages/server/migrations/README.md`, `migrations.ts`, directory listing | Kysely `FileMigrationProvider`, sortable UTC prefix, forward-only; current head `202610290100_link_preview_object_bytes.ts`; out-of-order names fail with `corrupted migrations` |
| R26 | `packages/server/src/bootstrap/config.ts`, `deploy/.env.example` | Flags are `KNOWN_FEATURE_*`; operator variables are `COLP_*` (`COLP_SERVER_ORIGIN`, `COLP_SERVER_SECRET`, `COLP_INSECURE_HTTP`) |
| R27 | `packages/web/src/App.tsx`, `pages/`, `api/`, `components/` | React 19 + react-router 7; routes `/agents`, `/approvals`, `/r/:id`, `/library/*`; `pages/Agents.tsx` has per-agent Manual/Trusted policy; `WriteApprovals.tsx` has Undo; no `features/` tree |

## External primary references

| ID | Source | Scope used | Re-read |
|---|---|---|---|
| W01 | [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) | Protocol `2026-07-28`; `events/list`, `events/subscribe`, `events/unsubscribe`; available in Work chats and with dots; HTTPS public callbacks, signed challenge, `-32015`; Standard Webhooks headers plus `X-MCP-Subscription-Id`; `whsec_` 24–64 bytes; 256 KiB; 410/413 not retried; no polling or streaming; replay only for replayable events | 2026-10-13 (this review) |
| W02 | [MCP Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md) | Draft dated 2026-02-19; identity `(principal, url, name, arguments)`; provisional error codes; poll and stream modes not adopted by W01 | 2026-10-13 (this review) |
| W03 | [Chrome MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) | Remote-code and interpreted-logic constraints | |
| W04 | [CEL overview](https://cel.dev/overview/cel-overview) | Typed environment, parse/check/evaluate | |
| W05 | [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) | Signature and header conventions | |
| W06 | [Node VM](https://nodejs.org/api/vm.html) | Not a security boundary | |
| W07 | [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html) | Document structure | |
| W08 | [CEL-ES](https://github.com/bufbuild/cel-es/blob/main/README.md) | Candidate implementation, unverified | |

## Accepted design decisions

| ADR | Decision | Rejected alternative |
|---|---|---|
| ADR-A01 | Shared pure rule core with separate host adapters | Two rule languages |
| ADR-A02 | Versioned role bindings by identity, never executable folder names | Auto-rebind by label |
| ADR-A03 | Task-specific satisfaction and typed output contracts | One "AI processed" boolean |
| ADR-A04 | Private facts plus each-event durable admission | Counting resource refresh hints |
| ADR-A05 | Explicit data destination and fallback approval | Silent cloud fallback |
| ADR-A06 | Pin run versions and member identities | Query newest N at execution |
| ADR-A07 | Opt-in connection catalogs plus call-time authorization | Global tools or client-name detection |
| ADR-A08 | Logical inbox distinct from OAuth client; shared-credential limitation stated | Treat a callback or name as a principal |
| ADR-A09 | Reference-only events plus claims and an effect gateway | Instructions and write credentials in payloads |
| ADR-A10 | Finite browser profile, bounded server CEL (M4) | Downloaded browser scripts |
| ADR-A11 | Source and transport contracts separate | JSON-RPC methods modeled as REST |
| ADR-A12 | Owner-scoped v1, optional protocol capabilities | Mandatory automation for every COLP implementation |
| ADR-A13 (revised 2026-10-12, owner decision) | MCP Events is the primary hosted-worker wake-up in M2; polling is a per-target mode for a worker with verified network access; readiness is backend-derived; the worker contract (list, claim, submit) is identical in both modes | Pull-only M2 with Events deferred; Events as the only path |
| ADR-A14 (new) | Agent-requested canonical effects use plans with cause `automation:…` and existing policy/approval/version machinery; M1 placement is Owner-authorized and run-level text is not a canonical mutation | A parallel approval and undo system |
| ADR-A15 (new) | M1 ships rules and folder bindings only; execution policy is created in M2 and absent means "no model calls, no fallback"; the web editor is one form that owns the rule's binding set | Four independently edited resources in the UI |
| ADR-A16 (new) | JSON is the only accepted authoring and storage format; no YAML on the server | YAML authoring with import validation |
| ADR-A17 (new) | Star-button creations: settle window 3 s; a bookmark-root parent is an unsorted heuristic only; known explicit choice, manual fences and later moves always win; unknown input is not forcibly moved | Treat every native folder as explicit, or none |
| ADR-A18 (new) | Digests and reviews are run-level texts shown on the run page and in a Digests list; summaries go to the bookmark note with attribution; no node is created for a digest | Create a bookmark or folder per digest |
| ADR-A19 (new) | `inputFields` name bookmark fields COLP holds (`description`, `note`, no `abstract`); workers fetch pages under their own permissions and declare it in evidence | A server-side page fetcher per task |
| ADR-A20 (new) | Story IDs `AU-xx`, task IDs `AW-xx`, test IDs `AC-xx` to avoid collision with the product plan's `US-xx` and lane tasks | Reuse `US`/`A-` prefixes |
| ADR-A21 (new) | Global pause above rule state; restore starts paused; daily caps hold tasks and never drop placement | Per-rule pause only; caps that drop |
| ADR-A22 (new) | Server intake requires verified command/receipt disposition after any receipt grace period; timeout alone grants no placement authority; imports/restores/unknown intent are not automatically moved | Browser-only rules |
| ADR-A23 (new, owner decision 2026-10-12) | The shared automation core is the `automation` subpath of the existing `@know-n/colp` package, marked optional and outside conformance | A new `@know-n/colp-automation` package |
| ADR-A24 (new, owner decision 2026-10-14) | Browser rules are a local-first layer kept in one browser: explicit choice, then account rules, then browser rules, then the local classifier; an account-rule outcome settles the save; overlaps are reviewed on connect; a browser rule reaches the account only through the web editor, filled in, and retires when the enabled duplicate arrives; disconnect keeps browser rules; amended 2026-10-14: the account's pause pauses browser rules too (01 §7.5) | Server-only rules; uploading browser rules on connect; one merged arbitration over both sets; browser rules ahead of account rules |

## Release gates

| Gate | Statement | State |
|---|---|---|
| G1 | The pinned SDK represents `events` capability without schema stripping; a real lifecycle test exists before any compatibility claim | open, AW-02 before hosted Events compatibility claims; not a local M1/polling blocker |
| G2 | Session cookie, CSRF header, error codes, route manifest and CORS bound to the active version | resolved on 2026-10-12 (R23); re-verify at AW-01 |
| G3 | Two logical targets pair and correlate in real host tool calls; shared OAuth credentials give no isolation | open, AW-02 before hosted Events compatibility claims; not a local M1/polling blocker |
| G4 | Browser-store acceptability of the finite rule profile | open, M0 (AW-03) |
| G5 | Local receipts join canonical Sync operations without touching closed wire schemas | open, M1 (AW-17) |
| G6 | Evaluator, Outbox and job workloads measured before raising limits | open, M2 (AW-44) |
| G7 | Background browser inference has its own lifecycle and consent | open, Later (AW-62) |
| G8 (new) | The proposed wake mode follows reachability: direct-public HTTPS is the selected v1 hosted topology; callbacks/host access verified separately, poll requires a reachable worker; the UI renders backend reasons and cannot override security | open, M2 (AW-26) |
| G9 (new) | Automation migrations sort after the current head; CI refuses out-of-order names | open, M0 (AW-01) |
| G10 (new) | The `@know-n/colp` release carrying the `automation` subpath lands before the extension's lockfile changes | open, M1 (AW-04) |

## Open questions (decide at the named gate)

| Q | Question | Default if undecided | Decide by |
|---|---|---|---|
| Q1 | Decided 2026-10-12 by the owner: the core is the `automation` subpath of `@know-n/colp` (ADR-A23). Remaining detail: how `check:traceability`, `check:protocol` and `check:source-size` exempt the module | Document the exemption in `packages/node/docs/API.md`; raise the size budget deliberately | AW-04 |
| Q2 | Settle window for star-button creations: Fixed 3 s observation window, or another tested policy? No native-dialog-close signal is assumed. | 3 s | AW-20 |
| Q3 | Where does a worker running on the Owner's machine get the API key: the Agents page key issuance as today? | Yes; no new credential type | AW-32 |
| Q4 | Does the web have an i18n layer the new pages must use, or English only like the current pages? | Follow the existing pages | AW-12 |
| Q5 | Should run-once be offered in M1 (placement only, no tasks) since imports are an M1 pain point? | Keep in M3; M1 preview covers "what would happen" | AW-12 review |
| Q6 | Can the Go `known` CLI act as a polling worker, or is it a script-only path until the CLI ships for COLP Server? | A hosted bot proves events mode; a script and a Claude Code routine prove poll mode; CLI optional | AW-32 |
| Q7 | Decided 2026-10-14 by the owner: rules made in the browser work without a server, as a layer below the account's rules (ADR-A24, AU-34) | — | AW-67 |
| Q8 | Attribution format for summaries in the note ("Summary by Research, 12 Oct") and whether the note's existing text is preserved above or below | Append below a separator; never replace | AW-24 |
| Q9 | Are automation plans counted in the agent's audit log (`/api/v1/me/agents/:id/audit`) as the agent's actions? | Yes, with the rule named | AW-24 |

## Review provenance — 2026-10-13

The uploaded revised pack is the design authority. The supplied ChatGPT share link did not expose a readable conversation body during this review; no claim in this revision relies on reconstructing that conversation. The local product-plan repository `~/known/colp-server` was not supplied. Its D-numbered decisions and R20 assertions are inherited context, not independently verified facts here.

| Evidence group | This review actually checked | Limit |
|---|---|---|
| R01 | COLP commit `2ee8397cc20008e7865f2a080c91be2d38d323ae` exists | No rebase to current main; implementation must compare its own checkout |
| R03 | `packages/server/src/modules/collections/application/canonical-mutation.ts` at that commit | Frozen order ends audit → outbox; private facts are a proposed extension, absent in the inspected file |
| R06 | `packages/node/src/shared/mcp-sdk-boundary.ts` at that commit | Core pin 2.3.1, protocol 2026-07-28, explicit schema boundary; Events production compatibility is not established |
| R07 | `packages/server/src/modules/mcp/agent-plan-policy.ts`, including Undo implementation, at that commit | Existing manual/trusted policy and collection-version/content fences verified; field-level selective Undo is not an existing capability claim. Existing force restore is NOT exposed by automation |
| R09 | `Known-Extension/src/classification-local-preview.ts` at `28acb4965` | Foreground gesture requirement and separate folder/tags requests verified; this is not a background worker |
| W01, W02, W09, W10 | Primary provider/profile/draft documents | Platform documentation, not a live COLP/host integration test |
| Remaining R entries; W03–W08 | Retained original baseline references | Not independently re-read as a complete set in this review; AW-01 rechecks exact assumptions before coding |

Additional primary references: **W09** [OpenAI Meet dots](https://learn.chatgpt.com/docs/dots), reviewed 2026-10-13; defines the cloud-agent surface and rollout/permission caveats. **W10** [OpenAI MCP connectivity guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), reviewed 2026-10-13; private/tunnel connectivity exists in other MCP integrations, but Events through that topology is not verified by this pack.

Direct repository references for the checked files: [canonical mutation](https://github.com/WhitenWhiten/colp/blob/2ee8397cc20008e7865f2a080c91be2d38d323ae/packages/server/src/modules/collections/application/canonical-mutation.ts), [SDK boundary](https://github.com/WhitenWhiten/colp/blob/2ee8397cc20008e7865f2a080c91be2d38d323ae/packages/node/src/shared/mcp-sdk-boundary.ts), [agent plans and Undo](https://github.com/WhitenWhiten/colp/blob/2ee8397cc20008e7865f2a080c91be2d38d323ae/packages/server/src/modules/mcp/agent-plan-policy.ts), [foreground classification](https://github.com/WhitenWhiten/Know-N/blob/28acb4965/Known-Extension/src/classification-local-preview.ts) (private repository access required).

No actual database crash test, browser lifecycle, model call, live subscription, callback or dot run was performed during this artifact review. Every AC test remains planned_not_executed. The validation reports describe only checks executed against this document pack.
