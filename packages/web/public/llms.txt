# Know-N

Know-N is an online bookmark library. People use it to save, sync, organize, and share bookmark collections and public reading paths.

This file is for agents. It names the jobs Know-N is for, how to reach published surfaces, and what not to attempt.

Site origin: https://know-n.com/

## When to use

Use Know-N when the work is a bookmark collection or a reading path, not a web-wide search.

Suitable work:

- Generate an embedded collection or News Digest card styled for the user's own website. Read the [agent embed styling guide](https://know-n.com/embed-guide.md) for content routes, supported appearance parameters, safe iframe export, host CSS and preview checks. No library write or API key is needed to style published content.

- Save links into a collection, then organize that collection (folders, lists, board or graph views over the same records).
- Sync a signed-in library across browsers so bookmarks stay in one place instead of drifting between local bookmark bars.
- Share a collection or a public reading path when the owner chooses to publish it. Explore at https://know-n.com/explore lists public paths; a signed-in account is required before a private library can be written.
- Capture the current page with the browser extension (install notes at https://know-n.com/extension). Capture writes into the signed-in library, including the page URL and surrounding context, rather than scraping the public site as an anonymous agent.
- Read Collection Protocol (COLP) publication metadata. Discovery is `GET /.well-known/collection-protocol` on this origin. That well-known document points at published collection snapshots. It is how an agent inspects collections the owner already made public, not a substitute for signing in.
- Connect as an MCP client. Endpoint chooser: MCP `2026-07-28` clients use the strict COLP Profile server `POST https://know-n.com/collections/-/mcp`. Host compatibility is `POST https://know-n.com/collections/-/mcp-compat`; supported versions only `2025-11-25`. Claude Code 2.1.250 must use the compatibility URL as user-scope config, not a project `.mcp.json` and not the strict endpoint. Other and older clients are unsupported. Copy-paste requests: https://know-n.com/mcp
- Codex CLI 0.150.1 and Claude Code 2.1.250 handshake was measured on compatibility; that is not a full support claim. Codex requested `2025-06-18` → negotiated `2025-11-25`.
- Strict Streamable HTTP (`2026-07-28`) still needs the `MCP-Protocol-Version` and `Mcp-Method` headers, an `Accept` naming both `application/json` and `text/event-stream`, and a `params._meta` envelope carrying `io.modelcontextprotocol/protocolVersion` plus `io.modelcontextprotocol/clientCapabilities`. Identity is OAuth consent at `/login` then `/consent`, not an API key in Settings. Obtain a `client_id` by `POST https://know-n.com/api/v1/auth/oauth2/register` (RFC 7591) or by sending the HTTPS URL of a client metadata document you host (CIMD). Request `mcp:read:own mcp:read:public nodes:write offline_access` in one consent. Compat clients send `resource` equal to the compat URL; the issuer also accepts the strict resource.
- Read published collections anonymously over MCP. Without any token, MCP `resources/list` and `resources/read` return every published collection, and `tools/list` returns `collections.get`, `collections.get_snapshot`, and `nodes.get` for those public collections. Write tools still require the OAuth consent above.
- Authenticated MCP tools: `nodes.get`; `collections.list` (`mcp:read:own`, includes collection `revision`); `collections.create`, `collections.update`, `nodes.create`, `nodes.update`, `annotations.create`, and `annotations.update` (`nodes:write`; low-risk tools apply when dryRun is omitted, while `nodes.create` also treats explicit `confirmApply:false` as a no-write preview); `changes.get` (`nodes:write`, own plan); high-risk visibility or delete still uses `changes.plan` / `/approvals` / `changes.commit` with per-tool scopes (`changes.plan` → `nodes:write` + `access:write`; `changes.commit` → those plus `changes:commit`; `changes.cancel` → `changes:cancel`). `changes.plan` `dryRun: true` stores a pending plan, not a preview. Collection `public`/`unlisted` uses the collection resource `revision` from `collections.get` or `collections.list`, not a node fence. Default consent does not include `access:write`. Owners with `mcp:read:own` can read unpublished drafts; `resources/list` is published public libraries only. Compat `2025-11-25` clients use `/collections/-/mcp-compat` and must not send `2026-07-28` headers. Automated clients should set a browser-like `User-Agent` (Cloudflare may return 403 Error 1010 otherwise).

How to call the public surfaces:

- Humans: https://know-n.com/ (HTML) and the same path with `Accept: text/markdown` for a markdown variant.
- Crawlable page list: https://know-n.com/sitemap.xml
- This guidance: https://know-n.com/llms.txt
- Trust pages: https://know-n.com/about, https://know-n.com/contact, https://know-n.com/privacy
- Embed customization: https://know-n.com/embed-guide (HTML), https://know-n.com/embed-guide.md (Markdown). The HTML URL also accepts `Accept: text/markdown`.
- Developer discovery: https://know-n.com/developers (COLP well-known, MCP, public snapshots, markdown negotiation)
- MCP connection: https://know-n.com/mcp
- Account: https://know-n.com/login and https://know-n.com/register
- COLP discovery: `GET https://know-n.com/.well-known/collection-protocol`
- MCP discovery: `GET https://know-n.com/.well-known/mcp` (JSON). There is no `/.well-known/mcp.json` and no `/mcp.json`. `server/discover` names the server `Known MCP`; `GET /.well-known/collection-protocol` claims `mcp-read` and `mcp-write`.
- MCP resource: `POST https://know-n.com/collections/-/mcp`
- MCP compatibility resource: `POST https://know-n.com/collections/-/mcp-compat`
- MCP OAuth discovery: `GET https://know-n.com/.well-known/oauth-protected-resource` and `GET https://know-n.com/.well-known/oauth-authorization-server/api/v1/auth`. Usable grants are `authorization_code` and `refresh_token`; token-endpoint authentication is `none`. Request `offline_access` with the MCP scopes to receive a refresh token; access tokens expire in 3600 seconds.

Do not invent other write APIs from this file. If a collection is not in the COLP directory or a public `/c/` or `/path/` URL, treat it as unpublished. `/mcp` and `/developer` are not protocol endpoints; do not POST JSON-RPC there.

## When not to use

- Do not treat Know-N as a general-purpose search-engine replacement. Site search and Explore browse collections already on Know-N; they do not index the open web.
- Do not write into a private library with no account. Anonymous agents may read published collections (over COLP HTTP or MCP resources) and this file. Creating, editing, syncing, or extension capture requires a signed-in account.
- Do not assume every path on the origin is a published document. Unknown first-segments return HTTP 404. The sitemap whitelist is the indexable set; `/library`, `/export`, and `/dashboard` are account surfaces, not crawl targets.
