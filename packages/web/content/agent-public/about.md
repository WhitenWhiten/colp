# About Know-N

Know-N is an online bookmark library for saving, syncing, organizing, and sharing collections and public reading paths. It is a place to keep pages you already care about, group them into collections you own, and publish a reading path when you want other people to follow the same sequence.

## What Know-N is

Know-N is software for bookmarks that live in collections. You save a page, file it with the rest of a collection, and return to it later. Signed-in people can sync that library while they work, capture a page with the browser extension, and share a collection as a public reading path when they are ready. Guests can browse public reading paths without an account. A new collection stays with its owner until that owner chooses to share it.

The site also publishes a Collection protocol document at [/.well-known/collection-protocol](/.well-known/collection-protocol). That document describes how a public collection can be read by other software. It is not a general search API, and it is not a way to write into a private library without an account.

Signed-in agents that need the library itself use MCP. Connection notes live at [/mcp](/mcp). The protocol endpoint is `POST /collections/-/mcp`, not a Settings API key and not this About page.

## What Know-N is not

Know-N is not a general-purpose search engine and is not a substitute for the open web. It does not try to index or rank the entire internet, and it does not claim to answer arbitrary questions from every public page. It is not a social network, a marketplace, or a CMS for writing original essays. It does not present other people's private collections as a public catalog.

Saving a bookmark for yourself does not require a public profile. A public reading path is something an owner publishes on purpose; it is not the default for a new collection. This page is a public product summary for people and agents who arrive without signing in. It is not a changelog, and it is not the signed-in Settings screen.
