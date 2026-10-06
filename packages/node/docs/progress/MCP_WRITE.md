# MCP Write Progress

> **Migration status: Accepted (COLP-MCP-15)** — the `mcp-write` package
> claim is restored after exact-version MCP `2026-07-28` source-bound
> conformance evidence was accepted. The historical repository-tracked
> certificate is superseded; MCP-* Requirement IDs are verified by the
> refreshed bundled evidence.

| Requirement | Implementation history | Release evidence | Current review status | Package Profile claim |
|---|---|---|---|---|
| `MCP-0007` | Mixed original boundary; remediated by finding | Accepted (MCP 2026-07-28); historical certificate superseded | Accepted: MCP 2026-07-28; historical process exception retained | Package supported (MCP 2026-07-28) |
| `MCP-0003` | Mixed original boundary; remediated by finding | Accepted (MCP 2026-07-28); historical certificate superseded | Accepted: MCP 2026-07-28; historical process exception retained | Package supported (MCP 2026-07-28) |
| `MCP-0004` | Mixed original boundary; remediated by finding | Accepted (MCP 2026-07-28); historical certificate superseded | Accepted: MCP 2026-07-28; historical process exception retained | Package supported (MCP 2026-07-28) |
| `MCP-0005` | Mixed original boundary; remediated by finding | Accepted (MCP 2026-07-28); historical certificate superseded | Accepted: MCP 2026-07-28; historical process exception retained | Package supported (MCP 2026-07-28) |

This document records implementation and evidence history. It does not create
an independent conformance claim. **Migration status: the `mcp-write` package
claim is accepted (COLP-MCP-15).** The historical repository-tracked
certificate was quarantined during the 2026-07-28 migration and is superseded
by the accepted source-bound evidence; MCP-* Requirement IDs are verified by
the refreshed bundled evidence. The package includes `mcp-write` in
`supportedProfiles` again; a deployment may serialize an `mcp-write` Manifest
claim only after satisfying `assertProfileClaims` with complete endpoint,
port, dependency, and deployment-probe evidence.

## Historical evidence revision boundary

Before the earlier external-evidence model was introduced, the standalone
mcp-write branch recorded this tested source revision:

`75152a1ff65d76faa8320740cfbfa3abd92a0fae`

The evidence-boundary commit is:

`3bc83563e051639cf52f47a49f9ec5707ad42cbe`

That historical boundary commit updated only the then-tracked evidence and its
derived traceability output. It is retained as history, not reused as the
current certificate. That repository-tracked certificate was quarantined
during the 2026-07-28 migration: `mcp-write` did not appear in
`supportedProfiles` and MCP-* Requirement IDs were excluded from the bundled
evidence until exact MCP `2026-07-28` source-bound conformance evidence was
accepted (COLP-MCP-15). Marker-free R-01/R-02 process contracts remain
mandatory in the normal package test run.

Package evidence completion is separate from publishing a deployment Profile
claim. The exported `supportedProfiles` array includes `mcp-write` again after
COLP-MCP-15 acceptance; a host must still satisfy `assertProfileClaims` with
the complete endpoint, port, dependency, and deployment-probe evidence before
serializing that claim.

## Historical process exception

The original implementation goal called for one independently reviewable and
accepted implementation commit per Requirement. The repository history does
not satisfy that process requirement:

- `3bb2b2c` introduced the principal production implementation for all four
  Requirements in one commit. Its subject names `MCP-0007`, but its files also
  include the plan, risk, and secret modules for `MCP-0003`, `MCP-0004`, and
  `MCP-0005`.
- `966df6e`, `cd6f906`, and `5fc7ef6` have subjects for `MCP-0003`,
  `MCP-0004`, and `MCP-0005`, respectively, but each is test-only. They are
  not independent production implementation commits.
- `1f3be9d` mixes production and test hardening across multiple Requirements;
  `080662c` then changes the `MCP-0004` implementation and test together, and
  `433b0a4` only records progress documentation.

The H/M/T remediation series below is intentionally one commit per finding,
and therefore repairs the remediation boundary. It cannot rewrite history or
retroactively turn the original mixed implementation and test-only commits
into per-Requirement independently accepted commits. This is a recorded
process non-compliance/exception, not an assertion that the original Goal was
met. The R-02 change itself is identified by its subject and boundary in this
document and does not self-reference a commit hash.

## Original commit boundaries

The following mapping is based on `git show --name-status` for each commit, not
on commit subjects alone.

