# @collection-protocol/node

Node.js implementation workspace for The Collection Protocol, abbreviated as COLP in package paths and internal identifiers.

## What this is

The Collection Protocol (COLP) is an open protocol for bookmark and knowledge
collections: a data model for collections, nodes and annotations, read-only
publication over HTTP and feeds, authenticated writes, two-way sync between
browsers, clients and servers, and an MCP mapping so AI tools can manage a
collection under the user's control.

This package is the protocol logic without a server. It validates wire
documents, decides what a request may do, and coordinates the durable steps of
a write or a sync exchange. You supply the HTTP routes, authentication and
storage by implementing small port interfaces; the package calls them in the
order the protocol requires and checks what they return.

## A minimal Sync host

The Sequence coordinator makes each client Operation take effect exactly once:
it replays a retried Operation from its receipt, and refuses a gap or a reused
sequence number. The example runs it against the in-memory reference adapters
from `./testing`.

```ts
import {
  createSyncHost,
  createSyncSession,
  requireVerifiedSyncSession,
} from '@collection-protocol/node/sync';
import {
  createInMemorySequenceUnitOfWork,
  createInMemorySyncSessionStore,
} from '@collection-protocol/node/testing';

const binding = {
  principal: { type: 'user', id: 'alice' },
  credential: { kind: 'token', id: 'token-1' },
  oauthClientId: null,
  origin: null,
  sessionScope: 'collection',
  protocolVersion: '0.1',
  collectionId: 'collection-1',
  purpose: null,
} as const;
const scopes = ['sync:pull', 'sync:push'] as const;

// Stand-ins for your database. Real adapters implement the same interfaces.
const sessions = createInMemorySyncSessionStore();
const unitOfWork = createInMemorySequenceUnitOfWork<{ status: string }>();

await createSyncSession(sessions, { ...binding, sessionId: 'session-1', authorizationScopes: scopes });

// Per request: verify the Session against the current credential, then act.
const session = await requireVerifiedSyncSession(sessions, {
  sessionId: 'session-1',
  binding,
  authorization: { credentialActive: true, authorizationScopes: scopes },
  terminatedAt: new Date().toISOString(),
});
const host = createSyncHost({ owner: 'sequence', session });

const { result } = await host.sequence(
  unitOfWork,
  { operationId: 'op-1', replicaId: 'replica-1', sequenceScope: 'collection-1', sequence: 1, digest: 'sha-256:…' },
  // Apply the Operation inside `transaction`; the receipt commits with it.
  async (_context, _transaction) => ({ status: 'applied', result: { status: 'applied' } }),
);
console.log(result.kind); // 'executed'; sending it again returns 'replayed'
```

To build a real host, replace the two in-memory adapters with your own
(`SyncSessionStore`, `SequenceCoordinatorUnitOfWork`) and follow
[`docs/SYNC_HOST_COMPOSITION.md`](docs/SYNC_HOST_COMPOSITION.md), which states
what each adapter must guarantee.

## Status

This directory contains the package Foundation Milestone: contracts, semantic validation, the publication client, server helpers, and conformance tooling. "Foundation" is a package-delivery term, not a protocol Profile or `Phase 1`. The package currently claims `core`, `publication`, `publisher`, `feed`, `sync`, `mcp-read`, and `mcp-write`. A deployment claim additionally requires real endpoint and runtime-port wiring plus Profile-specific black-box probe evidence.

Package capability and deployment capability are separate. This package owns protocol contracts, framework-neutral coordinators, port interfaces, security decisions, HTTP mapping contracts, and conformance tooling. An embedding host owns real URLs and routes, framework middleware, trusted transport evidence, authentication providers, persistence adapters, transaction wiring, configuration, secrets, and deployment probes. See [`docs/HOST_INTEGRATION_BOUNDARY.md`](docs/HOST_INTEGRATION_BOUNDARY.md) for the authoritative responsibility matrix.

Every surface is covered by the package's own tests and conformance tooling, but only some have also run inside a deployed host application. Those are `types`, `schema`, `semantic`, `server`, `mcp`, `conformance`, `sync/canonical`, and the Sequence-owner Sync host (`createSyncHost({ owner: 'sequence' })` with Session, bootstrap, Pull, and Replica lifecycle). Treat the others as experimental: `client` (`ColpClient`), `publisher`, `feed`, `security`, `adapters`, `delivery`, `sync/browser`, and the Push-owner Sync host. Their behaviour is tested, but no host has yet shaped their APIs, so expect them to change more before a stable release.

The normative protocol remains in the sibling `../../protocol` directory. Generated Schema, examples, and TypeScript types in this package must not be edited manually.

## Commands (repository checkout)

```bash
npm install
npm run refresh:protocol
npm run check
npm run pack:check
```

