# Know-N

Know-N is an online bookmark library for saving, syncing, organizing, and sharing collections.

Know-N keeps saved links, shared collections, browser sync, and knowledge paths worth revisiting in one library. Use Explore to browse public reading paths. Sign in to keep a private library, capture pages with the browser extension, and share a collection when you are ready.

## Capture, classify, connect, and publish

The library stays out of the way: capture in context, file with suggestions, and arrange on your terms.

- Capture preserves browser context: the page title, address, and source metadata in one click.
- Classify keeps suggestions reversible. Accept, adjust, or ignore so the library learns your folders.
- Connect uses board, list, and graph views over the same links. Reorganize without losing the thread.
- Publish a collection as private or as a public reading path others can follow.

## Browser extension and sync

A Chromium browser extension saves the page, with its title and source, into the right collection. It is built for Chrome. Two-way browser sync keeps existing bookmarks and the library in step, without a one-off import or export.

## Public reading paths

Explore lists collections with a point of view. Share a collection as a reading path, or keep it in a private library until you are ready. Bookmarks are better when they stay organized. Bring the links you already have and build a collection worth revisiting.

## For agents

If you are connecting as an MCP client, read these next. Do not invent other discovery URLs from this page.

- Guidance: [https://know-n.com/llms.txt](https://know-n.com/llms.txt)
- Connection notes: [https://know-n.com/mcp](https://know-n.com/mcp) (`GET /mcp` is documentation; do not POST JSON-RPC there)
- Machine discovery: `GET https://know-n.com/.well-known/mcp` (JSON). There is no `/.well-known/mcp.json` and no `/mcp.json`.
- Wire: `POST https://know-n.com/collections/-/mcp` (`2026-07-28`) or `POST https://know-n.com/collections/-/mcp-compat` (`2025-11-25`)