| Commit | Actual files/surface | Requirement mapping | Boundary decision |
|---|---|---|---|
| `3bb2b2c` `feat(colp): satisfy MCP-0007 mcp-write mount tools` | `src/mcp/write-mount.ts`, `write-tools.ts`, `change-plan.ts`, `risk-aggregation.ts`, `secret-redaction.ts`, exports, progress doc, and `write-mount-tools-contract.test.ts` | `MCP-0003`, `MCP-0004`, `MCP-0005`, `MCP-0007` | One mixed production commit; not four independent accepted commits |
| `966df6e` `feat(colp): satisfy MCP-0003 risk aggregation` | `tests/mcp/risk-aggregation-contract.test.ts` | `MCP-0003` | Test-only evidence addition |
| `cd6f906` `feat(colp): satisfy MCP-0004 plan commit approval` | `tests/mcp/plan-commit-contract.test.ts` | `MCP-0004` | Test-only evidence addition |
| `5fc7ef6` `feat(colp): satisfy MCP-0005 key secret redaction` | `tests/mcp/secret-redaction-contract.test.ts` | `MCP-0005` | Test-only evidence addition |
| `1f3be9d` `fix(colp): harden mcp-write plan commit and secret boundaries` | Production and contract-test changes in risk, plan/commit, secret, gateway, and mount surfaces | `MCP-0003`, `MCP-0004`, `MCP-0005`, `MCP-0007` | Cross-Requirement hardening |
| `080662c` `fix(colp): single-flight concurrent same-key commit` | `src/mcp/change-plan.ts` and Plan/Commit contract test | `MCP-0004` | Implementation and test in one hardening commit |
| `433b0a4` `docs(colp): note MCP-0004 concurrent single-flight evidence` | Progress documentation only | `MCP-0004` | Documentation update; no implementation boundary |

## Requirement records

These records distinguish the mixed original implementation from later
hardening and from tests that only supplied evidence.

### MCP-0007

- Primary implementation: `3bb2b2c` (mixed with all four Requirements).
- Test-only subject: none; the same `3bb2b2c` also added the mount contract.
- Cross-Requirement hardening: `1f3be9d`.
- Remediation ledger: `7aceadb` (trusted host context), `649500b` (registered
  operation gate), `12ce49c` (input budgets), `90a7b95` (closed schemas),
  `8a38360` (quality gates), `ad7fb03` (evidence matrix and approval boundary),
  `65723c6` (reachable and reserved Tool registration), and `3bc8356`
  (historical standalone evidence boundary).
- Evidence record: `schema.mcp-write-tools` in generated traceability.

### MCP-0003

- Primary implementation: `3bb2b2c` (`src/mcp/risk-aggregation.ts`, mixed
  with the other write surfaces).
- Test-only subject: `966df6e`.
- Cross-Requirement hardening: `1f3be9d`.
- Remediation ledger: `7aceadb` (snapshot/context), `649500b` (canonical
  operation adapters), `12ce49c` (resource budgets), `90a7b95` (closed tool
  schemas), `d9e17b4` (generalized risk cases), `8a38360` (quality gates),
  `ad7fb03` (evidence matrix), and `3bc8356` (current bundled evidence
  boundary).
- Evidence record: `mcp.risk-aggregation` in generated traceability.

### MCP-0004

- Primary implementation: `3bb2b2c` (`src/mcp/change-plan.ts`, mixed with the
  other write surfaces).
- Test-only subject: `cd6f906`.
- Cross-Requirement hardening: `1f3be9d`, `080662c`, and `433b0a4`.
- Remediation ledger: `e2fc669` (transaction coordinator), `5114349`
  (Commit/Cancel serialization), `5f61242` (replay first), `5971d78` (scope
  policy), `c25735e` (revision resolver), `eb9d60c` (executor result
  validation), `d06d2fe` (required rate-limit port), `be86d85` (URI policy),
  `99b6ca9` (store retention), `f63e490` (stateful replay tests), `8a77565`
  (durable host conformance), `ad7fb03` (Approval serialization and evidence
  matrix), `65723c6` (transaction-bound Revision reads and key reveal
  capability), `8dccf54` (invalid host clock contract), and `3bc8356`
  (current bundled evidence boundary).
- Shared remediation: `7aceadb`, `12ce49c`, `90a7b95`, and `8a38360` also
  cover gateway and quality boundaries used by this Requirement.
- Evidence record: `mcp.plan-commit` in generated traceability.

