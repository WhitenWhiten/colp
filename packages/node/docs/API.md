# API guide

`@collection-protocol/node` is split into entry points, one for each job, so that loading one part does not load the rest. This guide tells you which entry point to start from for a task and shows the first lines of code. Your editor's autocomplete lists everything else an entry point exports, and every export has TypeScript types.

The code in the sections on validating, reading, and serving is compiled and run against the packed package on every CI run, so it matches the API you install.

## Contents

- [Conventions](#conventions)
- [Which entry point?](#which-entry-point)
- [Validate a document](#validate-a-document)
- [Read from a server](#read-from-a-server)
- [Serve read-only collections](#serve-read-only-collections)
- [Accept writes](#accept-writes)
- [Host Sync](#host-sync)
- [Connect AI assistants over MCP](#connect-ai-assistants-over-mcp)
- [Check requests at the boundary](#check-requests-at-the-boundary)
- [Claim profiles in a Manifest](#claim-profiles-in-a-manifest)
- [Maturity](#maturity)

## Conventions

A few rules hold across the whole package. Knowing them makes the rest predictable.

- **Invalid data is a result, not an exception.** Validators return an object that says whether the input was valid and, if not, why. Decisions and coordinators return their outcome the same way, in a field named `valid`, `ok`, `allowed`, or `state` depending on the entry point. A thrown `TypeError` or `RangeError` usually means the call itself was wrong, such as an unknown option or a Proxy where plain data is expected. `ColpClient` is the exception: it reports failed requests by throwing [typed errors](#read-from-a-server).
- **Inputs are strict.** Inputs and options must be plain data, and an unknown option is a `TypeError` rather than something silently ignored, so a typo cannot quietly turn a check off.
- **Wire types are types only.** Import `Manifest`, `Snapshot`, `Node`, and the rest from `@collection-protocol/node/types` with `import type`. `ColpContract<'collectionMetadata'>` names the type of any JSON Schema definition.
- **You own storage and HTTP.** Where the package needs your database or your transaction manager, it asks for a small interface (a "port"), calls it in the order the protocol requires, and checks what it returns. The in-memory ports in `@collection-protocol/node/testing` are for tests only.
- **The root is metadata.** `@collection-protocol/node` exports only `protocolVersion`, `packageStatus`, and `supportedProfiles`. Everything else lives on its own entry point.

## Which entry point?

| I want to… | Entry point | Start with |
|---|---|---|
| Check that a JSON document is valid COLP | `semantic` | `validateColpDocument`, `validateColpJsonDocument` |
| Use TypeScript types for wire documents | `types` | `Manifest`, `Snapshot`, `ColpContract` |
| Get the raw JSON Schema | `schema` | `collectionProtocolSchema`, or the file `@collection-protocol/node/schema/collection-protocol.schema.json` |
| Read collections from a COLP server | `client` | `ColpClient` |
| Serve read-only collections | `server` | `composePublicationHttpReadFromRequest`, `createPublicationHttpReadRepresentation` |
| Accept authenticated writes | `publisher` | `executePublisherIdempotencyBoundary`, then the [Publisher quickstart](PUBLISHER_QUICKSTART.md) |
| Publish a change feed as JSON Feed or Atom | `feed` | `mapFeedToJsonFeed`, `mapFeedToAtom` |
| Host Sync for browsers and apps | `sync` | `createSyncSession`, `requireVerifiedSyncSession`, `createSyncHost` |
| Sync from a browser extension | `sync/browser` | `translateSyncBrowserEvent`, `applySyncBrowserBatch` |
| Compute Operation digests in a browser or MV3 worker | `sync/canonical` | `canonicalOperationDigest` |
| Let AI assistants read and change collections | `mcp` | `createMcp20260728ResourceAdapter`, `createMcp20260728ReadToolAdapter`, `createMcp20260728WriteToolAdapter` |
| Check HTTPS, Origin, scopes, and rate limits on a request | `security` | `enforcePublisherStreamableHttpBoundary`, then [Security composition](SECURITY_COMPOSITION.md) |
| Convert to and from browser formats without losing data | `adapters` | `transformExportExtensionCarrier`, `createAdapterConversionResult` |
| Decide which profiles a deployment may claim | `conformance` | `createDeploymentConformancePlan`, `runDeploymentConformanceProbes`, `assertProfileClaims` |
| Test against in-memory ports | `testing` | `createInMemorySyncSessionStore`, `createInMemorySequenceUnitOfWork`, `FixedClock` |
| See the recommended delivery order of the profiles | `delivery` | `planDelivery` |

Every entry point is imported as `@collection-protocol/node/<entry point>`, for example `@collection-protocol/node/semantic`. `mcp/2026-07-28` is the same surface as `mcp`, for hosts that want to pin the MCP version in their imports.

## Validate a document

`validateColpDocument` checks a parsed value, and `validateColpJsonDocument` parses I-JSON text first. Both check the document against its JSON Schema definition and then against the protocol rules a schema cannot express. The result says which stage rejected the document: `parse`, `structural` (JSON Schema, with Ajv `errors`), or `semantic` (protocol rules, with `issues` that each have a `code`, `path`, and `message`).

<!-- colp-consumer: api-validate -->
```ts
import { validateColpJsonDocument } from '@collection-protocol/node/semantic';
import type { Manifest } from '@collection-protocol/node/types';

/** Parses and checks a Manifest received as text. */
export function readManifest(text: string): Manifest {
  const result = validateColpJsonDocument('manifest', text);
  if (result.valid) return result.value;
  const reasons = result.stage === 'parse'
    ? [result.error.message]
    : result.stage === 'structural'
      ? result.errors.map((error) => `${error.instancePath} ${error.message ?? ''}`)
      : result.issues.map((issue) => `${issue.path} ${issue.message}`);
  throw new TypeError(`Invalid Manifest (${result.stage}): ${reasons.join('; ')}`);
}
```

The first argument is the name of a definition in the JSON Schema, such as `manifest`, `snapshot`, `collectionDirectory`, `collectionMetadata`, `nodeDetail`, or `problem`. On success, `result.value` has the matching type from `@collection-protocol/node/types`.

Which protocol rules run depends on the definition:

| Definition | Rules checked after the schema |
|---|---|
| `manifest` | Known profiles and their dependencies, the endpoints each profile requires, endpoint URI templates, MCP declarations, unique mount IDs |
| `snapshot` | The tree (one root, parents, positions, cycles, alias targets), visibility, sidecar references, tombstones, URL hashes, extensions, and the content digest |
| `problem` | The code's entry in the Problem registry, and the HTTP status and Content-Type if you pass them |
| `node`, `nodeDetail`, `nodeCreate`, `nodeCreateRequest` | The Bookmark `urlHash` matches its `url` |
| everything else | The schema only |

Options adjust the defaults:

- `snapshot` is merged over the Snapshot defaults. By default a Snapshot is checked as a consumer receives it: unknown extensions are preserved, and when the Snapshot is not complete (a cropped Snapshot, or one page of several) references to Nodes outside it are not reported. Pass `{ publicationExtensionMode: 'producer', publicSafeExtensions }` to check a Snapshot you are about to publish, or a `referenceResolution` to resolve references against your own store.
- `problem` takes the real `httpStatus` and `contentType` of a response, so the status in the body and the media type are checked too.
- `validateSemantics` replaces the built-in rules. Use it for documents whose rules need state the document does not carry, such as `validateNodeMergePatchUrlHashSemantics(currentNode, patch)` for a merge patch, or `validateAnnotationProvenance` for an Annotation write.
- `validators` supplies your own `createValidatorRegistry()`, and `limits` (JSON only) sets I-JSON depth, member, and byte limits.

The lower-level pieces are still there when you need them: `createValidatorRegistry` and `validateWireDocument` in `schema`, and each semantic validator, such as `validateManifestSemantics` and `validateSnapshotSemantics`, in `semantic`.

## Read from a server

`ColpClient` starts from a Manifest URL and follows the endpoints the Manifest declares, so it never guesses paths. It validates every response, follows Snapshot pages, caches with ETags, and enforces time and size budgets on every call.

<!-- colp-consumer: api-local-client -->
```ts
import { ColpClient, createLoopbackEgressPolicy } from '@collection-protocol/node/client';

/** A client for a COLP server on this machine, such as the example server. */
export function createLocalClient(origin = 'http://127.0.0.1:8080'): ColpClient {
  return new ColpClient({
    manifestUrl: new URL('/.well-known/collection-protocol', origin),
    egressPolicy: createLoopbackEgressPolicy([origin]),
  });
}
```

Then call `discover()` for the Manifest, `getDirectory()`, `getCollection(id)`, and `getSnapshot(id)`. `createNode` and `moveNode` write through a Publisher server and require an `idempotencyKey` (and `moveNode` an `ifMatch` ETag).

`egressPolicy` decides which URLs the client may request. For a public server, leave it out: the default refuses private and loopback addresses, which protects a server-side client from being pointed at your internal network. For a server on your own machine, `createLoopbackEgressPolicy` allows exactly the loopback origins you list. Without it, the client reaches a loopback server only on the first request to the Manifest's own origin, so redirects and the later pages of a paged Snapshot would be refused.

Failures are thrown as typed errors:

| Error | Meaning | Useful fields |
|---|---|---|
| `ColpProblemError` | The server answered with a Problem | `code`, `status`, `retryable`, `recovery` (for example `currentEtag`) |
| `ColpWireValidationError` | A response was not valid COLP | `stage`, `definition`, `details` |
| `ColpClientLimitError` | A time, size, page, or object budget ran out | `message` |

The [Publication quickstart](PUBLICATION_QUICKSTART.md) covers authenticated clients, caching, and budgets in detail.

## Serve read-only collections

A read-only server implements the `core` and `publication` profiles: a Manifest at `/.well-known/collection-protocol`, a Directory, Collection Metadata, and Snapshots. The package composes each read for you, in the order the protocol requires: it decodes and checks the query, asks you for the document, projects it to its public form, validates it, and then adds the ETag, cache headers, `304 Not Modified`, `HEAD`, and Problem responses.

<!-- colp-consumer: api-serve-read -->
```ts
import {
  composePublicationHttpReadFromRequest,
  createPublicationHttpReadRepresentation,
} from '@collection-protocol/node/server';
import type { Snapshot } from '@collection-protocol/node/types';

/** Serves GET and HEAD for one Collection's Snapshot from any Fetch-style framework. */
export function serveSnapshot(request: Request, loadSnapshot: () => Promise<Snapshot>): Promise<Response> {
  return composePublicationHttpReadFromRequest(request, {
    endpoint: 'snapshot',
    access: 'anonymous-public',
    // Runs only after the query string has been decoded and accepted.
    resolveRepresentation: async () => {
      const snapshot = await loadSnapshot();
      return createPublicationHttpReadRepresentation('snapshot', snapshot, {
        lastModified: new Date(snapshot.generatedAt),
        cacheControl: 'public, max-age=60',
      });
    },
  });
}
```

`composePublicationHttpReadFromRequest` takes the method, query string, and `If-None-Match` from the request, and answers any method other than `GET` and `HEAD` with a `405` Problem. The `endpoint` is one of `manifest`, `directory`, `metadata`, `snapshot`, or `node`. For data that depends on who is asking, use `access: 'authorized-private'` with an `authorize` callback, and pass `principalScope` to `createPublicationHttpReadRepresentation`.

`createPublicationHttpReadRepresentation` fills in what the document already says:

| Field | Default |
|---|---|
| `revision` | The document's own revision for `metadata`, `snapshot`, and `node`. The Manifest and Directory have none, so pass one. |
| `negotiatedMediaType` | The registered media type in `PUBLICATION_HTTP_READ_MEDIA_TYPES`, such as `application/vnd.collection-protocol.snapshot+json;version=0.1` |
| `snapshotIdentity`, `pageIdentity` | The Snapshot ID and page sequence. Pass `pageIdentity` with the page cursor when the request had one. |
| `headers` | Your headers, plus the `Link` headers that Collection Metadata must carry |
| `projectionKey`, `protocolVersion` | `public` and `0.1` |

The function returns a standard Fetch `Response`. Fetch-based frameworks return it as is; other frameworks must copy its status, headers, and exact body bytes, because the ETag covers those bytes. The [example server](https://github.com/WhitenWhiten/colp/blob/main/packages/node/examples/publication-server.mjs) does this for `node:http` in one file, and the [Publication quickstart](PUBLICATION_QUICKSTART.md) explains cursors, caching, and what your storage must guarantee. `composePublicationHttpRead` is the same composition with every request field passed explicitly.

## Accept writes

The `publisher` entry point runs authenticated writes inside your database transaction, with `Idempotency-Key` replay and `If-Match` preconditions. Start with `executePublisherIdempotencyBoundary`, which saves the first complete response in the same transaction as the write so that a retried request gets exactly the same answer. Coordinators such as `executePublisherCollectionCreate`, `executePublisherOrdinaryNodeCreate`, `executePublisherNodeMove`, and `executePublisherNodeDelete` implement the individual writes. The [Publisher quickstart](PUBLISHER_QUICKSTART.md) lists the request order and what each port must guarantee.

## Host Sync

Sync lets browsers and apps exchange Operations with a server. A host verifies the replica's Session on every request with `requireVerifiedSyncSession`, then calls the host returned by `createSyncHost` to sequence pushed Operations exactly once, serve Pull pages, and manage Replicas. The [package README](../README.md) has a runnable example against the in-memory ports from `testing`, and [Sync host composition](SYNC_HOST_COMPOSITION.md) states what each real port must guarantee.

Browser extensions use `sync/browser`, which has no Node.js built-ins: it translates native bookmark events into Operation intents, applies batches of changes, maps the browser's root folders, and parses Netscape bookmark HTML. `sync/canonical` holds only the canonical JSON and SHA-256 digests, for code that needs nothing else.

## Connect AI assistants over MCP

The `mcp` entry point maps collections onto MCP `2026-07-28`: resources and read tools for `mcp-read`, and write tools with scopes, audit, and a plan, approve, commit flow for `mcp-write`. Start with `createMcpStatelessReadCore` and `createMcp20260728ResourceAdapter`, add `createMcp20260728ReadToolAdapter` for read tools, and `createMcp20260728WriteToolAdapter` with `createChangePlanService` for writes. Each request is bound to its caller with `createMcp20260728RequestContext`. The [MCP host guide](MCP_HOST_GUIDE.md) walks through a complete host.

## Check requests at the boundary

The `security` entry point makes fail-closed decisions from evidence your HTTP layer supplies: HTTPS and Origin checks, effective scopes, rate limits, API-key and OAuth profiles, and content integrity. It never reads a raw request itself, so you decide what evidence to trust. [Security composition](SECURITY_COMPOSITION.md) gives the order in which to run the checks.

## Claim profiles in a Manifest

A Manifest may list only the profiles a deployment actually passes. `createDeploymentConformancePlan` lists the black-box probes for the profiles you intend to claim, `runDeploymentConformanceProbes` runs them against your deployment, and `assertProfileClaims` returns the exact profile list you may publish, or throws. [Host integration boundary](HOST_INTEGRATION_BOUNDARY.md) explains what the package proves and what your deployment must prove. To test a running server from the outside, use the repository's [`colp-conformance`](https://github.com/WhitenWhiten/colp/tree/main/packages/conformance) runner.

## Maturity

Every entry point is covered by the package's own tests. Some have also run inside a deployed host application, and those are the least likely to change before a stable release:

| Deployed in a host | Experimental |
|---|---|
| `types`, `schema`, `semantic`, `server`, `mcp`, `conformance`, `sync/canonical`, and the Sequence-owner Sync host | `client`, `publisher`, `feed`, `security`, `adapters`, `delivery`, `sync/browser`, and the Push-owner Sync host |

Experimental entry points behave as tested, but no host has shaped their APIs yet, so expect more changes there.
