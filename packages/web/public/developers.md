# Developers on Know-N

This page is a discovery index for agents and people who want to read published collections with software. It is not a protocol specification and it is not a server. Wire details live on the pages linked below.

Know-N publishes collections that an owner chose to share. Anonymous software can read those collections. Writing into a private library still needs a signed-in account and a consented client.

## Collection Protocol

Published collections are described by Collection Protocol (COLP). Start at the well-known document:

- `GET https://know-n.com/.well-known/collection-protocol`

That document names the directory, collection metadata, and snapshot URLs. Use it to list public collections and to fetch a snapshot the owner already published. It is not a general search API and it is not a way to write into a private library.

Do not copy or restate the COLP specification on this page. The well-known document is the discovery entry; the protocol package is the contract.

## MCP connection

Agents that speak Model Context Protocol should read [MCP on Know-N](/mcp). The protocol endpoint is `POST https://know-n.com/collections/-/mcp`. `GET /developers`, `GET /mcp`, and Settings do not host that server. Do not POST JSON-RPC to this page.

Anonymous MCP can list and read published collections as resources. Tools that touch a signed-in library need OAuth consent. The walkthrough, required headers, DCR registration, and Client ID Metadata Document rules are on `/mcp`.

## Public snapshots and markdown

A published collection has several read surfaces on this origin:

- HTML card and no-JS summary: `GET https://know-n.com/c/{slug}`
- The same URL with `Accept: text/markdown` returns a flattened markdown tree (folder headings and bookmark links). Responses `Vary` on `Accept`.
- Share and path wrappers (`/share/{slug}`, `/path/{slug}`) point their canonical URL at `/c/{slug}`.
- COLP snapshots remain under `/colp/v0.1/collections/{id}/snapshot` after you resolve the collection from the well-known directory.

Unknown slugs return HTTP 404. Unlisted collections are readable but are not in the collections sitemap.

## Crawl and agent files

- Sitemap index: `GET https://know-n.com/sitemap.xml` (static pages plus public collections)
- Agent guidance: `GET https://know-n.com/llms.txt`
- This index as markdown: `GET https://know-n.com/developers` with `Accept: text/markdown`

## What this page is not

This page does not replace COLP, MCP, or the trust pages. It does not accept API keys. It does not document Product `/api/v1` session routes. If you need the MCP wire format, go to `/mcp`. If you need the collection protocol itself, start at `/.well-known/collection-protocol`.

## Embed cards that match a website

Agents can generate styled iframe cards for published collections, the latest issue of a News Digest series, or a fixed Digest issue. Read the [embed styling guide](/embed-guide) before generating markup: it describes how to inspect the host site's design, choose supported appearance parameters, export the iframe and host CSS, and validate the result while preserving Know-N attribution. No API key or collection write is required.

For plain-text agent access, use [the Markdown guide](/embed-guide.md), or request /embed-guide with Accept: text/markdown. The HTML guide is included in the static sitemap.
