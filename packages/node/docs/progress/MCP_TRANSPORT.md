# MCP Transport Progress (COLP-MCP-03)

> **Candidate: `mcp-transport-entry-candidate`** — internal development
> artifact that was NOT a Profile claim or a release; COLP-MCP-15 accepted
> the exact MCP `2026-07-28` source-bound evidence and restored `mcp-read` /
> `mcp-write` (see `MCP_READ.md` / `MCP_WRITE.md`). This document records
> the SDK lock and the independent reference harness.

## Locked upstream MCP SDK

| Package | Role | Locked version |
|---|---|---|
| `@modelcontextprotocol/core` | dependency | `2.0.0` (exact) |
| `@modelcontextprotocol/client` | devDependency | `2.0.0` (exact) |
| `@modelcontextprotocol/server` | devDependency | `2.0.0` (exact) |

Policy: `docs/MCP_SDK_POLICY.md`. Source-bound boundary:
`src/shared/mcp-sdk-boundary.ts` (with an MCP-internal compatibility re-export
at `src/mcp/2026-07-28/sdk-boundary.ts`). Lock contract:
`tests/mcp/mcp-2026-07-28-sdk-lock-contract.test.ts`. Harness contract:
`tests/mcp/mcp-2026-07-28-reference-harness-contract.test.ts`.

## Harness topology (fixed by COLP-MCP-03)

| Surface | Location | Contract |
|---|---|---|
| Reference client (official `@modelcontextprotocol/client`) | `tests/fixtures/mcp-2026-07-28/reference-client/` | pinned modern era via `server/discover`; per-request `_meta` envelope |
| Fixture host / transport bridge (official `@modelcontextprotocol/server`) | `tests/fixtures/mcp-2026-07-28/fixture-host/` | POST JSON, POST→SSE, abort, bounded FIFO backpressure, restart/shutdown, fault injection |

The fixture host is test-only: it is not under `src/`, not a tsup entry, not
in package `exports`, and absent from the production tarball (asserted by the
lock contract test and `npm pack --dry-run`). Neither the fixture host nor the
reference client shares a hand-written JSON-RPC/SSE frame parser with
production code.

## Candidate status

| Aspect | Value |
|---|---|
| Candidate | `mcp-transport-entry-candidate` |
| Status | Accepted — accepted by COLP-MCP-15 |
| SDK N | `@modelcontextprotocol/core@2.0.0` / client / server `2.0.0` (2026-07-28 era) |
| SDK N-1 | legacy `@modelcontextprotocol/sdk@1.30.0` rejected (no 2026-07-28) |
| Source revision | working tree at `ec396a1` (COLP-MCP-01/02 baseline); becomes revision-bound when COLP-MCP-03 is committed |
| Verification tests | `tests/mcp/mcp-2026-07-28-sdk-lock-contract.test.ts`, `tests/mcp/mcp-2026-07-28-reference-harness-contract.test.ts` |
| Static gates | `check:protocol`, `check:types`, `check:requirements`, `typecheck`, `build`, `pack:check`, `check:test-granularity`, `npm audit` |
| Profile claim | Restored by COLP-MCP-15 — `supportedProfiles` includes `mcp-read` / `mcp-write` |

## Completion notes

- `server/discover` smoke passes through the official client over the fixture
  host with per-request `_meta.protocolVersion = '2026-07-28'` (stateless
  semantics), and `subscriptions/listen` upgrades the POST response to an SSE
  stream with the ack delivered.
- Legacy-negative samples (`initialize`, `notifications/initialized`,
  GET/DELETE, `Mcp-Session-Id`, `Last-Event-ID`, `resources/subscribe`,
  `resources/unsubscribe`, `ping`, `logging/setLevel`) fail stably and are
  marked `Legacy-negative` in the harness contract test.
- Security audit baseline: 0 high, 0 critical, 1 moderate dev-only transitive
  (`postcss`, via tsup/vitest/vite) — recorded in `docs/MCP_SDK_POLICY.md`.
- Known SDK note: the SDK's public `SUPPORTED_PROTOCOL_VERSIONS` is the legacy
  `initialize` list and does not contain `2026-07-28`; the modern era is
  negotiated via `server/discover`. COLP's `MCP_PROTOCOL_VERSION` remains
  authoritative (see policy §3).

## Generic authorization bindings (COLP-MCP-04)

- Module: `src/mcp/shared/authorization.ts` — fixed shared contract family
  (part of the "generic authorization and stateless core" build track).
- Fixed contracts: `McpAnonymousAuthorizationBinding` /
  `McpAuthenticatedAuthorizationBinding` / `McpAuthorizationBinding`
  discriminated union, exactly as pinned in the development plan §4.
