# 04. Authorization, Security and Rate Limits

<a id="colp-section-1"></a>

## 1. Security Boundaries

The protocol keeps identity, permissions, publication policy, and rate limits separate:

- Authentication: who the requester is.
- Authorization: what the requester may do.
- Publication: which data may be projected to the public internet.
- Rate limit: how much the requester may do within a period of time.
- Audit: who did what, and when.

"Having read permission" does not mean "may make the content public"; "having write permission" does not mean "may manage keys or ACLs".

<a id="colp-section-2"></a>

## 2. Principal

Principal types:

- `user`
- `group`
- `oauth_client`
- `api_key`
- `service`
- `ai_agent`
- `public`

`public` is an anonymous principal synthesized by the server. It is not a wildcard for "every request" or "every authenticated principal". The identity set contains the single `{ "type": "public", "id": "public" }` only when a request did not establish an identity through any credential; implementations MUST NOT add `public` to an identity set that already contains a user, group, OAuth client, API key, service, or AI agent. A `public` identity submitted by the caller must not make an authenticated request also be evaluated as an anonymous one.

An AI agent must record all of the following:

- The end-user subject.
- The OAuth client ID or API key ID.
- The MCP request context (protocol version and clientInfo).
- The agent or host name.
- Whether the user confirmed the action.

<a id="colp-section-3"></a>

## 3. Scope

Core scopes:

<a id="colp-section-3-1"></a>

### 3.1 Read

- `collections:list`
- `collections:read`
- `nodes:read`
- `annotations:read`
- `attachments:read`
- `relations:read`
- `source_refs:read`
- `feed:read`
- `audit:read`

<a id="colp-section-3-2"></a>

### 3.2 Write

- `collections:create`
- `collections:write`
- `collections:delete`
- `nodes:write`
- `nodes:delete`
- `annotations:write`
- `attachments:write`
- `relations:write`
- `release:publish`

<a id="colp-section-3-3"></a>

### 3.3 Sync

- `sync:bootstrap`
- `sync:pull`
- `sync:push`
- `sync:resolve`

<a id="colp-section-3-4"></a>

### 3.4 Administration

- `access:read`
- `access:write`
- `keys:read`
- `keys:write`
- `rate_limits:read`
- `rate_limits:write`
- `server:admin`

Tokens and keys SHOULD be further restricted by:

- A Collection ID allowlist.
- A Node subtree.
- IP or origin conditions.
- A maximum number of operations.
- A validity period.
- Whether public exposure is allowed.

Read scopes are field projections: `nodes:read` does not imply `annotations:read`, `attachments:read`, `relations:read`, or `source_refs:read`. Snapshots, search, MCP resources, and tools must check each kind of included data they return; by default only core Node fields are returned.

<a id="colp-section-4"></a>

## 4. Role

A role is a bundle of scopes, not the final basis of a protocol decision:

| Role | Default scopes |
|---|---|
| Reader | collections:read, nodes:read, feed:read |
| Editor | Reader + collections:write, nodes:write, annotations:write, attachments:write, relations:write |
| Publisher | Editor + release:publish |
| Sync Client | sync:bootstrap, sync:pull, sync:push + limited node scopes |
| Admin | access / keys / rate limits / audit |
| Owner | Every Collection-level scope |

The server must check effective scopes, not just role names.

<a id="colp-section-5"></a>

## 5. API Keys

<a id="colp-section-5-1"></a>

### 5.1 Key Format

Recommended:

```text
colp_live_<keyId>_<secret>
colp_test_<keyId>_<secret>
```

- The secret has at least 256 bits of random entropy.
- `keyId` can be public and is used for lookup and audit.
- The secret is shown only once, at creation.
- The server stores only a keyed digest, never the plaintext.
- Logs record at most the prefix and the key ID, never the secret.

<a id="colp-section-5-2"></a>

### 5.2 Usage

```http
Authorization: Bearer colp_live_...
```

An API key MUST NOT be placed in a query string, because of leaks through browser history, `Referer`, proxy logs, and screenshots.

<a id="colp-section-5-3"></a>

### 5.3 Key Types

- `read_key`: reads specified protected Collections or Feeds.
- `sync_key`: browser extension or service replica synchronization.
- `publisher_key`: writes Collections and Releases.
- `admin_key`: manages access, keys, and rate limits.
- `one_time_key`: one-time import, migration, or pairing.

Every key must contain:

```json
{
  "id": "key_01JZ...",
  "name": "Chrome on laptop",
  "type": "sync_key",
  "scopes": ["sync:pull", "sync:push", "nodes:read", "nodes:write"],
  "collections": ["collection-1"],
  "createdAt": "2026-07-16T06:00:00Z",
  "expiresAt": "2026-10-16T06:00:00Z",
  "lastUsedAt": null,
  "lastUsedIp": null,
  "status": "active"
}
```

The key list API never returns secrets.

<a id="colp-section-5-4"></a>

### 5.4 Rotation

- Rotation creates a new secret; the key ID may stay the same or a new ID may be generated.
- A short overlap window may be configured.
- The old secret is rejected as soon as it expires.
- Rotation and revocation produce high-priority audit events.

<a id="colp-section-6"></a>

## 6. OAuth 2.1

Remote MCP and third-party applications SHOULD use the OAuth 2.1 profile:

- The MCP server acts as a resource server.
- RFC 9728 protected resource metadata must be provided.
- Clients must use authorization server metadata or OIDC discovery.
- Authorization and token requests must use the RFC 8707 `resource` parameter.
- Access tokens must be bound to the target Collection Protocol resource audience.
- The `Authorization` header must be used; query tokens are forbidden.
- Public clients must use PKCE S256.
- Access tokens should be short-lived, and refresh tokens should be rotated.
- Token passthrough is forbidden on the server.
- High-risk remote management such as keys, ACLs, public exposure, and purge SHOULD use DPoP (RFC 9449) or mTLS sender-constrained access tokens, to reduce the risk of bearer token replay.

Example protected resource metadata:

```json
{
  "resource": "https://alice.example/collections/-/mcp",
  "authorization_servers": ["https://auth.alice.example"],
  "scopes_supported": [
    "collections:read",
    "nodes:read",
    "nodes:write",
    "sync:pull",
    "sync:push"
  ]
}
```

Insufficient scope:

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope",
  scope="access:write",
  resource_metadata="https://alice.example/.well-known/oauth-protected-resource/collections/-/mcp"
```

<a id="colp-section-6-1"></a>

### 6.1 OAuth Client Issuer Binding (MCP 2026-07-28)

An MCP OAuth client must compare the `iss` in the authorization response (RFC 9207) exactly with the authorization server issuer it recorded when it started the authorization; when it is missing or different, the client must abort the code exchange and must not continue with client credentials. Dynamic client registration (RFC 7591) must declare `application_type`. Client credentials must be isolated per issuer: the same client_id / client_secret must not be reused across authorization servers, and when the issuer changes the client must register again. The resource server still validates the access token on every request; issuer binding does not replace token validation.

<a id="colp-section-7"></a>

## 7. Access Policy

```json
{
  "visibility": "protected",
  "entries": [
    {
      "principal": { "type": "public", "id": "public" },
      "effect": "deny",
      "scopes": ["collections:read", "nodes:read"]
    },
    {
      "principal": { "type": "api_key", "id": "key_reader_1" },
      "effect": "allow",
      "scopes": ["collections:read", "nodes:read", "feed:read"]
    }
  ],
  "publication": {
    "listInDirectory": false,
    "allowSearchIndexing": false,
    "allowEmbedding": false
  },
  "revision": "acl_17"
}
```

Rules:

- An explicit deny takes precedence over an allow.
- Inheritance is mandatory for every policy layer: the server must evaluate the server default, the Collection, every ancestor Node, and the object policy in turn. `AccessPolicy` and `AccessPolicyPatch` provide no `inherit` boolean or any other switch to skip ancestors.
- A Node policy can only tighten the parent Collection or Node policy and cannot restore a scope that any upper layer removed.
- ACL writes must use `If-Match`.
- ACL changes must not use the general Node write scope.
- Changing `private` or `protected` to `public` is a high-risk operation.
- When tightening from public to `protected` or `private`, or deleting, the server must purge the CDNs and shared caches it controls, withdraw the publication index of the current mutable URL, and stop issuing new public responses. The protocol cannot recall data that third parties already downloaded, and the confirmation UI must state clearly that publication may be irreversible.

The effective policy is evaluated in this order:

1. Build the request identity set: an authenticated request contains the end user, groups, OAuth client, API key or service, and other verified identities, but never `public`; only when there is no authenticated identity at all is the single synthesized `public` identity used. A `public` ACL entry matches only anonymous requests and is not a principal wildcard.
2. Start from the credential or grant scopes and process the server default policy, the Collection, every ancestor Node, and the object policy in this fixed order; implementations MUST NOT skip, reorder, or short-circuit this chain.
3. At each layer, intersect the current scopes with the allow scopes that match at that layer, then remove every matching deny. `public` and `unlisted` visibility is a source of public read authorization that is independent of principal ACLs and can be used by anonymous or authenticated requests; a `public` ACL entry still matches only anonymous requests.
4. Lower layers can only keep intersecting and cannot restore a scope removed by a parent layer. An explicit deny at any layer wins.
5. The default decision is deny. Whether a resource answers `403` or hides itself as `404` is decided by the endpoint's concealment policy, but it must be consistent for the same resource type, and response differences must not leak the existence of private or unlisted resources.

<a id="colp-section-8"></a>

## 8. Rate Limit

<a id="colp-section-8-1"></a>

### 8.1 Buckets

A server SHOULD distinguish at least:

- Anonymous feed reads.
- Authenticated reads.
- Sync pulls.
- Sync pushes.
- General writes.
- MCP tool calls.
- Administration and key management.

A bucket key may include the principal, IP, Collection, and endpoint class.

Implementations MUST have subject or credential, IP, and instance-level limits at the same time; choosing only one of these dimensions is not enough. Batches, Sync pushes, and MCP tools are charged by the operation cost after expansion and the number of affected objects; splitting work into parallel small requests must not lower the total cost. SSE and subscriptions are separately limited in number of connections, number of subscribed resources, queued bytes, event rate, idle timeout, and maximum lifetime. A grant's `maxWrites` and the rate-limit counter must be decremented atomically.

<a id="colp-section-8-2"></a>

### 8.2 Response Headers

Successful and rate-limited responses SHOULD use the RFC 9651 structured fields:

```http
RateLimit: "feed:anonymous";r=83;t=27
RateLimit-Policy: "feed:anonymous";q=120;w=60
```

The legacy `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers may only be used as an explicit compatibility extension and are not part of the 0.1 core contract.