### MCP-0005

- Primary implementation: `3bb2b2c` (`src/mcp/secret-redaction.ts`, mixed
  with the other write surfaces).
- Test-only subject: `5fc7ef6`.
- Cross-Requirement hardening: `1f3be9d`.
- Remediation ledger: `6e0a5c2` (canonical API-key adapter), `be86d85` (reveal
  URI policy), `87a3f95` (canonical fixtures), `8a38360` (quality gates),
  `ad7fb03` (evidence matrix), `65723c6` (required Plan/Commit reveal
  boundary), and `3bc8356` (current bundled evidence boundary).
- Shared remediation: `7aceadb`, `12ce49c`, and `90a7b95` cover model-facing
  context, resource budgets, and closed output schemas used by key results.
- Evidence record: `mcp.secret-redaction` in generated traceability.

## Remediation commit ledger

Each finding remediation is a separate commit, but a finding can legitimately
touch more than one Requirement. The ledger records that many-to-many fact.

| Finding | Commit | Verified surface | Requirement(s) |
|---|---|---|---|
| H-01 | `7aceadb` | Trusted context, snapshot, and registered low-risk adapters | `MCP-0003`, `MCP-0004`, `MCP-0007` |
| H-02 | `e2fc669` | Transaction-bound Commit coordinator | `MCP-0004` |
| H-03 | `5114349` | Commit/Cancel serialization and `committing` state | `MCP-0004` |
| H-04 | `5f61242` | Idempotent replay before mutable revalidation | `MCP-0004` |
| H-05 | `5971d78` | Operation-derived Scope policy | `MCP-0004` |
| H-06 | `c25735e` | Authoritative revision resolver | `MCP-0004` |
| H-07 | `649500b` | Canonical operation registration and risk gate | `MCP-0003`, `MCP-0007` |
| H-08 | `eb9d60c` | Executor result validation and fail-closed commit | `MCP-0004` |
| H-09 | `d06d2fe` | Required rate-limit policy port | `MCP-0004`, `MCP-0007` |
| M-01 | `6e0a5c2` | Canonical API-key result adapter | `MCP-0005` |
| M-02 | `12ce49c` | Bounded snapshot, schema, and risk expansion | `MCP-0003`, `MCP-0004`, `MCP-0007` |
| M-03 | `90a7b95` | Closed Tool input/output schemas | `MCP-0002`, `MCP-0007` |
| M-04 | `be86d85` | Summary and approval/reveal URI safety | `MCP-0004`, `MCP-0005` |
| M-05 | `99b6ca9` | Bounded in-memory plan and approval stores | `MCP-0004` |
| T-01 | `8a38360` | MCP coverage and mutation gates | `MCP-0003`, `MCP-0004`, `MCP-0005`, `MCP-0007` |
| T-02 | `f63e490` | Stateful replay/revision contract tests | `MCP-0004` |
| T-03 | `8a77565` | Durable host conformance suite | `MCP-0004` |
| T-04 | `d9e17b4` | Generalized risk aggregation cases | `MCP-0003` |
| T-05 | `87a3f95` | Canonical API-key fixtures | `MCP-0005` |
| T-06 | `ad7fb03` | Approval transition serialization and evidence matrix | `MCP-0004` plus matrix coverage for `MCP-0003`, `MCP-0005`, `MCP-0007` |
| R-01 (initial) | `1620305` | Initial version-bound bundled evidence and traceability boundary | `MCP-0003`, `MCP-0004`, `MCP-0005`, `MCP-0007` |
| A-01 | `65723c6` | Transaction-bound authoritative Revision validation | `MCP-0004` |
| A-02 | `65723c6` | Required API-key Plan/Commit reveal boundary | `MCP-0004`, `MCP-0005` |
| A-05 | `65723c6` | Reachable dynamic Tool names and reserved-name rejection | `MCP-0007` |
| R-03 | `9ead865` | Repeatable evidence-bearing suite and batched process audit | process boundary |
| R-01 (intermediate) | `8ac7d6a` | Rebound bundled evidence before the final coverage contract | `MCP-0003`, `MCP-0004`, `MCP-0005`, `MCP-0007` |
| Q-01 | `8dccf54` | Invalid in-memory store clock failure contracts | `MCP-0004` |
| P-01 | `75152a1` | `mcp-write` package Profile claim boundary | package claim boundary |
| R-01 (historical) | `3bc8356` | Standalone bundled evidence and traceability boundary | `MCP-0003`, `MCP-0004`, `MCP-0005`, `MCP-0007` |

