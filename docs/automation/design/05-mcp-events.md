# MCP Events and Conditional Tool Catalog

**Status:** proposed M2 adapter; not a deployed or tested COLP/dot integration. **Version:** 0.2.1-design. **Review date:** 2026-10-13. W01/W02/W09/W10 identify primary references in [the evidence register](08-evidence-and-decisions.md). [The OpenAPI](api/mcp-events.openapi.yaml) describes method payloads, not a second REST endpoint or the complete MCP envelope.

## 1. Keep the chosen architecture

MCP Events is the preferred hosted-worker wake-up path. `automation.jobs.list`, get, inputs, claim, heartbeat, submit and fail are the durable worker contract in either wake mode. A webhook points to work; it neither authorizes an effect nor proves completion. Per-target polling is the alternative for a worker that can reach COLP, not an implementation of protocol `events/poll` and not a way for an unreachable hosted bot to access a LAN.

For v1, the tested hosted topology is an externally reachable HTTPS MCP endpoint and public HTTPS callbacks. These are two different network directions. Official tunnel connectivity exists for other MCP integrations (W10); this pack makes no unverified claim that Events through a tunnel works or is impossible. It is outside v1 acceptance. Origin shape is a setup hint only. The backend returns `wakeMode`, `wakeReadiness` and `wakeReason`; an Owner override cannot bypass reachability, authentication, callback verification or workspace controls.

## 2. Official capability versus integration evidence

W01 documents MCP `2026-07-28`, `server/discover` with `events`, and `events/list`, `events/subscribe`, `events/unsubscribe` on the same authenticated endpoint as tools. The documented OpenAI integration uses webhook delivery and verification; do not mount draft poll, stream, gap or terminated behavior. Work chat support is surface-specific (web, or desktop Work with Cloud); dots are also named. Availability and workspace settings still apply.

W09 defines a dot as an always-on cloud agent, not a COLP executor class or a credential type. Its own computer/browser does not imply unlimited permissions, guaranteed unattended completion, a dot-creation API in COLP, or distinct OAuth identities for two dots. Only AW-02/AW-46 can establish the selected account's actual lifecycle and identity behavior. Neither test was run while reviewing this document pack.

The experimental sketch W02 is a draft with poll/push and provisional errors. Keep the OpenAI compatibility profile separate: W01 uses `-32015 CallbackEndpointError`; the current draft uses a different provisional allocation (`-32027`). Never mechanically renumber the OpenAI adapter from the draft. Pin descriptor and request fixtures plus the COLP SDK boundary. Capability advertisement must fail closed if schemas strip the extension.

## 3. Composable catalogs and bootstrap

`ConnectionProfileInput.catalogs` is an explicit set containing `standard`, `automationManager` and/or `automationWorker`. The two automation choices are independent Owner opt-ins, not ambiguous states of a single radio button. Profile visibility and current scopes are both required.

| Membership/state | Added tools | Required authority |
|---|---|---|
| standard only | None | No automation instructions or resources leak into ordinary clients |
| automationManager | rules.describe, bindings.list, targets.list, rules.validate, rules.preview, rules.save, rules.set_state (all prefixed `automation.`) | Explicit manager opt-in and each tool's read/manage scope |
| automationWorker, not paired | `automation.targets.pair` only | Authenticated worker opt-in, `automation:work`, one-use Owner grant bound to expected client/credential |
| automationWorker, paired | Pair plus `automation.jobs.list`, get, inputs, claim, heartbeat, submit, fail | Current target binding, work scope, job/input authority |

The [catalog](api/mcp-tool-catalog.json) contains 15 descriptors: seven manager and eight worker tools. It is a design registry, not a wire `tools/list` response; prune internal metadata and unreachable definitions when generating the actual catalog. Apply the same authorization on `tools/call`. Include tenant, credential/client binding, scopes, profile revision and host mode in caches. A client name such as “dot” grants nothing.

## 4. Pairing in both transports

The Owner creates the connection profile/target and a short-lived grant. The intended authenticated worker redeems it with `automation.targets.pair` or `POST /api/v1/automation-work/pairings/claim`. The pre-pair request is not required to have a target already and never needs manager scope. Atomically verify and consume the grant, rate-limit failures, bind the target, and make subsequent work tools visible. A server may perform an equivalent explicit Owner binding for an existing known local credential, but it must not infer it from a name, callback or access to the endpoint.

