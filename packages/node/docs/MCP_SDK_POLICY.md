# MCP SDK Policy (COLP-MCP-03)

Status: accepted (COLP-MCP-03)

This document records how `@know-n/colp` locks, imports and
upgrades the upstream MCP SDK, which SDK types may cross COLP's public
boundary, and how the test-only reference client / fixture host are bounded.
It is the policy companion of the source-bound boundary module
`src/shared/mcp-sdk-boundary.ts` (re-exported through the established internal
`src/mcp/2026-07-28/sdk-boundary.ts` path) and of the lock contract test
`tests/mcp/mcp-2026-07-28-sdk-lock-contract.test.ts`.

## 1. Locked versions (N)

| Package | Role | Locked version | Lockfile |
|---|---|---|---|
| `@modelcontextprotocol/core` | `dependencies` | `2.3.1` (exact) | `package-lock.json` pins `2.3.1` |
| `@modelcontextprotocol/client` | `devDependencies` | `2.3.1` (exact) | `package-lock.json` pins `2.3.1` |
| `@modelcontextprotocol/server` | `devDependencies` | `2.3.1` (exact) | `package-lock.json` pins `2.3.1` |

All three are pinned exactly (no `^`/`~`) so a dependency bump is always an
explicit, reviewed change. The `package-lock.json` entries resolve to the
`*-2.3.1.tgz` registry artifacts.

## 2. Dependency decision: core as a production dependency, client/server as dev-only

- `@modelcontextprotocol/core` is a **regular `dependencies` entry**: future
  production adapters under `src/mcp/2026-07-28/` import its allowlisted
  schemas and `_meta` constants, so the runtime package must be resolvable by
  **packed consumers** who install only `@know-n/colp` plus its
  declared dependencies. Making it a dependency is the "runtime ownership"
  choice: production code owns and executes the schema/constant surface.
- `@modelcontextprotocol/client` and `@modelcontextprotocol/server` are
  **`devDependencies`**: they exist solely for the independent reference
  client and the test-only fixture host under `tests/fixtures/mcp-2026-07-28/`.
  They must never enter the production tarball (`files: ["dist","README.md"]`)
  and are asserted absent from package `exports` and from `npm pack --dry-run`
  output.
- **No `peerDependencies`** are introduced: the repository has no peer
  dependency precedent, and the lock contract test proves core resolves
  transitively from the package's own `dependencies` without host-side peer
  installation. Adding peers would push SDK version choice onto every host for
  no benefit.
- Packed consumer validation: `npm run pack:check` (`npm pack --dry-run`,
  `publint`, `attw --pack . --ignore-rules no-resolution`) validates the
  packed ESM/CJS shape; `mcp-2026-07-28-sdk-lock-contract.test.ts` validates
  ESM `import` and CJS `require` resolution of `@modelcontextprotocol/core`
  (the same resolution a packed consumer gets), and that fixtures never
  appear in the tarball.

## 3. Public type allowlist

Only the following SDK surface may cross COLP's public boundary, and only via
`src/shared/mcp-sdk-boundary.ts`:

| Kind | Allowed symbols |
|---|---|
| Schemas (from `@modelcontextprotocol/core`) | `DiscoverRequestSchema`, `DiscoverResultSchema`, `SubscriptionsListenRequestSchema`, `SubscriptionsListenResultSchema`, `SubscriptionsListenResultMetaSchema`, `SubscriptionsAcknowledgedNotificationSchema`, `SubscriptionFilterSchema`, `ResourceUpdatedNotificationSchema`, `ResourceListChangedNotificationSchema`, `ToolListChangedNotificationSchema`, `PromptListChangedNotificationSchema`, `RequestMetaSchema`, `ResultSchema`, `ImplementationSchema`, `ResultMetaObjectSchema`, `ToolSchema`, `ResourceSchema`, `ResourceTemplateSchema`, `ListResourcesResultSchema`, `ListResourceTemplatesResultSchema`, `ReadResourceResultSchema`, `ListToolsResultSchema`, `CallToolResultSchema` |
| `_meta` constants (from `@modelcontextprotocol/core/internal`) | `PROTOCOL_VERSION_META_KEY`, `SUBSCRIPTION_ID_META_KEY`, `CLIENT_CAPABILITIES_META_KEY`, `CLIENT_INFO_META_KEY`, `SERVER_INFO_META_KEY`, `LOG_LEVEL_META_KEY`, `TRACEPARENT_META_KEY`, `TRACESTATE_META_KEY`, `BAGGAGE_META_KEY` |
| Public type names COLP may expose | `DiscoverRequest`, `DiscoverResult`, `SubscriptionsListenRequest`, `SubscriptionsListenResult`, `SubscriptionsAcknowledgedNotification`, `ResourceUpdatedNotification`, `ResourceListChangedNotification`, `ToolListChangedNotification`, `PromptListChangedNotification`, `RequestMeta`, `ResultMetaObject`, `Implementation`, `Tool`, `Resource`, `ResourceTemplate`, `ListResourcesResult`, `ListResourceTemplatesResult`, `ReadResourceResult`, `ListToolsResult`, `CallToolResult` |
| OAuth client schemas (from `@modelcontextprotocol/core`, COLP-MCP-10) | `OAuthClientInformationSchema`, `OAuthClientInformationFullSchema`, `OAuthClientMetadataSchema`, `OAuthClientRegistrationErrorSchema`, `OAuthErrorResponseSchema`, `OAuthMetadataSchema`, `OAuthProtectedResourceMetadataSchema`, `OAuthTokenRevocationRequestSchema`, `OAuthTokensSchema`, `OpenIdProviderDiscoveryMetadataSchema`, `OpenIdProviderMetadataSchema` |