## Adapter composition notes (mcp-write v1)

This slice is an adapter library, not a complete remote MCP transport product.
Hosts own transport, session demultiplexing, OAuth approval UI, durable plan
and approval storage, and secret reveal pages.

| Surface | Host responsibility |
|---|---|
| Write mount | `createMcpWriteExposure(manifest, { mountId, writeTools })` requires `mcp-write` dependencies, `features.mcp.tools=true`, and trusted host context. |
| Write Tool gateway | Publishes `changes.plan`, `changes.commit`, and `changes.cancel`; optional key Tools use canonical result adapters and redaction. |
| Change Plan | Injects transaction-bound plan/approval stores, impact/revision/scope/authorization ports, executor, and required rate-limit policy. |
| Risk aggregation | Uses registered canonical operation adapters and shared input budgets; unknown executable shapes fail closed. |
| Secret redaction | Model-facing results expose metadata, `secretAvailable`, and a host reveal URI only; secret fields are removed before return or retention. |

### Host-owned residual risk

- Durable Approval compare-and-consume under multi-node concurrency remains a
  host responsibility; the in-memory helper is single-process only.
- OAuth re-authentication, CSRF protection, and one-time display for approval
  and secret-reveal pages remain host responsibilities.
- Transport/session demultiplexing and Streamable HTTP productization remain
  outside this adapter slice.
- Publisher ACL, Revision, and Outbox execution remain in existing publisher
  ports; MCP supplies the gateway and transaction contract.

## Modern Write candidate (COLP-MCP-13)

> **Candidate: `mcp-write-candidate`** — internal development artifact that
> was NOT a Profile claim or a release until COLP-MCP-15 accepted the exact
> MCP `2026-07-28` source-bound conformance evidence and restored the
> `mcp-write` package claim.

The Modern Write adapter (`src/mcp/2026-07-28/write.ts`,
`createMcp20260728WriteToolAdapter`) maps the COLP-MCP-06 Write Gateway
(`src/mcp/write-tools.ts`) and the change-plan core onto Modern `2026-07-28`
results:

- Normal results are fixed `complete` (low-risk Tools, `changes.cancel`,
  approved commit receipts, `tools/list`).
- Waiting for out-of-band approval returns MRTR `input_required` carrying an
  `inputRequests` map and a server-minted `requestState`. COLP never
  initiates roots/sampling/elicitation server-to-client requests, so the
  `inputRequests` map is present but empty; the at-least-one rule is
  satisfied by `requestState` and the client retries after the host records
  approval out-of-band.
- Retries echo `requestState` (+ optional `inputResponses`); the adapter
  verifies the state (HMAC integrity, expiry, authenticated-principal bind,
  method and input digest) and resumes the SAME plan business state. A fresh
  call without `requestState` always creates new business state. `elicitationId`
  and the completion-notification channel are never used (migration decision
  §3 "服务端发起请求" row).
- `inputResponses` is structurally validated per the SDK `inputResponse()`
  union (elicit/roots/sampling); well-formed entries for requests this server
  never issued are ignored, malformed entries are rejected with Invalid
  Params.
- The core execution, approval compare-and-consume and idempotency semantics
  stay in the gateway / change-plan service; the adapter is a thin result
  mapping. The host owns the `resolvePlan` status port backing retries, the
  durable plan/approval stores, the request-state HMAC key and the approval
  UI (host responsibility, not part of this adapter).

Migration table (old wire concept -> Modern Write surface):

| Old concept | Modern Write surface |
|---|---|
| `McpSessionBinding` / Plan `sessionId` binding | `McpAuthenticatedAuthorizationBinding` per request (`createMcp20260728RequestContext`) |
| `createMcpWriteExposure` / `createMcpWriteMountAdapter` | `createMcp20260728WriteToolAdapter` (one frozen instance, per-request contexts) |
| server-initiated request + `elicitationId` / completion notification | MRTR `input_required` + server-minted `requestState` + client retry |
| Session demux / hidden per-client instances | stateless adapter; host owns durable plan/approval storage and approval UI |
| 无判别 result | required `resultType: 'complete' \| 'input_required'` |

