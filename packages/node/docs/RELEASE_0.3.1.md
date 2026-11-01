# @know-n/colp 0.3.1

This patch publishes the shared SDK changes from the server's
`0.3.1-mcp-context.0` build. Experimental Automation `ConnectionProfileInput`
accepts optional `taskToolsets`: `recovery`, `rule-authoring`, `sync-diagnostics`
and `browser-rules`. Its generated types and validator accept unique selections
of at most four names. Hosts enforce the selection: omission preserves the
existing catalog, an empty selection excludes Manager and standard tools, and
Worker tools retain their existing authority checks.

`Mcp20260728ResultInput.fieldsBudget` lets a trusted host bound the snapshot of
generated result fields explicitly. The server uses it for larger closed tool
catalogs. The SDK's default result limits and request/write-input limits remain
unchanged; the override must never be derived from untrusted client arguments.

The existing draft compatibility baseline, protocol 0.1/0.2 negotiation,
canonical Schemas, seven exported Profiles, Requirements Digest and Apache-2.0
license are unchanged from 0.3.0. The experimental Automation contract remains
`0.2.1-design`. Server tool selection, host integration and deployment are
separate from this SDK publication. Actual model loading, long-session
performance and hosted MCP Events acceptance remain unverified.

Follow [RELEASE_ARTIFACT.md](RELEASE_ARTIFACT.md): prepare from a clean source
commit, run the release checks, pack once, and validate and publish the same
accepted bytes. Retain the source revision, check log, SHA-256/SHA-512, actual
consumer results and registry verification outside the checkout under
`~/known/colp-releases/`.

Retain the maintainer's native Windows/macOS acceptance exception documented in
[0.2.0](RELEASE_0.2.0.md), [0.2.1](RELEASE_0.2.1.md) and
[0.3.0](RELEASE_0.3.0.md). Run the same tarball through actual isolated Linux
Node 22 and 24 consumers. Explicitly record native Windows/macOS checks as
unrun, and do not create synthetic matrix records. The generic `publish`
subcommand still requires all six native matrix cells. Under the retained
exception, verify the accepted artifact and both actual Linux records, then
pass that same tarball directly to `npm publish --ignore-scripts`; retain the
publication result and registry integrity comparison with the release record.

The server, server runtime, extension and web keep the vendored prerelease until
npm serves the verified 0.3.1 bytes. After publication and registry integrity
verification, pin all four consumers to the exact registry release and remove
the obsolete vendored SDK. This also removes runtime installation's dependency
on an untracked local tarball. Server image and extension publication remain
separate deployment releases.
