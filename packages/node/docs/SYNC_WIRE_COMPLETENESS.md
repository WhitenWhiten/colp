# Sync wire integration inventory (SYNC-V-010)

**Package capability:** Sync contracts, coordinators, ports, composition helpers,
and package evidence are implemented; `supportedProfiles` includes `sync`.
**Deployment posture:** no ready-to-run Sync HTTP application is shipped; each
host must mount its own routes, adapters, and probes.
**Protocol reference:** `protocol/docs/03-sync.md` (chapter 03)

This document inventories chapter-03 capabilities against `packages/node/src/sync/**`
and identifies the remaining host integration work. Host-owned HTTP and storage
work is not a package-completeness gap. It is still mandatory before a deployment
may publish a Sync Manifest claim.

---

## Implemented package capabilities

| Capability area | Package surface | Notes |
|---|---|---|
| Session binding + verify | `session.ts` - `createSyncSession`, `verifySyncSessionContext`, optional `expiresAt` lease | Credential / scope / lease terminate paths |
| Session bootstrap | `session-bootstrap.ts` - `coordinateSessionBootstrap` | Instance `create_collection` lane — package-only, **no known production consumer**: the lane needs a backend that mints instance-scoped Sessions carrying `collections:create`, and no host is known to do so yet. A host whose Sessions are always Collection-bound answers `create_collection` with `unsupported_operation` and creates Collections through its own API. |
| Sequence continuity | `sequence.ts` - `coordinateSequenceOperation` | `sequence_gap` / `sequence_blocked` / replay |
| Push atomic batch | `push-transaction.ts` - `coordinatePushTransaction` | Dual-index receipts and opId claims; Sequence remains an alternative owner |
| Pull (authoritative order) | `pull.ts` - `coordinateSyncPull` | Cursor scope, commit ordinal, Snapshot URL HTTPS default |
| Tombstone (+ purge) | `tombstone.ts`, `tombstone-purge.ts` | Purge preconditions fail closed |
| Replica lifecycle | `replica-lifecycle.ts`, `replica-capability.ts` | Host derives authenticated proof from its credential boundary |
| Typed operations / merge | `typed-operations.ts`, `typed-update-merge.ts` | Key-set validation + three-way merge helper |
| Operation reuse / claims | `operation-reuse.ts` | Lifetime opId uniqueness + reuse audit |
| Browser adapters | `browser-batch-adapter.ts`, `browser-event-translation.ts` | Mapping helpers, not a complete browser product |
| Sidecar | `sidecar.ts` | Persistence / export helpers |
| Root mapping | `root-mapping.ts`, `root-mapping-adapter.ts` | Dynamic root mapping |
| Light-pull advisory | `light-pull-advisory.ts` | Advisory only |
| Composition helpers | `composition.ts` - session-bound Push/Pull/Sequence | Thin gates; bare coordinators remain composition-free |
| Host composition recipe | `host-composition-recipe.ts` - `SYNC_HOST_COMPOSITION_RECIPE`, `createTypedUpdateMergePushPreflight` | Session-first + exclusive owner + merge-in-preflight glue; no dual-owner facade |
| Netscape bookmark parser | `netscape-bookmark.ts` | Production parser (see progress honesty) |
| Separator visual | `separator-visual.ts` | UI projection helper |

---

## Required deployment integration

| Chapter-03 surface | Package contract | Host deployment responsibility |
|---|---|---|
| Session, bootstrap, Push, Pull, conflict, and acknowledgement URLs | Endpoint/Wire contracts and the relevant coordinators or ports | Register concrete routes, bind path/query/header/body inputs, and preserve package result/Problem mappings |
| Conflict resolution | Typed merge and conflict contracts | Own authoritative conflict storage and expose the deployment's conflict-resolution application route |
| Client acknowledgement | Replica checkpoint and tombstone-purge contracts | Persist acknowledgements and expose the deployment's acknowledgement route |
| Complete Sync HTTP surface | Framework-neutral behavior only; the package does not install an HTTP app | Attach framework middleware/guards, authentication, request limits, response serialization, and observability |
| Sequence + Push | Alternative exclusive owners | Choose exactly one opId owner for each write path (SYNC-V-009 / V-013) |
| Session / authorization | `verifySyncSessionContext` and session-bound helpers | Invoke the gate before Push/Pull/Sequence and derive credential facts from the real request |
| Replica authentication | `ReplicaAuthProof` composition boundary | Mint proof only from the deployment's verified identity/session result |
| Durable state | Store and Unit of Work ports | Provide database isolation, uniqueness, rollback, restart persistence, and cross-process serialization |

---

## Claim rules

1. `supportedProfiles` includes `sync` because the reusable package behavior and
   package evidence have passed their gate.
2. The package deliberately does not choose deployment URLs or ship a complete
   framework application. That does not downgrade the package claim.
3. A deployment must not copy `supportedProfiles` into its Manifest. It must
   mount the complete surface, provide the required runtime ports, run the Sync
   black-box probes, and serialize the result of `assertProfileClaims`.
4. Progress `Accepted` rows remain bound to Registry / TRACEABILITY evidence;
   this integration inventory does not re-grade them.
5. HTTP Problem serialization, transport authentication, rate-limit attachment,
   and probe execution are host responsibilities governed by package contracts.

---

## Related docs

- [`HOST_INTEGRATION_BOUNDARY.md`](HOST_INTEGRATION_BOUNDARY.md) - package/host ownership
- [`SYNC_HOST_COMPOSITION.md`](SYNC_HOST_COMPOSITION.md) - recommended integration order
- `packages/node/src/sync/composition.ts` - `SYNC_HOST_COMPOSITION_NOTES`
