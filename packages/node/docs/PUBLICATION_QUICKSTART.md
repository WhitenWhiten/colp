# Publication Quickstart

## Status

This package exposes the framework-neutral contracts for the COLP Publication
profile. It does not install an HTTP framework or choose a database. The
package-verified `supportedProfiles` are `core`, `publication`, `publisher`,
`feed`, `sync`, `mcp-read`, and `mcp-write`. A deployment must still run the
package-owned probes and publish only the immutable result of
`assertProfileClaims` in a Manifest. See [`HOST_INTEGRATION_BOUNDARY.md`](HOST_INTEGRATION_BOUNDARY.md) for
the package/host ownership matrix.

For a read-only Publication deployment, use the conformance scope
`{ profiles: ['core', 'publication'], capabilities: [] }`. Its plan contains
`publication.http-contracts`; the `publication -> core` data/wire dependency
does not require Sync storage, authoritative writes, AI writes, local browser
Profile ID storage, or server Profile ID HMAC lifecycle.

## Read path

The normal read path is driven by the Manifest. A server publishes a Manifest
with explicit `mounts` and endpoint declarations. A client follows those
absolute endpoint URLs, response `Link` targets, and server redirects; it
must not derive paths by concatenating `baseUrl`.

The Publication resources are intentionally separate:

1. Manifest discovery advertises mounts, profiles, media types, and endpoint
   declarations.
2. Directory lists visible Collections.
3. Collection Metadata describes one Collection and links to its resources.
4. Snapshot returns a point-in-time projection of Nodes. A large Snapshot may
   be delivered as pages; the server supplies the next Link and the client
   follows it without constructing a cursor URL.
5. Node records are the members of a Snapshot and are validated as the
   declared wire projection.

Use the public `client` entry point for `ColpClient` and the `server` entry
point for the response, query, projection, cursor, cache, and HTTP-read
boundaries. The composed `composePublicationHttpRead` API returns a
`Promise<Response>` (the standard Fetch Response). Lower-level helpers
return DTOs, descriptors, or `Headers` according to their individual signatures.
Fetch-compatible handlers can return the composed Response directly. Other
framework adapters must forward its status, headers, and exact body bytes,
preserving an absent body for HEAD and 304; do not JSON-serialize the Response
object or reserialize its body after the ETag has been computed.

## Authenticated client caching

Use `requestIdentityProvider` when one client can serve changing principals.
It runs once per public invocation, before discovery or cache reads, and returns
one captured identity for discovery, every redirect, every Snapshot page, and
the final write. Capture the principal, authorization-view key, and credential
material together; the per-URL callback must close over that captured material
and explicitly decide which destinations may receive it. Do not read mutable
global login state again inside that callback.

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

Abort the captured identity's signal on logout or revocation to discard in-flight
results. Without that signal, an already started request completes consistently
as its captured principal. Omit `cachePartition` to disable that identity's HTTP
cache. Cache storage must still be trusted, isolated by its full supplied key,
and available across the request lifetime. The explicit `currentSnapshot` state
belongs to the client instance: use separate instances per signed-in session
when retaining snapshots.

Migration: separate `credentialProvider` and functional `cachePartition` hooks
cannot capture an identity atomically; enabling a cache with that combination
now fails at construction. Move both into `requestIdentityProvider`, which is
mutually exclusive with those legacy options. Legacy `credentialProvider` alone
continues to work with caching disabled. Static-header/anonymous clients retain
their existing `cachePartition` options. The identity provider is included in
the request deadline and receives its cancellation signal.

## Client request budgets and cancellation

Every public HTTP method on ColpClient has a finite request budget. Defaults are
30,000 ms per method invocation and 64 MiB per response body. Configure defaults
with ColpClientOptions.requestLimits; pass ClientRequestOptions to override
timeoutMs or maxBytes and supply an AbortSignal for one call:

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
// createNode / moveNode accept these same options alongside idempotencyKey / ifMatch.
~~~