The Modern Write API is additive on the `/mcp` and `/mcp/2026-07-28` entries:
`createMcp20260728WriteToolAdapter`, `Mcp20260728WriteToolAdapter(Options)`,
`Mcp20260728WritePlanStatusPort`, `Mcp20260728PlanStatus`,
`Mcp20260728PlanResolution`, `Mcp20260728WriteRequestStateError` plus the
type-only write-core contracts (`McpChangePlanServiceOptions`,
`McpLowRiskToolDefinition`, `McpApiKeyApplicationPort`,
`McpWriteTransportRequirements`, `McpWriteInputBudget`). The internal Write
Gateway factory, the change-plan factory and the in-memory stores stay
internal (COLP-MCP-12 boundary) — the adapter composes the gateway
internally.

### Minimal Write host example (COLP-MCP-13)

A type-checked mirror lives under `tests/mcp/examples/write-host.ts`; the
fenced example below imports exclusively from `@collection-protocol/node/mcp`
for the Modern surface. The host wires the protocol-neutral change-plan
options (its own durable stores/ports in production) and the `resolvePlan`
status port; the package provides the request context, the Modern Write
adapter and the result contract.

```ts
import {
  createMcp20260728RequestContext,
  createMcp20260728WriteToolAdapter,
  mapStdioEvidenceToAuthenticatedBinding,
  type Mcp20260728PlanResolution,
} from '@collection-protocol/node/mcp';

// Host-owned: durable plan store, approval store, executor, impact/revision/
// scope/authorization/rate-limit ports, commit coordinator (see the type-
// checked mirror for the full wiring). The host owns the approval UI and
// calls adapter.recordOutOfBandApproval(planId, context) after the user
// approves out-of-band.
const resolvePlan = async (planId: string): Promise<Mcp20260728PlanResolution> => {
  const plan = await planStore.get(planId);
  if (plan === undefined) return { status: 'unknown' };
  return { status: plan.status, plan: projectPlan(plan) };
};

const writeAdapter = createMcp20260728WriteToolAdapter({
  changePlan,                 // protocol-neutral change-plan service options
  serverInfo: Object.freeze({ name: 'collection-write-host', version: '0.0.0' }),
  resolvePlan: { resolvePlan },
  requestStateKey: 'host-request-state-key-0123456789abcdef0123456789abcdef',
});

export async function handleToolCall(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>,
  input: Readonly<{
    name: string;
    arguments?: Readonly<Record<string, unknown>>;
    requestState?: string;
    inputResponses?: Readonly<Record<string, unknown>>;
  }>,
) {
  const context = createMcp20260728RequestContext({
    headers,
    httpMethod: 'POST',
    body,
    binding: mapStdioEvidenceToAuthenticatedBinding({
      credentialKind: 'stdio',
      principalId: 'local-principal',
      clientId: 'stdio-host-1',
      credentialBindingId: 'local-secret-binding-1',
      resourceAudience: 'urn:colp:resource:public',
      securityEpoch: 'epoch-1',
    }),
  });
  return writeAdapter.callTool(context, input);
}
```
## Versioned conformance candidate (COLP-MCP-14)

> **Candidate: `mcp-conformance-candidate`** — internal development artifact
> that was NOT a Profile claim or a release. COLP-MCP-15 accepted its exact
> MCP `2026-07-28` source-bound binding and restored `mcp-read` /
> `mcp-write`.

- The versioned probe families cover the full Modern write surface: the
  Write/MRTR family (`mcp-2026-07-28.write-mrtr-contracts`) plus the five
  mcp-read families inherited through the profile dependency closure
  (transport-header, discovery, subscription, read-schema, oauth-client).
- Target evidence issued for an MCP deployment scope now carries the exact
  versioned binding (MCP `2026-07-28`, source revision, locked SDK versions,
  fixture topology digest, report/requirement digests and a self-referential
  evidence digest). The runner fails closed when that source binding is
  missing or malformed.
- Old unversioned probes (`mcp-read.transport-contracts`,
  `mcp-write.approval-contracts`) are rejected migration input.
- `npm run generate:mcp-conformance-candidate` produces the source-bound
  `src/conformance/generated/mcp-conformance-candidate.json`; COLP-MCP-15
  regenerates it at the accepted revision and binds it into
  `src/conformance/generated/mcp-2026-07-28-sdk-accepted.json`.

## Accepted SDK (COLP-MCP-15)

> **Artifact: `mcp-2026-07-28-sdk-accepted`** — the source-bound total
> acceptance record. `mcp-read` / `mcp-write` are restored in
> `supportedProfiles` and the refreshed bundled evidence verifies every
> MCP-* Requirement ID.

COLP-MCP-15 establishes the accepted state:

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
