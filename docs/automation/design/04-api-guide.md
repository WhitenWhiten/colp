# API Guide and OpenAPI Integration

**Status:** design contract, not deployed. **Version:** 0.2.1-design. Two self-contained OpenAPI 3.1.0 documents are supplied: [Product, device and worker API](api/automation.openapi.yaml) and [MCP Events and outbound webhooks](api/mcp-events.openapi.yaml). The existing Product API stays authoritative for session, command and error integration (R11, R13, R23). Operation milestones are tagged `x-delivery-phase` in the YAML and listed in [operations.json](api/operations.json).

## 1. Surface boundaries

| Surface | Authentication | Purpose | Milestone |
|---|---|---|---|
| `/api/v1/me/automations/*` | Owner Product session: cookie `__Host-known_session` (`known_session` on acknowledged plain HTTP), `x-csrf-token` header plus Origin allowlist on writes (R23) | Rules, bindings, policies, targets, health, runs, approvals, pause, run-once, export, templates | M1+ |
| `/api/v1/automation-device/*` | The extension's existing device/replica bearer with a new `automation:device` grant | Rule bundles and intake receipts | M1 |
| `/api/v1/automation-work/*` | Agent bearer (OAuth or API key) with `automation:work` and a target binding | List, claim, heartbeat, submit, fail for workers that prefer HTTP over MCP tools | M2 |
| MCP endpoint (manifest-discovered) | Existing MCP OAuth and resource audience | Worker tools, manager tools and `events/*` methods | M2 |
| Subscriber callback (outbound) | Standard Webhooks signature; no COLP credential forwarded | Wake-up for targets in events mode | M2 |

Device and work bearer routes do not accept cookies and do not use the CSRF header; they still enforce CORS and audience policy. No new authentication issuer is introduced.

## 2. Common Product contract

Every read is current-authorized and private. Cursors are opaque, owner-scoped, bound to the normalized filter and ordering. Lists accept `limit` 1–100 and return `items` with nullable `nextCursor`, ordered by `(created_at, id)` unless the resource says otherwise. No arbitrary filtering in v1; typed filters only.

Every mutation carries `Known-Command-Id`. Same command and body replays the stored result; same command and different body is `409 automation_command_conflict`. Writes that change existing configuration or approve a proposal require `If-Match` with the resource ETag; node and collection revisions are separate fences. GET never runs a model or changes a bookmark. Validate and preview may store expiring diagnostic records; they never classify, deliver, publish or spend.

The verified Product error envelope is reused unchanged (R13):

```json
{
  "error": {
    "code": "automation_binding_unavailable",
    "message": "A required folder binding is unavailable.",
    "requestId": "request_demo",
    "recovery": "user_action",
    "sameRequestRetrySafe": false,
    "precondition": null,
    "currentEtag": null,
    "retryAfterSeconds": null,
    "fieldErrors": [
      {"path": "bindings.academicRoot", "code": "deleted", "message": "Choose a live authorized folder."}
    ]
  }
}
```

`automation_*` codes are additions to the host's closed error registry (`transport/product-codes.ts`). Never return Publication Problem Details from these routes.

## 3. Errors and recovery

| HTTP | Code | Recovery |
|---|---|---|
| 400 | `invalid_request` | Fix the shape; do not retry unchanged |
| 401 | `authentication_required` | Reauthenticate through the existing flow |
| 403 | `automation_mode_disabled`, insufficient scope | Enable the capability or obtain authority; capability alone never authorizes |
| 404 | `resource_not_found` | Foreign, unknown and disabled resources are concealed alike |
| 409 | `automation_rule_conflict`, `automation_binding_unavailable` | Repair the conflict or binding |
| 409 | `automation_command_conflict` | Retry with the original body or a new command ID |
| 409 | `automation_lease_conflict`, `automation_stale_input` | Re-read the job; never force an old result |
| 412 | `precondition_failed` | Read the fresh ETag and rebase explicitly |
| 413 | `payload_too_large` | Reduce bounded content |
| 422 | `automation_unsupported_capability`, `automation_invalid_graph` | Change the rule or install the capability |
| 428 | `precondition_required` | Supply `If-Match` |
| 429 | `automation_budget_exhausted`, `rate_limited` | Respect `Retry-After`; never rotate identity to evade limits |
| 503 | `service_unavailable`, `automation_paused` | Bounded retry when `sameRequestRetrySafe`; a paused server tells workers to back off |