- Strict snapshot/freeze validator `snapshotMcpAuthorizationBinding`:
  accepts plain object literals, rejects accessors/Proxies,
  mutation-after-call, missing/extra fields, empty ids, non-string
  audience/epoch, cross-kind confusion, and raw secret markers.
- Token-free host evidence mapping (verified stable identifiers only):
  `mapOAuthEvidenceToAuthenticatedBinding`, `mapApiKeyEvidenceToAuthenticatedBinding`,
  `mapServiceEvidenceToAuthenticatedBinding`, `mapStdioEvidenceToAuthenticatedBinding`,
  plus generic dispatcher `createAuthenticatedBinding` and anonymous public Read
  factory `createAnonymousPublicBinding`. Raw tokens, client secrets, API Key
  values and reversible credential material never enter a binding.
- Authenticated-only Plan/Write helpers: `assertAuthenticatedBinding` /
  `requireAuthenticatedWriteBinding` narrow to the authenticated branch;
  compile-time rejection is verified by
  `tests/mcp/mcp-2026-07-28-authorization-bindings.typecheck.ts`.
- Resource audience / security epoch mismatch checks:
  `bindingMatchesResourceAudience`, `bindingMatchesSecurityEpoch`,
  `assertBindingMatchesResourceAudience`, `assertBindingMatchesSecurityEpoch`.
- Verification tests:
  `tests/mcp/mcp-2026-07-28-authorization-bindings-contract.test.ts`.

## Plan/Approval desession (COLP-MCP-05)

- Production: src/mcp/change-plan.ts no longer defines McpPlanBinding; Plan,
  stored Plan, Approval Store, commit coordinator, rate-limit and revision/scopes
  ports now take the shared McpAuthenticatedAuthorizationBinding
  (kind/principalId/clientId/credentialBindingId/resourceAudience/securityEpoch)
  from src/mcp/shared/authorization.ts. Stored plans, approvals and commit
  receipts carry no sessionId. Binding comparison in assertBindingMatch and the
  in-memory approval store is exact equality across the five authenticated
  dimensions (plus kind); readBinding snapshots and narrows through
  snapshotMcpAuthorizationBinding + requireAuthenticatedWriteBinding, so
  anonymous and legacy session-shaped inputs fail closed with
  plan_binding_mismatch.
- src/mcp/write-tools.ts minimal compile adaptation (COLP-MCP-06 owns the full
  trusted request context migration): McpTrustedHostAuthorizationContext.binding
  is now McpAuthenticatedAuthorizationBinding, built by the gateway through the
  snapshot validator + requireAuthenticatedWriteBinding.
- Public surface: McpPlanBinding removed from src/mcp/index.ts and src/index.ts;
  the shared authorization binding family is exported from both boundaries.
  COLP-MCP-12 later removed the unrelated Session-oriented binding and the
  pre-Modern stdio factory from the public surface (see MCP_READ.md).
- Tests (written first): tests/mcp/mcp-2026-07-28-plan-approval-desession-contract.test.ts
  covers principal/client/credential/audience/security-epoch mismatch, digest and
  revision drift, concurrent consume, idempotent replay, expiry/retention, current
  authorization recheck, old session-shaped row/input and anonymous rejection, and
  public type absence. Existing h01..h09/m0x/t0x/durable-host tests migrated to the
  authenticated binding shape without dropping security/persistence/exact-once
  assertions.
- Candidate status: Draft — produced by COLP-MCP-05. No Profile claim;
  `mcp-read` / `mcp-write` stay quarantined (`MCP_READ.md` / `MCP_WRITE.md`).

## Write Gateway trusted request context (COLP-MCP-06)

- Production: src/mcp/write-tools.ts now accepts a per-request authenticated
  trusted context `McpTrustedWriteRequestContext`
  (binding/scope/budget/abortSignal plus opaque host residual `authorization`).
  `McpTrustedHostAuthorizationContext` was renamed to
  `McpTrustedWriteRequestContext` and re-semanticised: every
  `callTool` / `recordOutOfBandApproval` call re-accepts and re-validates the
  current binding, scope, budget and abort signal; the gateway never captures or
  reuses a Plan-creation request context object. Application ports
  (low-risk Tool, apiKeys) receive the per-request context, which never stores
  raw tokens/secrets and never receives Header/JSON-RPC/SDK request/transport
  objects.
- Budget is now per request: the gateway default `inputBudget` remains the
  transport byte cap (`transportRequirements.maxRequestBodyBytes`) and the
  plan-schema cap, while each call's trusted context carries its own budget
  used for input validation, risk assessment and output snapshot
  (`createMcpToolInputValidator` gained an optional per-call budget argument).
