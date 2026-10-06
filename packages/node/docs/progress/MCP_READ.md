# MCP Read Progress

> **Migration status: Accepted (COLP-MCP-15)** — the `mcp-read` package
> claim is restored after exact-version MCP `2026-07-28` source-bound
> conformance evidence was accepted. The superseded `2025-11-25`
> session-oriented slice is retained only as migration history.

| Requirement | Status | Evidence tests | Acceptance attempts | Protocol correction |
|---|---|---:|---:|---|
| `MCP-0001` | Accepted | 63 | 1 | No |
| `MCP-0002` | Accepted | 37 | 1 | No |
| `MCP-0006` | Accepted | 33 | 1 | No |
| `MCP-0008` | Accepted | 48 | 1 | No |
| `MCP-0009` | Accepted | 39 | 1 | No |
| `MCP-0010` | Accepted | 32 | 1 | No |
| `MCP-0011` | Accepted | 28 | 1 | No |
| `MCP-0012` | Accepted | 55 | 1 | No |
| `MCP-0013` | Accepted | 57 | 1 | No |
| `MCP-0014` | Accepted | 48 | 2 | No |
| `MCP-0015` | Accepted | 37 | 2 | No |

## Adapter composition notes (mcp-read v1)

This slice delivers an **adapter library**, not a full remote MCP transport product.
Hosts own transport, session demux, and application authorization ports.

| Surface | Host responsibility |
|---|---|
| Tool gateway / mount `tools` | **Gateway v1** always lists `collections.get`. **v1.1 optional**: pass `snapshotLink` to `createMcpReadToolGateway` or `snapshotLinkService` to `createMcpReadExposure` to also publish `collections.get_snapshot`. Sidecar factory `createCollectionsGetSnapshotTool` remains available for external registries. |
| Stateless Resource core | One frozen `createMcpStatelessReadCore` instance serves concurrent per-request contexts; every list/read call re-accepts a `McpTrustedReadRequestContext` (authorization binding, scope, budget, abort signal). No per-session instance, no sessionId echo, no subscription Map. |
| Anonymous Resources | `createMcpAnonymousReadExposure` returns **deeply frozen own-data snapshots** of application projections (aligned with Tool output hardening). Visibility/ACL stay in the application port. |
| Application ports | Tool and Resource factories require **own data functions** (not class-prototype methods). Prefer object literals or explicit own-property wraps, e.g. `{ getCollection: service.getCollection.bind(service) }`. |

### Minimal host examples (COLP-MCP-12)

Both examples import exclusively from the supported Modern entry
`@collection-protocol/node/mcp`. Type-checked mirrors live under
`tests/mcp/examples/` (`npm run typecheck` compiles them).

#### Resource-only host

```ts
import {
  createAnonymousPublicBinding,
  createMcp20260728RequestContext,
  createMcp20260728ResourceAdapter,
  createMcpStatelessReadCore,
  type McpResourceProjectionPort,
} from '@collection-protocol/node/mcp';

const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const collectionMetadataUri = `colp://${serverUuid}/collections/collection-1`;

// Host-owned, protocol-neutral projection port: authorize and project only.
const projection: McpResourceProjectionPort = {
  listResources: async () => ({
    resources: [{
      uri: collectionMetadataUri,
      name: 'Collection 1',
      mimeType: 'application/json',
      provenance: { origin: 'internal' },
    }],
  }),
  readResource: async () => ({
    contents: [{
      uri: collectionMetadataUri,
      mimeType: 'application/json',
      text: '{"id":"collection-1"}',
      provenance: { origin: 'internal' },
    }],
  }),
};

// Host-owned logical URI codec bound to the server's stable authority.
const uriCodec = {
  serverUuid,
  collectionMetadata: (collectionId: string) =>
    `colp://${serverUuid}/collections/${collectionId}`,
  collectionSnapshot: (collectionId: string) =>
    `colp://${serverUuid}/collections/${collectionId}/snapshot`,
  collectionNode: (collectionId: string, nodeId: string) =>
    `colp://${serverUuid}/collections/${collectionId}/nodes/${nodeId}`,
  parse: (uri: string) => {
    const collectionId = uri.split('/collections/')[1] ?? '';
    return { kind: 'collection-metadata' as const, collectionId };
  },
};

// One frozen adapter serves concurrent per-request contexts; no Session.
const resourceAdapter = createMcp20260728ResourceAdapter({
  readCore: createMcpStatelessReadCore({ projection, uriCodec }),
  serverInfo: Object.freeze({ name: 'collection-host', version: '0.0.0' }),
});

