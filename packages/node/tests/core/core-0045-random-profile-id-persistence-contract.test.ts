import { describe, expect, expectTypeOf, it } from 'vitest';

import * as adapterApi from '../../src/adapters/index.js';
import * as rootApi from '../../src/adapters/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import * as serverApi from '../../src/server/index.js';
import {
  getOrCreateRandomProfileId,
  type LocalProfileIdAllocator,
  type LocalProfileIdStore,
} from '../../src/adapters/index.js';
import type { ProfileIdRandomBytes, RandomProfileIdOptions } from '../../src/server/index.js';

const evidence = '[evidence:core.random-profile-id-persistence]';
const randomProfileIdPattern = /^prf\.r1\.[A-Za-z0-9_-]{43}$/u;

function entropy(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function entropySequence(...outputs: readonly Uint8Array[]): {
  readonly randomBytes: ProfileIdRandomBytes;
  readonly requestedLengths: number[];
} {
  const requestedLengths: number[] = [];
  let index = 0;
  return {
    requestedLengths,
    randomBytes: (length) => {
      requestedLengths.push(length);
      const output = outputs[index];
      index += 1;
      if (output === undefined) throw new Error('unexpected entropy request');
      return output;
    },
  };
}

function expectedId(byte: number): string {
  return `prf.r1.${Buffer.from(entropy(byte)).toString('base64url')}`;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface DurableProfileState {
  readonly ids: Map<string, string>;
  queue: Promise<void>;
}

function durableState(entries: readonly (readonly [string, string])[] = []): DurableProfileState {
  return { ids: new Map(entries), queue: Promise.resolve() };
}

/** Deterministic stand-in for a database uniqueness constraint plus transaction. */
class AtomicMemoryProfileIdStore implements LocalProfileIdStore {
  constructor(private readonly state: DurableProfileState) {}

  getOrCreate(localProfileKey: string, allocate: LocalProfileIdAllocator): Promise<string> {
    const operation = this.state.queue.then(() => {
      const existing = this.state.ids.get(localProfileKey);
      if (existing !== undefined) return existing;
      const profileId = allocate();
      this.state.ids.set(localProfileKey, profileId);
      return profileId;
    });
    this.state.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function expectWireRandomProfileId(value: string): void {
  expect(value).toMatch(randomProfileIdPattern);
  expect(value.length).toBeLessThanOrEqual(128);
  expect(createValidatorRegistry().validate('opaqueId', value)).toEqual({ valid: true, errors: [] });
}

describe(`CORE-0045 random profile ID persistence ${evidence}`, () => {
  it('persists the first CSPRNG allocation before exposing it to the caller', async () => {
    const staged = deferred();
    const allowCommit = deferred();
    const committed = deferred();
    const allowReturn = deferred();
    const durable = new Map<string, string>();
    const source = entropySequence(entropy(0x11));
    const store: LocalProfileIdStore = {
      async getOrCreate(key, allocate) {
        const candidate = allocate();
        staged.resolve();
        await allowCommit.promise;
        durable.set(key, candidate);
        committed.resolve();
        await allowReturn.promise;
        return candidate;
      },
    };
    let exposed: string | undefined;

    const pending = getOrCreateRandomProfileId('chromium:Default', store, {
      randomBytes: source.randomBytes,
    }).then((value) => {
      exposed = value;
      return value;
    });
    await staged.promise;
    expect(source.requestedLengths).toEqual([32]);
    expect(durable.size).toBe(0);
    expect(exposed).toBeUndefined();

    allowCommit.resolve();
    await committed.promise;
    expect(durable.get('chromium:Default')).toBe(expectedId(0x11));
    expect(exposed).toBeUndefined();

    allowReturn.resolve();
    await expect(pending).resolves.toBe(expectedId(0x11));
    expectWireRandomProfileId(exposed as string);
  });

  it('reuses one durable ID across repeated calls and a restart-like store instance', async () => {
    const state = durableState();
    const source = entropySequence(entropy(0x21));

    const first = await getOrCreateRandomProfileId(
      'firefox:default-release',
      new AtomicMemoryProfileIdStore(state),
      { randomBytes: source.randomBytes },
    );
    const repeated = await getOrCreateRandomProfileId(
      'firefox:default-release',
      new AtomicMemoryProfileIdStore(state),
      { randomBytes: source.randomBytes },
    );
    const afterRestart = await getOrCreateRandomProfileId(
      'firefox:default-release',
      new AtomicMemoryProfileIdStore(state),
      { randomBytes: source.randomBytes },
    );

    expect([first, repeated, afterRestart]).toEqual([
      expectedId(0x21),
      expectedId(0x21),
      expectedId(0x21),
    ]);
    expect(source.requestedLengths).toEqual([32]);
    expect(state.ids).toEqual(new Map([['firefox:default-release', expectedId(0x21)]]));
  });

  it('resolves concurrent initializers to one durable ID with exactly one allocation', async () => {
    const state = durableState();
    const store = new AtomicMemoryProfileIdStore(state);
    const source = entropySequence(entropy(0x31));

    const first = getOrCreateRandomProfileId('edge:Profile 1', store, {
      randomBytes: source.randomBytes,
    });
    const concurrent = getOrCreateRandomProfileId('edge:Profile 1', store, {
      randomBytes: source.randomBytes,
    });

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      expectedId(0x31),
      expectedId(0x31),
    ]);
    expect(source.requestedLengths).toEqual([32]);
    expect(state.ids).toEqual(new Map([['edge:Profile 1', expectedId(0x31)]]));
  });

  it('isolates different local profiles in the same durable store', async () => {
    const state = durableState();
    const store = new AtomicMemoryProfileIdStore(state);
    const source = entropySequence(entropy(0x41), entropy(0x42));

    const first = await getOrCreateRandomProfileId('chromium:Default', store, {
      randomBytes: source.randomBytes,
    });
    const second = await getOrCreateRandomProfileId('chromium:Profile 1', store, {
      randomBytes: source.randomBytes,
    });

    expect(first).toBe(expectedId(0x41));
    expect(second).toBe(expectedId(0x42));
    expect(first).not.toBe(second);
    expect(source.requestedLengths).toEqual([32, 32]);
    expect(state.ids).toEqual(
      new Map([
        ['chromium:Default', expectedId(0x41)],
        ['chromium:Profile 1', expectedId(0x42)],
      ]),
    );
  });

  it('returns no candidate when durable storage or commit fails', async () => {
    const source = entropySequence(entropy(0x51));
    const durable = new Map<string, string>();
    const store: LocalProfileIdStore = {
      async getOrCreate(_key, allocate) {
        allocate();
        throw new Error('commit failed');
      },
    };
    let exposed: string | undefined;

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, {
        randomBytes: source.randomBytes,
      }).then((value) => {
        exposed = value;
        return value;
      }),
    ).rejects.toThrow('commit failed');
    expect(exposed).toBeUndefined();
    expect(durable.size).toBe(0);
    expect(source.requestedLengths).toEqual([32]);
  });

  it('fails closed when the store cannot determine whether commit succeeded', async () => {
    const source = entropySequence(entropy(0x54));
    let exposed: string | undefined;
    const store: LocalProfileIdStore = {
      async getOrCreate(_key, allocate) {
        allocate();
        throw new Error('commit outcome unknown');
      },
    };

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, {
        randomBytes: source.randomBytes,
      }).then((value) => {
        exposed = value;
        return value;
      }),
    ).rejects.toThrow('commit outcome unknown');
    expect(exposed).toBeUndefined();
    expect(source.requestedLengths).toEqual([32]);
  });

  it('propagates a storage read failure without requesting entropy', async () => {
    const source = entropySequence(entropy(0x55));
    const store: LocalProfileIdStore = {
      async getOrCreate() {
        throw new Error('storage unavailable');
      },
    };

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, {
        randomBytes: source.randomBytes,
      }),
    ).rejects.toThrow('storage unavailable');
    expect(source.requestedLengths).toEqual([]);
  });

  it('allows a fresh allocation after a never-exposed failed transaction', async () => {
    const source = entropySequence(entropy(0x52), entropy(0x53));
    let attempts = 0;
    const state = durableState();
    const store: LocalProfileIdStore = {
      async getOrCreate(key, allocate) {
        attempts += 1;
        if (attempts === 1) {
          allocate();
          throw new Error('rolled back');
        }
        const profileId = allocate();
        state.ids.set(key, profileId);
        return profileId;
      },
    };

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, { randomBytes: source.randomBytes }),
    ).rejects.toThrow('rolled back');
    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, { randomBytes: source.randomBytes }),
    ).resolves.toBe(expectedId(0x53));
    expect(state.ids.get('chromium:Default')).toBe(expectedId(0x53));
    expect(source.requestedLengths).toEqual([32, 32]);
  });

  it.each([
    ['empty', ''],
    ['raw local label', 'Default'],
    ['wrong random version', `prf.r2.${Buffer.from(entropy(1)).toString('base64url')}`],
    ['short random payload', 'prf.r1.AQ'],
    ['non-base64url payload', `prf.r1.${'+'.repeat(43)}`],
    [
      'noncanonical base64url final quantum',
      `${expectedId(1).slice(0, -1)}R`,
    ],
    ['HMAC profile ID', `prf.h1.v1.${Buffer.from(entropy(2)).toString('base64url')}`],
  ])('rejects a malformed or non-random stored ID: %s', async (_label, stored) => {
    let allocations = 0;
    const store: LocalProfileIdStore = {
      async getOrCreate() {
        return stored;
      },
    };

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, {
        randomBytes: () => {
          allocations += 1;
          return entropy(0x61);
        },
      }),
    ).rejects.toThrow(TypeError);
    expect(allocations).toBe(0);
  });

  it.each([
    ['empty string', ''],
    ['NUL', 'chromium\u0000Default'],
    ['unpaired surrogate', 'chromium:\ud800'],
    ['number', 1],
    ['missing', undefined],
  ])('rejects an invalid local profile key: %s', async (_label, key) => {
    let storeCalls = 0;
    const store: LocalProfileIdStore = {
      async getOrCreate() {
        storeCalls += 1;
        return expectedId(0x62);
      },
    };

    await expect(
      getOrCreateRandomProfileId(key as string, store, { randomBytes: () => entropy(0x62) }),
    ).rejects.toThrow(TypeError);
    expect(storeCalls).toBe(0);
  });

  it.each([
    ['null', null],
    ['number', 1],
    ['ordinary object', {}],
    ['missing method', { get: () => undefined }],
    ['non-callable method', { getOrCreate: true }],
  ])('rejects an invalid profile ID store: %s', async (_label, store) => {
    let entropyCalls = 0;

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store as LocalProfileIdStore, {
        randomBytes: () => {
          entropyCalls += 1;
          return entropy(0x63);
        },
      }),
    ).rejects.toThrow(TypeError);
    expect(entropyCalls).toBe(0);
  });

  it.each([
    ['non-function', null],
    ['ordinary object', {}],
    ['Promise result', () => Promise.resolve(entropy(0x64))],
    ['short result', () => new Uint8Array(31)],
  ])('rejects an invalid entropy provider on the allocation path: %s', async (_label, provider) => {
    const store = new AtomicMemoryProfileIdStore(durableState());

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, {
        randomBytes: provider as ProfileIdRandomBytes,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('does not inspect or invoke an entropy provider when a valid ID is already durable', async () => {
    const state = durableState([['chromium:Default', expectedId(0x65)]]);
    let calls = 0;

    await expect(
      getOrCreateRandomProfileId('chromium:Default', new AtomicMemoryProfileIdStore(state), {
        randomBytes: (() => {
          calls += 1;
          throw new Error('must not request entropy');
        }) as ProfileIdRandomBytes,
      }),
    ).resolves.toBe(expectedId(0x65));
    expect(calls).toBe(0);
  });

  it('rejects a store that invokes the one-shot allocator twice even if it swallows the error', async () => {
    const source = entropySequence(entropy(0x71), entropy(0x72));
    let secondError: unknown;
    const store: LocalProfileIdStore = {
      async getOrCreate(_key, allocate) {
        const first = allocate();
        try {
          allocate();
        } catch (error) {
          secondError = error;
        }
        return first;
      },
    };

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, { randomBytes: source.randomBytes }),
    ).rejects.toThrow(TypeError);
    expect(secondError).toBeInstanceOf(TypeError);
    expect(source.requestedLengths).toEqual([32]);
  });

  it('rejects a store that allocates speculatively but returns a different durable ID', async () => {
    const source = entropySequence(entropy(0x72));
    const store: LocalProfileIdStore = {
      async getOrCreate(_key, allocate) {
        allocate();
        return expectedId(0x73);
      },
    };

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, { randomBytes: source.randomBytes }),
    ).rejects.toThrow(TypeError);
    expect(source.requestedLengths).toEqual([32]);
  });

  it('permits exactly one asynchronous in-scope allocator callback before persistence', async () => {
    const source = entropySequence(entropy(0x73));
    const beforeAllocate = deferred();
    const state = durableState();
    const store: LocalProfileIdStore = {
      async getOrCreate(key, allocate) {
        await beforeAllocate.promise;
        const profileId = allocate();
        state.ids.set(key, profileId);
        return profileId;
      },
    };

    const pending = getOrCreateRandomProfileId('chromium:Default', store, {
      randomBytes: source.randomBytes,
    });
    expect(source.requestedLengths).toEqual([]);
    beforeAllocate.resolve();
    await expect(pending).resolves.toBe(expectedId(0x73));
    expect(state.ids.get('chromium:Default')).toBe(expectedId(0x73));
    expect(source.requestedLengths).toEqual([32]);
  });

  it('closes the allocator when the store promise settles', async () => {
    let escapedAllocator: LocalProfileIdAllocator | undefined;
    const source = entropySequence(entropy(0x74), entropy(0x75));
    const store: LocalProfileIdStore = {
      async getOrCreate(_key, allocate) {
        escapedAllocator = allocate;
        return allocate();
      },
    };

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, { randomBytes: source.randomBytes }),
    ).resolves.toBe(expectedId(0x74));
    expect(() => escapedAllocator?.()).toThrow(TypeError);
    expect(source.requestedLengths).toEqual([32]);
  });

  it('propagates an asynchronously rejected store operation without exposing an ID', async () => {
    const rejection = deferred();
    const source = entropySequence(entropy(0x76));
    const store: LocalProfileIdStore = {
      async getOrCreate(_key, allocate) {
        allocate();
        await rejection.promise;
        throw new Error('transaction aborted');
      },
    };
    let exposed: string | undefined;

    const pending = getOrCreateRandomProfileId('chromium:Default', store, {
      randomBytes: source.randomBytes,
    }).then((value) => {
      exposed = value;
      return value;
    });
    expect(exposed).toBeUndefined();
    rejection.resolve();
    await expect(pending).rejects.toThrow('transaction aborted');
    expect(exposed).toBeUndefined();
    expect(source.requestedLengths).toEqual([32]);
  });

  it('rejects a store that does not return a Promise', async () => {
    const store = {
      getOrCreate(_key: string, allocate: LocalProfileIdAllocator): string {
        return allocate();
      },
    } as unknown as LocalProfileIdStore;
    const source = entropySequence(entropy(0x77));

    await expect(
      getOrCreateRandomProfileId('chromium:Default', store, { randomBytes: source.randomBytes }),
    ).rejects.toThrow(TypeError);
    expect(source.requestedLengths).toEqual([32]);
  });

  it('does not mutate caller options, entropy, profile keys, or the store object', async () => {
    const entropyBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const entropyBefore = entropyBytes.slice();
    const key = 'firefox:\u7528\u6237-profile';
    const seenKeys: string[] = [];
    const store = Object.freeze<LocalProfileIdStore>({
      async getOrCreate(receivedKey, allocate) {
        seenKeys.push(receivedKey);
        return allocate();
      },
    });
    const options = Object.freeze<RandomProfileIdOptions>({ randomBytes: () => entropyBytes });

    const profileId = await getOrCreateRandomProfileId(key, store, options);

    expectWireRandomProfileId(profileId);
    expect(seenKeys).toEqual([key]);
    expect(entropyBytes).toEqual(entropyBefore);
    expect(options.randomBytes).toBeDefined();
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.isFrozen(options)).toBe(true);
  });

  it('rejects the naive load-then-save shape that permits concurrent double allocation', async () => {
    let loadCalls = 0;
    let saveCalls = 0;
    const legacyStore = {
      async load() {
        loadCalls += 1;
        return undefined;
      },
      async save() {
        saveCalls += 1;
      },
    };
    let entropyCalls = 0;

    await expect(
      getOrCreateRandomProfileId('chromium:Default', legacyStore as unknown as LocalProfileIdStore, {
        randomBytes: () => {
          entropyCalls += 1;
          return entropy(0x78);
        },
      }),
    ).rejects.toThrow(TypeError);
    expect(loadCalls).toBe(0);
    expect(saveCalls).toBe(0);
    expect(entropyCalls).toBe(0);
  });

  it('publishes the adapter persistence boundary and exact callable types', () => {
    expect(adapterApi.getOrCreateRandomProfileId).toBe(getOrCreateRandomProfileId);
    expect(rootApi.getOrCreateRandomProfileId).toBe(getOrCreateRandomProfileId);
    expect(serverApi).not.toHaveProperty('getOrCreateRandomProfileId');
    expectTypeOf<LocalProfileIdAllocator>().toEqualTypeOf<() => string>();
    expectTypeOf<LocalProfileIdStore['getOrCreate']>().toEqualTypeOf<
      (localProfileKey: string, allocate: LocalProfileIdAllocator) => Promise<string>
    >();
    expectTypeOf(getOrCreateRandomProfileId).parameters.toEqualTypeOf<
      [localProfileKey: string, store: LocalProfileIdStore, options?: RandomProfileIdOptions]
    >();
    expectTypeOf(getOrCreateRandomProfileId).returns.toEqualTypeOf<Promise<string>>();
  });
});