- Abort threading: the gateway validates the `AbortSignal`, rejects aborted
  calls at entry with `McpWriteRequestAbortedError` (`request_aborted`), carries
  the live signal through to application ports, and re-checks it after every
  awaited Plan/Approval/application call so an aborted request never yields a
  model-visible result. Anonymous bindings, malformed contexts, invalid
  scope/budget/abortSignal fail closed with `McpWriteBindingRequiredError`.
- Tests (written first): tests/mcp/mcp-2026-07-28-write-gateway-trusted-context-contract.test.ts
  covers anonymous rejection, current vs different binding, scope/risk
  downgrade, timeout/abort, secret redaction, output validation, application
  exception hiding, same/different idempotency replay and Session public
  absence. Existing h01/h07/m02/m03/h09/t01/risk-aggregation/secret-redaction/
  write-mount tests were migrated to the per-request context API.
- Session absence: write-tools.ts / write-mount.ts contain no `sessionId` /
  `McpSessionBinding` / `McpPlanBinding`; since COLP-MCP-12 the /mcp entry no
  longer re-exports the Write module at all
  (the Resource Server Session API was removed by COLP-MCP-07).
- Candidate status: Draft — produced by COLP-MCP-06. No Profile claim;
  `mcp-read` / `mcp-write` stay quarantined (`MCP_READ.md` / `MCP_WRITE.md`).

## Stateless Resource/Tool ports (COLP-MCP-07)

- Production: `src/mcp/shared/resources.ts` establishes protocol-neutral
  Resource projection ports and canonical models, the per-request trusted read
  context `McpTrustedReadRequestContext` (authorization binding, scope, read
  budget, abort signal plus opaque host residual), the read budget
  (`McpResourceReadBudget` + resolver), an own-data clock port
  (`McpReadClockPort`, reserved for COLP-MCP-09 cache metadata) and the
  reusable stateless application core `createMcpStatelessReadCore`. One frozen
  core serves concurrent per-request contexts; list/read re-validate the
  context, canonicalize URIs through the injected `McpResourceUriCodec`,
  enforce cursor/list/content/text budgets, honor abort signals, hide
  application exceptions behind the generic secret-free `McpResourceRequestError`
  and never retain request-scoped state.
- `src/mcp/shared/tools.ts` establishes the protocol-neutral Tool execution
  port (`McpToolExecutionPort`), safe `McpToolDefinition` schemas and the
  stateless Tool core `createMcpStatelessToolCore` (deterministic frozen
  `listTools`, per-call `callTool(context, name, input)` with name checks,
  abort checks, per-request budget snapshot and application exception hiding).
- The removed per-Session Resource Server
  (`createMcpReadResourceServer` / `McpReadResourceServerSession` /
  `subscribeResource` / `unsubscribeResource`, sessionId echo and the instance
  subscription Map) is deleted together with
  `src/mcp/resource-server.ts`; `collections-get.ts` /
  `collections-get-snapshot.ts` now route through the shared Tool core and
  their application ports receive the per-request trusted context, and
  `read-mount.ts` keeps consuming the gateway through the updated `McpReadToolGateway` type unchanged, while the package root export surface drops the removed Session API and adds the stateless core exports.
- Resource/Tool fake ports and the shared modules carry no MCP Header,
  JSON-RPC, transport or SDK types (`sdk-boundary.ts` allowlisted schema types
  stay in the 2026-07-28 adapter layer). COLP Sync Session is untouched.
- Tests (written first): tests/mcp/mcp-2026-07-28-stateless-resource-tool-ports-contract.test.ts
  covers concurrent principal isolation, anonymous/authenticated binding
  threading, cursor/URI canonicalization, scope/security epoch passthrough,
  abort, budgets, application exception hiding, no retained context,
  protocol-neutral fake ports, Sync Session non-collateral and runtime absence
  of the removed API; tests/mcp/mcp-2026-07-28-stateless-resource-tool-ports.typecheck.ts
  proves the old factory/type symbols no longer compile. The old
  resource-server-security-contract.test.ts was deleted and its still-valid
  read tool gateway / schema tests were migrated in place.
- Candidate status: Draft — produced by COLP-MCP-07. No Profile claim;
  `mcp-read` / `mcp-write` stay quarantined (`MCP_READ.md` / `MCP_WRITE.md`).

## Modern request/discovery/result contracts (COLP-MCP-08)

> **Candidate: `mcp-request-candidate`** — internal development artifact, NOT
> a Profile claim and NOT a release. `mcp-read` / `mcp-write` stay
> quarantined (`MCP_READ.md` / `MCP_WRITE.md`). Completion standard: a host
> transport can map every Modern `2026-07-28` request independently into
> exactly one trusted adapter call/result.

