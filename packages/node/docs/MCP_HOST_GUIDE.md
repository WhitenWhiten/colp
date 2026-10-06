# MCP Host Guide

The `mcp-read` and `mcp-write` profiles are delivered as adapter libraries, not
as a complete remote MCP server. Every example below imports only from the
public `@collection-protocol/node/mcp` entry, which serves MCP protocol version
`2026-07-28`. Type-checked copies of the examples live in
[`tests/mcp/examples/`](../tests/mcp/examples), and `npm run typecheck` compiles
them, so keep the two in sync when you change either.

The host owns the transport, request demultiplexing, authentication, and the
application ports. The package owns per-request context validation, result
shapes, budgets, and the fail-closed boundaries listed below. See
[`MCP_SDK_POLICY.md`](MCP_SDK_POLICY.md) for how the upstream SDK is pinned.

## Read: host responsibilities

| Surface | Host responsibility |
|---|---|
| Stateless Resource core | One frozen `createMcpStatelessReadCore` instance serves concurrent per-request contexts; every list/read call re-accepts a `McpTrustedReadRequestContext` (authorization binding, scope, budget, abort signal). No per-session instance, no sessionId echo, no subscription Map. |
| Application ports | Tool and Resource factories require **own data functions** (not class-prototype methods). Prefer object literals or explicit own-property wraps, e.g. `{ getCollection: service.getCollection.bind(service) }`. |

## Read: minimal hosts

### Resource-only host

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

### Read Tools host

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

The stdio evidence mapper turns identifiers the host has already verified into
a token-free authenticated binding. The package never resolves raw credentials.

## Read: hardening at adapter boundaries

| Boundary | Snapshot / own-data | Notes |
|---|---|---|
| `collections.get` output | `snapshotMcpData` | Fail-closed on getters, cycles, non-JSON prototypes |
| Tool input validator | top-level own data + nested `snapshotMcpData` | Nested aliasing cannot reach validation results |
| Anonymous `readResource` | `snapshotMcpData` | Same hardening as Tool output |
| Stateless Resource core read/list | rebuild + freeze + budgets | cursor, list-item, content and text-byte limits enforced |
| Collection read Tool port | own `getCollection` data function | Prototype methods rejected |
| Snapshot link Tool port | own `getCollectionSnapshotLinkMetadata` | Same pattern |
| Stateless Resource projection port | exact own-data list/read surface | protocol-neutral; no wire/session types |

## Write: host responsibilities

Beyond the read responsibilities, a write host owns the OAuth approval UI,
durable plan and approval storage, and secret reveal pages.

| Surface | Host responsibility |
|---|---|
| Write Tool gateway | Publishes `changes.plan`, `changes.commit`, and `changes.cancel`; optional key Tools use canonical result adapters and redaction. |
| Change Plan | Injects transaction-bound plan/approval stores, impact/revision/scope/authorization ports, executor, and required rate-limit policy. |
| Risk aggregation | Uses registered canonical operation adapters and shared input budgets; unknown executable shapes fail closed. |
| Secret redaction | Model-facing results expose metadata, `secretAvailable`, and a host reveal URI only; secret fields are removed before return or retention. |

Residual risks that stay with the host:

- Durable Approval compare-and-consume under multi-node concurrency remains a
  host responsibility; the in-memory helper is single-process only.
- OAuth re-authentication, CSRF protection, and one-time display for approval
  and secret-reveal pages remain host responsibilities.
- Transport/session demultiplexing and Streamable HTTP productization remain
  outside this adapter library.
- Publisher ACL, Revision, and Outbox execution remain in existing publisher
  ports; MCP supplies the gateway and transaction contract.

## Write: the `2026-07-28` adapter

`createMcp20260728WriteToolAdapter` maps the write gateway and the change-plan
core onto `2026-07-28` results:

- Normal results are `complete`: low-risk Tools, `changes.cancel`, approved
  commit receipts, and `tools/list`.
- A call that waits for out-of-band approval returns `input_required` with an
  `inputRequests` map and a server-minted `requestState`. COLP never sends
  roots, sampling, or elicitation requests to the client, so the map is empty;
  the client retries after the host records the approval.
- A retry echoes `requestState` (and optional `inputResponses`). The adapter
  verifies its HMAC integrity, expiry, principal binding, method, and input
  digest, then resumes the same plan. A call without `requestState` always
  creates a new plan.
- `inputResponses` entries are validated structurally. Well-formed entries for
  requests this server never issued are ignored; malformed entries are
  rejected with Invalid Params.
- Execution, approval compare-and-consume, and idempotency stay in the gateway
  and change-plan service; the adapter only maps results. The host supplies the
  `resolvePlan` status port, the durable plan and approval stores, the
  request-state HMAC key, and the approval UI.

The write gateway factory, the change-plan factory, and the in-memory stores
are internal; the adapter composes them.

## Write: minimal host

```ts
import {
  createMcp20260728RequestContext,
  createMcp20260728WriteToolAdapter,
  mapStdioEvidenceToAuthenticatedBinding,
  type Mcp20260728PlanResolution,
} from '@collection-protocol/node/mcp';

// Host-owned: durable plan store, approval store, executor, impact/revision/
// scope/authorization/rate-limit ports, commit coordinator (see the type-
// checked mirror for the full wiring). The host owns the approval UI and
// calls adapter.recordOutOfBandApproval(planId, context) after the user
// approves out-of-band.
const resolvePlan = async (planId: string): Promise<Mcp20260728PlanResolution> => {
  const plan = await planStore.get(planId);
  if (plan === undefined) return { status: 'unknown' };
  return { status: plan.status, plan: projectPlan(plan) };
};

const writeAdapter = createMcp20260728WriteToolAdapter({
  changePlan,                 // protocol-neutral change-plan service options
  serverInfo: Object.freeze({ name: 'collection-write-host', version: '0.0.0' }),
  resolvePlan: { resolvePlan },
  requestStateKey: 'host-request-state-key-0123456789abcdef0123456789abcdef',
});

export async function handleToolCall(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>,
  input: Readonly<{
    name: string;
    arguments?: Readonly<Record<string, unknown>>;
    requestState?: string;
    inputResponses?: Readonly<Record<string, unknown>>;
  }>,
) {
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
  return writeAdapter.callTool(context, input);
}
```