## 4. Lifecycle sequences

### Create and enable (M1)

Create the draft rule (the web editor creates its binding set in the same flow). Validate. Preview over the last 200 bookmarks in scope or over supplied facts. Enable through lifecycle with the rule ETag and the accepted preview ID. Activation recomputes authority and source fences. Desired state and effective state are separate: a rule can be enabled while its worker target is unavailable ("degraded"); a missing intake folder blocks admission.

### Pause all (M1)

`POST /api/v1/me/automations/pause` with `{ "paused": true }` stops admission for every rule, holds pending jobs and sets the bundle flag. Workers that list jobs receive `503 automation_paused` with `Retry-After`. Resume captures fresh source/activation high-water fences and does not backfill. Browsers read `/pause` with their web session independently of personal Sync, checking `Known-Automation-Account-Id` in the same response. Offline devices learn a new pause on their next successful refresh; an expired bundle withdraws account placement permission. A learned pause also stops browser rules and site automations, survives expiry and failed reads, and cannot be rolled back by an older settings response. Pause revisions and bundle configuration epochs are separate sequences. Bookmarks saved while paused can later be selected explicitly by M3 run-once; M1 must not imply that action is already available.

### Device handoff (M1)

GET the bounded full bundle; validate digest, profile, version and expiry; install atomically; acknowledge. The bundle references canonical folder identities; the device resolves them to native IDs itself. POST intake receipts with device generation and the sync operation identity; the server may answer `waitingForSync`. Repeating a receipt is idempotent. Bundle replacement carries `removedRuleIds`; an oversized bundle is refused with a diagnostic, never served partially.

### Worker execution (M2)

A worker sees only jobs for its own target. A target in events mode is told when to look; a target in poll mode looks on its own schedule. Either way it lists ready jobs, claims one (atomic; opaque lease token and generation), reads only allowlisted data through `automation.jobs.inputs` or `getAutomationWorkInputs` under current job/source authority, heartbeats, and submits a typed result bound to the original input digest and contract. `succeeded` means the typed result and any required canonical effect have been durably accepted; `awaitingApproval`, `review` and `stale` are not success. A failure report distinguishes `knownRetryable`, `permanent` and `unknownOutcome` before any reassignment.

The same contract is exposed twice: as the `automation.jobs.*` MCP tools (for agents that live in an MCP client) and as `/api/v1/automation-work/*` (for scripts and cron). Neither grants write tools; the server applies results.

### Approve and undo (M1 placement; M2 agent plans)

M1 records deterministic placement effects and permits a proven compensating move without an agent. M2 canonical agent mutations use a change plan with cause `automation:<ruleId>:<jobId>` and existing manual/trusted approvals. `undoAutomationRun` takes one effectReceiptId and digest; the baseline uses collection-content fences, not arbitrary field-level restore. Unknown before-state or newer content returns undo-unavailable/conflict. No automation force-restore flag is exposed. Plan commit and job bookkeeping use durable idempotent orchestration and reconciliation, not an assumed nested transaction.

### Run once (M3)

`POST /api/v1/me/automations/rules/{ruleId}/run-once/preview` returns counts and a sample for a folder; `POST .../run-once` creates a `manual` run using required previewId/previewDigest and exactly the unexpired stored member/revision snapshot (≤ 1,000). Changed options, configuration or source revisions require a new preview. Over-limit previews cannot start; no silent truncation. It never schedules itself again.

### Export (M1)

`GET /api/v1/me/automations/export` returns the Owner’s current, unarchived rule configuration as PortableRuleDefinition with symbolic collection/target slots and optional private folder-path hints, without live target IDs, secrets or pairing codes, for the web Export menu and `colp-server export`. Archived history remains in the database and is excluded from this configuration export, so historical rules do not consume the 500-rule export limit.

### Wake-up (M2)

Target created → authenticated worker pairing (or explicit Owner binding of an existing credential) → the agent pairs over MCP → for events mode the agent subscribes with `events/subscribe` → callback verified → ready-job occurrences delivered. A hosted run may handle several occurrences and deliveries may retry. Targets in `poll` mode receive no occurrence; their jobs wait in the ready list. Switching modes is a target update with `If-Match`. Details in [the Events adapter](05-mcp-events.md).