- `src/mcp/2026-07-28/request-context.ts` — per-request adapter. Raw header
  fields + parsed JSON body `_meta` envelope map into exactly one frozen,
  token-free `Mcp20260728RequestContext` (extends `McpTrustedReadRequestContext`
  so stateless cores accept it directly). Stable wire codes: `-32020`
  `HeaderMismatch`, `-32021` `MissingRequiredClientCapability`, `-32022`
  `UnsupportedProtocolVersion`; legacy `Mcp-Session-Id` / `Last-Event-ID`
  headers rejected; duplicate/conflicting standard or `Mcp-Param-*` headers,
  missing/conflicting `Mcp-Method`/`Mcp-Name`, header/body version or name
  mismatches, invalid Base64 sentinels and undeclared `Mcp-Param-*` headers
  all reject stably. Unknown `_meta` extension keys are budgeted and inert
  (never enter authorization); W3C trace context (`traceparent`/`tracestate`/
  `baggage`) is bounded and tracing-only; per-request `_meta` log level gates
  `notifications/message` (`mayEmitMcp20260728LogNotification`); missing
  required client capabilities fail with `-32021`
  (`requireMcp20260728ClientCapability`). The Base64 sentinel codec
  (plain/encoded/sentinel) and `x-mcp-header`/`Mcp-Param-*` validation mirror
  the pinned SDK's client/server contract helpers (the core dependency does
  not export them; see `docs/MCP_SDK_POLICY.md` §3). 2026-08-27 (MCP
  usability audit MCP-U-06/07): a missing `_meta` envelope / missing
  `protocolVersion` field now rejects as `-32602` and a missing
  `MCP-Protocol-Version` header as `-32020` (only an unsupported version
  *value* stays `-32022`), and envelope/header errors carry a repair hint in
  `data` (`MCP_20260728_EXPECTED_ENVELOPE_HINT` /
  `MCP_20260728_REQUIRED_HEADERS_HINT`).
- `src/mcp/2026-07-28/discovery.ts` — `server/discover` advertises exactly
  `['2026-07-28']` plus the host-provided real capabilities, stamps
  serverInfo into result `_meta`, validates against the pinned
  `DiscoverResultSchema`, and returns a deeply frozen snapshot;
  `validateMcp20260728DiscoverRequest` gates incoming discover bodies.
- `src/mcp/2026-07-28/results.ts` — Modern results always carry `resultType`
  (`complete` default; `input_required` confined to `tools/call`,
  `prompts/get`, `resources/read`); cacheable operations (`tools/list`,
  `prompts/list`, `resources/list`, `resources/templates/list`,
  `resources/read`, `server/discover`) receive `ttlMs`/`cacheScope`
  (defaults `0` / `private`); results are deep-frozen.
  `normalizeMcp20260728Error` collapses adapter and upstream SDK-shaped
  errors into stable `-32020/-32021/-32022` codes and anything else to a
  low-sensitivity `-32603`.
- `src/shared/mcp-sdk-boundary.ts` allowlist extended (schemas
  `ImplementationSchema`, `ResultMetaObjectSchema`; `_meta` keys
  `LOG_LEVEL_META_KEY`, `TRACEPARENT_META_KEY`, `TRACESTATE_META_KEY`,
  `BAGGAGE_META_KEY`; public type `Implementation`) — policy document and the
  sdk-lock contract test updated in the same change.
- Tests (written first, adapter unit suites — no real HTTP server except one
  discover smoke over the fixture host):
  tests/mcp/mcp-2026-07-28-request-context-contracts.test.ts (headers,
  envelope/version, codec, x-mcp-header/Mcp-Param, capabilities, trace/
  extension budgets, log opt-in, trusted boundary),
  tests/mcp/mcp-2026-07-28-request-discovery-result-contracts.test.ts
  (discover, resultType/cache, error normalization, harness discover smoke)
  plus the compile-time companion
  tests/mcp/mcp-2026-07-28-request-discovery-result-contracts.typecheck.ts.
- Candidate status: Draft — produced by COLP-MCP-08. No Profile claim;
  `mcp-read` / `mcp-write` stay quarantined (`MCP_READ.md` / `MCP_WRITE.md`).

## Modern Read adapters (COLP-MCP-09)

> **Candidate: `mcp-read-candidate`** — internal development artifact, NOT a
> Profile claim and NOT a release. `mcp-read` / `mcp-write` stay quarantined
> (`MCP_READ.md` / `MCP_WRITE.md`). Completion standard: a single stateless
> adapter instance concurrently serves isolated Modern Read requests and does
> not create hidden per-client instances.