When rate limited:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 27
Content-Type: application/problem+json
```

```json
{
  "type": "https://collectionprotocol.org/problems/rate-limited",
  "title": "Too many requests",
  "status": 429,
  "code": "rate_limited",
  "retryAfterSeconds": 27,
  "bucket": "feed:anonymous"
}
```

<a id="colp-section-8-3"></a>

### 8.3 Configuration Model

```json
{
  "id": "feed:anonymous",
  "scope": {
    "endpointClass": "feed",
    "principalType": "public"
  },
  "limit": 120,
  "windowSeconds": 60,
  "burst": 20,
  "concurrency": 10,
  "minIntervalMilliseconds": 500,
  "action": "reject",
  "revision": "rl_8"
}
```

<a id="colp-section-8-4"></a>

### 8.4 Safety Floor

The remote management API must not allow management and authentication endpoints to be configured as unlimited. Implementations must provide a hard-coded or deployment-level minimum safety policy that application-level configuration cannot lower.

<a id="colp-section-9"></a>

## 9. Request Security

- Every remote endpoint MUST use HTTPS.
- Streamable HTTP MCP MUST validate the origin, to prevent DNS rebinding.
- CORS is off by default and is enabled by an explicit origin allowlist.
- The server must limit the request body, batches, number of parsed members, number of Nodes visited in graph traversal, depth, URL length, and attachment size; remote requests cannot relax the deployment's hard limits.
- The JSON parser must enforce a deterministic nesting depth and member and array-item budgets before constructing business objects, to prevent prototype pollution and excessively deep nesting; catching a runtime call stack overflow cannot replace an explicit budget.
- The I-JSON parser must reject duplicate members, protocol integers outside the safe range, non-finite numbers, and prototype pollution keys such as `__proto__`, `constructor`, and `prototype` before constructing business objects; running an ordinary `JSON.parse` first and checking for duplicate keys afterwards does not satisfy this requirement.
- URL fetching must prevent SSRF. Every redirect hop must re-resolve and re-check DNS and IP, rejecting loopback, link-local, private, ULA, CGNAT, multicast, unspecified, and cloud metadata addresses; connect to the verified IP while keeping the correct TLS SNI.
- Fetchers forbid URL userinfo and limit the number of redirects, response bytes, decompression ratio, total duration, and concurrency. `Authorization`, cookies, and Collection Protocol credentials must not be forwarded to the fetch target or across origins on redirects.
- Fetching through an isolated egress proxy is recommended; checking only the first DNS resolution does not satisfy SSRF protection.
- HTML and Markdown output must be sanitized for its target context.
- Attachment downloads should be protected against MIME sniffing and use `Content-Disposition` and size limits.
- Logs must redact `Authorization`, cookies, secrets, Sync session IDs, and private notes.
- The query and fragment of bookmark, attachment, approval, and similar URLs are treated as potential secrets. Logs and Problem Details keep only the scheme, host, and a hash of the path by default, and do not echo the full URL.

<a id="colp-section-10"></a>

## 10. Content Integrity

Public Snapshots and Feeds SHOULD provide:

```http
Content-Digest: sha-256=:...:
Signature-Input: sig1=("@method" "@target-uri" "content-digest" "content-type");keyid="ed25519-2026-01";alg="ed25519"
Signature: sig1=:...:
```

- Use RFC 9530 Content-Digest.
- Use RFC 9421 HTTP Message Signatures.
- Ed25519 is recommended.
- Public keys are declared through JWKS or the Manifest.
- Key rotation must keep old public keys long enough to verify historical Releases.
- The signature input of a mutable resource SHOULD cover `@status`, `created`, `expires`, `etag`, and the protocol version, and clients must limit the maximum staleness. Historical Releases use immutable URIs that include the release ID or revision.

A signature proves that the content came from a particular server; it does not automatically prove that the external page a bookmark points to is authentic, safe, or unchanged.

<a id="colp-section-11"></a>

## 11. Audit Log

High-value operations must be audited:

- Sign-in, authorization, and scope upgrades.
- Key creation, display, rotation, and revocation.
- ACL and publication changes.
- Rate-limit changes.
- Collection deletion, restore, and release.
- Large sync batches and conflict resolution.
- High-risk MCP tool calls.

```json
{
  "id": "audit_01JZ...",
  "time": "2026-07-16T06:30:00Z",
  "actor": {
    "principalId": "user:alice",
    "clientId": "https://ai-client.example/client.json",
    "agent": "Example AI Host"
  },
  "action": "access.visibility.changed",
  "target": "collection:interface-systems",
  "result": "success",
  "risk": "high",
  "confirmation": {
    "required": true,
    "method": "out_of_band",
    "confirmedAt": "2026-07-16T06:29:58Z"
  },
  "metadata": {
    "from": "protected",
    "to": "public"
  }
}
```

The audit log should not record private bookmark bodies, tokens, or complete keys.

<a id="colp-section-12"></a>

## 12. Default Security Policy

Recommended defaults for a new server:

- New Collection: `private`.
- New Annotation: `private`.
- New API key: valid for 90 days, limited to specific Collections, minimal scopes.
- Anonymous directory: a minimum polling interval of 60 seconds.
- MCP write tools: OAuth required.
- Public exposure, delete, keys, ACLs, rate limits: two-phase confirmation.
- Feed: `release` by default rather than `live`.
- Public Snapshot: no source references, private annotations, captured page bodies, or local attachments.
- Unknown extensions: kept in authoritative and Sync storage and excluded from public, Feed, and assistant projections by default; only namespaces that are explicitly allowlisted and have a publication schema may be published.

<a id="colp-section-13"></a>

## 13. Threat Matrix

| Threat | Main mitigations |
|---|---|
| API key leak | Header transport, shown only once, digest storage, scope / Collection / expiry limits, rotation |
| Token accepted by the wrong service | RFC 8707 resource, audience validation, no token passthrough |
| DNS rebinding against a local MCP server | Origin validation, binding local servers only to 127.0.0.1, authentication |
| SSRF fetching internal URLs | Scheme allowlist, DNS / IP checks, blocking metadata and private networks, response size limits |
| Prompt injection triggering management operations | Treating external content as data, tool scopes, change plans, out-of-band approval |
| AI reading plaintext keys | MCP results never return secrets; only a reveal URI is provided |
| A public Collection accidentally leaking private notes | Independent visibility, public projection allowlist, release preview |
| Concurrent overwrites | ETag, If-Match, base revision, conflicts |
| Old replicas resurrecting deleted nodes | Tombstones, delete dominates, explicit restore |
| Polling or tool abuse | Separate buckets, 429, Retry-After, cost units, concurrency limits |
| Secrets leaking through audit logs | Redaction, minimal metadata, access scopes, retention policy |
| Malicious extension fields | Namespaces, schema and size limits, output sanitization, unknown fields never executed |
| DoS through large trees or deep JSON | Body, depth, Node, batch, pagination, and execution time limits |
