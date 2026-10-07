# Website to extension subscription setup

The deployed website must set VITE_KNOWN_EXTENSION_ID to its published extension ID (32 lower-case letters a–p). Set VITE_KNOWN_EXTENSION_STORE_URL to the actual HTTPS Chrome Web Store or Microsoft Edge Add-ons listing. An unset ID disables direct messaging and opens the installation/setup fallback; no fabricated store ID is shipped.

The matching extension build config must declare subscriptionBridgeOrigins entries with exact webOrigin and serverOrigin origins. Each serverOrigin must equal the build's configured serverOrigin. Production/staging require HTTPS, and development permits only loopback HTTP. Wildcards, paths, credentials, mixed environments and duplicate origins fail the build. Build emits externally_connectable.matches only for these explicit web origins. The worker rechecks the same origin, its current server environment and the closed message schema.

The only website payload is kind=known.openBookmarkSubscription, requestId (UUID), sourceType (collection or digest_series) and sourceId. The response acknowledges opening setup; it never asserts that a native folder was mounted or exposes login data. Website timeouts offer install/continue, preserve the originating source route, and reuse the request ID on retry. The extension persists a short-lived draft and requires the user to finish its four-step review before writing native bookmarks.

Private Digest routes are /library/digests/:id/read and /library/digests/:id/issues/:editionId/read. They use authenticated /api/v1/me/report-readers routes, require effective series membership and separately readable source content, and never fall back to public reader slugs. Responses are no-store and account identity changes clear the rendered reader immediately.

Validation must separately cover the final published extension ID and store listing, both browser families, and each deployed origin. Local unit or fixture tests do not certify those deployment values.