- `src/mcp/2026-07-28/resources.ts` — Modern Resource adapters over the
  shared stateless Read core: `resources/list`, `resources/read` and
  `resources/templates/list` (protocol-neutral host templates). Every result
  is `complete`, stamps `io.modelcontextprotocol/serverInfo` and, for the
  three cacheable methods, accurate `ttlMs`/`cacheScope` (host-configured or
  default `0`/`private`). Emitted fields are snapshotted against the
  per-request output budget and validated against the pinned
  `ListResourcesResultSchema` / `ReadResourceResultSchema` /
  `ListResourceTemplatesResultSchema`. Unknown Resources surface as a stable
  `invalid_params` (-32602) not-found error
  (`McpResourceNotFoundError` rethrown by the shared core), aborts surface as
  `McpReadRequestAbortedError`.
- `src/mcp/2026-07-28/tools.ts` — Modern read-only Tool adapters over the
  shared stateless Tool core. `tools/list` is deterministically ordered by
  registered name and validates against `ToolSchema` /
  `ListToolsResultSchema`; `tools/call` validates wire arguments against the
  Tool inputSchema (stable -32602 on invalid arguments / unknown tool) and
  maps structured scalar/array/object content to `CallToolResultSchema`.
  Raw secret markers in output are withheld
  (`Mcp20260728ReadToolSecretMarkerError`) so the Read side never leaks;
  `tools/call` is non-cacheable so it never carries `ttlMs`/`cacheScope`.
- `src/mcp/2026-07-28/schema-budget.ts` — Schema 2020-12 budget guard applied
  at Tool adapter factory time: bounded parse depth / node / reference /
  byte budgets over `$ref`/`$dynamicRef`/`$recursiveRef` and composition
  keywords, rejecting object cycles, ref bombs, Proxies, accessors and
  non-JSON prototypes (`McpSchemaBudgetError`).
- `src/shared/mcp-sdk-boundary.ts` allowlist extended (COLP-MCP-09): the
  Modern Resource/Tool result schemas (`ResourceSchema`,
  `ResourceTemplateSchema`, `ListResourcesResultSchema`,
  `ListResourceTemplatesResultSchema`, `ReadResourceResultSchema`,
  `ToolSchema`, `ListToolsResultSchema`, `CallToolResultSchema`) and the
  matching public type names are added to the allowlist, policy document and
  lock contract test in the same change.
- Tests (written first): tests/mcp/mcp-2026-07-28-read-adapters-contract.test.ts
  (list/read/templates, cursor/scope, anonymous/authenticated, large result,
  cacheScope/TTL, complete resultType, not-found, abort, structured
  scalar/array/object, secret marker, deterministic ordering, concurrent
  isolation), tests/mcp/mcp-2026-07-28-schema-budget-contract.test.ts
  (depth/node/ref/byte budgets, cycle/ref bomb rejection, factory
  application), plus the compile-time companion
  tests/mcp/mcp-2026-07-28-read-adapters.typecheck.ts.
- Candidate status: Draft — produced by COLP-MCP-09. No Profile claim;
  `mcp-read` / `mcp-write` stay quarantined (`MCP_READ.md` / `MCP_WRITE.md`).


## OAuth client security (COLP-MCP-10)

> **Candidate: `mcp-oauth-client-candidate`** — internal development
> artifact, NOT a Profile claim and NOT a release. `mcp-read` / `mcp-write`
> stay quarantined (`MCP_READ.md` / `MCP_WRITE.md`). Completion standard: the
> OAuth client security contracts are source-bound and OAuth requirements do
> not pollute the shared authorization binding, the Resource Server or the
> stdio contract.

