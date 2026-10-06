# 02. HTTP Publication and Feed Protocol

<a id="colp-section-1"></a>

## 1. Goals

The HTTP layer lets any site publish Collections under an ordinary path, for example:

```text
https://alice.example/collections
```

Consumers do not need an account with the publisher, and do not need to install a particular client. Browsers, feed readers, search services, command-line tools, and AI assistants can all use the same set of resources.

<a id="colp-section-2"></a>

## 2. Discovery Manifest

`GET /.well-known/collection-protocol`

```json
{
  "protocol": "https://collectionprotocol.org/spec/0.1",
  "protocolVersions": ["0.1"],
  "serverId": "https://alice.example/",
  "serverUuid": "019b3c67-a03c-7f02-9c7e-1ee8d50a77de",
  "title": "Alice's Collections",
  "mounts": [
    {
      "id": "default",
      "baseUrl": "https://alice.example/collections/",
      "profiles": ["core", "publication", "feed", "publisher", "mcp-read", "mcp-write"],
      "endpoints": {
        "directory": "https://alice.example/collections",
        "collection": "https://alice.example/collections/c/{collectionId}",
        "snapshot": "https://alice.example/collections/c/{collectionId}/snapshot",
        "node": "https://alice.example/collections/c/{collectionId}/nodes/{nodeId}",
        "nodes": "https://alice.example/collections/c/{collectionId}/nodes",
        "nodeMove": "https://alice.example/collections/c/{collectionId}/nodes/{nodeId}/move",
        "annotations": "https://alice.example/collections/c/{collectionId}/annotations",
        "annotation": "https://alice.example/collections/c/{collectionId}/annotations/{annotationId}",
        "attachments": "https://alice.example/collections/c/{collectionId}/attachments",
        "attachment": "https://alice.example/collections/c/{collectionId}/attachments/{attachmentId}",
        "relations": "https://alice.example/collections/c/{collectionId}/relations",
        "relation": "https://alice.example/collections/c/{collectionId}/relations/{relationId}",
        "release": "https://alice.example/collections/c/{collectionId}/release",
        "releases": "https://alice.example/collections/c/{collectionId}/releases",
        "releaseItem": "https://alice.example/collections/c/{collectionId}/releases/{releaseId}",
        "releaseSnapshot": "https://alice.example/collections/c/{collectionId}/releases/{releaseId}/snapshot",
        "collectionAccess": "https://alice.example/collections/c/{collectionId}/access",
        "instanceFeed": "https://alice.example/collections/-/feed",
        "collectionFeed": "https://alice.example/collections/c/{collectionId}/feed",
        "mcp": "https://alice.example/collections/-/mcp"
      },
      "features": {
        "feed": { "modes": ["live", "release"] },
        "patch": { "mediaTypes": ["application/merge-patch+json"] },
        "bookmarkUrls": { "acceptedSchemes": ["http", "https", "file"] },
        "mcp": { "protocolVersion": "2026-07-28", "resources": true, "tools": true }
      },
      "auth": {
        "anonymousRead": true,
        "apiKeys": true,
        "oauth": true,
        "protectedResourceMetadata": "https://alice.example/.well-known/oauth-protected-resource/collections/-/mcp"
      },
      "limits": {
        "maxPageSize": 200,
        "maxSnapshotNodes": 10000,
        "minPollIntervalSeconds": 60,
        "recommendedPollIntervalSeconds": 300,
        "idempotencyRetentionSeconds": 86400
      }
    }
  ],
  "signing": {
    "httpMessageSignatures": true,
    "jwksUrl": "https://alice.example/.well-known/jwks.json"
  }
}
```

The Manifest response SHOULD use:

- `Cache-Control: public, max-age=300`
- `ETag`
- `Content-Type: application/vnd.collection-protocol.manifest+json;version=0.1`

Rules:

- `serverUuid` stays stable across server migrations and restarts.
- `baseUrl` is only for display and same-origin checks and MUST end with `/`; clients must not guess endpoints by string concatenation or relative URL resolution.
- `profiles`, `endpoints`, `features`, `auth`, and `limits` are all scoped to the mount.
- An endpoint must be an absolute HTTPS URI or an RFC 6570 Level 1 template. Development environments MAY use `http://localhost`, `http://127.0.0.1`, or `http://[::1]`; this exception must not be used for non-loopback hosts.
- The variable set of an endpoint key must exactly match the registry; for example, `node` must use exactly `collectionId` and `nodeId`. Implementations use the same RFC 6570 parser for validation and expansion.
- Clients must follow `endpoints` and the `links` in resource responses.
- The `publisher` profile must declare `nodes`, `node`, `nodeMove`, `annotations`, `annotation`, `attachments`, `attachment`, `relations`, `relation`, `release`, `releases`, `releaseItem`, and `releaseSnapshot`.
- `features.admin` is declared only when the HTTP management API is supported, together with the `adminAccess`, `adminKeys`, `adminKey`, `adminKeyRotate`, `adminRateLimits`, and `adminAudit` endpoints; when every flag would be `false`, the whole feature should be omitted.
- `features.mcp.protocolVersion` is always `2026-07-28` (see `docs/05-mcp-profile.md`).

<a id="colp-section-3"></a>

## 3. Collection Directory

`GET /collections`

Query parameters:

- `cursor`
- `limit`
- `tag`
- `creator`
- `kind`
- `updatedSince`
- `q`

Response:

```json
{
  "protocolVersion": "0.1",
  "collections": [
    {
      "id": "collection-1",
      "canonicalUrl": "https://alice.example/collections/interface-systems",
      "title": "Interface Systems",
      "summary": "A curated path into design engineering.",
      "kind": "knowledge_collection",
      "tags": ["design", "engineering"],
      "language": "en",
      "creators": [
        {
          "id": "https://alice.example/about",
          "name": "Alice",
          "url": "https://alice.example/"
        }
      ],
      "nodeCount": 48,
      "updatedAt": "2026-07-16T06:30:00Z",
      "visibility": "public",
      "links": {
        "self": "https://alice.example/collections/c/collection-1",
        "canonical": "https://alice.example/collections/interface-systems",
        "snapshot": "https://alice.example/collections/c/collection-1/snapshot",
        "feed": "https://alice.example/collections/c/collection-1/feed"
      },
      "extensions": {}
    }
  ],
  "nextCursor": null
}
```

Rules:

- Only `public` Collections are listed.
- `unlisted` must not appear in the directory, but a client that knows the canonical URL can read it.
- The anonymous directory, search, instance feed, sitemap, and MCP lists must never rediscover `unlisted` Collections. Their HTML and HTTP responses SHOULD use `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`.
- `protected` MAY appear in the directory, but only after authorization.
- The directory never returns the full ACL.
- The default order is `updatedAt DESC, id ASC`. The cursor points to the exclusive position after the last item and is bound to the principal, filters, order, limit, and protocol version.
- `nextCursor=null` means the current result set is exhausted. When a response differs from the anonymous result because of authorization, it must be `private, no-store` and cannot enter a shared cache.

<a id="colp-section-4"></a>

## 4. Collection Metadata

`GET /collections/c/{collectionId}` returns the public projection of a Collection and its links. `canonicalUrl` is the human-facing page; the API `self` link is a separate JSON resource.

The response must validate against `collectionMetadata` and contain the complete Collection and its links, with no empty-object placeholders. See `examples/collection-metadata.json` for an executable example.

The server SHOULD also send Link headers:

```http
Link: </collections/c/collection-1>; rel="self"; type="application/vnd.collection-protocol.collection+json"
Link: </collections/interface-systems>; rel="canonical"; type="text/html"
Link: </collections/c/collection-1/snapshot>; rel="https://collectionprotocol.org/rels/snapshot"; type="application/vnd.collection-protocol.snapshot+json"
Link: </collections/c/collection-1/feed>; rel="https://collectionprotocol.org/rels/feed"; type="application/vnd.collection-protocol.feed+json"
Link: </collections/c/collection-1/feed.json>; rel="alternate"; type="application/feed+json"
```

<a id="colp-section-5"></a>

## 5. Snapshot Retrieval

`GET /collections/c/{collectionId}/snapshot`

Query parameters:

- `pageCursor`: pagination for very large trees.
- `limit`: Node page size.
- `include=annotations&include=attachments&include=relations`. Arrays use repeated parameters, not comma separation.
- `depth`: optional maximum depth.
- `root`: fetch only one subtree.

Every query is first decoded according to `snapshotQuery` and then validated against the schema. Unknown parameters, repeated scalars, empty values, or invalid booleans or integers return `400 invalid_query`.

In `mode=publication`, the `url` of a Bookmark that does not use `redacted=true` MUST be an absolute HTTP(S) URL whose authority has no userinfo. The same restriction applies to authorized protected or private Publication: authorization can decide whether the target URL is returned, but cannot turn `user:password@host` into a publishable URL. Authoritative and Sync representations still keep the negotiated original URI under `$defs.bookmarkUrl`.

<a id="colp-section-5-1"></a>

### 5.1 Consistency

- All pages of a paginated Snapshot MUST belong to the same `snapshotId`, `revision`, `mode`, principal, and query scope.
- `page.sequence` starts at 1 and increases by one. Clients can only follow the `rel=next` URL provided in the response and cannot construct later cursors in parallel.
- `page.nextCursor` must be bound to the revision, principal, `root`, `depth`, `include`, and page size, and is the exclusive position of the next page.
- When there is a next page, the response SHOULD also send `Link: <...pageCursor=...>; rel="next"`. The URL must come from the server; clients must not build it by appending a cursor.
- If the revision expires during pagination, the server returns `409 snapshot_expired` and the client starts over.
- For static or small Collections, the server SHOULD return a complete single-page Snapshot.
- `syncCursor` must not be used for pagination, and a public Snapshot must not return a sync cursor.
- A logical Snapshot without `root` or `depth` cropping, and either without `include` or with an `include` that explicitly lists all of the authoritative arrays (annotations, attachments, relations), uses `complete=true`, whether or not it is paginated. Clients must still not perform a destructive replace or mirror before they have every page. A cropped response that omits any authoritative array uses `complete=false`.

<a id="colp-section-5-2"></a>

### 5.2 Caching

```http
ETag: "snapshot-public-r_1042-p1-7f2c"
Cache-Control: public, max-age=60
Content-Digest: sha-256=:...:
```

For a protected Collection, the default is:

```http
Cache-Control: private, no-store
Vary: Authorization
```

An ETag identifies the actual representation and page. Different `include`, `depth`, `root`, principal, media type, or page position must not reuse the same ETag.

A mutable Snapshot whose access policy might tighten should not use `stale-while-revalidate`. Long-lived public caching should prefer immutable Release Snapshot URLs. When a Collection goes from public to private or is deleted, the server must purge the CDNs and shared caches it controls.

<a id="colp-section-6"></a>

## 6. Feed Event Model

Feed events are compatible with CloudEvents 1.0.

A Bookmark navigation URL that appears in a Feed MUST be an absolute HTTP(S) URL whose authority has no userinfo; a target that cannot be safely projected must be omitted or represented by a redacted summary without the target URL.

```json
{
  "specversion": "1.0",
  "id": "019b3d0b-...",
  "source": "https://alice.example/collections",
  "type": "org.collectionprotocol.node.created.v1",
  "subject": "collections/c/collection-1/nodes/node-9",
  "time": "2026-07-16T06:30:00Z",
  "datacontenttype": "application/json",
  "collectionprotocolversion": "0.1",
  "data": {
    "collectionId": "collection-1",
    "node": {
      "id": "node-9",
      "kind": "bookmark",
      "title": "New resource",
      "url": "https://example.com/article"
    }
  }
}
```