export async function handleResourceList(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>,
): Promise<unknown> {
  const context = createMcp20260728RequestContext({
    headers,
    httpMethod: 'POST',
    body,
    binding: createAnonymousPublicBinding({
      resourceAudience: 'urn:colp:resource:public',
      securityEpoch: 'epoch-1',
    }),
  });
  return resourceAdapter.listResources(context, {});
}
```

#### Read Tools host

```ts
import {
  createMcp20260728ReadToolAdapter,
  createMcp20260728RequestContext,
  createMcpStatelessToolCore,
  mapStdioEvidenceToAuthenticatedBinding,
  type McpToolDefinition,
} from '@collection-protocol/node/mcp';

const collectionsGetDefinition: McpToolDefinition = Object.freeze({
  name: 'collections.get',
  description: 'Read a collection by id.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({ collectionId: { type: 'string' } }),
    required: Object.freeze(['collectionId']),
    additionalProperties: false,
  }),
});

const toolCore = createMcpStatelessToolCore({
  tools: [{
    definition: collectionsGetDefinition,
    invoke: async (input) => ({ structuredContent: { id: input.collectionId } }),
  }],
});

// One frozen adapter serves concurrent per-request contexts; no Session.
const readToolAdapter = createMcp20260728ReadToolAdapter({
  toolCore,
  serverInfo: Object.freeze({ name: 'collection-host', version: '0.0.0' }),
});