The deadline starts before discovery and covers cache and credential hooks,
egress policy, redirects, and response streaming. Redirects do not restart it.
The byte cap applies to Manifest, success, Problem, and revalidated cache bodies;
oversized or cancelled streams are cancelled immediately. Snapshot retrieval
also retains its cumulative page, byte, and object caps; its timeout is the
smaller of the call budget and snapshotLimits.timeoutMs. To allow a longer
Snapshot deadline, increase both limits. These limits must be positive safe
integers. Cancellation preserves the caller's signal reason; budget exhaustion
throws ColpClientLimitError. One caller's cancellation does not cancel another
concurrent call, and settled calls remove their timers and caller listeners.

JSON parsing has an independent default limit of 100,000 members and array
items per document, even when the response fits the byte budget. A static
single-page plan can legitimately exceed this count: for example, 10,000
folders occupy about 3 MiB but contain more than 100,000 JSON members/items.
For a trusted deployment serving such snapshots, select an explicit bounded
parser budget alongside the transport and cumulative Snapshot budgets:

~~~ts
const largeSnapshotClient = new ColpClient({
  manifestUrl,
  jsonLimits: { maxMembers: 1_000_000 },
  requestLimits: { maxBytes: 64 * 1024 * 1024 },
  snapshotLimits: { maxObjects: 1_000_000, maxBytes: 64 * 1024 * 1024 },
});
await largeSnapshotClient.getSnapshot(collectionId);
~~~

The parser hard ceiling is 1,000,000 members/items. Choose pagination when a
logical Snapshot cannot fit the selected per-page parser budget. A server
delivery plan binds its producer output budget; it does not change receiver
limits or grant permission to exceed them.

Cancellation ends client waiting and prevents subsequent request hops. It cannot
roll back an HTTP write already received by the server or a custom port's work
already started. Treat a timed out or aborted write as having an unknown outcome;
recover with the original idempotency key and payload. The client does not retry
writes automatically. Custom asynchronous ports should clean up their own work;
fetch implementations receive the operation's AbortSignal.

## Minimal composition

At the application boundary, compose a read in this order:

```text
decode query -> authenticate -> choose projection -> serialize JSON
-> compute representation ETag -> apply cache/Vary policy
-> evaluate If-None-Match -> return 200/304 or a Problem response
```

`composePublicationHttpRead` from `@collection-protocol/node/server` keeps
this order explicit and distinguishes
anonymous public output from authorization-dependent output. Do not compute
an ETag over an authoritative object before public projection, and do not let
an adapter bypass the final response validation. HEAD uses the same validated
headers as GET and omits only the body. Problem responses use the declared
Problem representation media type.

This complete module compiles against the installed package. The host supplies
`loadDirectory`: it receives the decoded query and returns an anonymous-public
representation containing `value` (a valid CollectionDirectory), `revision`,
`projectionKey`, `protocolVersion`, and `lastModified`. Optional `headers`
carry declared Link targets; `cacheControl` declares the public cache policy.
For personalized data, instead compose `access: 'authorized-private'` with
`authorize` and a representation whose `principalScope` partitions the ETag.

<!-- colp-consumer: publication-read -->
```ts
import { createValidatorRegistry } from '@collection-protocol/node/schema';
import {
  composePublicationHttpRead,
  type AnonymousPublicationHttpReadInput,
} from '@collection-protocol/node/server';

const validators = createValidatorRegistry();

export async function readPublicDirectory(
  request: Request,
  loadDirectory: AnonymousPublicationHttpReadInput['resolveRepresentation'],
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  return composePublicationHttpRead({
    endpoint: 'directory', access: 'anonymous-public', method: request.method,
    rawSearch: new URL(request.url).search,
    ifNoneMatch: request.headers.get('if-none-match'),
    validators, resolveRepresentation: loadDirectory,
  });
}
```

In a repository checkout, the black-box examples in
`tests/integration/publication-http-blackbox.test.ts`
run a loopback `node:http` server and a real `fetch`/`ColpClient` pair. They
are an adapter reference: framework adapters should preserve the same status,
header, Link, ETag, 304, HEAD, and Problem behavior.