Standard event types:

- `org.collectionprotocol.collection.created.v1`
- `org.collectionprotocol.collection.updated.v1`
- `org.collectionprotocol.collection.deleted.v1`
- `org.collectionprotocol.release.published.v1`
- `org.collectionprotocol.node.created.v1`
- `org.collectionprotocol.node.updated.v1`
- `org.collectionprotocol.node.moved.v1`
- `org.collectionprotocol.node.deleted.v1`
- `org.collectionprotocol.annotation.published.v1`
- `org.collectionprotocol.access.publication_changed.v1`

An access event may only say that the publication state changed; it must not carry keys, internal principals, or private rules.

The `data` of each standard event type uses an exact discriminated contract: a release must carry `releaseId`, the immutable Snapshot URL, a digest, and change counts; Node events use only the redacted `feedNode`; a delete carries only the Node ID and a necessary summary. Core events do not allow arbitrary extra fields. The `type` of an extension event must be an HTTPS URI, and its data can only go into namespaced `extensions`.

<a id="colp-section-7"></a>

## 7. Feed Response

`GET /collections/c/{collectionId}/feed?cursor=...&limit=50`

When the first request omits the cursor, the default response is "the newest page within the retention window", with events still in ascending commit order. A client may explicitly use `from=now` to get only the current checkpoint, or, where the server allows it, `from=beginning` to start from the oldest retained event; `from` and `cursor` must not appear together.

```json
{
  "protocolVersion": "0.1",
  "feedUrl": "https://alice.example/collections/c/collection-1/feed",
  "collectionUrl": "https://alice.example/collections/interface-systems",
  "title": "Interface Systems updates",
  "events": [],
  "nextCursor": "feed_01JZ...",
  "hasMore": false,
  "poll": {
    "notBefore": "2026-07-16T06:35:00Z",
    "recommendedAfterSeconds": 300
  },
  "hubs": []
}
```

<a id="colp-section-7-1"></a>

### 7.1 Cursor

- Feed cursors and sync cursors are not in the same namespace.
- A Feed cursor is an opaque string.
- A request cursor means "start after this checkpoint"; the boundary is exclusive. Response events are in ascending server commit order.
- `nextCursor` is the new checkpoint after this response has been processed; it may advance even when `events` is empty. When `hasMore=true` the client should continue pulling immediately; otherwise it waits according to the poll hint.
- A cursor must be bound to the principal, feed, filters, and protocol version, and reuse across contexts must be rejected.
- A client should save `nextCursor` only after every event has been persisted.
- Feed delivery is at-least-once. Event IDs are stable within the server and never reused, and clients must deduplicate idempotently by event ID.
- A server may compact old Feed history. When a cursor has expired it returns `410 feed_cursor_expired` with the latest Snapshot URL.

<a id="colp-section-7-2"></a>

### 7.2 Feed Mode

`live` mode:

- Public Node create, update, move, and delete events are allowed.
- The server may merge consecutive updates within a short time window.

`release` mode:

- Internal edits do not produce public events.
- `POST /release` produces `release.published`.
- The event data contains the release summary, change counts, Snapshot URL, and release revision.
- The release Snapshot URL MUST point to an immutable resource, such as `/c/{collectionId}/releases/{releaseId}/snapshot`, and provide a digest. It must not point only to the `/snapshot` that changes with the latest state.

For individual curators, `release` is the recommended default mode, because it keeps followers from being flooded with small operations such as drags and title edits.

<a id="colp-section-8"></a>

## 8. JSON Feed 1.1 Representation

Implementations MAY provide:

```text
/collections/-/feed.json
/collections/c/{id}/feed.json
```

Content-Type: `application/feed+json`

Mapping:

| Collection Protocol | JSON Feed 1.1 |
|---|---|
| Feed URL | `feed_url` |
| Collection canonical URL | `home_page_url` |
| Creator | `authors` |
| Event ID | `items[].id` |
| Event time | `date_published` |
| Event subject URL | `url` |
| Bookmark URL | `external_url` |
| Event summary | `content_text` / `summary` |
| Collection tags | `tags` |
| Attachment | `attachments` |

Core feed events contain no attachment payload. The JSON Feed representation layer generates `items[].attachments` from attachment projection metadata that the publisher provides explicitly and associates by event ID; it does not infer attachments from unknown event fields and does not extend the current event schema for this purpose. Each projected entry contains the absolute HTTP(S) `url` and the `mime_type` that JSON Feed 1.1 requires. An unknown event ID or invalid metadata fails that mapping, and the output keeps no caller-mutable references.

Protocol-specific data goes into the `_collection_protocol` extension.

JSON Feed is a distribution compatibility layer and must not be used for two-way synchronization.

<a id="colp-section-9"></a>

## 9. Atom Representation

Implementations MAY provide Atom 1.0. Atom entry IDs must be stable; external bookmark URLs use `rel=related`, and event or Collection pages use `rel=alternate`.

<a id="colp-section-10"></a>

## 10. WebSub

Implementations MAY declare WebSub hubs in a Feed:

```json
{
  "hubs": [
    {
      "type": "WebSub",
      "url": "https://hub.example/"
    }
  ]
}
```

A WebSub notification only means "the feed has changed". After a notification, a subscriber should still pull the feed with a conditional GET and should not treat the notification body as authoritative data.

<a id="colp-section-11"></a>

## 11. Polling and Caching Behavior

Clients MUST:

- Respect `minPollIntervalSeconds` from the Manifest.
- Prefer ETags and `If-None-Match`.
- Use `Retry-After` when they receive `429`.
- Use exponential backoff with random jitter for `5xx`.
- Not bypass background polling limits just because the user opened a page.

Clients SHOULD combine multiple local subscriptions into a single instance-level request, to avoid N+1 polling.

Recommended backoff:

```text
delay = min(serverMax, base * 2^attempt) + random(0, jitter)
```

After a successful response, reset the backoff using the interval recommended by the server.

<a id="colp-section-12"></a>

## 12. Static Hosting Mode

A read-only publisher can deploy the following files as static JSON:

```text
/.well-known/collection-protocol
/collections/index.json
/collections/items/{id}/index.json
/collections/items/{id}/snapshot.json
/collections/items/{id}/feed.json
```

Static mode:

- MUST declare `profiles=["core", "publication"]`, and additionally `feed` when a feed is provided.
- MUST declare the real absolute file URLs or templates listed above in the Manifest `endpoints`; clients do not infer paths.
- Provides no writes, Sync, or remote MCP tools.
- May provide a read-only MCP server as a separate process that reads these files.
- Uses CDN ETags, `Cache-Control`, and optional HTTP signatures.

<a id="colp-section-13"></a>

## 13. Deletion and Removal

- When a Collection is deleted, the Feed publishes `collection.deleted`.
- The server SHOULD return `410 Gone` at the original canonical URL and keep doing so for at least 30 days.
- The `410` response SHOULD point to an archive, a new location, or the owner's page.
- A Node deletion event only exposes the Node ID and a necessary summary, not a private reason for deletion.

<a id="colp-section-14"></a>

## 14. Migration

When a Collection moves to a new server:

- The old address returns `308 Permanent Redirect`, or `410` with `movedTo`.
- The Manifest or the Collection metadata provides the new canonical URL.
- The new server keeps the Collection ID or provides `formerIds`.
- The Feed publishes a `collection.moved` extension event.
- Consumers must guard against infinite redirects and cross-origin credential leaks; the `Authorization` header must not be forwarded automatically to an untrusted new origin.
