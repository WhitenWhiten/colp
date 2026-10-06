# Development Logs

These files are the per-area development logs kept while the package was built:
[Publication](PUBLICATION.md), [Publisher](PUBLISHER.md), [Feed](FEED.md),
[Sync](SYNC.md), [Security](SECURITY.md), [MCP transport](MCP_TRANSPORT.md),
[MCP read](MCP_READ.md), and [MCP write](MCP_WRITE.md).

They are historical records, not current instructions. Commands they mention
such as `check:requirements`, `check:release-evidence`,
`generate:mcp-conformance-candidate`, and `accept:mcp-2026-07-28-sdk` were
replaced by the simpler evidence workflow described in the package
[README](../../README.md#commands-repository-checkout): `npm run refresh:evidence`
to record evidence and `npm run check:evidence` to verify it.
