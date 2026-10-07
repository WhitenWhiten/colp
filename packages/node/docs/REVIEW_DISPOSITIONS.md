# Review Dispositions

This ledger records findings that do not represent current Core implementation defects. They are excluded from the open defect count unless their explicit reopen condition becomes true. Security hardening accepted from a rejected compliance claim remains tracked as an enhancement.

| ID | Finding | Disposition | Repository action | Reopen condition |
|---|---|---|---|---|
| `AUDIT-DISP-0001` | Reusing `0.1` violates version rules | Conditionally closed | The Specification identifies `0.1-draft` as unstable and the release checklist requires an external-publication audit before freezing the first baseline. The current repository has no protocol release tag. The maintainer selected `@know-n/colp@0.1.0` as the first npm release; the canonical namespace now uses `https://know-n.com/colp/`. | Evidence appears that a stable `0.1` validator, Schema, package, or Wire implementation was distributed externally, or a stable release is attempted without a recorded baseline decision. |
| `AUDIT-DISP-0002` | `globalResourceReference` is an isolated primitive | Closed, by design | The primitive defines global identity encoding. Existing Snapshot references remain same-Collection bare IDs, so no object field is widened. | A product requirement introduces cross-server Relation, Provenance, Alias, or another object-level reference. That feature requires a separately versioned Wire Contract and end-to-end tests. |
| `AUDIT-DISP-0003` | HTTPS Namespace must reject every unusual authority | Compliance claim rejected; targeted enhancement completed | The Draft now rejects userinfo and empty explicit ports and compares keys by exact spelling. IP literals and loopback remain valid identifiers. Network dereference continues to require a separate SSRF boundary. | The protocol starts dereferencing Namespace URIs, policy requires public-DNS-only identifiers, or interoperability evidence shows another authority form must be constrained. |
| `AUDIT-DISP-0004` | Exact HMAC transcript must be protocol normative | Closed as a protocol defect; retained as a package contract | Profile IDs are opaque and deployments use independent keys. The package framing remains documented, independently tested, and pinned by a fixed golden vector for this package and compatible SDKs. | The protocol requires independent implementations using the same key and logical input to produce byte-identical Profile IDs. |
| `AUDIT-DISP-0005` | The HMAC helper must own key-version mapping | Accepted deployment responsibility | The stateless helper accepts an opaque key handle. For deployments that enable `server-profile-id-hmac`, the required `core.profile-id-key-rotation` deployment probe covers immutable label assignment, retention, restart recovery, rotation, and nondisclosure. | A supported package-owned key store is introduced, or deployment evidence cannot reliably enforce the mapping lifecycle. |

## Status rules

- `Conditionally closed` findings remain outside the defect count while their condition is false, but their release gate is mandatory.
- `Closed, by design` findings are reopened only by an approved scope change.
- Accepted enhancements are tested and documented without retroactively classifying the original implementation as non-conformant.
- Deployment responsibilities must be demonstrated by black-box probes before Profile claims; helper unit tests alone are insufficient.