- `src/security/mcp-oauth-client.ts` — security/client adapter (SEC-0019
  `mcp.oauth-issuer-binding`):
  - RFC 9207 authorization-response `iss` validation (`enforceOAuthAuthorizationResponseIss`):
    missing (when the AS metadata requires it), swap (different `iss` echo) and the
    mix-up defense at token exchange (`enforceOAuthTokenExchangeIssuer`) are denied;
    the client never proceeds to code exchange with client credentials.
  - RFC 8414 authorization-server metadata validation
    (`enforceOAuthAuthorizationServerMetadata`): canonical https issuer (loopback
    http tolerated), required authorization/token endpoints, DCR registration
    endpoint when dynamic registration is required, PKCE S256 support.
  - RFC 7591 DCR (`buildOAuthDcrClientMetadata`, `resolveOAuthApplicationType`,
    `enforceOAuthDcrApplicationType`): `application_type` is always declared and
    derived from the deployment type (web vs native via loopback/custom-scheme
    redirect URIs); explicit deployment type wins.
  - Canonical-issuer alias normalisation (`canonicalOAuthIssuer`) keying both
    credential isolation (`enforceOAuthCredentialIssuerIsolation`,
    `selectOAuthClientCredentialForIssuer`) and refresh state
    (`rotateOAuthRefreshToken`, `selectOAuthRefreshStateForIssuer`): the same
    client_id/client_secret is never reused across issuers, refresh rotation
    rejects reuse of an already-rotated token, and cross-issuer refresh is denied.
  - Redirect-URI exact match (`enforceOAuthRedirectUri`) and PKCE S256
    (`enforceOAuthPkce`).
  - Secret storage/logging discipline: `redactOAuthCredential` and
    `formatOAuthLogContext` only emit stable identifiers (issuer, clientId,
    operation, outcome, stable denial reason code); decisions/log output never
    carry token/secret values. The gateway-owned credential vault and token
    store ports (`OAuthClientCredentialVaultPort`, `OAuthClientTokenStorePort`)
    are keyed by canonical issuer and are never handed to the application layer.
  - stdio / API Key / local hosts are marked not-applicable
    (`classifyOAuthClientApplicability`) so they stay on their non-OAuth paths.
- `McpReadClientGatewayPort` (src/mcp/read-client.ts) continues to own
  transport + OAuth composition: the Read application client only sees
  `callTool` and its strict options validator rejects any token-store field, so
  the application layer can never obtain a token store handle.
- `src/shared/mcp-sdk-boundary.ts` allowlist extended (COLP-MCP-10): the
  SDK OAuth client vocabulary schemas (`OAuthClientInformationSchema`,
  `OAuthClientMetadataSchema`, `OAuthMetadataSchema`, `OAuthTokensSchema`,
  ...) are allowlisted and re-exported; `OAuthClientMetadataSchema` is used at
  runtime to validate the built RFC 7591 DCR body. Policy document and sdk-lock
  contract test updated in the same change. The security module never imports
  `@modelcontextprotocol/client`.
- `src/security/mcp-oauth-client.ts` is registered in the security mutation
  shard (`stryker.security.config.mjs`).
- Tests (written first): tests/security/mcp-oauth-client.sec-0019.test.ts
  (iss missing/swap/mix-up, AS metadata, DCR web/native, issuer alias,
  credential reuse, refresh rotation, redirect/PKCE, secret storage/logging,
  stdio/API Key applicability, no client-package import), plus the mcp-side
  tests/mcp/mcp-2026-07-28-read-client-gateway-oauth-contract.test.ts (gateway
  port owns OAuth composition, no token store in read client options, binding
  token-free, stdio/API Key non-OAuth path) and its compile-time companion
  tests/mcp/mcp-2026-07-28-read-client-gateway-oauth.typecheck.ts.
- Candidate status: Draft — produced by COLP-MCP-10. No Profile claim;
  `mcp-read` / `mcp-write` stay quarantined (`MCP_READ.md` / `MCP_WRITE.md`).
## subscriptions/listen (COLP-MCP-11)

> **Candidate: `mcp-listen-candidate`** — internal development artifact, NOT
> a Profile claim and NOT a release. `mcp-read` / `mcp-write` stay
> quarantined (`MCP_READ.md` / `MCP_WRITE.md`). Completion standard: every
> listen request is self-contained and deterministically released; after a
> disconnect the client only re-listens and re-reads (no event replay).

- `src/mcp/shared/change-signal.ts` — protocol-neutral change-signal port
  (`McpChangeSignalSourcePort` + strict `snapshotMcpChangeSignal` validator):
  signal kinds `resource-updated` / `resource-list-changed` /
  `tool-list-changed` / `prompt-list-changed`, with per-source `sequence` and
  `timestamp` audit fields and a `resourceUri` on `resource-updated`. The
  port never carries wire notification types, JSON-RPC framing or SDK
  objects; delivery is live and non-durable (no broker/registry outlives a
  request, no Last-Event-ID backfill).