- `npm run refresh:protocol` synchronizes canonical assets and regenerates types. Commit those source changes before running `npm run refresh:evidence`, because a certificate must attest an already committed source revision.
- `npm run check:protocol` fails when committed generated assets drift from the protocol source.
- `npm run check:requirements` scans every BCP14 occurrence and fails on missing, duplicate, or stale Requirement selectors. `npm run update:requirements` appends stable IDs for newly discovered occurrences; stale selectors require an intentional Registry edit so IDs are preserved.
- `npm run check:types` and `npm run check:traceability` fail when generated TypeScript, Registry digests, bundled evidence, or traceability records drift.
- `npm run generate:evidence` verifies a clean protected COLP scope at exact `HEAD`, runs the complete evidence-bearing Vitest suite itself, rechecks that state, and writes the verified certificate to `src/conformance/generated/evidence.json`. Then `npm run generate:traceability` updates the certificate-derived documentation; `npm run refresh:evidence` runs both commands. Marker-free process-boundary contracts are excluded from evidence generation and remain mandatory in `npm run check`. External reports, caller-supplied revisions, and alternate output paths are rejected.
- `npm run check:release-evidence` is the release gate for every Profile exported in `supportedProfiles`. It reads the tracked certificate, requires its tested source revision to be an ancestor of the current `HEAD`, and permits only the certificate and generated traceability document to differ inside the protected release scope. It reruns the owned evidence suite, requires the current passed Requirement IDs to equal the certificate, and validates every selected Profile's transitive MUST / MUST_NOT closure. The default `--all-supported` selection is derived from the canonical release dependency registry.

Coverage command ownership — `npm test` and `npm run test:coverage` do **not** mean the package has passed the Security or Publisher floors:

| Command | Owns |
| --- | --- |
| `npm test` | Discovery run with no coverage collection or thresholds |
| `npm run test:coverage` | Aggregate universe in `vitest.config.ts`; does **not** include `src/security` or `src/publisher` |
| `npm run check` | Release entry: `test:coverage:publisher`, `test:coverage:security`, `test:coverage:sync-core`, and release-evidence |

- `npm run test:coverage:publisher` is the dedicated Publisher source coverage gate invoked by `npm run check`; `npm run test:mutation:publisher` runs its slower semantic mutation gate (local only).
- `npm run pack:check` validates package metadata, creates the actual npm tarball, extracts it into an isolated consumer using only lockfile-installed dependencies, and loads every public ESM/CJS entry point plus the JSON Schema export. It also compiles and runs the packaged Publisher quickstart import as ESM and CommonJS against the package declarations. The gate also checks that local Markdown links resolve inside the tarball. The tarball includes `docs/HOST_INTEGRATION_BOUNDARY.md`, `docs/PUBLICATION_QUICKSTART.md`, `docs/PUBLISHER_QUICKSTART.md`, `docs/SECURITY_COMPOSITION.md`, and `docs/SYNC_HOST_COMPOSITION.md` alongside `dist` and `README.md`.
- The repository-only `.github/workflows/colp-ci.yml` owns package CI and validates the repository-tracked release certificate. Embedding applications keep separate integration and deployment workflows.

## Public entry points

The public subpaths are `schema`, `types`, `semantic`, `client`, `server`, `publisher`, `adapters`, `feed`, `sync`, `sync/canonical`, `sync/browser`, `testing`, `delivery`, `conformance`, `security`, `mcp`, and `mcp/2026-07-28`. Import every protocol API from its owning subpath so loading one domain does not initialize unrelated schemas and runtime state; for example, use `@collection-protocol/node/publisher` and `@collection-protocol/node/sync`. Browser and MV3 protocol digest identity must import `@collection-protocol/node/sync/canonical` (no Node builtins); production `./sync` re-exports the same digest function objects. Browser-targeted consumers that also need browser event translation, batch application, root mapping, sidecars, Netscape bookmark parsing, separator presentation, transport budgets, light-Pull advice or typed-update payload validation import `@collection-protocol/node/sync/browser`, whose dependency graph has no Node built-ins or implicit `Buffer` use; it re-exports all of `sync/canonical`. Coordinators, Pull/effect-page validators and `mergeSyncTypedUpdate` (which keeps its Node-backed Proxy guard) stay on `sync`. `@collection-protocol/node/testing` holds test-only helpers: a fixed clock, a deterministic ID generator, the unverified Replica auth proof, and in-memory reference adapters for the Sync Session store and the Sequence unit of work (`createInMemorySyncSessionStore`, `createInMemorySequenceUnitOfWork`). Use them to exercise coordinators without a database and as a known-good comparison for a real adapter; never wire them into a deployment. The package root exports only `protocolVersion`, `packageStatus`, and `supportedProfiles`; it is package metadata, not a business API barrel. Feed contracts are available from `@collection-protocol/node/feed`; the Modern MCP `2026-07-28` Read/shared surface is available only from `@collection-protocol/node/mcp` (or the explicit `@collection-protocol/node/mcp/2026-07-28`). `nestjs` is internal reference code, not a public package surface or a package-completion requirement. Browser adapters remain separate browser-targeted packages and consume the shared conversion contract from `adapters`.

