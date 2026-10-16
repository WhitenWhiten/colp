# @know-n/colp 0.2.1

This patch publishes the Automation contract updates used by the server's
vendored `0.2.1-automation.1` build. Editing previews accept an optional owned
`ruleId`; replacement inputs distinguish an omitted `executionPolicyId`
(preserve the current policy) from `null` (remove it); usage views accept
optional `heldRuns` for owner-held runs with remaining work.

The experimental Automation contract remains `0.2.1-design`. The draft
compatibility baseline, Apache-2.0 license, protocol negotiation, canonical
Schema, Profiles and Requirements Digest are unchanged from 0.2.0. Hosted
Events acceptance against a real MCP Events host has not been run.

Follow [RELEASE_ARTIFACT.md](RELEASE_ARTIFACT.md): check the clean source commit,
pack once, validate the exact tarball and publish those accepted bytes. Retain
the source revision, check log, digests, actual consumer results and registry
verification outside the checkout in `~/known/colp-releases/`.

Retain the maintainer's native Windows/macOS acceptance exception recorded in
`~/known/colp-server/evidence/F3/acceptance.md` and continued for 0.2.0. Run the
same tarball through actual Linux Node 22 and 24 consumers; record native
Windows/macOS checks as unrun and do not create synthetic matrix results.

The server keeps its vendored build until npm serves the verified 0.2.1
artifact. Switching downstream dependencies is a separate change after
publication and registry verification.
