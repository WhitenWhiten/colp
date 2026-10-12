# @know-n/colp 0.1.3

This package release includes the MCP approval interaction fix in commit
`6396b8f7ca5e26b5b862b8131bdc24348ad4ca75` and its subsequent contract fixes.
`changes.plan` and `changes.commit` now request standard URL elicitation when
the client supports it. Clients without that capability, or calls whose
elicitation answer arrives before owner approval, receive an
`awaiting_approval` result matching the advertised output schema. An elicitation
answer never substitutes for owner approval, and a pending plan does not cause
an unbounded interaction loop.

The release also rejects endpoint expansions whose whole-path `.` or `..`
identifiers would be removed by URL normalization, including Sync effect-page
URLs. The opaque-ID grammar and safe query/sentinel templates are unchanged.

The existing draft compatibility baseline, Apache-2.0 license, protocol 0.1/0.2
negotiation and canonical Schema are unchanged from 0.1.2. The canonical Schema
SHA-256 is `a9942cb693a9de41e251d4ef166a7dac528d03325f62032d9da93238f3ebe7fe`;
the Requirements Digest is
`sha256:90598ba4a2472b37f3317e560b790f396b015902e9d7e5b26c263e669328495a`.

Follow the artifact identity and validation steps in [RELEASE_ARTIFACT.md](RELEASE_ARTIFACT.md).
The previous release record at
`~/known/colp-server/evidence/F3/acceptance.md` records the maintainer's instruction
to waive native Windows/macOS acceptance. This release retains that exception:
run the exact tarball through Linux Node 22 and 24 consumers, and record native
Windows/macOS checks as unrun. Do not create synthetic matrix results.

Retain the exact source revision, check log, accepted artifact digests, actual
consumer results and registry verification outside the source checkout in
`~/known/colp-releases/`. Downstream dependency upgrades and removal of server
approval compatibility code follow publication and HTTP interoperability checks.
