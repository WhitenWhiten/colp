# MCP on Know-N

Know-N exposes a Model Context Protocol server for agents. This page is documentation. It is not the protocol endpoint, and it is not a place to paste an API key.

## Choose an endpoint

Know-N has two POST MCP paths. Pick by protocol. The host does not fall back from one path to the other.

- Strict COLP Profile: `POST https://know-n.com/collections/-/mcp` accepts MCP `2026-07-28` Profile only.
- Host compatibility: `POST https://know-n.com/collections/-/mcp-compat` is not a COLP Profile endpoint; supported versions only `2025-11-25`.

`GET /mcp`, `/developer`, and Settings do not host either server. There is no API-key connector in the library UI.

## Compatibility measurements (2026-08-28)

These rows record a real-binary handshake on 2026-08-28. They are not a support claim. OAuth, private read, write, and approval were not completed, so the compatibility surface is beta/unverified.

| client | tested client version | tested date | transport | requested/negotiated protocol | auth registration | anonymous/read/write/approval result | known limitations |
|---|---|---|---|---|---|---|---|
| Codex CLI | 0.150.1 | 2026-08-28 | Streamable HTTP | requested `2025-06-18` → negotiated `2025-11-25` | Not tested | anonymous tools/list pass; resources/list, private read, write, approval: Not tested | Handshake only. Full T-09 checklist not passed. Not a support claim. Requesting `2025-06-18` then negotiating `2025-11-25` is not operational `2025-06-18` support. Fixed `2025-06-18`-only clients are unsupported. |
| Claude Code | 2.1.250 | 2026-08-28 | Streamable HTTP | requested, negotiated, and operational `2025-11-25` | Not tested | anonymous tools/list pass; resources/list, private read, write, approval: Not tested | Handshake only. Full T-09 checklist not passed. Not a support claim. After initialize the client GET received `405` `text/plain` `Method not allowed.` and then continued to tools/list. |

Codex CLI 0.150.1 requested `2025-06-18` and negotiated `2025-11-25`. That is not operational `2025-06-18` support. Fixed `2025-06-18`-only clients are unsupported. Claude Code 2.1.250 requested, negotiated, and operational `2025-11-25`.

## Claude Code user-scope configuration

Claude Code **2.1.250** must use the compatibility URL. Do not connect that binary to strict `/collections/-/mcp`. Store this as **user-scope** config (`claude mcp add --scope user`), not a project `.mcp.json` that asks for approval on every launch. These shapes ran against the pinned binaries for handshake plus anonymous `tools/list`. They are not a full support claim. Use the production origin. Do not enable Codex `mcp_2026_07_28`.

```toml
[mcp_servers.known_compat]
url = "https://know-n.com/collections/-/mcp-compat"
enabled = true
```

```json
{
  "mcpServers": {
    "known-compat": {
      "type": "http",
      "url": "https://know-n.com/collections/-/mcp-compat"
    }
  }
}
```

## Compatibility capabilities vs strict

Compared with strict, compatibility does not advertise the resources/subscribe method, listChanged notifications, server-to-client requests, or prompts. Compat `tools/list` omits `x-mcp-header` (that 2026-07-28 extension is only on strict); body `collectionId` still works. High-risk visibility or delete still uses out-of-band `approvalUri`. Saving a library or bookmark does not.

Compat clients call JSON-RPC `tools/call` with `params.name` such as `collections.get`. A method named `collections/get` is not found. Do not send MCP `2026-07-28` headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) or `_meta` envelopes on the compatibility URL.

Automated HTTP clients should set a browser-like `User-Agent` (for example `Claude-Code/2.1.250`). Cloudflare Bot Fight can return HTTP 403 Error 1010 for default Python urllib. That is an edge filter, not an MCP protocol error.

Create a library: collections.create (title). Save folders/bookmarks with nodes.create (collectionId, node.kind/title; bookmarks need node.url). Do not call changes.plan to save links. Parent defaults to root. dryRun:true or confirmApply:false previews without writing; omit both to apply. changes.plan dryRun:true stores a pending plan; open approvalUri then changes.commit. Collection public uses collections.get revision, not a node fence. Do not send elicitation, sampling, requestState, or inputResponses.

