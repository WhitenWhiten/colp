# P1 security boundary migration

This change addresses the seven findings from the COLP source/test review. It
changes security-sensitive behavior; passing existing unit tests is not a claim
that a deployment has attached the guards or passed its black-box probes.

## Transport and OAuth

Streamable HTTP checks Origin on loopback as well as remote deployments. The
loopback HTTP transport exception applies to HTTPS enforcement only, not to
Origin. Configure an exact allowlist. Local transports may allow explicitly
listed `http://localhost`, `http://127.0.0.1`, or `http://[::1]` origins, including
their port; arbitrary HTTP origins, `null`, wildcards and multiple Origins are
not accepted. Non-Streamable transports retain their separate not-applicable
path. The existing strict missing-Origin denial is retained and now also applies
to loopback Streamable HTTP. Do not use self-asserted client transport evidence.

OAuth authorization-server metadata is extensible, not a closed seven-field
object. Known fields are validated, ignored standard/extension members are not
projected back, and the own-data surface is bounded and accessor/Proxy safe.
`response_types_supported` must support code flow; `code_challenge_methods_supported`
must be present and support S256. Missing capability declarations are not proof
that the server supports them.

`canonicalOAuthIssuer` retains its historical export name but now validates and
returns the exact input string. Issuer comparisons, credential keys and refresh
state keys do not normalize trailing slashes, default ports, case or percent
encoding. This is deliberately different from comparing browser Origins.
Existing stores indexed by a lossy normalized issuer must be rebound from trusted
original issuer metadata or re-registered. Do not migrate by guessing aliases,
trying multiple old keys, or copying a secret into another issuer namespace.

Normative references: RFC 8414 sections 2, 3.3 and 4; RFC 9207 section 2.4; MCP
2026-07-28 Authorization and Streamable HTTP. The package's existing host-owned
TLS facts, credential providers and deployment responsibilities remain unchanged.

## Client Snapshot state and egress

`refreshSnapshot()` on a client configured with a request identity provider,
credential provider, dynamic cache partition, or Mount selector now owns one
Snapshot state per invocation. It still captures identity only once inside
`getSnapshot()` and validates complete assembly before returning it. It never
returns a later request's projection as a stale-refresh substitute.

These dynamic-context clients return `undefined` from synchronous
`currentSnapshot` and reject `replaceSnapshot`: neither synchronous API has a
current authenticated request with which to select a safe projection. Store
returned snapshots in caller-owned, authorization-scoped state, or use one
fixed-context client per authority. Fixed-context clients retain their existing
atomic replacement and refresh-fencing behavior. This does not make reusing an
incorrect HTTP cache partition safe; hosts must still bind cache partitions to
captured credentials correctly.

Server-provided `rel=next` targets are untrusted navigation even when the new
request's redirect count is zero. The default policy rejects private/local
literal targets before calling the credential provider or fetch. A deliberately
configured `egressPolicy` may opt into a private destination; initial
host-selected endpoints retain their prior local exception. Public cross-Origin
pagination and existing HTTPS downgrade checks are preserved. DNS resolution,
rebinding and network-layer allowlisting remain fetching-host responsibilities.

## MCP digest policy

`createMcpWriteToolGateway` preserves `verifyStoredOperationsDigest` when it
composes its core Change Plan service. Accessor-backed or hidden verifier
configuration rejects construction instead of silently dropping a security
policy. A configured verifier's rejection is never retried with the default
operations-only digest. Durable idempotent replay still returns the first result
without running current mutable verification again.

The Plan producer and verifier must agree on a digest transcript. Host-authored
plans covering binding/revisions/scopes/risk/impact must use their host verifier;
the generic planner still produces its documented operations-only digest. Do not
remove the stronger verifier, accept either transcript indiscriminately, or
modify stored approvals to work around a mismatch. The regression tests compare
core and gateway entry points using the same explicitly authored stored plan.

A host that configures a stronger `verifyStoredOperationsDigest` must also make
the gateway mint `changes.plan` under the same rules. Set an own, enumerable
`planner: { plan(request, binding) }` on the gateway's `changePlan` options; when
present, `changes.plan` calls it instead of the generic planner (its result is
still validated against the plan output schema). An accessor-backed or hidden
`planner` rejects construction rather than falling back to the generic planner.
A host planner does this by stamping its own
canonical digest as each Plan is first persisted. Without it, every Plan minted
through the gateway fails Commit with `digest_mismatch`.

## Validation before merge

Run the focused regressions and existing security contract suites, then the
package's normal type, build, coverage and consumer gates:

```sh
cd packages/node
npm test -- tests/security/p1-security-boundaries.test.ts tests/client/p1-client-boundaries.test.ts tests/mcp/p1-digest-policy.test.ts
npm test -- tests/security/mcp-oauth-client.sec-0019.test.ts tests/security/mcp-oauth-client-defensive.sec-0019.test.ts tests/security/origin-guard.sec-0016.test.ts tests/security/request-boundary.composition.test.ts tests/security/composition-cookbook.pr5.test.ts
npm run check
```

Also exercise the actual host's approved-plan commit/rollback/replay route and
its installed-package imports. In-memory fixture coordinators are not evidence
of database atomicity. Do not relabel syntax or isolated helper checks as a full
Vitest, PostgreSQL, transport or deployment-conformance pass.