## 5. Operation inventory

Path presence is not a feature claim; the capabilities response lists mounted behavior only. Full list with method and path in [operations.json](api/operations.json).

| Milestone | Operations |
|---|---|
| M0 | `getAutomationCapabilities` |
| M1 | rules: `validateAutomationRule`, `previewAutomationRule`, `listAutomationRules`, `createAutomationRule`, `getAutomationRule`, `replaceAutomationRule`, `setAutomationRuleLifecycle`, `getAutomationRuleHealth`, `getAutomationRuleDependencies`, `revalidateAutomationRule`; binding sets: list, create, get, replace; incidents: list, acknowledge; runs: `listAutomationRuns`, `getAutomationRun`, `cancelAutomationRun`, `undoAutomationRun` (verified placement only); `setAutomationPause`; `exportAutomations`; device: `getAutomationDeviceBundle`, `acknowledgeAutomationDeviceBundle`, `ingestAutomationIntakeReceipt` |
| M2 | execution policies: list, create, get, replace; targets: list, create, get, replace, `createAutomationTargetPairing`, `revokeAutomationTarget`; connection profiles: list, create, get, replace; executors: list, get (created automatically with a target); subscriptions: `listAutomationSubscriptions`, `revokeAutomationSubscription`; deliveries: `listAutomationDeliveries`, `retryAutomationDelivery`; `getAutomationJobForOwner`, `decideAutomationJob`; extends `undoAutomationRun` to linked agent plans; work: `claimAutomationTargetPairing`, `listAutomationWork`, `getAutomationWork`, `getAutomationWorkInputs`, `claimAutomationWork`, `heartbeatAutomationWork`, `submitAutomationWorkResult`, `reportAutomationWorkFailure` |
| M3 | `previewAutomationRunOnce`, `startAutomationRunOnce`, `listAutomationRunOutputs`, `markAutomationRunRead` |
| M4 | templates: list, import, install, export |
| Later | `replayAutomationRule`, `createAutomationExecutor`, `replaceAutomationExecutor` |

## 6. Schema and semantic mapping

`RuleInput` is shared by create, validate and preview. `RuleDefinition` is live deployment logic; `PortableRuleDefinition` is shareable logic before binding; `BindingSetInput` and `ExecutionPolicyInput` are local configuration. Worker results use `TaskOutput` discriminated by kind. Restrictions that JSON Schema cannot express are mandatory in the semantic validator.

`TargetInput.wakeMode` (`events` or `poll`) and `pollIntervalMinutes` are target settings; the backend proposes the selected mode and computes readiness using actual authority/verification/reachability. Owner selection does not override readiness checks. A target created from the Agents page creates its executor record; `Executor.verifiedCapabilities` is what the server has seen the agent complete, not what the agent declares. Provider credentials (Later server-model executors) are host-owned references, never returned.

The example execution policy has zero COLP-billed budget and `externalCosts: unknownDisclosed`: the agent bills its own platform. A strict monetary cap can only be promised for executors whose cost is known; otherwise the UI says "billed by your agent".

## 7. Existing repository integration

Add `packages/server/openapi/fragments/automations.yaml` and reference it from the bundle source so that `colp-server-v1.yaml` includes the new paths and components; prefix component names (`Automation…`) to avoid collisions. Run the existing pipeline; never hand-edit `packages/server/generated/openapi/*` or `packages/web/src/generated/*`:

```sh
npm --prefix packages/server run openapi:lint
npm --prefix packages/server run openapi:generate
npm --prefix packages/server run openapi:ci
npm --prefix packages/web run generate:api-types
```

Routes register through the route manifest derived from the bundle (`transport/product-route-manifest.ts`); feature-gated operations join the existing gate lists so readiness coverage stays honest. MCP tools and Events methods use the same application services with MCP framing. Product DTOs map to application commands; they never become COLP Sync wire types.

## 8. Worked client interaction