Patch an existing folder or bookmark with `nodes.update` (`collectionId`, `nodeId`, `baseRevision` from `nodes.get`, and a patch of title, url, description, or tags). Node visibility changes always go through `changes.plan`, human approval, and `changes.commit`. Rename a library with `collections.update` (title or summary only; needs `baseRevision`). Notes are annotations on a node via `annotations.create` or `annotations.update`, not bookmark `note`/`tldr` fields. Create takes `collectionId`, `nodeId`, and `value`; type is note|tldr|summary (default note); visibility private|protected (default private); a public profile handle is required. Update takes `collectionId`, `annotationId`, `baseRevision`, and a patch of value, format, or visibility.

The compatibility endpoint is stateless and does not issue a session id.

OAuth `resource` / token `aud` is the URL the client is calling. Compat PRM advertises `https://know-n.com/collections/-/mcp-compat`; the authorization server also accepts the strict resource `https://know-n.com/collections/-/mcp`. Both verifiers accept either audience. Request `mcp:read:own mcp:read:public nodes:write offline_access` in one consent. Do not treat HTTP 401, 403, or 5xx as a reason to switch endpoints.

Handshake measured 2026-08-28. The full client write checklist did not pass, so this remains beta/unverified. Compatibility pins are reviewed when those client versions change; this page will not claim Claude Code write support until that checklist passes.

## What anonymous agents can do right now

Anonymous MCP is not empty. Without an account or token, `resources/list` returns every published collection as an MCP resource, and `resources/read` returns collection metadata, snapshots, and nodes. Anonymous `tools/list` returns the three public read tools `collections.get`, `collections.get_snapshot`, and `nodes.get`; they succeed on published public collections and conceal private targets the same way an unauthorized authenticated call does. `nodes.get` takes `collectionId` and `nodeId` and includes `revision`. Write tools still require the OAuth consent below. Start with the anonymous examples — they work immediately.

## Owned libraries vs published libraries

`mcp:read:own` reads libraries you own, including unpublished private drafts. `collections.get`, `collections.get_snapshot`, and `nodes.get` return those drafts for the owner or a member. `collections.list` lists only libraries you own and includes `revision` (the collection resource fence). `collections.create` returns the same fences.

Anonymous callers and tokens with only `mcp:read:public` still see published public libraries only. `resources/list` and Collection Protocol REST are the published directory; they will not show unpublished drafts. Outsiders who guess a private id still get `"Tool result unavailable."`

### Which revision to send

- Collection metadata update and collection `set_visibility` (`public`, `unlisted`, or collection `private`): `revision` from `collections.get`, `collections.list`, or `collections.create`.
- Node update and node `set_visibility` (`protected` or `private`): `revision` from `nodes.get` or `nodes.create`.
- Do not send a Publication composite revision as `baseRevision` for `set_visibility`.
- Stale-revision errors do not include the current token. Call get or list again. That is intentional so outsiders cannot learn a fence.

### Publishing a library

There is no one-shot public switch on `collections.update` (title or summary only). To publish, request extra OAuth scopes `access:write` and `changes:commit` (not in the default consent), then `changes.plan` with `type: set_visibility`, `collectionId`, `baseRevision` equal to the collection resource `revision`, and `input.visibility` `public` or `unlisted`. `dryRun` must be `true` and creates a real pending plan, not a preview. A person opens `approvalUri` (`/approvals`) and then `changes.commit` with the same `planId`. Default consent stays `mcp:read:own mcp:read:public nodes:write offline_access`.

## Wire requirements (MCP 2026-07-28)

These requirements come from the MCP `2026-07-28` revision itself, not from Know-N. They apply to the strict COLP Profile endpoint. Every request must carry:

- Header `MCP-Protocol-Version: 2026-07-28`.
- Header `Mcp-Method`, equal to the JSON-RPC `method` in the body.
- Header `Mcp-Name` when the method addresses a named target: `tools/call` mirrors `params.name`, `resources/read` mirrors `params.uri`, `prompts/get` mirrors `params.name`. List methods do not need it.
- Header `Accept` listing both `application/json` and `text/event-stream`.
- A `params._meta` envelope in the body with `io.modelcontextprotocol/protocolVersion` set to `"2026-07-28"` and `io.modelcontextprotocol/clientCapabilities` as an object (may be empty). `io.modelcontextprotocol/clientInfo` is recommended.

On the strict endpoint there is no protocol session: the server rejects `initialize`, `Mcp-Session-Id`, and `Last-Event-ID`. Every request is self-contained.

### Example: anonymous resources/list

```
curl -sS -X POST https://know-n.com/collections/-/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: resources/list' \
  --data '{"jsonrpc":"2.0","id":1,"method":"resources/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"my-agent","version":"1.0.0"}}}}'
```

