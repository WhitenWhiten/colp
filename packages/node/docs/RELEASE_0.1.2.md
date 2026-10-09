# @know-n/colp 0.1.2 release preparation

Status: local preparation; not published. The latest registry version remains
0.1.1. Server dependency pins must change only after the accepted artifact is
available from the registry; do not substitute a file dependency in a release.

## Compatibility baseline

The maintainer confirmed on 2026-10-09 that earlier public packages made no
stable protocol compatibility promise. COLP remains a draft. This is the basis
for preparing package 0.1.2 without declaring a new stable protocol version.
The existing Apache-2.0 license remains in effect.

Compared with the published 0.1.1 Schema, the draft adds the move, subtree-delete
and search MCP input/result definitions and the `changePlan.approvedBy` field.
The published Schema SHA-256 is
`d75b1ae691f4a3b99e20a4f99d55c9fa0ff020a748fb9d074fb92e38b748ba40`;
the candidate canonical Schema SHA-256 is
`a9942cb693a9de41e251d4ef166a7dac528d03325f62032d9da93238f3ebe7fe`.
The bundled evidence uses protocol 0.1, package 0.1.2 and Requirements Digest
`sha256:90598ba4a2472b37f3317e560b790f396b015902e9d7e5b26c263e669328495a`.
Existing 0.1/0.2 negotiation and registered media types are unchanged.

## Release gates

Follow [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) and publish the exact bytes
accepted by [RELEASE_ARTIFACT.md](RELEASE_ARTIFACT.md). All seven exported
profiles must remain Complete in TRACEABILITY.md. Retain clean-source check,
strict tarball consumer and local platform/Node results with the artifact.

Publication and server/Known-Backend pin updates are pending the required
Windows and macOS acceptance in addition to the available Linux checks.
The planning evidence under `~/known/colp-server/evidence/F3/` records the actual
commands and results; unrun checks are not a release pass.
