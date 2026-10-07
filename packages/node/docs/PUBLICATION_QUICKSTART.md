# Publication quickstart

This guide shows how to serve COLP's read-only `core + publication` endpoints from your own HTTP framework, and how to read them back with `ColpClient`. The package handles the protocol: it decodes and checks each query, projects documents to their public form, validates them, and adds ETags, cache headers, `304 Not Modified`, `HEAD`, and Problem responses. Your application supplies the routes, the data, and any authentication.

For a complete server in one file, see the [example server](https://github.com/WhitenWhiten/colp/blob/main/packages/node/examples/publication-server.mjs), which runs on `node:http`. For the other entry points, see the [API guide](API.md).

## Contents

- [The read path](#the-read-path)
- [Serve one endpoint](#serve-one-endpoint)
- [Forward the response](#forward-the-response)
- [Private data](#private-data)
- [Read it back with ColpClient](#read-it-back-with-colpclient)
- [Authenticated client caching](#authenticated-client-caching)
- [Client request budgets and cancellation](#client-request-budgets-and-cancellation)
- [Cursor keys](#cursor-keys)
- [Cache and storage responsibilities](#cache-and-storage-responsibilities)
- [Before you publish profile claims](#before-you-publish-profile-claims)

## The read path

Everything starts at the Manifest. A server publishes a Manifest with explicit `mounts` and endpoint declarations, and a client follows those absolute endpoint URLs, the response `Link` targets, and server redirects. A client must not build paths by appending to `baseUrl`.

The Publication resources are separate on purpose:

1. **Manifest** (`/.well-known/collection-protocol`) advertises mounts, profiles, media types, and endpoint declarations.
2. **Directory** lists the visible Collections.
3. **Collection Metadata** describes one Collection and links to its resources.
4. **Snapshot** returns a point-in-time copy of a Collection's Nodes. A large Snapshot may be split into pages; the server supplies the `next` Link, and the client follows it without building a cursor URL.
5. **Node** returns one Node with its sidecar data.

The package composes each read in this order, so an adapter cannot get it wrong:

```text
decode query -> authorize -> load the document -> project to public form -> validate
-> serialize JSON -> compute the ETag -> apply cache and Vary policy
-> evaluate If-None-Match -> 200, 304, or a Problem
```

Never compute an ETag over an authoritative object before public projection, and never let an adapter bypass the final validation. `HEAD` uses the same headers as `GET` and omits only the body. Errors are Problem Details with a registered code, served as `application/problem+json`.

## Serve one endpoint

`composePublicationHttpReadFromRequest` from `@know-n/colp/server` takes a Fetch API `Request` and returns a `Promise<Response>`. It reads the method, query string, and `If-None-Match` from the request and answers any method other than `GET` and `HEAD` with a `405` Problem and `Allow: GET, HEAD`.

This complete module compiles against the installed package. The host supplies `loadDirectory`, which receives the decoded query and returns the representation to serve:

<!-- colp-consumer: publication-read -->
```ts
import {
  composePublicationHttpReadFromRequest,
  type AnonymousPublicationHttpReadInput,
} from '@know-n/colp/server';

export function readPublicDirectory(
  request: Request,
  loadDirectory: AnonymousPublicationHttpReadInput['resolveRepresentation'],
): Promise<Response> {
  return composePublicationHttpReadFromRequest(request, {
    endpoint: 'directory',
    access: 'anonymous-public',
    resolveRepresentation: loadDirectory,
  });
}
```

A representation is the document plus what the ETag and cache headers need: `value` (a valid CollectionDirectory here), `revision`, `projectionKey`, `protocolVersion`, and `lastModified`. Optional `headers` carry declared `Link` targets, and `cacheControl` declares the public cache policy.

`createPublicationHttpReadRepresentation(endpoint, value, options)` builds a representation for you. It takes the revision from the document for `metadata`, `snapshot`, and `node`, sets the registered vendor media type (listed in `PUBLICATION_HTTP_READ_MEDIA_TYPES`), derives the Snapshot and page identities, and adds the `Link` headers that Collection Metadata must carry. You pass `lastModified`, and a `revision` for the Manifest and the Directory, which have none of their own:

```ts
resolveRepresentation: () => createPublicationHttpReadRepresentation('directory', directory, {
  revision: directoryRevision,
  lastModified: directoryUpdatedAt,
  cacheControl: 'public, max-age=60',
}),
```

`composePublicationHttpRead` is the same composition with every request field (`method`, `rawSearch`, `ifNoneMatch`, `validators`) passed explicitly, for frameworks that do not expose a Fetch `Request`.

## Forward the response

Fetch-compatible handlers can return the composed `Response` directly. Other framework adapters must forward its status, headers, and exact body bytes, and keep the body absent for `HEAD` and `304`. Do not JSON-serialize the `Response` object or re-serialize its body: the ETag covers those exact bytes. Lower-level helpers in the `server` entry point return DTOs, descriptors, or `Headers` according to their individual signatures.

In a repository checkout, the black-box tests in [`tests/integration/publication-http-blackbox.test.ts`](https://github.com/WhitenWhiten/colp/blob/main/packages/node/tests/integration/publication-http-blackbox.test.ts) run a loopback `node:http` server against a real `fetch` and `ColpClient`. They are a reference for adapters, which should preserve the same status, header, `Link`, ETag, `304`, `HEAD`, and Problem behavior.

## Private data

The composition distinguishes anonymous public output from output that depends on who is asking. For personalized data, use `access: 'authorized-private'` with an `authorize` callback. It runs after the query is decoded and before anything is loaded; it returns `{ allowed: true, context }`, or `{ allowed: false, problem }` with `insufficient_scope` (`403`) or `resource_not_found` (`404`, to hide that the resource exists). The representation must then carry a `principalScope`, which partitions the ETag so two principals never share one for different bodies.

## Read it back with ColpClient

```ts
import { ColpClient, createLoopbackEgressPolicy } from '@know-n/colp/client';

const client = new ColpClient({
  manifestUrl: 'http://127.0.0.1:8080/.well-known/collection-protocol',
  egressPolicy: createLoopbackEgressPolicy(['http://127.0.0.1:8080']),
});
const manifest = await client.discover();
const snapshot = await client.getSnapshot(collectionId);
```

`ColpClient` follows declared endpoints, `Link` targets, and HTTP redirects. Which of those destinations it may contact is decided by its `egressPolicy`:

- **Without a policy**, it refuses private, loopback, and link-local literal addresses, except for requests made directly to the origin of the `manifestUrl` you passed. Redirects and `Link` targets, including the later pages of a Snapshot, never get that exception. The default Node fetch path also checks every DNS answer before each request and redirect, rejecting failed or empty resolutions and any private or local address. Custom fetch implementations can supply `resolveHost` for the same check.
- **`createLoopbackEgressPolicy(origins)`** allows exactly the listed `localhost`, `127.0.0.1`, or `[::1]` origins and nothing else. Use it for a server on your own machine.
- **Your own policy** replaces the default checks entirely. Avoid `() => true`, which turns off the protection against requests to private networks.

DNS checks do not pin the address the connection later uses: the fetching transport still owns protection against DNS rebinding, and should enforce an allowlist or validate the address it connects to.

## Authenticated client caching

Use `requestIdentityProvider` when one client serves changing principals. It runs once per public call, before discovery or cache reads, and returns one captured identity for discovery, every redirect, every Snapshot page, and the final write. Capture the principal, authorization-view key, and credential material together; the per-URL callback must close over that captured material and explicitly decide which destinations may receive it. Do not read mutable global login state again inside that callback.

~~~ts
const client = new ColpClient({
  manifestUrl,
  cache,
  requestIdentityProvider: () => {
    const { principalId, authorizationVersion, token, signal } = auth.capture();
    return {
      cachePartition: JSON.stringify([principalId, authorizationVersion]),
      signal,
      credentialProvider: url => url.origin === trustedOrigin
        ? { Authorization: 'Bearer ' + token }
        : undefined,
    };
  },
});
~~~

Abort the captured identity's signal on logout or revocation to discard in-flight results. Without that signal, a request that has already started completes as its captured principal. Omit `cachePartition` to disable that identity's HTTP cache. Cache storage must still be trusted, isolated by its full supplied key, and available for the whole request. The `currentSnapshot` state belongs to the client instance, so use a separate instance per signed-in session when keeping snapshots.

Migration: separate `credentialProvider` and functional `cachePartition` hooks cannot capture an identity atomically, so enabling a cache with that combination fails at construction. Move both into `requestIdentityProvider`, which cannot be combined with them. `credentialProvider` alone still works with caching disabled, and static-header or anonymous clients keep their existing `cachePartition` options. The identity provider counts toward the request deadline and receives its cancellation signal.

## Client request budgets and cancellation

Every public HTTP method on `ColpClient` has a finite budget: by default 30,000 ms per call and 64 MiB per response body. Set defaults with `requestLimits`, and pass options to override `timeoutMs` or `maxBytes`, or to supply an `AbortSignal`, for one call:

~~~ts
const client = new ColpClient({
  manifestUrl,
  requestLimits: { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024 },
});
await client.discover(false, { signal });
await client.getDirectory({}, { signal });
await client.getCollection(collectionId, { signal, timeoutMs: 5_000 });
await client.getSnapshot(collectionId, {}, { signal });
await client.refreshSnapshot(collectionId, {}, { signal });
// createNode and moveNode accept the same options alongside idempotencyKey and ifMatch.
~~~

The deadline starts before discovery and covers cache and credential hooks, the egress policy, redirects, and response streaming; redirects do not restart it. The byte cap applies to Manifest, success, Problem, and revalidated cache bodies, and oversized or cancelled streams are cancelled immediately. Snapshot retrieval also keeps its cumulative page, byte, and object caps, and its timeout is the smaller of the call budget and `snapshotLimits.timeoutMs`; to allow a longer Snapshot deadline, raise both. All limits must be positive safe integers. Cancellation keeps the caller's signal reason, and an exhausted budget throws `ColpClientLimitError`. One caller's cancellation does not cancel another concurrent call, and settled calls remove their timers and listeners.

JSON parsing has its own default limit of 100,000 members and array items per document, even when the response fits the byte budget. A static single-page Snapshot can legitimately exceed it: 10,000 folders take about 3 MiB but contain more than 100,000 JSON members and items. For a trusted deployment serving such Snapshots, raise the parser budget together with the transport and Snapshot budgets:

~~~ts
const largeSnapshotClient = new ColpClient({
  manifestUrl,
  jsonLimits: { maxMembers: 1_000_000 },
  requestLimits: { maxBytes: 64 * 1024 * 1024 },
  snapshotLimits: { maxObjects: 1_000_000, maxBytes: 64 * 1024 * 1024 },
});
await largeSnapshotClient.getSnapshot(collectionId);
~~~

The parser's hard ceiling is 1,000,000 members and items. Use pagination when a Snapshot cannot fit the per-page parser budget. A server's delivery plan binds its own output budget; it does not change what a receiver accepts.

Cancellation ends the client's waiting and prevents further request hops. It cannot roll back a write the server has already received, or work a custom port has already started. Treat a timed-out or aborted write as having an unknown outcome, and recover by retrying with the original idempotency key and payload. The client never retries writes on its own. Custom asynchronous ports should clean up their own work; fetch implementations receive the call's `AbortSignal`.

## Cursor keys

Snapshot and Directory cursors are HMAC-bound capabilities, so a client cannot forge or alter one. All these functions are exported from `@know-n/colp/server`:

| Purpose | Snapshot | Directory |
|---|---|---|
| Import deployment-managed random bytes | `createPublicationSnapshotCursorHmacKey(bytes)` | `createPublicationDirectoryCursorHmacKey(bytes)` |
| Sign the next page position and scope | `createPublicationSnapshotCursor(scope, key)` | `createPublicationDirectoryCursor(scope, key)` |
| Verify before using the next position | `verifyPublicationSnapshotCursor(cursor, context, key)` | `verifyPublicationDirectoryCursor(cursor, context, key)` |

Both constructors take a `Uint8Array` of 32 to 1024 bytes and copy it into a process-local handle that cannot be read back. Use independently generated secret material for the two purposes. A successful verification returns `{ valid: true, nextPosition }`; malformed cursors, wrong keys, and mismatched scope return `{ valid: false, code: 'invalid_cursor_scope' }`.

Restore the handles at worker startup from your secret store, then reuse them for their active lifetime. This startup module accepts bytes the host has already loaded; it does not generate fresh keys on every request or restart:

<!-- colp-consumer: publication-cursor-keys -->
```ts
import {
  createPublicationSnapshotCursorHmacKey,
  createPublicationDirectoryCursorHmacKey,
} from '@know-n/colp/server';

export function restorePublicationCursorKeys(
  snapshotKeyMaterial: Uint8Array,
  directoryKeyMaterial: Uint8Array,
) {
  const snapshot = createPublicationSnapshotCursorHmacKey(snapshotKeyMaterial);
  try {
    const directory = createPublicationDirectoryCursorHmacKey(directoryKeyMaterial);
    return { snapshot, directory };
  } catch (error) {
    snapshot.destroy();
    throw error;
  }
}
```

Persist each key version's protected **key material**, or a secure reference from which the host can reload the same bytes. Do not persist or serialize the handle: a reconstructed plain object is not a valid signing capability. Every cluster worker must load the same active and retained key material and create its own local handles. Call `destroy()` on each local handle at shutdown or retirement, and dispose of the host's loaded byte buffers after import. Never expose key bytes in a DTO, log, URL, or generic configuration object.

Rotation is additive: sign new cursors with a new key while keeping old keys until their cursors leave the retention window. The `psc1` and `pdc1` cursor prefixes identify the wire format, not a key version, and these helpers do not embed a key ID. The host therefore needs a bounded retained-key verification policy, or a trusted server-side association that selects the right key. Do not prepend a key ID to the protocol cursor, and never reuse a version label for different bytes. The host owns storage, rotation, retention, and any expiry checks; the HMAC helpers do not provide those policies.

## Cache and storage responsibilities

Anonymous public representations may use shared caches when their cache directives allow it. Any representation that changes with `Authorization` must be `Cache-Control: private, no-store` and include `Vary: Authorization`. Negotiation adds `Vary: Accept, Collection-Protocol-Version` without removing existing fields. Cache keys and stored responses must therefore be partitioned by the effective principal whenever authorization changes the representation, as well as by query, projection, page, and negotiated media type.

The package supplies validation and composition, not persistence. Adapters own Collection and Node storage, revision and Snapshot consistency, transactions, authorization, cursor-key persistence, and forwarding of the returned headers. An adapter must not rebuild a Snapshot from separate queries after the consistency boundary, or silently rewrite absolute `Link` targets.

Publication JSON validation applies only at explicit JSON parsing boundaries. It does not change shared fetch behavior, Streamable HTTP SSE negotiation, or the MCP read and write transports. Sync, Security, and MCP reuse the core contracts while keeping their own media, authorization, composition, and streaming rules.

## Before you publish profile claims

The package itself is verified for `core`, `publication`, `publisher`, `feed`, `sync`, `mcp-read`, and `mcp-write`. A deployment is a separate claim: it must run the package-owned probes and publish only the immutable result of `assertProfileClaims` in its Manifest. See [Host integration boundary](HOST_INTEGRATION_BOUNDARY.md) for who owns what.

For a read-only Publication deployment, use the conformance scope `{ profiles: ['core', 'publication'], capabilities: [] }`. Its plan contains the `publication.http-contracts` probe. The `publication -> core` dependency is about data and wire formats; it does not require Sync storage, authoritative writes, AI writes, local browser Profile ID storage, or a server Profile ID HMAC lifecycle.

Generated schemas, examples, TypeScript declarations, requirements, evidence, and traceability files are derived from the protocol specification by the package scripts. Change the canonical source in the repository's `protocol/` directory, then run `npm run refresh:protocol`; never edit generated files by hand.