Rules:

- The listen vocabulary row (COLP-MCP-11) pins the SDK
  `subscriptions/listen` result/ack/filter and the four streamed notification
  schemas used by `src/mcp/2026-07-28/subscriptions.ts`. The listen result is
  only sent on graceful teardown; every streamed notification is validated
  against the pinned schema and carries `io.modelcontextprotocol/subscriptionId`.

- COLP derives its public `*Request` / `*Result` types **structurally from the
  allowlisted schemas**; the named types exported by `@modelcontextprotocol/client`
  and `@modelcontextprotocol/server` are harness-only and never cross a
  production port.
- The OAuth client schemas row (COLP-MCP-10) pins the SDK's OAuth client
  vocabulary for the security/client adapter `src/security/mcp-oauth-client.ts`.
  `OAuthClientMetadataSchema` is used at runtime to validate the built RFC 7591
  DCR body; the remaining schemas are the pinned OAuth vocabulary for the client
  adapter and COLP-MCP-12/14. The adapter still hand-rolls its wire security
  validation of untrusted metadata/credentials and never imports
  `@modelcontextprotocol/client`. These names are asserted in
  `MCP_SDK_SCHEMA_ALLOWLIST` and the lock contract test.
- SDK private types, `Transport` instances, and raw JSON-RPC request objects
  never cross COLP's `shared` ports (development plan §2).
- The modern `_meta` envelope is **not exported by the core SDK**: the core's `RequestMetaSchema` is the legacy 2025-11-25 shape, and the modern `RequestMetaEnvelopeSchema` lives inside the dev-only client/server codec. COLP-MCP-08 therefore validates the per-request envelope (`protocolVersion` + `clientCapabilities` required, plus clientInfo/logLevel/trace/extensions budgets) in `src/mcp/2026-07-28/request-context.ts` itself, pinned to the same reserved `_meta` keys and the SDK codec's `outboundEnvelope` / `validateEnvelopeMeta` behavior. The Base64 sentinel codec and `Mcp-Name`/`Mcp-Param-*`/`x-mcp-header` validation are likewise contract-layer implementations in the adapter (the client/server packages own the SDK originals and are dev-only).
- `SUPPORTED_PROTOCOL_VERSIONS`, `LATEST_PROTOCOL_VERSION` and
  `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` are **deliberately not re-exported**.
  Finding: the SDK's public `SUPPORTED_PROTOCOL_VERSIONS` is the legacy
  `initialize` interop list (`2025-11-25` … `2024-10-07`) and intentionally
  never contains `2026-07-28`; the modern era is negotiated through
  `server/discover`. COLP's `MCP_PROTOCOL_VERSION = '2026-07-28'` is
  authoritative and must not be derived from those SDK constants. The lock
  contract test asserts this asymmetry so it cannot silently regress.

## 4. Upgrade rules

1. Version upgrades are explicit `package.json` + `package-lock.json` edits to
   all three packages together (core, client, server share the same stable
   line). No caret/tilde ranges.
2. After any upgrade, re-run: `npm run typecheck`, `npm run build`,
   `npm run pack:check`, `npm run check:protocol`, `npm run check:types`,
   `npm run check:traceability`, the
   `mcp-2026-07-28-*-contract.test.ts` suites, and update the locked version in
   this document and in `src/shared/mcp-sdk-boundary.ts`.
3. The `MCP_SDK_PUBLIC_TYPE_ALLOWLIST` / `MCP_SDK_SCHEMA_ALLOWLIST` /
   `MCP_SDK_META_KEY_ALLOWLIST` manifests are frozen; widening the allowlist
   requires a policy review and a policy-doc + test update in the same commit.

## 5. N/N-1 contract

- **N** = `@modelcontextprotocol/core@2.3.1` (and client/server `2.3.1`),
  which implement the `2026-07-28` modern era (`server/discover`,
  `subscriptions/listen`, per-request `_meta` envelopes).
