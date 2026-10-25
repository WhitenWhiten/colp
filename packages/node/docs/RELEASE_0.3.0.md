# @know-n/colp 0.3.0

This minor release publishes the accumulated changes since 0.2.1, including the
unpublished `0.2.2-automation-client-id.1` build and the subsequent negotiated
replica-retirement contract. The maintainer selected version 0.3.0 for registry
publication. The license remains Apache-2.0.

The package adds optional COLP 0.2 replica health, issue-action and command-result
contracts. A rebuild command can carry `replicaRetired: true` only after the
server has retired the replica through the negotiated rebuild flow. Subtree
deletion Problems can include `currentSubtree`, and the Sync entry exposes
member-identity digests and observation summaries. Shared browser folder roles,
Automation agent setup, exact-bookmark runs and tasks-only runs are included.
See the repository [changelog](../../../CHANGELOG.md) for the security,
concurrency and performance fixes.

Protocol 0.1/0.2 negotiation, the existing draft compatibility baseline, the
seven exported Profiles and the Requirements Digest remain unchanged. Optional
recovery fields extend the Schemas; their hashes therefore differ from 0.2.1:

- Canonical 0.1 Schema SHA-256:
  `3326cdc8bf65e0061aa21f7aa8aba426e824666ad971d89af30f0e63b52a1c20`.
- COLP 0.2 Schema SHA-256:
  `6ffcd85650d89dd9d67ed8a4ba33bd77968544ab6e63d58390477266297032e2`.
- Requirements Digest:
  `sha256:90598ba4a2472b37f3317e560b790f396b015902e9d7e5b26c263e669328495a`.

The experimental Automation contract remains `0.2.1-design`. Hosted Events
acceptance against a real MCP Events host has not been run.

Follow [RELEASE_ARTIFACT.md](RELEASE_ARTIFACT.md): check the clean source commit,
pack once, test the exact bytes and retain their SHA-256/SHA-512, check log,
actual consumer results and registry verification outside the checkout under
`~/known/colp-releases/`. Retain the native Windows/macOS acceptance exception
documented in [0.2.0](RELEASE_0.2.0.md) and [0.2.1](RELEASE_0.2.1.md). Test the
same tarball with actual isolated Linux Node 22 and 24 consumers; explicitly
record native Windows/macOS checks as unrun, never as successful Linux results.
The generic `publish` subcommand still requires all six native matrix cells.
For this retained exception, verify the accepted artifact and both actual Linux
records, then pass that same tarball directly to `npm publish --ignore-scripts`;
retain the publication command and registry integrity comparison with the
release record. Do not manufacture matrix records to satisfy the generic gate.

The server, server runtime, extension and web keep their existing artifact until
npm serves the verified 0.3.0 bytes. Switching those consumers to the exact
registry version and removing the vendored SDK follows publication and registry
integrity verification. Server image and extension store publication are separate
deployment releases.