The `security` entry point (`./security`) exports the fail-closed contract library and request-boundary composition helpers (`TrustedTransportEvidence`, HTTPS/Origin composition, rate-limit, OAuth profile guards, and related SEC modules). Exporting this surface does **not by itself** authorize a deployment claim: adapters must derive and supply trusted transport evidence at the request boundary, and real HTTP middleware wiring plus deployment probes remain required before publishing production Manifest claims. For guard order and footguns, see [`docs/SECURITY_COMPOSITION.md`](docs/SECURITY_COMPOSITION.md). The package remains `private` at version `0.0.0-development`; those fields describe publication maturity, not a requirement for the package to ship an application server.

The `delivery` entry point exposes the immutable five-stage CORE-0037 implementation order and the `planDelivery` / `assertDeliveryOrder` status boundary. A completion list is an oldest-to-newest chronological ledger, not an unordered snapshot; members of one grouped stage may appear in either order, but a claim cannot return to an earlier stage. It may show partial progress only in its current grouped stage: `core` alone does not deliver `core + publication`, and one MCP component does not deliver `mcp-read` / `mcp-write`. Feed completion requires `mode: "release"`. The boundary rejects unknown or legacy names, duplicate claims, malformed records, skipped stages, and chronological inversions, then returns a detached immutable status in canonical order. Delivery status is planning metadata only; it is separate from protocol Profile dependencies and cannot populate `supportedProfiles`, conformance evidence, or Manifest claims.

The `conformance` entry point exposes `createDeploymentConformancePlan`, `runDeploymentConformanceProbes`, `evaluateProfileClaims`, and `assertProfileClaims`. The planner strictly combines the exact explicit Profile list with generic deployment capabilities and returns an immutable canonical probe plan. Profile dependency edges retain their data/wire meaning without forcing optional Core roles into every deployment: a read-only `core + publication` plan runs the Publication HTTP contract, while Publisher and Sync imply authoritative writes and Sync additionally implies unknown-Extension storage. AI writes, local Profile ID storage, and server Profile ID HMAC lifecycle are selected only when enabled. Only a complete scope-derived run returns process-local opaque evidence bound to Profiles, capabilities, and passed probe IDs; single-probe runs, configuration booleans, copied objects, and manually constructed passed-ID sets cannot substitute for it. The assertion must receive the exact requested Profile list and rejects legacy names, missing dependencies, and claims without complete endpoint, runtime-port, scope-bound deployment-probe, and bundled MUST / MUST_NOT evidence. Publishers must serialize the assertion's immutable return value; its caller-owned input and the evaluator's eligibility list are not verified publication claims.

`areUrlHashDeduplicationCandidates` is a candidate pre-filter only. It returns `true` only for two present, syntactically valid, equal URL-hash hints, and never mutates objects, chooses a winner, or establishes that they are duplicates. Callers must first validate each hint against its own preserved URL with `urlHashMatches` or the Bookmark semantic validators, then perform the applicable URL, content, and Collection-semantic comparison. Even after that comparison, duplicate handling is separate from protocol identity: equal hashes, URLs, content, or Collection context do not make distinct IDs or distinct `(serverUuid, resourceType, id)` tuples the same object. Colliding or stale hints therefore cannot override identity.

Generated `OpaqueId` and `UrlHash` TypeScript types are structural `string` aliases. Their disjoint wire grammars are enforced by the canonical JSON Schema and runtime validators; code accepting unvalidated TypeScript values must not treat the aliases alone as an identity boundary.

The package remains marked `private` and uses version `0.0.0-development` while the remaining profiles and release packaging are completed.

## Publication quickstart

The framework-neutral Publication read path, cursor-key lifecycle, cache and
adapter responsibilities, and real HTTP integration reference are documented
in [`docs/PUBLICATION_QUICKSTART.md`](docs/PUBLICATION_QUICKSTART.md). The
package currently claims `supportedProfiles=['core', 'publication', 'publisher',
'feed', 'sync', 'mcp-read', 'mcp-write']`. Deployment adapters still need to run the
package-owned black-box probes before publishing those claims in a Manifest.

## Publisher quickstart

The framework-neutral transaction boundary, idempotency flow, coordinator selection, adapter obligations, and deployment claim procedure are documented in [`docs/PUBLISHER_QUICKSTART.md`](docs/PUBLISHER_QUICKSTART.md).

Audit findings that were conditionally closed, rejected by design, or converted to hardening work are recorded in the repository-only `docs/REVIEW_DISPOSITIONS.md`. Maintainers preparing the first stable release follow the repository-only `docs/RELEASE_CHECKLIST.md`; these audit and release-process files are not installed with the npm package.

## License

Apache License 2.0. See [LICENSE](LICENSE).