- `src/mcp/2026-07-28/subscriptions.ts` — Modern `subscriptions/listen`
  adapter (`createMcp20260728SubscriptionsListenAdapter`):
  - opt-in types are only accepted when the server capabilities actually
    declare them (`resources.subscribe` / `resources.listChanged` /
    `tools.listChanged` / `prompts.listChanged`); unsupported opt-ins are
    rejected with Invalid Params (-32602);
  - the empty listen result and every streamed notification carry
    `io.modelcontextprotocol/subscriptionId` (the listen request JSON-RPC
    id, verbatim per the SDK `SUBSCRIPTION_ID_META_KEY` contract); the
    leading `notifications/subscriptions/acknowledged` carries the honored
    filter;
  - request-scoped notifications stay on the original request response
    stream (single-use async iterable) and never carry a resource body —
    they are re-read hints;
  - delivery is bounded by queue (`maxQueueSize`), rate (`maxRatePerWindow`
    / `rateWindowMs`), lifetime (`maxLifetimeMs`) and notification budget
    (`maxNotifications`); overflow and rate-limited signals are dropped and
    counted in the deterministic teardown summary;
  - the request abort signal and a per-send authorization recheck
    (`Mcp20260728AuthorizationRecheckPort`) end the stream immediately on
    abort / binding / scope / security-epoch revocation; every session
    unsubscribes from the source and clears its timers on teardown (no
    hidden Session/Map, one frozen adapter instance for all requests).
- `src/shared/mcp-sdk-boundary.ts` allowlist extended (COLP-MCP-11):
  `SubscriptionsListenResultSchema`, `SubscriptionsListenResultMetaSchema`,
  `SubscriptionsAcknowledgedNotificationSchema`, `SubscriptionFilterSchema`,
  `ResourceUpdatedNotificationSchema`, `ResourceListChangedNotificationSchema`,
  `ToolListChangedNotificationSchema`, `PromptListChangedNotificationSchema`
  (schemas) and the corresponding public notification type names; policy
  document and sdk-lock contract test updated in the same change. Both new
  source files are registered in the mcp-read mutation shard
  (`stryker.mcp.read.config.mjs`).
- Tests (written first):
  tests/mcp/mcp-2026-07-28-subscriptions-listen-contract.test.ts (opt-in
  validation against real capabilities, unsupported-type rejection,
  subscription-id stamping on result/ack/notifications, signal mapping and
  uri filtering, duplicate/late signals, multi-principal and
  request-scoped isolation, authorization revocation mid-stream and with
  queued items, bounded queue overflow, rate limiting and window reset,
  lifetime and notification-budget teardown, abort/cleanup,
  disconnect/reconnect with no replay, no Last-Event-ID buffering, and the
  re-read contract with no resource body), plus the compile-time companion
  tests/mcp/mcp-2026-07-28-subscriptions-listen.typecheck.ts. The strict
  change-signal snapshot validator (frozen own-data snapshot; rejection of
  Proxies, accessors, extra/symbol keys, foreign prototypes and unsafe
  sequence/timestamp values) is covered directly by
  tests/mcp/mcp-2026-07-28-change-signal-contract.test.ts.
- Candidate status: Draft — produced by COLP-MCP-11. No Profile claim;
  `mcp-read` / `mcp-write` stay quarantined (`MCP_READ.md` / `MCP_WRITE.md`).

## Modern Write / MRTR adapter (COLP-MCP-13)

> **Candidate: `mcp-write-candidate`** — internal development artifact, NOT a
> Profile claim and NOT a release. `mcp-read` / `mcp-write` stay quarantined.

- `src/mcp/2026-07-28/write.ts` — Modern `2026-07-28` Write / MRTR adapter
  (`createMcp20260728WriteToolAdapter`):
  - maps the COLP-MCP-06 Write Gateway (`changes.plan` / `changes.commit` /
    `changes.cancel`, `keys.*`, registered low-risk Tools) onto Modern
    results; normal results are fixed `complete`;
  - waiting for out-of-band approval returns MRTR `input_required` with an
    (empty) `inputRequests` map and a server-minted `requestState` (HMAC
    integrity + expiry + authenticated-principal bind + method + input
    digest); retries echo `requestState` (+ optional `inputResponses`) and
    resume the SAME plan business state via the host `resolvePlan` port;
  - never initiates roots/sampling/elicitation server-to-client requests and
    never uses `elicitationId` / completion notifications; `inputResponses`
    is structurally validated per the pinned SDK `inputResponse()` union;
  - the host owns durable plan/approval stores, the request-state HMAC key,
    the `resolvePlan` status port and the approval UI; execution, approval
    compare-and-consume and idempotency semantics stay in the gateway /
    change-plan core.
- `src/mcp/index.ts` / `src/mcp/2026-07-28/index.ts` add the Modern Write
  surface additively (Read keys unchanged; the internal Write Gateway and
  change-plan factories stay off the entries).
- New source file registered in the mcp-write mutation shard
  (`stryker.mcp.write.config.mjs`).
- Tests (written first): the write-adapters contract, write-adapter
  hardening, write-package-surface contract, write-package typechecks and the
  minimal Write host example under `tests/mcp/examples/write-host.ts`.