- **N-1** = the legacy monolithic `@modelcontextprotocol/sdk@1.30.0`
  (`LATEST_PROTOCOL_VERSION = '2025-11-25'`): it does not implement
  `2026-07-28` and is **rejected** — it must never be installed, imported or
  added to the lockfile. The lock contract test asserts the lockfile and every
  `src/` / `tests/` file never reference `@modelcontextprotocol/sdk`.
- The SDK's own `LATEST_PROTOCOL_VERSION = '2025-11-25'` constant is legacy
  interop vocabulary inside the supported `2.3.1` packages; COLP does not
  treat it as a supported wire version.
- Major-version auto-upgrades are impossible by construction (exact pins +
  frozen lockfile), so an N→N+1 move is always a deliberate, documented step
  that re-runs the full validation set above.

## 6. Security scan

- Every dependency change runs `npm run scan:dependencies` (`npm audit
  --omit=dev --audit-level=high` then `npm audit --audit-level=high`).
- Baseline at SYNC-Q-005: **0 high, 0 critical** on both the production and
  full trees. Residual **1 moderate** — `postcss <=8.5.22`
  (GHSA-fxqj-rqcc-2cmp), a **dev-only transitive** of the existing `tsup` /
  `vitest` / `vite` toolchain, unrelated to the MCP SDK packages and absent
  from the production tree.
- Production `fast-uri` is pinned to `3.1.8` (GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g, GHSA-hrr3-gc8f-f4qj; drop the
  override after AJV declares `>=3.1.8`). Dev Highs `js-yaml@4.3.2` and
  `nanoid@3.3.18` stay overridden until those parents declare patched ranges.
- Rule: no high/critical vulnerability may be introduced by an MCP SDK
  dependency change; moderate findings that are dev-only are tracked in this
  section and re-audited on each upgrade. `npm audit fix` must not be applied
  blindly to the MCP SDK pins (it would break the exact-pin policy).

### Standalone dependency refresh (2026-10-06)

The standalone repository updates Vitest and its V8 coverage provider to the
patched 4.1 line, pins `fast-uri` to 3.1.8, requires `qs` >=6.16.0, and refreshes
`brace-expansion` and `source-map-js` in the lockfile. Production and full-tree
npm audits both report zero vulnerabilities. The three MCP SDK packages remain
locked at exactly 2.0.0; existing coverage thresholds remain unchanged.

### Upgrade to 2.3.1 (2026-10-06)

All three packages moved from 2.0.0 to 2.3.1 together to clear
GHSA-6qxp-vccf-f47h (High): the SDK's OAuth client in `@modelcontextprotocol/client`
2.0.0–2.1.0 could send stored credentials to an authorization server chosen
by the MCP server. The client is dev-only here and never ships, and COLP's
own OAuth client (`src/security/mcp-oauth-client.ts`) does not use it: it
keys credentials and refresh state by exact issuer, requires an issuer on
every pre-registered credential, and denies authorization-server metadata
without a trusted `expectedIssuer` that matches it exactly.

Behavior change observed: the 2.3 server rejects a `2026-07-28` request
without an `MCP-Protocol-Version` header (400, -32020). COLP already
requires that header (`protocol/docs/05-mcp-profile.md`); only test helpers
that built raw fixture-host requests needed it added. Production and full
tree audits report zero vulnerabilities after the upgrade.

## 7. Fixture host boundary

- The independent reference client lives in
  `tests/fixtures/mcp-2026-07-28/reference-client/`; the test-only fixture
  host / transport bridge lives in `tests/fixtures/mcp-2026-07-28/fixture-host/`.
- Both are **test-only**: never under `src/`, never a tsup entry, never in
  package `exports`, never in the production tarball (asserted by the lock
  contract test and by `npm pack --dry-run`).
- The fixture host fixes the transport topology under test: POST JSON and
  POST→SSE (`subscriptions/listen`), per-request `_meta` envelopes, abort
  propagation, bounded FIFO dispatch (backpressure), restart/shutdown, and
  fault injection (`fail`, `malformed-json`, `hold`, `delay`).
- Legacy rejection samples are marked `Legacy-negative` in test names/comments
  and cover: `initialize`, `notifications/initialized`, GET/DELETE,
  `Mcp-Session-Id`, `Last-Event-ID`, `resources/subscribe`,
  `resources/unsubscribe` and deleted legacy methods (`ping`,
  `logging/setLevel`).
- Neither the fixture host nor the reference client shares a hand-written
  frame parser with anything under `src/`; both ends use the upstream SDK's
  transport/framing (development plan §5, COLP-MCP-03 completion standard).

## 8. Host product compatibility surface

A host may add a product compatibility surface outside the Profile endpoint.
That surface must not enter Manifest, Profile claims, or conformance evidence.
COLP MCP entries remain `2026-07-28` only.

`protocol/docs/05-mcp-profile.md` was reviewed on 2026-08-28 and again during its English
translation. The Profile modern-only conclusion remains correct.
