# @know-n/colp 0.2.0

This minor release adds the experimental `@know-n/colp/automation` subpath and
a pinned MCP Events profile on `@know-n/colp/mcp` for Automation wake-ups. Both
are optional and sit outside protocol conformance: they add no Profile and
change no protocol requirement. The Automation contract reports itself as
`0.2.1-design` and follows the rule format in
[AUTOMATION_BROWSER_PROFILE.md](AUTOMATION_BROWSER_PROFILE.md). Hosted Events
acceptance against a real MCP Events host has not been run; any change it
requires to the Events surface needs a later release.

The draft compatibility baseline, Apache-2.0 license, protocol 0.1/0.2
negotiation and canonical Schema are unchanged from 0.1.3. The canonical Schema
SHA-256 is `a9942cb693a9de41e251d4ef166a7dac528d03325f62032d9da93238f3ebe7fe`;
the Requirements Digest is
`sha256:90598ba4a2472b37f3317e560b790f396b015902e9d7e5b26c263e669328495a`.

Follow the artifact identity and validation steps in [RELEASE_ARTIFACT.md](RELEASE_ARTIFACT.md).
The release record at `~/known/colp-server/evidence/F3/acceptance.md` records
the maintainer's instruction to waive native Windows/macOS acceptance. This
release retains that exception: run the exact tarball through Linux Node 22
and 24 consumers, and record native Windows/macOS checks as unrun. Do not
create synthetic matrix results.

Retain the exact source revision, check log, accepted artifact digests, actual
consumer results and registry verification outside the source checkout in
`~/known/colp-releases/`. The server keeps its vendored
`0.2.0-automation.0` build until the registry serves 0.2.0; switch its
dependency only after publication and registry verification.
