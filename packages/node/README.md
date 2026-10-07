# @collection-protocol/node

The reference implementation of [The Collection Protocol](https://github.com/WhitenWhiten/colp) (COLP) for Node.js 22 and later, written in TypeScript.

COLP is an open protocol for bookmarks and curated knowledge collections: one data model for collections, nodes, and annotations; read-only publication over HTTP and feeds; authenticated writes; two-way sync between browsers, apps, and servers; and an MCP mapping so AI assistants can work on a collection under the user's control.

This package is the protocol logic without a server. It validates wire documents, decides what each request may do, and coordinates the durable steps of a write or a sync exchange. You supply the HTTP routes, authentication, and storage by implementing small port interfaces; the package calls them in the order the protocol requires and checks what they return.

> **Status:** not yet published to npm. The package is marked `private` at version `0.0.0-development`; build it from a repository checkout as shown below. It implements all seven protocol profiles: `core`, `publication`, `publisher`, `feed`, `sync`, `mcp-read`, and `mcp-write`.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Entry points](#entry-points)
- [Guides](#guides)
- [What the package does, and what you do](#what-the-package-does-and-what-you-do)
- [API notes](#api-notes)
- [Development](#development)

## Install

From a clone of the repository:

```bash
git clone https://github.com/WhitenWhiten/colp.git && cd colp
npm run install:package && npm run build
```

To use the build in another project, pack it and install the tarball there:

```bash
cd packages/node && npm pack
cd /path/to/your-project && npm install /path/to/collection-protocol-node-0.0.0-development.tgz
```

Every entry point works from both ESM (`import`) and CommonJS (`require`).

## Quick start

### Validate a document

One call checks a document against its JSON Schema definition and then against the protocol rules a schema cannot express:

```ts
import { validateColpJsonDocument } from '@collection-protocol/node/semantic';

const result = validateColpJsonDocument('snapshot', text);
if (result.valid) {
  console.log(result.value.nodes.length); // result.value is typed as a Snapshot
} else {
  console.log(result.stage); // 'parse', 'structural', or 'semantic'
}
```

### Read a collection

`ColpClient` starts from a server's Manifest and follows the endpoints it declares:

```ts
import { ColpClient } from '@collection-protocol/node/client';

const client = new ColpClient({
  manifestUrl: 'https://alice.example/.well-known/collection-protocol',
});
const manifest = await client.discover();
const snapshot = await client.getSnapshot('019b3ca2-8424-7cc2-9a61-4bf44c23f07a');
```

For a server on your own machine, pass `egressPolicy: createLoopbackEgressPolicy([origin])`. By default the client reaches loopback and private addresses only through direct requests to the Manifest's own origin, never through redirects or the next-page links of a Snapshot.

### Serve a collection

In any handler that receives a Fetch API `Request`, one call serves a read with the right ETag, cache headers, `304`, `HEAD`, and Problem responses:

```ts
import {
  composePublicationHttpReadFromRequest,
  createPublicationHttpReadRepresentation,
} from '@collection-protocol/node/server';
import type { Snapshot } from '@collection-protocol/node/types';

export function serveSnapshot(request: Request, snapshot: Snapshot): Promise<Response> {
  return composePublicationHttpReadFromRequest(request, {
    endpoint: 'snapshot',
    access: 'anonymous-public',
    resolveRepresentation: () => createPublicationHttpReadRepresentation('snapshot', snapshot, {
      lastModified: new Date(snapshot.generatedAt),
    }),
  });
}
```

The repository's [example server](https://github.com/WhitenWhiten/colp/blob/main/packages/node/examples/publication-server.mjs) serves all four `core + publication` endpoints this way in one file, on `node:http`.

### Host Sync

The Sequence coordinator makes each client Operation take effect exactly once: it replays a retried Operation from its receipt, and refuses a gap or a reused sequence number. This example runs it against the in-memory reference adapters from `@collection-protocol/node/testing`:

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
  terminatedAt: new Date().toISOString(), // the current server time
});
const host = createSyncHost({ owner: 'sequence', session });

const { result } = await host.sequence(
  unitOfWork,
  // A real host passes canonicalOperationDigest(operation), which looks like 'sha-256=:…:'.
  { operationId: 'op-1', replicaId: 'replica-1', sequenceScope: 'collection-1', sequence: 1, digest: 'sha-256=:…:' },
  // Apply the Operation inside `transaction`; the receipt commits with it.
  async (_context, _transaction) => ({ status: 'applied', result: { status: 'applied' } }),
);
console.log(result.kind); // 'executed'; sending it again returns 'replayed'
```

To build a real host, replace the two in-memory adapters with your own (`SyncSessionStore`, `SequenceCoordinatorUnitOfWork`) and follow [Sync host composition](docs/SYNC_HOST_COMPOSITION.md), which states what each adapter must guarantee.

## Entry points

The public subpaths are `schema`, `types`, `semantic`, `client`, `server`, `publisher`, `adapters`, `feed`, `sync`, `sync/canonical`, `sync/browser`, `testing`, `delivery`, `conformance`, `security`, `mcp`, and `mcp/2026-07-28`. Import each one as `@collection-protocol/node/<subpath>`, for example `@collection-protocol/node/sync`, so that loading one domain does not initialize unrelated schemas and runtime state. The raw JSON Schema is also exported as `@collection-protocol/node/schema/collection-protocol.schema.json`.

| Entry point | Use it to | Maturity |
|---|---|---|
| `types` | Type wire documents (`Manifest`, `Snapshot`, `ColpContract<Name>`); types only, no runtime code | Deployed |
| `schema` | Validate against the JSON Schema, parse I-JSON, check URLs | Deployed |
| `semantic` | Validate documents end to end, and check the rules a schema cannot express | Deployed |
| `client` | Read and write through `ColpClient` | Experimental |
| `server` | Serve Publication reads: composed reads, Problems, cursors, ETags, projection | Deployed |
| `publisher` | Run authenticated, idempotent writes inside your transactions | Experimental |
| `feed` | Build the change feed, JSON Feed, Atom, and WebSub mapping | Experimental |
| `sync` | Host Sync: Sessions, sequencing, Pull, Replicas, digests | Sequence-owner host deployed; Push-owner host experimental |
| `sync/canonical` | Compute canonical JSON and Operation digests without Node.js built-ins | Deployed |
| `sync/browser` | Sync from a browser extension without Node.js built-ins | Experimental |
| `mcp`, `mcp/2026-07-28` | Serve MCP `2026-07-28` resources, read tools, and write tools | Deployed |
| `security` | Make request-boundary decisions: HTTPS, Origin, scopes, rate limits, OAuth | Experimental |
| `adapters` | Convert to and from browser formats with a loss audit | Experimental |
| `conformance` | Plan and run deployment probes, and decide which profiles you may claim | Deployed |
| `delivery` | Check the recommended order for delivering profiles | Experimental |
| `testing` | Use a fixed clock, deterministic IDs, and in-memory ports in tests | Tests only |

"Deployed" entry points have also run inside a deployed host application. "Experimental" ones behave as tested, but no host has shaped their APIs yet, so expect more changes there before a stable release.

A few rules about where things live:

- **Browser and MV3 code** imports digests from `@collection-protocol/node/sync/canonical`, and the other browser Sync helpers (event translation, batch application, root mapping, sidecars, Netscape bookmark parsing, separator presentation, transport budgets, light-Pull advice, typed-update payload validation) from `@collection-protocol/node/sync/browser`, which re-exports all of `sync/canonical`. Both are verified to contain no Node.js built-ins or implicit `Buffer` use; treat every other entry point as Node.js only. Production `sync` re-exports the same digest functions, while coordinators, Pull and effect-page validators, and `mergeSyncTypedUpdate` stay on `sync`.
- **`testing`** holds test-only helpers: a fixed clock, a deterministic ID generator, the unverified Replica auth proof, and in-memory reference adapters for the Sync Session store and the Sequence unit of work. Use them to exercise coordinators without a database and as a known-good comparison for a real adapter; never wire them into a deployment.
- **The package root** exports only `protocolVersion`, `packageStatus`, and `supportedProfiles`. It is package metadata, not an API barrel.
- **MCP**: the Modern MCP `2026-07-28` surface, Read and Write, is available only from `mcp` (or the explicit `mcp/2026-07-28`).
- `nestjs` in the source tree is internal reference code, not a public package surface.

## Guides

These guides ship with the package, in its `docs/` directory:

| Guide | Read it when you want to… |
|---|---|
| [API guide](docs/API.md) | find the right entry point for a task, with a short example for each |
| [Publication quickstart](docs/PUBLICATION_QUICKSTART.md) | serve the read-only `core + publication` endpoints, and read them with `ColpClient` |
| [Publisher quickstart](docs/PUBLISHER_QUICKSTART.md) | accept authenticated writes with idempotency keys and real transactions |
| [Sync host composition](docs/SYNC_HOST_COMPOSITION.md) | host the Sync endpoints that browser and app replicas talk to |
| [Browser batch integration](docs/BROWSER_BATCH_INTEGRATION.md) | apply a batch of browser bookmark changes from an extension |
| [MCP host guide](docs/MCP_HOST_GUIDE.md) | let AI assistants read and change collections over MCP |
| [Security composition](docs/SECURITY_COMPOSITION.md) | put the HTTPS, Origin, rate-limit, OAuth, and credential checks in the right order |
| [Host integration boundary](docs/HOST_INTEGRATION_BOUNDARY.md) | see exactly what the package does and what your application must do |

The repository has more: the [documentation index](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/README.md), the package [architecture](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/ARCHITECTURE.md), the generated [traceability matrix](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/TRACEABILITY.md) from every protocol requirement to its tests, and the [protocol specification](https://github.com/WhitenWhiten/colp/tree/main/protocol) itself.

## What the package does, and what you do

Package capability and deployment capability are separate. This package owns the protocol contracts, framework-neutral coordinators, port interfaces, security decisions, HTTP mapping contracts, and conformance tooling. Your application owns the real URLs and routes, framework middleware, trusted transport evidence, authentication providers, persistence adapters, transaction wiring, configuration, secrets, and deployment probes. [Host integration boundary](docs/HOST_INTEGRATION_BOUNDARY.md) is the authoritative responsibility matrix.

The package claims `core`, `publication`, `publisher`, `feed`, `sync`, `mcp-read`, and `mcp-write` on the strength of its own tests. A deployment that wants to declare those profiles in its Manifest additionally needs real endpoint and runtime-port wiring plus the profile-specific black-box probe evidence that the `conformance` entry point checks. Exporting the `security` surface does not by itself authorize a deployment claim either: adapters must derive and supply trusted transport evidence at the request boundary, and real HTTP middleware plus deployment probes remain required. [Security composition](docs/SECURITY_COMPOSITION.md) gives the guard order and its pitfalls.

The normative protocol is in the repository's `protocol/` directory. The schemas, examples, and TypeScript types generated from it must not be edited by hand.

## API notes

**`conformance`** exposes `createDeploymentConformancePlan`, `runDeploymentConformanceProbes`, `evaluateProfileClaims`, and `assertProfileClaims`. The planner strictly combines the exact explicit profile list with generic deployment capabilities and returns an immutable canonical probe plan. Profile dependency edges keep their data and wire meaning without forcing optional Core roles into every deployment: a read-only `core + publication` plan runs the Publication HTTP contract, while Publisher and Sync imply authoritative writes, and Sync also implies unknown-extension storage. AI writes, local Profile ID storage, and the server Profile ID HMAC lifecycle are selected only when enabled. Only a complete, scope-derived run returns process-local opaque evidence bound to profiles, capabilities, and passed probe IDs; single-probe runs, configuration booleans, copied objects, and hand-built sets of passed IDs cannot substitute for it. The assertion must receive the exact requested profile list, and rejects legacy names, missing dependencies, and claims without complete endpoint, runtime-port, scope-bound deployment-probe, and bundled MUST / MUST NOT evidence. Publishers must serialize the assertion's immutable return value; its caller-owned input and the evaluator's eligibility list are not verified claims.

**`delivery`** exposes the immutable five-stage CORE-0037 implementation order and the `planDelivery` / `assertDeliveryOrder` status boundary. A completion list is an oldest-to-newest ledger, not an unordered set: members of one grouped stage may appear in either order, but a claim cannot return to an earlier stage, and partial progress shows only in the current grouped stage. `core` alone does not deliver `core + publication`, one MCP component does not deliver `mcp-read` or `mcp-write`, and Feed completion requires `mode: "release"`. The boundary rejects unknown or legacy names, duplicates, malformed records, skipped stages, and chronological inversions, then returns a detached immutable status in canonical order. Delivery status is planning metadata only: it is separate from protocol profile dependencies and cannot populate `supportedProfiles`, conformance evidence, or Manifest claims.

**`areUrlHashDeduplicationCandidates`** is a candidate pre-filter only. It returns `true` only for two present, syntactically valid, equal URL-hash hints, and never mutates objects, picks a winner, or establishes that they are duplicates. Callers must first validate each hint against its own preserved URL with `urlHashMatches` or the Bookmark semantic validators, then perform the applicable URL, content, and Collection-semantic comparison. Even then, duplicate handling is separate from protocol identity: equal hashes, URLs, content, or Collection context do not make distinct IDs, or distinct `(serverUuid, resourceType, id)` tuples, the same object.

**`OpaqueId` and `UrlHash`** are structural `string` aliases in the generated TypeScript types. Their disjoint wire grammars are enforced by the JSON Schema and the runtime validators, so code that accepts unvalidated TypeScript values must not treat the aliases alone as an identity boundary.

## Development

In a repository checkout, from `packages/node`:

```bash
npm install
npm run refresh:protocol
npm run check
npm run pack:check
```

- `npm run refresh:protocol` copies the canonical protocol assets into `fixtures/protocol` and regenerates the types.
- `npm run check:protocol` and `npm run check:types` fail when the committed copies or generated types drift from the protocol source.
- `npm run check:traceability` validates `protocol/requirements.yaml` and `requirements-0.2.yaml` (fields, unique IDs, and that every `source` anchor exists) and fails when `docs/TRACEABILITY.md` or `src/conformance/generated/requirements.json` is stale.
- `npm run refresh:evidence` runs the full Vitest suite, records every requirement whose tagged tests all passed in `src/conformance/generated/evidence.json`, and regenerates the traceability files. Run it after changing a requirement's ID, level, profile, or tests, or after adding `[evidence:<test-id>]` tags, and commit the result. `npm run check:evidence` reruns the suite and fails if the committed evidence is out of date.

`npm test` and `npm run test:coverage` do **not** mean the package has passed the Security or Publisher coverage floors:

| Command | Covers |
| --- | --- |
| `npm test` | The whole suite, without coverage collection or thresholds |
| `npm run test:coverage` | The aggregate coverage universe in `vitest.config.ts`, which does **not** include `src/security` or `src/publisher` |
| `npm run check` | The release gate: protocol, type, and traceability checks, `test:coverage:publisher`, `test:coverage:security`, `test:coverage:sync-core`, the coverage evidence check, and `pack:check` |

- `npm run test:coverage:publisher` is the dedicated Publisher coverage gate that `npm run check` runs; `npm run test:mutation:publisher` runs its slower mutation gate (local only).
- `npm run pack:check` validates the package metadata, creates the real npm tarball, installs it into an isolated consumer using only lockfile-installed dependencies, and loads every public ESM and CommonJS entry point plus the JSON Schema export. It also compiles and runs the marked code examples in the shipped guides as ESM and CommonJS against the package declarations, and checks that every local Markdown link resolves inside the tarball. The tarball contains `dist`, this README, and the guides listed above.
- The repository-only `.github/workflows/colp-ci.yml` runs the package CI, including the evidence check. Applications that embed the package keep their own integration and deployment workflows.

Audit findings that were conditionally closed, rejected by design, or turned into hardening work are recorded in the repository-only [review dispositions](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/REVIEW_DISPOSITIONS.md). Maintainers preparing the first stable release follow the repository-only [release checklist](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/RELEASE_CHECKLIST.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