Pairing codes never enter subscription arguments, query strings, exported templates or logs. A target is a logical inbox. Multiple targets sharing a credential are not mutually isolated principals; restricted rules require demonstrably dedicated credential bindings. The job ledger issues `deliveryHandle` in both Events and poll mode; it is an authenticated locator, not a webhook ID or bearer authorization.

## 5. Discovery, subscribe and TTL

Expose `colp.automation.triggered`, filtered by current principal authority, with subscription arguments `{targetId}`. `payloadSchema` describes `data`, not the outer occurrence. Subscription identity is authenticated principal, callback URL, event name and canonical arguments. Refresh preserves that identity and changes neither job membership nor job IDs.

V1 explicitly implements no event replay: request cursor must be null; response cursor is null and truncated is false. A non-null cursor fails validation rather than pretending to restore history. Omitted TTL uses a finite server default; a requested TTL may be shortened or raised to a configured minimum as documented by W01. V1 declines indefinite lifetime by granting a finite `refreshBefore`. Persist the granted deadline and require refresh before it. Changing descriptors requires a platform plugin rescan as applicable, not merely a local cache clear.

## 6. Callback verification and signing

Validate `whsec_` base64 by decoded length (24–64 bytes), current target authority and the HTTPS URL before I/O. Reuse hardened egress only after AW-01 confirms its real API: public address classification at connection time, pinned destination with TLS hostname checks, no redirects, no forwarded COLP credentials, bounded body/time. A DNS check performed only at subscribe time is insufficient.

Sign the verification body and verify the returned challenge under W01. Use short-lived single-use challenges and a bounded successful-verification cache keyed by principal, URL and secret generation. Encrypt secrets at rest and never expose them in Product DTOs. Use Standard Webhooks headers plus `X-MCP-Subscription-Id`; the signature covers the exact body. `webhook-id` equals the occurrence event ID. Serialize once and reuse the same body and event ID across retries, but generate a fresh signing timestamp and signature for every attempt. Secret rotation uses a short explicitly bounded dual-signing window, then deletes the old secret.

## 7. Delivery is not execution

A ready transition persists an occurrence with minimal references: run, job, rule/revision, target, member count and job access handle. One HTTP POST carries one occurrence; a host may group several occurrences into one task run. Iterate all referenced jobs and tolerate duplicate/out-of-order events. The broader academic fixture can create three worker jobs; use academic-summary-only for the deliberately one-job release fixture.

Keep the body near 4 KiB and below the documented 256 KiB maximum. A 2xx acknowledges receipt, not claim, model success or committed effect. `410` and `413` are terminal for automatic retry: in this design, 410 deactivates that subscription path; 413 dead-letters only the oversized occurrence and raises a diagnostic, not every healthy job/target. Other failures use bounded jittered retry and applicable Retry-After caps. Persist delivery leases/generations, send outside database locks, and recheck pause, expiry, authorization and generation before recording the result.

## 8. Lost wake-up and recovery

Non-replayable occurrences missed during an interruption are not recoverable through an event cursor. Ready jobs remain in COLP. The worker lists the authorized queue on initial setup and every reconnect, then claims any remaining jobs. The server may issue a new bounded readiness reminder for still-ready work after a new subscription; that is a new occurrence about current state, never a replay of old history. Do not run a hidden protocol poll loop for an Events target or silently switch its configured mode. A polling worker uses its own explicit schedule.

Read inputs through `automation.jobs.inputs` or its HTTP counterpart. This enforces the declared field allowlist and current source authority; do not instruct a minimally scoped worker to call broad `nodes.get`. A worker separately granted general node read/write permissions is outside the job-only fence and that fact must be disclosed. Page/source contents and metadata are untrusted input, never new instructions or authority.

## 9. Release evidence

AW-02 is an independent backend fixture spike, not a production pairing flow that depends on M2 UI. AW-46 verifies the real hosted lifecycle: discovery, list, challenge, create/refresh/expiry/restart/unsubscribe, schema rescan, identity isolation limits, bad secret, DNS/redirect blocks, duplicate/out-of-order delivery, fresh retry signatures, burst grouping, reconnection and accepted effects. Preserve redacted build/version/date evidence. Missing account access or an unproven platform behavior remains an explicit feature gate. M1 does not depend on that hosted gate.
