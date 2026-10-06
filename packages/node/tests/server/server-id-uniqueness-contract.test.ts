import { readFile } from "node:fs/promises";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  executeIdempotentPublisherCreation,
  type IdempotencyBinding,
  type PublisherTransaction,
  type PublisherUnitOfWork,
} from "../../src/publisher/index.js";
import {
  reserveServerIds,
  ServerIdAlreadyReservedError,
  type ServerIdReservation,
  type ServerIdReservationStore,
  type ServerIdReservationTransaction,
} from "../../src/server/index.js";
import { validateSnapshotSemantics } from "../../src/semantic/index.js";
import type { SyncTransaction } from "../../src/sync/index.js";
import type { Snapshot } from "../../src/types/index.js";

type ResourceType = ServerIdReservation["resourceType"];

const resourceTypes = [
  "collection",
  "node",
  "annotation",
  "attachment",
  "relation",
  "operation",
  "event",
] as const satisfies readonly ResourceType[];

interface DurableState {
  readonly reservedIds: Map<string, ResourceType>;
  readonly resources: Map<string, ResourceType>;
  transactionQueue: Promise<void>;
}

interface TestTransaction extends ServerIdReservationTransaction {
  readonly resources: {
    put(id: string, resourceType: ResourceType): Promise<void>;
  };
}

function cloneState(state: DurableState): DurableState {
  return {
    reservedIds: new Map(state.reservedIds),
    resources: new Map(state.resources),
    transactionQueue: state.transactionQueue,
  };
}

class AtomicPersistentIdentityStore {
  readonly state: DurableState;
  claimCalls = 0;
  failClaims = false;
  constructor(
    state: DurableState = {
      reservedIds: new Map(),
      resources: new Map(),
      transactionQueue: Promise.resolve(),
    },
  ) {
    this.state = state;
  }

