# COLP Server source archive contract v1

The current implementation uses a registered site identity codec and namespace-aware source authority. See [runtime foundation](runtime-foundation.md#cloud-identity-contract) for the backward-compatible locator fields and capability negotiation. Only Bilibili v1 is currently registered.

The user clarified on 2026-10-24 that COLP Server is the only backend for this work and backend classification does not exist. This supersedes the old design's separate Know-N backend dependency. No generated JEV file is changed. This document now records the implementation contract rather than a request for another backend owner's approval. Acceptance evidence is tracked separately in [execution evidence](execution-evidence.md).

## Negotiation and supported scope

An authenticated `GET /colp/v0.1/sync/source-archives` returns the product extension profile. It does not invent a standard COLP manifest profile. The browser requires **all** v1 source admission, final effects and authority lease capabilities, the bounded 20-edge batch, two-minute lease, and the explicit negative classification capabilities. Missing routes, old versions and changed capability meanings stop source submission. There is no fallback to ordinary account rules, intake, classification or root-placement receipts.

The current account workflow is an explicitly reviewed **source import batch** using positive facts already accepted by the bundled reader. Configure a v3 source rule for a mapped synced root, review the account/root/collection scope, approve this device, preview the next batch, then approve that exact batch. Each batch contains at most 20 edges; scanning/preview never creates canonical bookmarks. Earlier source rules retain their first-match priority; a local-only first match is omitted instead of falling through to a cloud rule. New source facts require another preview. The cloud workflow does not start a background classifier or unreviewed cloud live importer.

| Capability | v1 behavior |
| --- | --- |
| Site and identity | Bilibili, identity version 1; `video:av:<aid>` and exact canonical HTTPS av URL; source collections use numeric site IDs |
| Copies | `sourceAndSemantic`; a distinct source copy for each root/collection/item. The local SA-07 executor retains all three copy policies. Cloud single-copy semantic coordination is explicitly unavailable, and changing to either single-copy policy blocks cloud dispatch for review. |
| Source facts | Account-authorized device reports; no claim that Bilibili signed them or that a human performed the observed action. Community-origin observations cannot enter the cloud workflow. |
| Placement | Canonical roots, resource revisions, allowed source collection IDs, ordered browser rule/subscription digest, local binding digest and policy revision are pinned. Per-edge entry remains `siteImport`; canonical intake is `userSelected`, automation origin `import`. |
| Classification | `classification: false`, `classificationDestinationPolicy: false`; `classify` rejects. No model or tag request, API key, classification cache or provider job is created. Local SA-07 candidate/cache/apply/recovery exclusions remain in force. |
| Rename/removal | Existing canonical objects retain identity and their original names. Manual changes require review and are not overwritten or recreated. Membership removal retains archives. Automatic source folder renaming and root migration are unavailable in this profile. |

## Authority and commands

Every POST is the closed envelope `{version: 1, action, input}`. The route shares COLP extension credential verification, active account resolution, origin/TLS checks, bounded bodies and admission budgets. A source lease is separate from ordinary Sync authority.

- `status`: private connection scopes and epochs; never returns another device's lease token.
- `configure`: exact reviewed scope, replica ID, expected epoch and approval digest. Requires an active credential-bound Sync session and a nonretired replica belonging to that account/collection. A live lease held by another replica rejects. Successful approval increments the epoch and issues a fresh random token.
- `renew`: matching replica/epoch/token only, extends the bounded lease without changing its epoch.
- `revoke`: account-authorized expected epoch, increments the epoch and clears the lease. Browser fencing persists before the network request.
- `preview`: stable plan ID, current lease/scope digest and at most 20 strict source edges. Stores the exact server-side scope, epoch and payload digest for ten minutes. Reusing an ID with changed input conflicts.
- `commit`: plan ID and exact digest, matching current lease and scope. Revalidates active replica, root ownership/ancestry/revisions and every existing binding. All folder and bookmark changes, canonical revisions/operations/audit/Sync effects, shared reservations and the final receipt commit in one PostgreSQL transaction.
- `cancel`: fences a prepared plan, including a durable digest tombstone when its prepare request has not arrived yet. Committed results are returned rather than undone. The browser requires uncertain submitted work to be recovered first.
- `recover`: read-only lookup by original plan ID/digest. Committed results remain available after source disable, lease expiry, revocation and transfer. Recovery does not grant new writes. A missing prepare is retried under the same ID and exact input; uncertain submitted work never authorizes a replacement create.

Source authority is keyed by authenticated COLP account plus stable site account, not a device's randomly generated local connection ID. Exclusive epochs and durable root/collection/item reservations survive device transfer. A second browser can receive ordinary canonical bookmarks through Sync while still having no source authority. It must independently connect the correct site account and review its own native-to-canonical root mappings. No native bookmark ID, cookie, site session, page capability or model secret is sent as source authority.

The transaction lock order is active credential-bound Sync sessions → account → private source receipt row → collection replica gate → active replicas → collection → canonical nodes/operations. Revocation/retirement and canonical writes therefore serialize under the existing Sync locks. The private per-account row serializes source epochs and logical reservations. Limits are 128 connections, 5,000 retained plans, 10,000 folders, 50,000 copies and 32 MiB encoded state per account. At capacity, admission stops visibly; it does not evict unknown commands or receipts.

## Final receipts and recovery

A successful receipt names the actual canonical bookmark and collection-specific **final parent**, its resource revision and canonical operation ID. The selected rule root never substitutes for that final parent. Receipt digests bind the exact ordered effects and all canonical folder/bookmark mutations, including operation IDs, content/resource revisions and commit ordinals. A replay returns the original result; changed digests conflict. Same-name source collections receive separate folders because reservations use source collection IDs. Unproven same-name/URL nodes are never adopted automatically.

Canonical writes make the normal Sync replicas recover through the existing canonical recovery path. The source workflow never creates a native bookmark and independently pushes a second copy. Local planned execution still rejects Sync-range roots; the negotiated account command owns canonical creation instead.

The browser stores the plan before prepare and marks it submitted before commit. A timeout or lost response becomes `unknown`. Recovery can confirm the original receipt or return the still-prepared original command for explicit retry. Completed batches checkpoint accepted membership ordinals, rather than a sorted item-ID cursor, so a later lower-ID addition remains visible. Existing canonical/manual changes are never deleted as compensation. Private source state remains in its own server table and local source metadata, outside public node payloads and exported executable backups.

## Local validation

Use the prepared OrbStack runner. The optional `COLP_ADAPTER_POSTGRES=1` harness creates a disposable PostgreSQL 16.4 container on a run-specific Docker network, shares that network with the existing xvfb runner, and passes only its database URL. No host port or Docker socket is exposed. The runner stops/removes its test container, database container and network on completion, failure or interruption. Cached images and dependency volumes remain reusable.

```sh
node packages/extension/scripts/with-orbstack.mjs run node_modules/.bin/vitest run tests/site-adapter-cloud.test.ts
COLP_ADAPTER_POSTGRES=1 node packages/extension/scripts/with-orbstack.mjs e2e e2e/mv3-site-adapter-cloud.spec.ts
```

The E2E fixture uses the actual COLP Fastify/auth/canonical/Sync stack and real PostgreSQL, with Bilibili/provider responses controlled in Chromium. It does not use a separate Know-N service or the user's real account/site state. Exact passing results and limitations belong to [execution evidence](execution-evidence.md); code or a prepared environment alone is not acceptance.

## Local adoption convergence capability

`managedLocalConvergence: 1` adds optional `converge: { fromParentId }` to an adopt-only `managed.save` command. The original uploaded node/revision, source parent and immutable command digest remain mandatory. A convergence receipt may carry `convergedFrom` for a retired provisional node. The server never creates another node for this path. Canonical mutation, tombstone, Sync effect, binding and receipt commit in one transaction. A client recovers that receipt before inspecting a native node removed by the merge. Unsupported servers receive ordinary adoption commands only.

Only pristine provisional copies qualify. Annotation, relation, extension/pin, description/tag, revision or ownership changes require review. A source child may move only into the shared folder for the same site/version/account/collection, with matching root provenance. A duplicate folder containing children waits; personal children require review. Original native save receipts survive replacement of the current projection association.