### Example: anonymous resources/read

Take a resource `uri` from the list result (they look like `colp://<server-uuid>/collections/...`). The same value must be mirrored in the `Mcp-Name` header:

```
curl -sS -X POST https://know-n.com/collections/-/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: resources/read' \
  -H 'Mcp-Name: <uri-from-resources-list>' \
  --data '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"<uri-from-resources-list>","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

### Example: authenticated tools/call

After the OAuth flow below, authenticated read tools are `collections.get`, `collections.get_snapshot`, and `nodes.get`. Owners with `mcp:read:own` can read unpublished libraries; `collections.get` and `collections.list` `revision` is the collection resource fence. `nodes.get` takes `collectionId` plus `nodeId` and includes the node resource `revision`:

```
curl -sS -X POST https://know-n.com/collections/-/mcp \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: collections.get' \
  -H 'Mcp-Param-X-Collection-Id: <collection-id>' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"collections.get","arguments":{"collectionId":"<collection-id>"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

### Example: authenticated changes.plan

Authenticated write tools include `collections.create`, `collections.update`, `nodes.create`, `nodes.update`, `annotations.create`, `annotations.update`, `changes.plan`, `changes.commit`, and `changes.cancel`. `collections.list` is an authenticated read of libraries you own (`mcp:read:own`). `changes.get` inspects your own plan (`nodes:write`; same concealment as GET `/api/v1/mcp/approvals/:planId`). Scopes are per tool: `nodes.create` needs `nodes:write`; `collections.create`, `collections.update`, `nodes.update`, `annotations.create`, and `annotations.update` use the same `nodes:write` scope; `changes.plan` needs `nodes:write` and `access:write`; `changes.commit` needs those plus `changes:commit`; `changes.cancel` needs `changes:cancel`. `nodes.create` applies immediately when both `dryRun` and `confirmApply` are omitted; either `dryRun: true` or `confirmApply: false` is a no-write preview. Omit `dryRun` to apply now on the other low-risk write tools. High-risk visibility or delete still uses `changes.plan`; `dryRun: true` on that tool stores a pending plan a person must approve at `/approvals` before `changes.commit` writes. Do not one-shot public visibility, move, or delete. `GET /api/v1/mcp/approvals` returning 401 means the route is mounted and requires authentication, not that write is unavailable.

```
curl -sS -X POST https://know-n.com/collections/-/mcp \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: changes.plan' \
  -H 'Mcp-Param-X-Collection-Id: <collection-id>' \
  --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"changes.plan","arguments":{"operations":[{"type":"set_visibility","collectionId":"<collection-id>","baseRevision":"<collection-revision-from-collections.get>","input":{"visibility":"public"}}],"reason":"Publish this library","dryRun":true},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## OAuth

Know-N issues OAuth 2.1 authorization-code tokens with PKCE (S256). There are two ways to get a `client_id`:

1. **Dynamic client registration (RFC 7591) — use this if you do not already host CIMD.** `POST https://know-n.com/api/v1/auth/oauth2/register` with JSON such as:

```
{
  "client_name": "My CLI agent",
  "redirect_uris": ["http://127.0.0.1:8943/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "application_type": "native"
}
```

The response includes a `client_id`. Use that opaque string on authorize and token. No public HTTPS document is required. `GET /oauth2/register` is not supported (405).

2. **Client ID Metadata Documents (CIMD)** — use this when your client already publishes a metadata URL (for example Claude Code's `https://claude.ai/oauth/claude-code-client-metadata`). The `client_id` you send is that HTTPS URL, and Know-N fetches it server-side. Authorization-server metadata still sets `client_id_metadata_document_supported: true`.

Requirements for a CIMD document and its URL:

- HTTPS only, with an explicit path (`https://example.com/oauth-client.json`, not a bare origin).
- No URL fragment, no userinfo credentials, no `..` path segments; the host must be a public address (loopback and private ranges are refused).
- The response must be JSON, 5 KB or smaller, served without redirects. The `Content-Type` response header must be `application/json` (or `*+json`); GitHub raw and Gist raw return `text/plain` and are rejected.
- The JSON must contain `client_id` byte-for-byte equal to the document URL, plus a non-empty `client_name` and `redirect_uris`.

Example document — host this file, then use its URL as your `client_id`:

```
{
  "client_id": "https://example.com/oauth-client.json",
  "client_name": "My CLI agent",
  "redirect_uris": ["http://127.0.0.1:8943/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "mcp:read:own mcp:read:public nodes:write offline_access"
}
```

Any static HTTPS host works: GitHub Pages, your own site, or an object-store bucket. Loopback callbacks may omit the port (`http://localhost/callback` or `http://127.0.0.1/callback`). Know-N ignores the port when matching those hosts, so native clients such as Claude Code can bind a new ephemeral port each session. The DCR example above uses a fixed `127.0.0.1` port because that client registers the URI it will actually use.

Do not invent an opaque `client_id`. Either register one at `/oauth2/register` or send a CIMD URL you actually host.

## How to connect

1. Read machine-readable MCP discovery at `GET /.well-known/mcp`. It names the Streamable HTTP endpoint, protocol version, documentation URL, OAuth protected-resource metadata, and what anonymous clients can do. When compatibility is on, that document includes `endpoints.*.chooseWhen` and `suggestedScopes`. `server/discover` identifies this host as `Known MCP` (read and write). `GET /.well-known/collection-protocol` claims `mcp-read` and `mcp-write` on the MCP mount.
2. For Claude Code 2.1.250, treat `https://know-n.com/collections/-/mcp-compat` as the MCP resource URL and send that same URL as RFC 8707 `resource`. The authorization server also accepts the strict resource `https://know-n.com/collections/-/mcp`. 2026-07-28 clients use the strict URL.
3. Read OAuth protected-resource metadata at `GET /.well-known/oauth-protected-resource` or the path-inserted alias for the URL you are calling (`…/collections/-/mcp` or `…/collections/-/mcp-compat`).
4. Read authorization-server metadata at `GET /.well-known/oauth-authorization-server/api/v1/auth`. The issuer is `https://know-n.com/api/v1/auth`. That document advertises `client_id_metadata_document_supported` and `registration_endpoint`. It may still advertise extra token-endpoint auth methods (confidential-client methods, DPoP, backchannel logout). The grant and auth subset this host actually supports is `authorization_code` plus `refresh_token`, with token-endpoint authentication `none`. Do not select `client_credentials`, device authorization, or `private_key_jwt`.
5. Obtain a `client_id`: `POST /api/v1/auth/oauth2/register` (DCR), or send a CIMD URL you host. Do not send an unregistered opaque string.
6. Start the authorization code flow with PKCE (S256 only). The `resource` parameter must be the MCP URL you are calling and must be repeated at the token step. Request `mcp:read:own mcp:read:public nodes:write offline_access` in one consent. `offline_access` is required to receive a `refresh_token`; without it the access token lasts one hour and then the client must authorize again. High-risk plan tools still need `access:write`, `changes:commit`, and `changes:cancel` if you use them.
7. A person signs in at `/login` and approves the client at `/consent`. That consent is the identity grant. Do not invent a Settings API key or a cookie login from a foreign origin.
8. Exchange the code at the token endpoint from the authorization-server metadata, with the same `resource` parameter. The access token `expires_in` is 3600 seconds. If the authorize step included `offline_access`, the token response also includes `refresh_token`. Refresh with `grant_type=refresh_token` and the same `resource`. Call MCP with the Bearer access token and the wire requirements above.

On the strict endpoint the server rejects `initialize`. Ready probe: `GET /ready/features/mcp`.

## Authenticated write

Write tools are enabled. A consented client can call `collections.create`, `collections.update`, `nodes.create`, `nodes.update`, `annotations.create`, and `annotations.update` with `nodes:write` (libraries created this way stay private; omit `dryRun` to apply now, and do not send `confirmApply:false` on `nodes.create` unless you want a preview). `collections.list` needs `mcp:read:own`. `changes.get` needs `nodes:write` and returns only your own plan. High-risk visibility or delete still uses `changes.plan` with `nodes:write` and `access:write`, then a person approves at `/approvals` before `changes.commit`. `changes.plan` `dryRun: true` creates that pending plan; it is not a no-op preview. That approval is a second gate on top of OAuth consent, not a replacement for it, and it is not required to save a bookmark. Do not one-shot public visibility, move, or delete. `GET /api/v1/mcp/approvals` returning 401 means authentication is required, not that write review is closed.

## What this is not

Do not POST JSON-RPC to `/mcp`. Do not treat Collection Protocol (`GET /.well-known/collection-protocol`) as MCP. COLP is how published snapshots are listed; MCP is how a consented client reads the signed-in library and, with write scopes, creates a private collection or saves a bookmark. High-risk visibility or delete still needs `/approvals`.