  execute<Result>(
    work: (transaction: TestTransaction) => Promise<Result>,
  ): Promise<Result> {
    const run = async (): Promise<Result> => {
      const draft = cloneState(this.state);
      const idReservations: ServerIdReservationStore = {
        reserveAll: async (reservations) => {
          this.claimCalls += 1;
          if (this.failClaims) throw new Error("identity storage unavailable");
          const conflict = reservations.find(({ id }) => draft.reservedIds.has(id));
          if (conflict !== undefined) {
            return {
              state: "conflict",
              conflict: {
                requested: conflict,
                existing: {
                  id: conflict.id,
                  resourceType: draft.reservedIds.get(conflict.id)!,
                },
              },
            };
          }
          reservations.forEach(({ id, resourceType }) =>
            draft.reservedIds.set(id, resourceType),
          );
          return { state: "reserved" };
        },
      };
      const result = await work({
        idReservations,
        resources: {
          put: async (id, resourceType) => {
            draft.resources.set(id, resourceType);
          },
        },
      });
      this.state.reservedIds.clear();
      draft.reservedIds.forEach((type, id) =>
        this.state.reservedIds.set(id, type),
      );
      this.state.resources.clear();
      draft.resources.forEach((type, id) => this.state.resources.set(id, type));
      return result;
    };

    const result = this.state.transactionQueue.then(run, run);
    this.state.transactionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  create(type: ResourceType, id: string): Promise<void> {
    return this.execute(async (transaction) => {
      await reserveServerIds(transaction, [{ resourceType: type, id }]);
      await transaction.resources.put(id, type);
    });
  }
}

async function fixture(name: string): Promise<Snapshot> {
  return JSON.parse(
    await readFile(
      new URL(`../../fixtures/protocol/examples/${name}`, import.meta.url),
      "utf8",
    ),
  ) as Snapshot;
}

describe("durable server ID ledger [evidence:core.server-id-uniqueness]", () => {
  it.each(resourceTypes)(
    "never accepts a second %s claim for the same ID",
    async (resourceType) => {
      const store = new AtomicPersistentIdentityStore();
      await expect(
        store.create(resourceType, `${resourceType}-durable-id`),
      ).resolves.toBeUndefined();
      await expect(
        store.create(resourceType, `${resourceType}-durable-id`),
      ).rejects.toBeInstanceOf(ServerIdAlreadyReservedError);
    },
  );

  it("uses one server-wide namespace across resource types", async () => {
    const store = new AtomicPersistentIdentityStore();
    await store.create("collection", "shared-id");
    await expect(store.create("event", "shared-id")).rejects.toMatchObject({
      name: "ServerIdAlreadyReservedError",
      code: "server_id_already_reserved",
      conflict: {
        requested: { resourceType: "event", id: "shared-id" },
        existing: { resourceType: "collection", id: "shared-id" },
      },
    });
  });

  it("allows exactly one of two concurrent claimants to commit", async () => {
    const store = new AtomicPersistentIdentityStore();
    const results = await Promise.allSettled([
      store.create("node", "contended-id"),
      store.create("node", "contended-id"),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ServerIdAlreadyReservedError);
  });

  it("allows exactly one winner under many concurrent claims", async () => {
    const store = new AtomicPersistentIdentityStore();
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () => store.create("operation", "hot-id")),
    );

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(31);
    rejected.forEach((result) =>
      expect(result.reason).toBeInstanceOf(ServerIdAlreadyReservedError),
    );
  });

  it("allows one winner across separate coordinators sharing durable state", async () => {
    const first = new AtomicPersistentIdentityStore();
    const second = new AtomicPersistentIdentityStore(first.state);
    const results = await Promise.allSettled([
      first.create("annotation", "cross-coordinator-id"),
      second.create("relation", "cross-coordinator-id"),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("publishes a reservation only when its transaction commits", async () => {
    const store = new AtomicPersistentIdentityStore();
    let continueTransaction!: () => void;
    const paused = new Promise<void>((resolve) => {
      continueTransaction = resolve;
    });
    let reserved!: () => void;
    const reservationMade = new Promise<void>((resolve) => {
      reserved = resolve;
    });

    const pending = store.execute(async (transaction) => {
      await reserveServerIds(transaction, [
        { resourceType: "annotation", id: "commit-visible-id" },
      ]);
      reserved();
      await paused;
    });
    // Also surface an early transaction failure instead of waiting for the test timeout.
    await Promise.race([reservationMade, pending]);
    expect(store.state.reservedIds.has("commit-visible-id")).toBe(false);
    continueTransaction();
    await pending;
    expect(store.state.reservedIds.has("commit-visible-id")).toBe(true);
  });

  it("rolls back a reservation so a never-committed candidate can retry", async () => {
    const store = new AtomicPersistentIdentityStore();
    await expect(
      store.execute(async (transaction) => {
        await reserveServerIds(transaction, [
          { resourceType: "attachment", id: "rolled-back-id" },
        ]);
        throw new Error("abort resource creation");
      }),
    ).rejects.toThrow("abort resource creation");

    await expect(
      store.create("attachment", "rolled-back-id"),
    ).resolves.toBeUndefined();
  });

  it("rolls back an entire creation set when a later ID collides", async () => {
    const store = new AtomicPersistentIdentityStore();
    await store.create("node", "existing-batch-id");
    await expect(
      store.execute((transaction) =>
        reserveServerIds(transaction, [
          { resourceType: "collection", id: "new-batch-id" },
          { resourceType: "node", id: "existing-batch-id" },
        ]),
      ),
    ).rejects.toBeInstanceOf(ServerIdAlreadyReservedError);

    await expect(
      store.create("collection", "new-batch-id"),
    ).resolves.toBeUndefined();
  });

  it("rejects duplicate entries in one creation set before touching storage", async () => {
    const store = new AtomicPersistentIdentityStore();
    await expect(
      store.execute((transaction) =>
        reserveServerIds(transaction, [
          { resourceType: "node", id: "duplicate-batch-id" },
          { resourceType: "event", id: "duplicate-batch-id" },
        ]),
      ),
    ).rejects.toBeInstanceOf(ServerIdAlreadyReservedError);
    expect(store.claimCalls).toBe(0);
    expect(store.state.reservedIds.size).toBe(0);
  });

  it.each(["resource deletion", "Tombstone purge", "retention cleanup"])(
    "%s cannot release a committed ID",
    async () => {
      const store = new AtomicPersistentIdentityStore();
      await store.create("relation", "deleted-id");
      store.state.resources.delete("deleted-id");

      await expect(
        store.create("relation", "deleted-id"),
      ).rejects.toBeInstanceOf(ServerIdAlreadyReservedError);
    },
  );

  it("rejects reuse after a service restart over the same durable store", async () => {
    const firstProcess = new AtomicPersistentIdentityStore();
    await firstProcess.create("event", "restart-id");
    const restartedProcess = new AtomicPersistentIdentityStore(
      firstProcess.state,
    );

    await expect(
      restartedProcess.create("event", "restart-id"),
    ).rejects.toBeInstanceOf(ServerIdAlreadyReservedError);
  });

  it("treats opaque IDs that differ only by case as distinct", async () => {
    const store = new AtomicPersistentIdentityStore();
    await expect(
      store.create("node", "CaseSensitive"),
    ).resolves.toBeUndefined();
    await expect(
      store.create("node", "casesensitive"),
    ).resolves.toBeUndefined();
  });

  it.each(["", "contains/slash", "contains space", "x".repeat(129)])(
    "rejects invalid ID %j before touching storage",
    async (id) => {
      const store = new AtomicPersistentIdentityStore();
      await expect(store.create("node", id)).rejects.toThrow(
        /1-128 URI-unreserved/u,
      );
      expect(store.claimCalls).toBe(0);
    },
  );

  it.each(["Collection", "unknown", null, 42])(
    "rejects invalid resourceType %j before touching storage",
    async (resourceType) => {
      const reserveAll = vi.fn(async () => ({ state: "reserved" as const }));
      await expect(
        reserveServerIds(
          { idReservations: { reserveAll } },
          [{ id: "valid-id", resourceType } as unknown as ServerIdReservation],
        ),
      ).rejects.toThrow(/valid id and resourceType/u);
      expect(reserveAll).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], "reservation"])(
    "rejects a non-object reservation %j",
    async (reservation) => {
      await expect(reserveServerIds(
        { idReservations: { reserveAll: async () => ({ state: "reserved" }) } },
        [reservation] as unknown as readonly ServerIdReservation[],
      )).rejects.toThrow(/must be an object/u);
    },
  );

  it("rejects non-array, sparse, and empty reservation collections safely", async () => {
    const reserveAll = vi.fn(async () => ({ state: "reserved" as const }));
    const transaction = { idReservations: { reserveAll } };
    await expect(reserveServerIds(
      transaction,
      {} as unknown as readonly ServerIdReservation[],
    )).rejects.toThrow(/must be an array/u);
    await expect(reserveServerIds(
      transaction,
      new Array(1) as readonly ServerIdReservation[],
    )).rejects.toThrow(/must not contain a hole/u);
    await expect(reserveServerIds(transaction, [])).resolves.toBeUndefined();
    expect(reserveAll).not.toHaveBeenCalled();
  });

  it("rejects sparse holes even when Array.prototype supplies an inherited index slot", async () => {
    const reserveAll = vi.fn(async () => ({ state: "reserved" as const }));
    const transaction = { idReservations: { reserveAll } };
    const sparse = [] as ServerIdReservation[];
    sparse.length = 1;

    Object.defineProperty(Array.prototype, "0", {
      value: { resourceType: "operation", id: "polluted" },
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      // Ordinary indexing would see the inherited polluted reservation.
      expect(sparse[0]).toEqual({ resourceType: "operation", id: "polluted" });
      expect(Object.hasOwn(sparse, 0)).toBe(false);

      await expect(reserveServerIds(transaction, sparse)).rejects.toThrow(
        /must not contain a hole/u,
      );
      expect(reserveAll).not.toHaveBeenCalled();

      // Dense own-index reservations still succeed under the same pollution.
      await expect(
        reserveServerIds(transaction, [{ resourceType: "node", id: "dense-under-pollution" }]),
      ).resolves.toBeUndefined();
      expect(reserveAll).toHaveBeenCalledOnce();
    } finally {
      // Always restore Array.prototype regardless of assertion outcome.
      Reflect.deleteProperty(Array.prototype, "0");
    }
  });

  it("passes a detached frozen reservation snapshot to asynchronous storage", async () => {
    let received!: readonly ServerIdReservation[];
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const reserveAll = vi.fn(async (reservations: readonly ServerIdReservation[]) => {
      received = reservations;
      await paused;
      return { state: "reserved" as const };
    });
    const input: Array<{ id: string; resourceType: ResourceType }> = [
      { id: "stable-id", resourceType: "node" },
    ];
    const pending = reserveServerIds({ idReservations: { reserveAll } }, input);

    input[0]!.id = "mutated-id";
    input.push({ id: "late-id", resourceType: "event" });
    expect(received).toEqual([{ id: "stable-id", resourceType: "node" }]);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(() => { (received[0] as { id: string }).id = "store-mutation"; }).toThrow(TypeError);
    release();
    await expect(pending).resolves.toBeUndefined();
  });

  it.each([
    null,
    { state: "unknown" },
    { state: "reserved", extra: true },
    { state: "conflict" },
    { state: "conflict", conflict: null },
    { state: "conflict", conflict: { requested: {}, existing: {}, extra: true } },
    {
      state: "conflict",
      conflict: {
        requested: { id: "different-id", resourceType: "node" },
        existing: { id: "different-id", resourceType: "event" },
      },
    },
    {
      state: "conflict",
      conflict: {
        requested: { id: "requested-id", resourceType: "node" },
        existing: { id: "another-id", resourceType: "event" },
      },
    },
  ])("rejects malformed storage result %#", async (result) => {
    await expect(
      reserveServerIds(
        { idReservations: { reserveAll: async () => result as never } },
        [{ id: "requested-id", resourceType: "node" }],
      ),
    ).rejects.toThrow(/store (?:returned|must)|does not match/u);
  });

  it("rejects an accessor-based reservation result", async () => {
    const result = {} as Record<string, unknown>;
    Object.defineProperty(result, "state", { enumerable: true, get: () => "reserved" });
    await expect(reserveServerIds(
      { idReservations: { reserveAll: async () => result as never } },
      [{ id: "accessor-result", resourceType: "node" }],
    )).rejects.toThrow(/invalid result/u);
  });

  it("requires reservation storage to return a native Promise", async () => {
    const reserveAll = (() => ({ state: "reserved" })) as unknown as ServerIdReservationStore["reserveAll"];
    await expect(
      reserveServerIds(
        { idReservations: { reserveAll } },
        [{ id: "promise-required", resourceType: "event" }],
      ),
    ).rejects.toThrow(/native Promise/u);
  });

  it("detaches and freezes conflict metadata returned by storage", async () => {
    const conflict: {
      requested: { id: string; resourceType: ResourceType };
      existing: { id: string; resourceType: ResourceType };
    } = {
      requested: { id: "conflicted-id", resourceType: "node" },
      existing: { id: "conflicted-id", resourceType: "collection" },
    };
    let caught!: ServerIdAlreadyReservedError;
    try {
      await reserveServerIds(
        { idReservations: { reserveAll: async () => ({ state: "conflict", conflict }) } },
        [conflict.requested],
      );
    } catch (error) {
      caught = error as ServerIdAlreadyReservedError;
    }

    conflict.existing.resourceType = "event";
    expect(caught).toBeInstanceOf(ServerIdAlreadyReservedError);
    expect(caught.conflict.existing.resourceType).toBe("collection");
    expect(Object.isFrozen(caught.conflict)).toBe(true);
    expect(Object.isFrozen(caught.conflict.requested)).toBe(true);
    expect(Object.isFrozen(caught.conflict.existing)).toBe(true);
  });

  it("fails closed when durable claim storage errors", async () => {
    const store = new AtomicPersistentIdentityStore();
    store.failClaims = true;
    await expect(
      store.create("collection", "storage-error-id"),
    ).rejects.toThrow("identity storage unavailable");
    expect(store.state.reservedIds.has("storage-error-id")).toBe(false);
    expect(store.state.resources.has("storage-error-id")).toBe(false);
  });

  it("does not expose a release or delete operation on the ledger", () => {
    type ReleaseApi = Extract<keyof ServerIdReservationStore, "release" | "delete">;
    const ledger: ServerIdReservationStore = {
      reserveAll: async () => ({ state: "reserved" }),
    };
    expectTypeOf<ReleaseApi>().toEqualTypeOf<never>();
    expect(Object.keys(ledger)).toEqual(["reserveAll"]);
    expect("release" in ledger).toBe(false);
    expect("delete" in ledger).toBe(false);
  });

  it("integrates the same ledger into Publisher and Sync atomic transactions", () => {
    type PublisherUsesLedger = PublisherTransaction extends {
      readonly idReservations: ServerIdReservationStore;
    }
      ? true
      : false;
    type SyncUsesLedger =
      SyncTransaction<unknown, unknown, unknown, unknown, unknown> extends {
        readonly idReservations: ServerIdReservationStore;
      }
        ? true
        : false;

    expectTypeOf<PublisherUsesLedger>().toEqualTypeOf<true>();
    expectTypeOf<SyncUsesLedger>().toEqualTypeOf<true>();
    expectTypeOf(executeIdempotentPublisherCreation)
      .parameter(0)
      .not.toMatchTypeOf<Set<string>>();
    expectTypeOf<Set<string>>().not.toMatchTypeOf<ServerIdReservationTransaction>();
  });

  it("publisher creation claims IDs inside its unit of work before writing resources", async () => {
    const calls: string[] = [];
    let reservedBatch: readonly ServerIdReservation[] = [];
    const transaction: PublisherTransaction = {
      resources: {},
      idReservations: {
        reserveAll: async (reservations) => {
          calls.push("identity");
          reservedBatch = reservations;
          return { state: "reserved" };
        },
      },
      idempotency: {
        claim: async () => ({ state: "claimed" }),
        complete: async () => undefined,
      },
      operations: { append: async () => undefined },
      audit: { append: async () => undefined },
      outbox: { append: async () => undefined },
    };
    const unitOfWork: PublisherUnitOfWork<PublisherTransaction> =
      {
        execute: async (work) => work(transaction),
      };
    const binding: IdempotencyBinding = {
      principalId: "principal-1",
      protocolVersion: "0.1",
      method: "POST",
      endpointKey: "nodes",
      resourceIdentity: "collection-1",
      key: "idempotency-1",
      requestDigest: "sha-256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };

    await executeIdempotentPublisherCreation(
      unitOfWork,
      binding,
      [
        { resourceType: "operation", id: "publisher-operation-id" },
        { resourceType: "node", id: "publisher-node-id" },
        { resourceType: "event", id: "publisher-event-id" },
      ],
      async () => {
        calls.push("write");
        return { status: 201, headers: {}, body: { id: "publisher-node-id" } };
      },
    );

    expect(calls).toEqual(["identity", "write"]);
    expect(reservedBatch.map(({ id }) => id)).toEqual([
      "publisher-operation-id",
      "publisher-node-id",
      "publisher-event-id",
    ]);
  });

  it("replays a committed creation without attempting another reservation", async () => {
    let reservationCalls = 0;
    let writeCalls = 0;
    const replayedResponse = {
      status: 201,
      headers: { Location: "/nodes/replayed-node-id" },
      body: { id: "replayed-node-id" },
    };
    const transaction: PublisherTransaction = {
      resources: {},
      idReservations: {
        reserveAll: async () => {
          reservationCalls += 1;
          return { state: "reserved" };
        },
      },
      idempotency: {
        claim: async () => ({ state: "replay", response: replayedResponse }),
        complete: async () => {
          throw new Error("a replay must not be completed again");
        },
      },
      operations: { append: async () => undefined },
      audit: { append: async () => undefined },
      outbox: { append: async () => undefined },
    };
    const unitOfWork: PublisherUnitOfWork<PublisherTransaction> = {
      execute: async (work) => work(transaction),
    };
    const replayBinding: IdempotencyBinding = {
      principalId: "principal-1",
      protocolVersion: "0.1",
      method: "POST",
      endpointKey: "nodes",
      resourceIdentity: "collection-1",
      key: "idempotency-replay",
      requestDigest: "sha-256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };

    await expect(
      executeIdempotentPublisherCreation(
        unitOfWork,
        replayBinding,
        [{ resourceType: "node", id: "replayed-node-id" }],
        async () => {
          writeCalls += 1;
          return replayedResponse;
        },
      ),
    ).resolves.toEqual({ state: "replayed", response: replayedResponse });
    expect(reservationCalls).toBe(0);
    expect(writeCalls).toBe(0);
  });
});

describe("Snapshot-local identity regression [evidence:core.server-id-uniqueness]", () => {
  it("still rejects a duplicate visible inside one Snapshot", async () => {
    const snapshot = await fixture("collection-snapshot.json");
    const annotation = snapshot.annotations[0];
    if (annotation === undefined)
      throw new Error("fixture must contain an annotation");
    (annotation as { id: string }).id = snapshot.collection.id;

    expect(validateSnapshotSemantics(snapshot).issues).toContainEqual(
      expect.objectContaining({
        code: "duplicate_live_id",
        path: "/annotations/0/id",
      }),
    );
  });

  it("still rejects a visible live/Tombstone overlap without proving lifetime uniqueness", async () => {
    const snapshot = await fixture("sync-snapshot.json");
    const liveNode = snapshot.nodes[1];
    if (liveNode === undefined)
      throw new Error("fixture must contain a live node");
    snapshot.tombstones.push({
      resourceType: "node",
      targetId: liveNode.id,
      collectionId: snapshot.collection.id,
      scope: "single",
      deletedAt: snapshot.generatedAt,
      deleteRevision: "delete-revision",
      operationId: "delete-operation",
      deleteCursor: "delete-cursor",
      affectedCount: 1,
      purgeAfter: snapshot.generatedAt,
    });

    expect(validateSnapshotSemantics(snapshot).issues).toContainEqual(
      expect.objectContaining({ code: "live_tombstone_overlap" }),
    );
  });
});