`ColpClient` follows declared endpoints, `Link` targets, and HTTP redirects.
When `egressPolicy` is omitted, it refuses private, loopback, or link-local
literal targets, except for directly requested URLs on the caller-selected
local Manifest origin. The default Node fetch path also checks every DNS answer
before each request and redirect, rejecting failed/empty resolutions and any
private or local address. Custom fetch implementations can supply `resolveHost`
for the same preflight check. Pass `egressPolicy` to allowlist destinations or
permit local targets; an explicit policy replaces the default checks.
DNS preflight does not pin the subsequent connection's address: the fetching
transport still owns protection against DNS rebinding and should enforce an
allowlist or validate the address used to connect.

## Cursor keys

Snapshot and Directory cursors are HMAC-bound capabilities. All these functions
are public exports of `@collection-protocol/node/server`:

| Purpose | Snapshot | Directory |
|---|---|---|
| Import deployment-managed random bytes | `createPublicationSnapshotCursorHmacKey(bytes)` | `createPublicationDirectoryCursorHmacKey(bytes)` |
| Sign the next page position and scope | `createPublicationSnapshotCursor(scope, key)` | `createPublicationDirectoryCursor(scope, key)` |
| Verify before using the next position | `verifyPublicationSnapshotCursor(cursor, context, key)` | `verifyPublicationDirectoryCursor(cursor, context, key)` |

Both constructors take a `Uint8Array` of 32–1024 bytes and copy it into a
process-local, non-readable handle. Use independently generated secret material
for the two key purposes. A successful verification returns
`{ valid: true, nextPosition }`; malformed cursors, wrong keys, and mismatched
scope return `{ valid: false, code: 'invalid_cursor_scope' }`.

Restore handles at worker startup from the secret store, then reuse them for
their active lifetime. This startup module accepts bytes already loaded by the
host; it does not generate fresh keys on every request or restart:

<!-- colp-consumer: publication-cursor-keys -->
```ts
import {
  createPublicationSnapshotCursorHmacKey,
  createPublicationDirectoryCursorHmacKey,
} from '@collection-protocol/node/server';

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

Persist each key version's protected **key material**, or a secure reference
from which the host can reload the same bytes. Do not persist/serialize the
handle: a reconstructed plain object is not a valid signing capability.
Every cluster worker must load the same active and retained key material and
create its own local handles. Call `destroy()` on each local handle at shutdown
or retirement; dispose of the host's loaded byte buffers after import. Never
expose key bytes in a DTO, log, URL, or generic configuration object.

Rotation is additive: sign new cursors with a new key while retaining old keys
until their cursors leave the retention window. The `psc1` / `pdc1` cursor
prefixes identify the wire format, not a key version; these helpers do not embed
a key ID. The host therefore needs a bounded retained-key verification policy
or a trusted server-side association that selects the correct key. Do not
prepend a key ID to the protocol cursor. Never reuse a version label for
different bytes. The host owns storage, rotation, retention, and any expiry
checks; the HMAC helpers themselves do not provide those policies.

## Cache and storage responsibilities

Anonymous public representations may use shared caching when their cache
directives permit it. Any representation that changes with Authorization
must be `Cache-Control: private, no-store` and include `Vary: Authorization`.
Negotiation adds `Vary: Accept, Collection-Protocol-Version` without removing
existing fields. Cache keys and persisted responses must therefore be
partitioned by the effective principal whenever authorization changes the
representation, as well as by query, projection, page, and negotiated media
type.

The package supplies validation and composition boundaries, not persistence.
Adapters own Collection/Node storage, revision and snapshot consistency,
transactionality, authorization, cursor-key persistence, and forwarding of
returned headers. An adapter must not reconstruct a Snapshot from separate
queries after the consistency boundary or silently rewrite absolute Link
targets.

## MCP and other profiles

Publication JSON response validation is scoped to explicit JSON parsing
boundaries. It does not change the shared fetch behavior, Streamable HTTP
SSE negotiation, or MCP read/write transports. Sync, Security, and MCP
capabilities reuse core contracts while retaining their own media,
authorization, composition, and streaming rules.

Generated Schema, examples, TypeScript declarations, requirements, evidence,
and traceability files are derived from `The Collection Protocol` and the
package scripts. Update the canonical source, then run `npm run refresh:protocol`;
do not edit generated files manually.
