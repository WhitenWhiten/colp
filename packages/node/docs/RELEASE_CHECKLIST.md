# Release Checklist

This checklist separates an npm package release from a deployment release. A
package release proves reusable implementation capability; a deployment release
proves that one running system correctly wires and exposes that capability. A
release record must state which boundary it covers and preserve the evidence used
for each decision. See
[`HOST_INTEGRATION_BOUNDARY.md`](HOST_INTEGRATION_BOUNDARY.md).

## Version baseline

- [ ] Search repository and protocol release tags; record the result.
- [ ] Confirm whether any `0.1` validator, Schema, package, or Wire implementation was distributed externally as stable, including artifacts not represented by this Git repository.
- [ ] If no stable `0.1` existed, record that the corrected Draft is the initial compatibility baseline.
- [ ] If a stable `0.1` existed, select a new Minor or Major version under Specification section 12 and do not reuse `0.1`.
- [ ] Freeze the canonical Schema digest, protocol version, media types, and supported negotiation behavior in the release record.

## Package release

- [ ] Confirm the intended package Profiles and their transitive dependencies exactly match `supportedProfiles`.
- [ ] Remove `private` and replace `0.0.0-development` only when the package is intended for registry publication; these fields do not determine whether a host has mounted HTTP routes.
- [ ] Record the owner-approved license and include its LICENSE file. Set the final repository and issue-reporting metadata; missing repository/bugs metadata is a readiness warning, not the same technical block as private:true.
- [ ] Run `npm run refresh:evidence`, review the `evidence.json` and traceability changes, and commit them.
- [ ] Run `npm run check` from the exact clean Git HEAD that will be released. It fails if the committed evidence no longer matches a fresh run, and it also scans the packed tarball for Legacy MCP wire symbols via `check:mcp-legacy-absence` after `pack:check`.
- [ ] Confirm that `docs/TRACEABILITY.md` reports every exported Profile as Complete.
- [ ] When mutation evidence is required, run `npm run test:mutation:release` explicitly from a clean local checkout and retain the local reports. Do not add mutation testing to GitHub Actions.
- [ ] Local only: run `npm run check:benchmark:publication-snapshot-delivery` on a machine whose OS and Node major match `packages/node/tests/performance/baselines/publication-snapshot-delivery.json` `reference.environment`, or compare against a same-host artifact at `packages/node/reports/publication-snapshot-delivery-host-baseline.json`. A platform or Node-major mismatch must skip the absolute-Hz floor (exit 0) and must not use the win32 12008 plans/s figure as a Linux or CI gate. GitHub Actions must not run this script.
- [ ] For Publication hotspot changes, retain local scale/pipeline reports as described in [`LOCAL_PERFORMANCE_REVIEW.md`](LOCAL_PERFORMANCE_REVIEW.md). Do not convert this local measurement into an Actions or npm run check gate.
- [ ] Local / release ceremony: exercise Node 22 and Node 24 on Linux, Windows, and macOS before release. GitHub Actions (`.github/workflows/colp-ci.yml`) proves **ubuntu-24.04 + Node 22** only; do not treat the three-OS × Node 24 matrix as a CI Baseline gate.
- [ ] Run `npm run pack:check` and inspect the exported subpaths, types, ESM/CJS entry points, and packaged assets.
- [ ] Prepare the final artifact using [`RELEASE_ARTIFACT.md`](RELEASE_ARTIFACT.md). Run the additional [`clean tarball acceptance`](CLEAN_TARBALL_ACCEPTANCE.md) on the same tarball in every local matrix environment, retain its SHA-256/SHA-512 and exact source revision, and publish those accepted bytes without repacking.
- [ ] Record the package version, release commit, protocol version, and Requirements Digest from `src/conformance/generated/evidence.json`.

An npm package release does not require this repository to ship a ready-to-run
HTTP application. Real routes, middleware, databases, identity providers, and
deployment probes belong to the embedding host.

## Deployment release

- [ ] Pin an exact package artifact whose `supportedProfiles` contains every requested Profile and dependency.
- [ ] Confirm every requested endpoint is actually mounted at the absolute URL declared by the Manifest.
- [ ] Confirm framework middleware/guards preserve raw Header cardinality, construct trusted transport evidence, and invoke the documented security order on every applicable route.
- [ ] Confirm every required persistence, transaction, identity, signing, clock, rate-limit, and notification port is backed by the deployment's real adapters.
- [ ] Build the immutable deployment conformance plan from the exact explicit Profile list and the generic roles actually enabled; do not infer optional roles merely from `core` dependency closure.
- [ ] Run the complete scope-derived black-box plan against the release environment; configuration declarations, package tests, and single-probe executions are not deployment evidence.
- [ ] Confirm published Manifest Profiles exactly equal the immutable `assertProfileClaims` output for the requested list.
- [ ] Retain the deployment artifact digest, configuration version, probe result, asserted Profile list, and rollback record together.

## Deployment integration hardening

### Namespace handling

- [ ] Confirm extension Namespace tests reject userinfo and empty explicit ports.
- [ ] Confirm IP literals and loopback names remain accepted when deployment policy permits them.
- [ ] Confirm Namespace keys are stored, compared, and relayed by exact original spelling without URI normalization.
- [ ] Apply SSRF controls at every network dereference boundary; do not treat Namespace validation as an SSRF defense.

### Profile ID key rotation

- [ ] Assign each public key-version label once and never map it to different key material.
- [ ] Retain mappings for every version referenced by stored Profile IDs.
- [ ] Prove mappings and stored-ID resolution survive process and storage restarts.
- [ ] Prove rotation leaves old identifiers resolvable while new derivations use the intended new version.
- [ ] Prove key bytes do not enter responses, exceptions, structured logs, tracing attributes, metrics labels, or generic configuration dumps.
- [ ] Verify the package HMAC golden vector documented in `ARCHITECTURE.md`.