export async function handleToolCall(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>,
): Promise<unknown> {
  const context = createMcp20260728RequestContext({
    headers,
    httpMethod: 'POST',
    body,
    binding: mapStdioEvidenceToAuthenticatedBinding({
      credentialKind: 'stdio',
      principalId: 'local-principal',
      clientId: 'stdio-host-1',
      credentialBindingId: 'local-secret-binding-1',
      resourceAudience: 'urn:colp:resource:public',
      securityEpoch: 'epoch-1',
    }),
  });
  return readToolAdapter.callTool(context, {
    name: 'collections.get',
    arguments: { collectionId: 'collection-1' },
  });
}
```

> The stdio evidence mapper replaces the removed `createMcpStdioCredentialBinding`
> factory: hosts map already-verified stable identifiers to a token-free
> authenticated binding and never resolve raw credentials inside the package.

### Hardening inventory (adapter boundaries)

| Boundary | Snapshot / own-data | Notes |
|---|---|---|
| `collections.get` output | `snapshotMcpData` | Fail-closed on getters, cycles, non-JSON prototypes |
| Tool input validator | top-level own data + nested `snapshotMcpData` | Nested aliasing cannot reach validation results |
| Anonymous `readResource` | `snapshotMcpData` | Same hardening as Tool output (MCP-R-001) |
| Stateless Resource core read/list | rebuild + freeze + budgets | cursor, list-item, content and text-byte limits enforced |
| Collection read Tool port | own `getCollection` data function | Prototype methods rejected |
| Snapshot link Tool port | own `getCollectionSnapshotLinkMetadata` | Same pattern |
| Stateless Resource projection port | exact own-data list/read surface | protocol-neutral; no wire/session types |

## Modern Read candidate (COLP-MCP-09)

> **Candidate: `mcp-read-candidate`** — internal development artifact that
> was NOT a Profile claim or a release until COLP-MCP-15 accepted the exact
> MCP `2026-07-28` source-bound conformance evidence and restored the
> `mcp-read` package claim.

The Modern Read adapter layer (`src/mcp/2026-07-28/resources.ts`,
`src/mcp/2026-07-28/tools.ts`, `src/mcp/2026-07-28/schema-budget.ts`) maps
per-request `Mcp20260728RequestContext` facts through the stateless shared
cores to Modern `2026-07-28` results (`complete`, serverInfo, accurate cache
metadata on cacheable methods). One frozen adapter instance serves concurrent
isolated requests; no hidden per-client instance. See `MCP_TRANSPORT.md`
(COLP-MCP-09) for the full contract inventory.

## Read package surface candidate (COLP-MCP-12)

> **Candidate: `mcp-read-package-candidate`** — internal development artifact
> that was NOT a Profile claim or a release until COLP-MCP-15 accepted the
> exact MCP `2026-07-28` source-bound conformance evidence and restored the
> `mcp-read` package claim. Third parties consume the completed Modern
> Read/shared API through `@collection-protocol/node/mcp` (or the versioned
> `@collection-protocol/node/mcp/2026-07-28`).

COLP-MCP-12 publishes the Modern Read package surface:

- `src/mcp/index.ts` (default `/mcp` entry) and `src/mcp/2026-07-28/index.ts`
  (explicit versioned entry) export the completed Modern `2026-07-28`
  Read + shared surface: shared authorization/resources/tools/change-signal,
  request-context/discovery/results, Resource and Read Tool adapters, OAuth
  client security and subscriptions/listen.
- The package root no longer re-exports MCP adapters or MCP wire-version
  metadata; `MCP_PROTOCOL_VERSION` / `supportedMcpProtocolVersions` live on
  the `/mcp` entries only.
- Removed public symbols: the legacy Session binding, the legacy read server
  session, the pre-Modern stdio credential factory (`createMcpStdioCredentialBinding`
  / `McpStdioCredentialBinding`, replaced by `mapStdioEvidenceToAuthenticatedBinding`)
  and the pre-Modern read/write adapter factories. The pre-Modern helper
  modules stay internal-only.
- `package.json` exports adds `./mcp` and `./mcp/2026-07-28` (types
  import/require + ESM/CJS); deep imports under the entries are blocked by the
  exports map. `tsup` emits `dist/mcp/index.*` and
  `dist/mcp/2026-07-28/index.*` for both formats.
- Verified by `tests/mcp/mcp-2026-07-28-read-package-surface-contract.test.ts`
  (root absence, default/versioned parity, Legacy symbol absence, deep-import
  blocking, packed ESM/CJS declaration/runtime consistency, tarball scan) and
  `tests/mcp/mcp-2026-07-28-read-package-surface.typecheck.ts` (compile-time
  root/entry absence), plus the minimal host example typechecks under
  `tests/mcp/examples/`.

## Modern Write addition (COLP-MCP-13)

> **Candidate: `mcp-write-candidate`** — internal development artifact, NOT a
> Profile claim and NOT a release. See `MCP_WRITE.md` for the Modern Write
> adapter details.

COLP-MCP-13 adds the implemented Modern Write/MRTR API to the same two
supported entries (`/mcp` and `/mcp/2026-07-28`) **additively**: every Read
key from `mcp-read-package-candidate` remains present and unchanged, so
Read-only consumers keep working without any drift. The write package-surface
contract test asserts the Read key set is a subset of the combined surface and
that the internal Write Gateway / change-plan factories stay absent from both
entries.
## Versioned conformance candidate (COLP-MCP-14)

> **Candidate: `mcp-conformance-candidate`** — internal development artifact
> that was NOT a Profile claim or a release. COLP-MCP-15 accepted its exact
> MCP `2026-07-28` source-bound binding and restored `mcp-read` /
> `mcp-write`.

- The generic Read/Write deployment probes are split into six fixed versioned
  families: `mcp-2026-07-28.transport-header-contracts`,
  `mcp-2026-07-28.discovery-contracts`,
  `mcp-2026-07-28.subscription-contracts`,
  `mcp-2026-07-28.read-schema-contracts`,
  `mcp-2026-07-28.write-mrtr-contracts` and
  `mcp-2026-07-28.oauth-client-contracts`.
- Certificate, target evidence, bundled evidence and the runner verdict carry
  the exact MCP version `2026-07-28`, the source revision, the locked
  `@modelcontextprotocol/*` SDK versions (`core`, `client` and `server` all
  `2.0.0`) and the reference-client/fixture-host topology digest.
- Old unversioned probe IDs (`mcp-read.transport-contracts`,
  `mcp-write.approval-contracts`) are rejected migration input and can never
  satisfy a versioned claim.
- Generator: `scripts/generate-mcp-conformance-candidate.mjs` (wired as
  `npm run generate:mcp-conformance-candidate`); it runs the owned Vitest
  suite at the committed source revision and writes
  `src/conformance/generated/mcp-conformance-candidate.json`. COLP-MCP-15
  regenerates it at the accepted revision and binds it into
  `src/conformance/generated/mcp-2026-07-28-sdk-accepted.json`.

## Accepted SDK (COLP-MCP-15)

> **Artifact: `mcp-2026-07-28-sdk-accepted`** — the source-bound total
> acceptance record. `mcp-read` / `mcp-write` are restored in
> `supportedProfiles` and the refreshed bundled evidence verifies every
> MCP-* Requirement ID.

- Total runner: `npm run accept:mcp-2026-07-28-sdk`
  (`scripts/accept-mcp-2026-07-28-sdk.mjs`) aggregates protocol sync, types,
  requirements, traceability, typecheck, the owned Vitest evidence suite, the
  reference client / fixture host acceptance e2e, build, `pack:check`, the
  SDK lock, the regenerated `mcp-conformance-candidate`, and the Legacy MCP
  absence scan, then writes `mcp-2026-07-28-sdk-accepted.json`.
- Legacy MCP absence: `scripts/lib/legacy-mcp-absence.mjs` +
  `npm run check:mcp-legacy-absence` scan source, declarations and the packed
  tarball for Legacy MCP wire symbols (`McpSessionBinding`, `initialize`,
  old subscriptions, GET/DELETE MCP transport, `Last-Event-ID`,
  `Mcp-Session-Id`, the legacy SDK import) without flagging COLP Sync
  Session (`SyncSession*`).
- Claim restoration: `supportedProfiles` includes `mcp-read` / `mcp-write`;
  `conformance-evidence.mjs` is in the accepted state (no MCP quarantine, no
  MCP evidence stripping); the refreshed `evidence.json` / `TRACEABILITY.md`
  are regenerated by `npm run refresh:evidence` after this commit.