```http
POST /api/v1/me/automations/rules
Content-Type: application/json
Known-Command-Id: a1d3bb12-5a80-4e04-8a50-596501da3c8f
Origin: https://colp.example.invalid
x-csrf-token: <host-token>
Cookie: __Host-known_session=<host-session>

<contents of examples/m1-rule-create.json>
```

The 201 response contains a draft Rule and ETag. A separate lifecycle call enables it after preview. A 201 is not proof that any agent will run a job. Companion examples carry synthetic IDs and an unusable all-zero demonstration secret; never treat this pack as a credential bundle.

## 9. Contract ownership

The backend owns OpenAPI, result states and permission decisions; Web/extension consume generated DTOs and versioned fixtures. Catalogs are a composable set; pre-pair worker authority exposes only pairing, not manager functions. The complete worker interface includes queue list and HTTP pairing. Run outputs are paginated backend data; read commands name the last viewed output so concurrent outputs remain unread. See [execution contract](11-execution-contract.md) and [delivery lanes](12-delivery-lanes.md).

## 10. Implemented manager recovery tools (2026-10-30)

The source of tool names, closed input schemas and required scopes is the [MCP catalog](api/mcp-tool-catalog.json). The manager profile must be enabled for the current credential; enabling a browser bridge additionally requires the Owner's explicit opt-in on that device.

| Task | Tools and constraints |
| --- | --- |
| Inspect ordinary saved classification | `automation.classification.captures.list/get/retry`; list cursors bind account and collection. Retry requires the observed capture revision and retains the original save identity. User edits and stopped work remain fenced. |
| Preview classification | `automation.classification.preview` accepts exactly one of `jobId`, `captureId`, or incoming `bookmark`. It may call the browser's configured provider once and returns suggestions without creating or moving a bookmark. Diagnostics accept `cursor` and `group` (`recovery` or `history`). |
| Repair adapter work | `automation.adapters.tasks.list/get/control` select a connection and one task kind: semantic, confirmation, import, save, transfer, reconcile or observation. Each task exposes reasons, revision and permitted actions. Control requires that revision and only accepts advertised retry/resume/cancel actions. Existing confirmation and permission requirements still apply. |
| Repair personal Sync | `automation.sync.conflicts/resolve_conflict`, `retry_issue`, `replica_plan/replica_command`. Read the current plan before sending retry/rebuild. Rebuild requires `confirmation: "rebuild_replica"` and the observed lifecycle revision; commands remain asynchronous and are reconciled through Sync status. |
| Configure automation | `automation.pause.get/set`; `connection_profiles`, `executors`, `execution_policies` each provide `list/get/save`; `targets` provides `list/get/save/revoke/issue_pairing`. Save selects create or update explicitly; updates require the observed revision. Only installed executor kinds and enforceable policy limits are accepted. |

Browser tools return a durable device request handle; poll `automation.device_requests.get` for the operation result. Use a new `commandId` for each continuation request. The bridge authenticates with the current bearer and installation proof (`Known-Sync-Replica-Id` and `Known-Sync-Replica-Proof`), independently of personal Sync's run state or lease. Account, replica ownership, proof, credential security epoch and revocation are still checked. Legacy live Sync-session authority remains accepted. Disabling the bridge prevents pending work from applying.

Manager reads require `automation:read`; mutations require `automation:manage`. Sync conflicts additionally require `mcp:read:own`; resolving them and issuing replica commands additionally require `nodes:write`. Configuration writes use the same owner transaction, validators, revision preconditions and durable receipts as Product HTTP. A lost reply is retried with the same command and arguments; a changed body with the same command is rejected. List continuations inherit the signed page size when `limit` is omitted; explicitly changing it requires restarting the list.

To connect a worker, create its profile and target, then issue a pairing grant with the target revision. `automation.targets.issue_pairing` returns a five-minute code once and advances `targetRevision`. Its exact receipt replay returns `code: null, replayed: true`; the server never stores the code in receipt plaintext. If the first response was lost, read the current target and explicitly issue a new grant, invalidating older grants. Deliver the code only to the intended worker, which redeems it with `automation.targets.pair` under its own worker authority.

Events remain wake hints. Workers reconcile `jobs.list` on startup/reconnect. Retrying a dead delivery after its subscription generation or target authority changed is rejected with an explanation; it does not report a retry that the worker will immediately cancel.
