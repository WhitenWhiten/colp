# Security Cloud 2026-10-06 remediation

This change set integrates the candidate hardening into the full `packages/node`
checkout. It addresses the input-boundary, authorization, and clean-tarball
issues described below. It does not claim that the upstream Security Cloud
findings are closed: a new scan and the opt-in Docker isolation run still need
to be performed in the release environment.

## Publisher identity authorization

`PublisherGuardedNodeWritePorts.authorizeNodeIdentity` is an optional TypeScript
port for source compatibility, but it is required at runtime for Create, Move,
Reparent, and Restore. The public Create and Move adapters now snapshot and
forward this port to the common guard. A missing, exceptional, or non-boolean
decision denies the operation before resolving a node, collection, parent,
anchor, or children.

The guard checks every literal identity present in the validated mutation,
including proposed Create IDs and Move anchors. Concealment receives a
`node-identity` subject without a graph plan; complete affected-node
authorization and policy checks still run after the identity gate. Integration
tests cover existing versus missing IDs, receiver/capture behavior, proposed
IDs, concealed subjects, and the no-read fail-closed path for Create and Move.

## Resource subscription authorization

`Mcp20260728AuthorizationRecheckPort.isResourceAuthorized(context, resourceUri)`
is required for nonempty `resourceSubscriptions`. General `isAuthorized` does
not grant resource access. The adapter validates and freezes bounded filters,
checks authorization at listen start, rechecks it on signals and before queued
notifications are returned, and clears queued data when revocation tears down
the stream. Errors and non-boolean answers fail closed. The test harness and
integration tests now provide the resource ACL explicitly and cover revocation,
mixed resource lists, missing ACL ports, and teardown cleanup.

## Input and serialization budgets

The implementation adds bounded UTF-8 accounting before expansion or parsing at
the following boundaries:

- extension maps: 1 MiB aggregate, with the existing safe JSON shape checks;
- OAuth metadata and resource-filter arrays: bounded members and 64 KiB text;
- push batches: at most 1,000 operations and 8 MiB aggregate JSON;
- request targets: 16 KiB and 256 nonempty query entries;
- Atom input: 1 MiB source data and 8 MiB escaped XML;
- canonical and shared immutable JSON snapshots: 8 MiB by default.

Shared helpers charge repeated references, object keys, delimiters, Unicode
encoding, and escaping at every occurrence. Durable-write code retains its
existing transaction boundary so a post-commit reporting failure cannot turn a
committed write into a false failure.

## Clean tarball verification

Candidate runtime imports and the installed compiler run only through Docker.
The probe container has no network, a read-only root and candidate bind mount,
UID/GID `65534`, dropped capabilities, no-new-privileges, and CPU, memory, and
PID limits. Docker is required; if its CLI or daemon is unavailable, the check
fails closed instead of running candidate code under the host Node.

The host-side install ignores lifecycle scripts and uses an allowlisted
environment plus disposable npmrc, cache, and temporary directories. Permission
normalization uses descriptor-based `O_NOFOLLOW`/`O_NONBLOCK` operations,
rejects shared hard-linked files, and never follows package symlinks. The image
is currently selected by an exact Node-version tag; release infrastructure
should pin and review the approved image digest before relying on this check.

## Validation

The following checks passed in this workspace:

- `npm --prefix packages/node run typecheck`;
- `npm --prefix packages/node run check:source-size`;
- `npm --prefix packages/node run build`;
- 507 targeted security, Publisher, MCP, schema, sync, quality-gate, and
  clean-consumer tests;
- the complete Node test suite with the environment-only memory test excluded:
  409 files and 10,913 tests passed;
- Node sandbox helper tests: 5 passed and the Docker-only test skipped because
  this environment has no Docker CLI/daemon;
- patch-engine regression tests: 7 passed.

The unexcluded suite has one known environment failure in
`tests/client/publication-snapshot-read-only.test.ts`: this runner reports
`ENOENT: uv_resident_set_memory` from `process.memoryUsage()`. That failure is
outside the remediation code and must be rerun on a normal Node runtime. A
Security Cloud rescan and the Docker-only candidate regression remain release
acceptance steps.
