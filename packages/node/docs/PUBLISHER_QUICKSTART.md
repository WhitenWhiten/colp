# Publisher Quickstart

The Publisher implementation is framework-neutral. It supplies validated application boundaries and transaction ports; the host supplies HTTP routing, authentication, authorization, durable storage, and the real transaction manager. The complete ownership matrix is in [`HOST_INTEGRATION_BOUNDARY.md`](HOST_INTEGRATION_BOUNDARY.md).

## Import

Use the dedicated entry point for Publisher-only integrations:

```ts
import {
  executePublisherIdempotencyBoundary,
  type PublisherTransaction,
  type PublisherUnitOfWork,
} from '@collection-protocol/node/publisher';
```

Publisher runtime functions and transaction types are exported from
`@collection-protocol/node/publisher`. The package root
`@collection-protocol/node` exports only `protocolVersion`, `packageStatus`, and
`supportedProfiles`; it does not export Publisher APIs.

The import example above is a complete TypeScript consumer snippet. It resolves
against the installed package without repository source imports or path aliases.
`npm run pack:consumer-smoke` extracts this exact snippet from the quickstart in
the actual npm tarball, compiles it as both ESM and CommonJS with NodeNext
resolution, and runs both outputs in an isolated consumer. This checks the
runtime function and both transaction types against the published declarations.
The host transaction example below requires the application's own database ports.

## Request order

For every remote write, keep this order:

1. Enforce trusted transport, Origin, and route-specific credential transport boundaries.
2. Authenticate the caller, resolve effective scopes, and perform request-target authorization plus concealment before exposing authoritative resource state. Apply credential restrictions and sender constraints where required.
3. Run `enforceRateLimitForOperation` using that authentication result and the authoritative route/operation classification. Charge the protocol bucket once, then apply operation-cost/subscription admission before costly work.
4. Preserve raw repeated `If-Match` and `Idempotency-Key` fields until the Publisher boundary has classified them.
5. Decode and Schema-validate the canonical request DTO. Never pass raw query text, `URLSearchParams`, or caller-provided descendant lists as authoritative state.
6. Execute the selected Publisher coordinator with one transaction-bound port set.
7. Serialize only the coordinator's immutable result and registered Problem code.

An optional host-owned coarse IP/connection limit may run before authentication
to protect the authentication service. It is a separate resource budget, not the
authenticated protocol quota: do not label a not-yet-authenticated credential as
anonymous to charge its protocol bucket, or charge that same bucket again after
authentication. See the complete [security pipeline](SECURITY_COMPOSITION.md).

## Durable idempotency

`PublisherUnitOfWork.execute` must invoke its callback exactly once and return that exact callback result only after commit. Claim, business mutation, stored response, audit event, and Outbox append belong to the same database transaction.

The database types and functions in this example are intentionally host-defined placeholders:

```ts
type DatabasePublisherTransaction = PublisherTransaction & {
  readonly database: DatabaseTransaction;
};

const unitOfWork: PublisherUnitOfWork<DatabasePublisherTransaction> = {
  async execute(work) {
    return database.transaction(async (databaseTransaction) => {
      const transaction = createPublisherTransaction(databaseTransaction);
      return work(transaction);
    });
  },
};

const result = await executePublisherIdempotencyBoundary(
  unitOfWork,
  {
    principalId: authenticatedPrincipal.id,
    protocolVersion: '0.1',
    method: 'POST',
    endpointKey: 'annotations',
    resourceIdentity: `${collectionId}/${annotationId}`,
    idempotencyKey,
    decodedQuery: {},
    mediaType: 'application/json',
    body: annotationCreate,
  },
  async (transaction) => {
    const created = await createAnnotation(transaction.database, annotationCreate);
    await appendAuditAndOutbox(transaction.database, created);
    return {
      status: 201,
      headers: { Location: created.location },
      body: created.body,
    };
  },
);
```

The callback must return a native `Promise` and an exact I-JSON response. Header names and values are validated, replay snapshots are detached and frozen, and unsafe integers, excessive nesting, excessive members, accessors, and Proxy-backed adapter values fail closed.

## Coordinators

Use the narrowest coordinator for the endpoint:

- `executePublisherCollectionCreate`: atomically reserves server IDs and creates one Collection with its unique Root.
- `executePublisherOrdinaryNodeCreate`: validates the authoritative Parent and applies one canonical `create_node` Operation.
- `executePublisherNodeMove`: binds Node `If-Match`, both Parent Children Revisions, complete position context, authorization, and one canonical `move_node` Operation.
- `executePublisherNodeDelete`: derives single versus subtree deletion from `recursive`, traverses authoritative graph state, and binds the exact member set to deletion, Watermark, receipt, audit, and Outbox behavior.
- `executePublisherDelete`: lower-level cursor-free deletion receipt and internal Watermark coordinator for Collection and sidecar endpoints.
- `applyPublisherOperations`: validates and applies canonical atomic Publisher Operation batches through the host application service.

Pass explicit `maxDepth` and `maxVisitedNodes` values appropriate for the deployment. Remote input must never raise them above deployment or package ceilings.

## Startup checks

Call `verifyPublisherIdempotencyRetention` against the exact Manifest mount and the live store guarantee. Fail readiness when the durable retention guarantee is below `limits.idempotencyRetentionSeconds`.

Before publishing `publisher` in a deployment Manifest, pass the exact explicit Profile closure and any additional enabled capabilities to `runDeploymentConformanceProbes` against the real adapter. The scope planner automatically adds `core-authoritative-writes` and `managed-bookmark-writes` for Publisher. The former proves general authoritative-write guarantees; the latter separately proves that the generic Publisher mutation path enforces the default read-only boundary when it encounters the `managed-bookmarks` Folder role. Both capability probe groups and `publisher.transaction-contracts` must pass. The latter must observe commit, replay, and rollback through the deployment boundary. Pass the returned opaque scope-bound evidence to `assertProfileClaims`; endpoint presence, a copied boolean, or partial single-probe execution cannot replace this proof.

## Host obligations

The package cannot prove database or framework attachment properties through TypeScript ports. The host remains responsible for:

- serializable isolation or an equivalent locked snapshot for authoritative reads and writes;
- durable uniqueness for global IDs, Roots, idempotency bindings, and Operation sequence identities;
- atomic rollback across resources, receipts, audit, and Outbox records;
- cross-process serialization and safe retry of the same idempotency binding;
- reconciliation of an unknown commit outcome without reporting false success;
- deriving trusted transport and authenticated identity evidence from framework/deployment state.
- registering every Publisher route and attaching the required middleware/guards before parsing or coordinator invocation.

Run `npm run check`, `npm run test:coverage:publisher`, and the slower `npm run test:mutation:publisher` before shipping package changes.