- Candidate status: Draft — produced by COLP-MCP-13. No Profile claim;
  `mcp-read` / `mcp-write` stay quarantined.
## Versioned Profile / conformance evidence (COLP-MCP-14)

> **Candidate: `mcp-conformance-candidate`** — internal development artifact
> that was NOT a Profile claim or a release. COLP-MCP-15 accepted its exact
> MCP `2026-07-28` source-bound binding and restored `mcp-read` /
> `mcp-write` (see `MCP_READ.md` / `MCP_WRITE.md`); only exact-version
> source-bound conformance evidence accepted by COLP-MCP-15 can restore them.

- The generic Read/Write deployment probes
  (`mcp-read.transport-contracts`, `mcp-write.approval-contracts`) are split
  into six fixed versioned families (development plan §6):
  `mcp-2026-07-28.transport-header-contracts`,
  `mcp-2026-07-28.discovery-contracts`,
  `mcp-2026-07-28.subscription-contracts`,
  `mcp-2026-07-28.read-schema-contracts`,
  `mcp-2026-07-28.write-mrtr-contracts` and
  `mcp-2026-07-28.oauth-client-contracts`.
- Versioned evidence model (`scripts/lib/mcp-conformance-versioning.mjs` and
  `src/conformance/mcp-conformance.ts`): the certificate, deployment target
  evidence, bundled evidence and the runner verdict all bind the exact MCP
  version `2026-07-28`, the source revision, the locked upstream SDK versions
  (`@modelcontextprotocol/core` `2.0.0`, `@modelcontextprotocol/client`
  `2.0.0`, `@modelcontextprotocol/server` `2.0.0`), the
  reference-client/fixture-host topology digest, requirement/report digests
  and a self-referential evidence digest. Breaking any layer (version,
  source, SDK lock, topology, digest) is rejected.
- Old unversioned probe IDs are rejected migration input: the versioned
  runner refuses `mcp-read.transport-contracts` /
  `mcp-write.approval-contracts` and the binding validator rejects legacy
  probe replay, so stale generic evidence can never satisfy a new claim.
- Generator: `scripts/generate-mcp-conformance-candidate.mjs` (wired as
  `npm run generate:mcp-conformance-candidate`) produces the source-bound
  `src/conformance/generated/mcp-conformance-candidate.json` after the
  protected source commit; COLP-MCP-15 bundles it and restores claims.
- Verification tests (written first):
  `tests/conformance/mcp-2026-07-28-conformance-versioning.test.ts` and
  `tests/conformance/mcp-2026-07-28-conformance-probes.test.ts`, plus the
  updated `tests/conformance/deployment-evidence.ts` /
  `deployment-scope.test.ts`.

## Accepted SDK (COLP-MCP-15)

> **Artifact: `mcp-2026-07-28-sdk-accepted`** — the source-bound total
> acceptance record. `mcp-read` / `mcp-write` are restored in
> `supportedProfiles` and the refreshed bundled evidence verifies every
> MCP-* Requirement ID.

- Total runner: `npm run accept:mcp-2026-07-28-sdk`
  (`scripts/accept-mcp-2026-07-28-sdk.mjs`) aggregates protocol sync, types,
  requirements, traceability, typecheck, the owned Vitest evidence suite, the
  reference client / fixture host acceptance e2e, build, `pack:check`, the
  SDK lock, the regenerated `mcp-conformance-candidate`, and the Legacy MCP
  absence scan, then writes `mcp-2026-07-28-sdk-accepted.json`.
- Legacy MCP absence: `scripts/lib/legacy-mcp-absence.mjs` +
  `npm run check:mcp-legacy-absence` scan source, declarations and the packed
  tarball for Legacy MCP wire symbols (`McpSessionBinding`, `initialize`,
  old subscriptions, GET/DELETE MCP transport, `Last-Event-ID`,
  `Mcp-Session-Id`, the legacy SDK import) without flagging COLP Sync
  Session (`SyncSession*`).
- Claim restoration: `supportedProfiles` includes `mcp-read` / `mcp-write`;
  `conformance-evidence.mjs` is in the accepted state (no MCP quarantine, no
  MCP evidence stripping); the refreshed `evidence.json` / `TRACEABILITY.md`
  are regenerated by `npm run refresh:evidence` after this commit.
- Acceptance e2e: `tests/mcp/mcp-2026-07-28-sdk-acceptance-e2e.test.ts`
  drives the independent reference client over the fixture host through
  discovery, Read, listen and a Write/MRTR round trip with Plan/Approval,
  and locks the import boundary, the packed tarball, the restored claims and
  the COLP Sync Session regression.
