import { describe, expect, it, vi } from 'vitest';

import {
  coordinateSessionBoundPull,
  createSyncSession,
  rejectPrivateOrLocalSnapshotUrl,
  requireVerifiedSyncSession,
  withRecommendedSnapshotUrlHostPolicy,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventReadRequest,
  type SyncPullEventStore,
  type SyncPullRequestContext,
  type SyncPullSnapshotUrlOptions,
  type SyncPullSnapshotUrlSafetyAssert,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';
import {
  coordinateSyncPull,
} from '../../src/sync/unsafe.js';

/**
 * Expired Pull recovery Snapshot URL host / SSRF policy (SYNC-V-007 extension).
 *
 * Exercises the real `coordinateSyncPull` expired-cursor path (same fixture
 * pattern as pull-snapshot-url-hardening.test.ts). Production contract:
 * - optional `assertSnapshotUrlSafe` on `SyncPullSnapshotUrlOptions`
 * - hook runs only after scheme + userinfo transport checks
 * - throw to reject; exceptions propagate from the coordinator
 * - `rejectPrivateOrLocalSnapshotUrl` is the built-in pure hostname rejector
 */

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

function request(overrides: Partial<SyncPullRequestContext> = {}): SyncPullRequestContext {
  return {
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    cursor: 'cursor-expired',
    limit: 10,
    ...overrides,
  };
}

function expiredCursor(snapshotUrl: string): SyncPullCursorRecord {
  return {
    cursor: 'cursor-expired',
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    commitOrdinal: '100',
    state: 'expired',
    snapshotUrl,
  };
}

class MemoryCursorStore implements SyncPullCursorStore {
  constructor(private readonly record: SyncPullCursorRecord) {}

  async resolveCursor(cursor: string): Promise<SyncPullCursorRecord | null> {
    await Promise.resolve();
    return cursor === this.record.cursor ? copy(this.record) : null;
  }
}

class TrackingEventStore implements SyncPullEventStore {
  readonly reads: SyncPullEventReadRequest[] = [];

  async readCommittedAfter(candidate: SyncPullEventReadRequest): Promise<SyncPullEventPage> {
    await Promise.resolve();
    this.reads.push(copy(candidate));
    return {
      entries: [],
      hasMore: false,
      collectionRevision: 'revision-1',
      recommendedPullAfterSeconds: 0,
    };
  }
}

async function pullExpired(
  snapshotUrl: string,
  options?: SyncPullSnapshotUrlOptions,
): Promise<{
  readonly result: Awaited<ReturnType<typeof coordinateSyncPull>>;
  readonly events: TrackingEventStore;
}> {
  const events = new TrackingEventStore();
  const cursors = new MemoryCursorStore(expiredCursor(snapshotUrl));
  const result = await coordinateSyncPull(request(), cursors, events, options);
  return { result, events };
}

async function expectExpiredRejects(
  snapshotUrl: string,
  options: SyncPullSnapshotUrlOptions | undefined,
  message: RegExp,
): Promise<void> {
  const events = new TrackingEventStore();
  const cursors = new MemoryCursorStore(expiredCursor(snapshotUrl));
  await expect(coordinateSyncPull(request(), cursors, events, options)).rejects.toThrow(message);
  expect(events.reads).toHaveLength(0);
}

const privateLocalMessage =
  /localhost|private|local|loopback|link.?local|metadata|not allowed|forbidden|snapshotUrl|SSRF/i;

describe('expired Pull Snapshot URL host / SSRF policy', () => {
  describe('default (no assertSnapshotUrlSafe hook)', () => {
    it('still accepts absolute https Snapshot URLs without reading events', async () => {
      const snapshotUrl = 'https://sync.example/snapshots/latest';
      const { result, events } = await pullExpired(snapshotUrl);

      expect(result).toMatchObject({
        ok: false,
        status: 410,
        problem: {
          status: 410,
          code: 'sync_cursor_expired',
          snapshotUrl,
          retryable: false,
        },
      });
      expect(events.reads).toHaveLength(0);
    });

    it('still rejects cleartext http Snapshot URLs by default', async () => {
      await expectExpiredRejects(
        'http://sync.example/snapshots/latest',
        undefined,
        /http|insecure|Snapshot URL|snapshotUrl|HTTPS/i,
      );
    });

    it('does not apply private/local rejection unless assertSnapshotUrlSafe is installed', async () => {
      // Backward-compatible transport-only default: private IP literals remain
      // accepted when no host policy hook is configured.
      const snapshotUrl = 'https://127.0.0.1/snapshots/latest';
      const { result, events } = await pullExpired(snapshotUrl);

      expect(result).toMatchObject({
        ok: false,
        status: 410,
        problem: { code: 'sync_cursor_expired', snapshotUrl },
      });
      expect(events.reads).toHaveLength(0);
    });
  });

  describe('built-in rejectPrivateOrLocalSnapshotUrl', () => {
    const privateOrLocalUrls = [
      'http://127.0.0.1/snapshots/latest',
      'https://127.0.0.1/snapshots/latest',
      'https://localhost/snapshots/latest',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.1/snapshots/latest',
      'https://192.168.1.1/snapshots/latest',
      'https://172.16.0.1/snapshots/latest',
    ] as const;

    it.each(privateOrLocalUrls)(
      'rejects private/local Snapshot URL %s on the expired path',
      async (snapshotUrl) => {
        const options = {
          // http://127.0.0.1 needs insecure opt-in so the host policy is the subject.
          allowInsecureSnapshotUrl: snapshotUrl.startsWith('http:'),
          assertSnapshotUrlSafe: rejectPrivateOrLocalSnapshotUrl,
        } satisfies SyncPullSnapshotUrlOptions;

        await expectExpiredRejects(snapshotUrl, options, privateLocalMessage);
      },
    );

    it('accepts a public hostname Snapshot URL when used as assertSnapshotUrlSafe', async () => {
      const snapshotUrl = 'https://snapshots.example.com/collections/c1/snapshots/latest';
      const { result, events } = await pullExpired(snapshotUrl, {
        assertSnapshotUrlSafe: rejectPrivateOrLocalSnapshotUrl,
      } satisfies SyncPullSnapshotUrlOptions);

      expect(result).toMatchObject({
        ok: false,
        status: 410,
        problem: {
          status: 410,
          code: 'sync_cursor_expired',
          snapshotUrl,
          retryable: false,
        },
      });
      expect(events.reads).toHaveLength(0);
    });

    it('can be invoked directly without reimplementing IP classification in tests', () => {
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://10.0.0.1/x'));
      }).toThrow(privateLocalMessage);

      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://127.0.0.1/x'));
      }).toThrow(privateLocalMessage);

      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://localhost/x'));
      }).toThrow(privateLocalMessage);

      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://169.254.169.254/x'));
      }).toThrow(privateLocalMessage);

      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://192.168.1.1/x'));
      }).toThrow(privateLocalMessage);

      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://172.16.0.1/x'));
      }).toThrow(privateLocalMessage);

      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://snapshots.example.com/x'));
      }).not.toThrow();
    });

    it('rejects CGNAT 100.64.0.0/10 and decimal/hex single-number IPv4 loopback forms', () => {
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://100.64.0.1/x'));
      }).toThrow(privateLocalMessage);
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://100.127.255.254/x'));
      }).toThrow(privateLocalMessage);
      // 100.63.0.1 is outside CGNAT and not RFC1918 — not blocked by pure helper.
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://100.63.0.1/x'));
      }).not.toThrow();

      // 2130706433 = 127.0.0.1; 0x7f000001 likewise (when URL keeps host as-is).
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://2130706433/x'));
      }).toThrow(privateLocalMessage);

      // Node URL may lowercase hex hosts; exercise the helper via hostname string path.
      const hexUrl = new URL('https://example.com/x');
      Object.defineProperty(hexUrl, 'hostname', { value: '0x7f000001' });
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(hexUrl);
      }).toThrow(privateLocalMessage);
    });

    it('rejects IPv4-mapped IPv6, ULA, link-local, and unspecified host forms', () => {
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://[::ffff:10.0.0.1]/x'));
      }).toThrow(privateLocalMessage);
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://[::ffff:127.0.0.1]/x'));
      }).toThrow(privateLocalMessage);
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://[fc00::1]/x'));
      }).toThrow(privateLocalMessage);
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://[fe80::1]/x'));
      }).toThrow(privateLocalMessage);
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://0.0.0.0/x'));
      }).toThrow(privateLocalMessage);
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://0.1.2.3/x'));
      }).toThrow(privateLocalMessage);

      // Public IPv4-mapped counterexample remains allowed.
      expect(() => {
        rejectPrivateOrLocalSnapshotUrl(new URL('https://[::ffff:203.0.113.10]/x'));
      }).not.toThrow();
    });
  });

  describe('withRecommendedSnapshotUrlHostPolicy', () => {
    it('installs rejectPrivateOrLocalSnapshotUrl when the hook is omitted', async () => {
      const policy = withRecommendedSnapshotUrlHostPolicy();
      expect(policy.assertSnapshotUrlSafe).toBe(rejectPrivateOrLocalSnapshotUrl);

      await expectExpiredRejects(
        'https://127.0.0.1/snapshots/latest',
        policy,
        privateLocalMessage,
      );

      const snapshotUrl = 'https://snapshots.example.com/ok';
      const { result } = await pullExpired(snapshotUrl, policy);
      expect(result).toMatchObject({
        ok: false,
        problem: { code: 'sync_cursor_expired', snapshotUrl },
      });
    });

    it('preserves an explicit host hook (including intentional no-op)', async () => {
      const custom = vi.fn<SyncPullSnapshotUrlSafetyAssert>(() => undefined);
      const policy = withRecommendedSnapshotUrlHostPolicy({
        assertSnapshotUrlSafe: custom,
      });
      expect(policy.assertSnapshotUrlSafe).toBe(custom);

      const snapshotUrl = 'https://127.0.0.1/snapshots/latest';
      const { result } = await pullExpired(snapshotUrl, policy);
      expect(custom).toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        problem: { code: 'sync_cursor_expired', snapshotUrl },
      });
    });
  });

  describe('session-bound Pull default host policy', () => {
    function copyValue<Value>(value: Value): Value {
      return structuredClone(value);
    }

    class DurableMemorySessionStore implements SyncSessionStore {
      public constructor(private readonly state: Map<string, SyncSessionRecord> = new Map()) {}

      public async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
        await Promise.resolve();
        const existing = this.state.get(session.sessionId);
        if (existing !== undefined) return copyValue({ state: 'conflict', session: existing });
        const stored = copyValue(session);
        this.state.set(session.sessionId, stored);
        return copyValue({ state: 'created', session: stored });
      }

      public async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
        await Promise.resolve();
        const session = this.state.get(sessionId);
        return session === undefined ? undefined : copyValue(session);
      }

      public async terminate(
        termination: SyncSessionTermination,
      ): Promise<SyncSessionRecord | undefined> {
        await Promise.resolve();
        const existing = this.state.get(termination.sessionId);
        if (existing === undefined) return undefined;
        if (existing.status === 'terminated') return copyValue(existing);
        const terminated: SyncSessionRecord = {
          ...copyValue(existing),
          status: 'terminated',
          terminationReason: termination.reason,
          terminatedAt: termination.terminatedAt,
        };
        this.state.set(termination.sessionId, terminated);
        return copyValue(terminated);
      }
    }

    function sessionInput(): CreateSyncSessionInput {
      return {
        sessionId: 'session-1',
        principal: { type: 'user', id: 'alice' },
        credential: { kind: 'token', id: 'token-1' },
        oauthClientId: 'https://client.example/app',
        origin: 'https://client.example',
        sessionScope: 'collection',
        protocolVersion: '0.1',
        collectionId: 'collection-1',
        purpose: null,
        authorizationScopes: ['sync:pull', 'sync:push'],
      };
    }

    function sessionVerify(input: CreateSyncSessionInput): VerifySyncSessionContextInput {
      return {
        sessionId: input.sessionId,
        binding: {
          principal: copyValue(input.principal),
          credential: copyValue(input.credential),
          oauthClientId: input.oauthClientId,
          origin: input.origin,
          sessionScope: input.sessionScope,
          protocolVersion: input.protocolVersion,
          collectionId: input.collectionId,
          purpose: input.purpose,
        },
        authorization: {
          credentialActive: true,
          authorizationScopes: [...input.authorizationScopes],
        },
        terminatedAt: '2026-07-18T02:00:00Z',
      };
    }

    it('defaults private/local Snapshot URLs to fail-closed without an explicit hook', async () => {
      const store = new DurableMemorySessionStore();
      const input = sessionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, sessionVerify(input));
      const events = new TrackingEventStore();
      const cursors = new MemoryCursorStore(expiredCursor('https://127.0.0.1/snapshots/latest'));

      await expect(
        coordinateSessionBoundPull(
          { kind: 'verified', session: verified },
          request(),
          cursors,
          events,
        ),
      ).rejects.toThrow(privateLocalMessage);
      expect(events.reads).toHaveLength(0);
    });

    it('still accepts public https Snapshot URLs on the session-bound default path', async () => {
      const store = new DurableMemorySessionStore();
      const input = sessionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, sessionVerify(input));
      const events = new TrackingEventStore();
      const snapshotUrl = 'https://snapshots.example.com/ok';
      const cursors = new MemoryCursorStore(expiredCursor(snapshotUrl));

      const outcome = await coordinateSessionBoundPull(
        { kind: 'verified', session: verified },
        request(),
        cursors,
        events,
      );
      expect(outcome.result).toMatchObject({
        ok: false,
        problem: { code: 'sync_cursor_expired', snapshotUrl },
      });
      expect(events.reads).toHaveLength(0);
    });

    it('allows an explicit no-op hook to opt out of the default private rejector', async () => {
      const store = new DurableMemorySessionStore();
      const input = sessionInput();
      await createSyncSession(store, input);
      const verified = await requireVerifiedSyncSession(store, sessionVerify(input));
      const events = new TrackingEventStore();
      const snapshotUrl = 'https://127.0.0.1/snapshots/latest';
      const cursors = new MemoryCursorStore(expiredCursor(snapshotUrl));

      const outcome = await coordinateSessionBoundPull(
        { kind: 'verified', session: verified },
        request(),
        cursors,
        events,
        { assertSnapshotUrlSafe: () => undefined },
      );
      expect(outcome.result).toMatchObject({
        ok: false,
        problem: { code: 'sync_cursor_expired', snapshotUrl },
      });
      expect(events.reads).toHaveLength(0);
    });
  });

  describe('custom assertSnapshotUrlSafe hook', () => {
    it('lets hosts reject even public hostnames (allowlist style)', async () => {
      const allowlist: SyncPullSnapshotUrlSafetyAssert = (url) => {
        if (url.hostname !== 'snapshots.example.com') {
          throw new TypeError('Expired Sync Cursor snapshotUrl host is not on the allowlist.');
        }
      };

      await expectExpiredRejects(
        'https://evil.example.com/snapshots/latest',
        { assertSnapshotUrlSafe: allowlist } satisfies SyncPullSnapshotUrlOptions,
        /allowlist|host|policy|denied|not allowed|forbidden|snapshotUrl/i,
      );

      const snapshotUrl = 'https://snapshots.example.com/snapshots/latest';
      const { result, events } = await pullExpired(snapshotUrl, {
        assertSnapshotUrlSafe: allowlist,
      } satisfies SyncPullSnapshotUrlOptions);

      expect(result).toMatchObject({
        ok: false,
        status: 410,
        problem: { code: 'sync_cursor_expired', snapshotUrl },
      });
      expect(events.reads).toHaveLength(0);
    });

    it('is not called when the protocol is already invalid', async () => {
      const assertSnapshotUrlSafe = vi.fn<SyncPullSnapshotUrlSafetyAssert>(() => undefined);

      await expectExpiredRejects(
        'http://snapshots.example.com/snapshots/latest',
        { assertSnapshotUrlSafe } satisfies SyncPullSnapshotUrlOptions,
        /http|insecure|Snapshot URL|snapshotUrl|HTTPS/i,
      );
      expect(assertSnapshotUrlSafe).not.toHaveBeenCalled();
    });

    it('is not called when userinfo credentials are already invalid', async () => {
      const assertSnapshotUrlSafe = vi.fn<SyncPullSnapshotUrlSafetyAssert>(() => undefined);

      await expectExpiredRejects(
        'https://alice:secret@snapshots.example.com/snapshots/latest',
        { assertSnapshotUrlSafe } satisfies SyncPullSnapshotUrlOptions,
        /userinfo|user information|credentials|username|password/i,
      );
      expect(assertSnapshotUrlSafe).not.toHaveBeenCalled();
    });

    it('is not called for non-HTTP(S) schemes even with insecure opt-in', async () => {
      const assertSnapshotUrlSafe = vi.fn<SyncPullSnapshotUrlSafetyAssert>(() => undefined);

      await expectExpiredRejects(
        'file:///var/sync/snapshots/latest',
        {
          allowInsecureSnapshotUrl: true,
          assertSnapshotUrlSafe,
        } satisfies SyncPullSnapshotUrlOptions,
        /absolute HTTP|Snapshot URL|snapshotUrl|scheme/i,
      );
      expect(assertSnapshotUrlSafe).not.toHaveBeenCalled();
    });

    it('surfaces hook throws as rejection on the expired coordinateSyncPull path', async () => {
      const assertSnapshotUrlSafe: SyncPullSnapshotUrlSafetyAssert = () => {
        throw new TypeError('custom host policy refused Snapshot URL');
      };
      const events = new TrackingEventStore();
      const cursors = new MemoryCursorStore(
        expiredCursor('https://snapshots.example.com/snapshots/latest'),
      );

      await expect(
        coordinateSyncPull(request(), cursors, events, {
          assertSnapshotUrlSafe,
        } satisfies SyncPullSnapshotUrlOptions),
      ).rejects.toThrow(/custom host policy refused Snapshot URL/);
      expect(events.reads).toHaveLength(0);
    });

    it('receives the parsed URL and the original raw snapshotUrl string', async () => {
      const assertSnapshotUrlSafe = vi.fn<SyncPullSnapshotUrlSafetyAssert>(() => undefined);
      const snapshotUrl = 'https://snapshots.example.com/snapshots/latest';

      const { result, events } = await pullExpired(snapshotUrl, {
        assertSnapshotUrlSafe,
      } satisfies SyncPullSnapshotUrlOptions);

      expect(assertSnapshotUrlSafe).toHaveBeenCalledTimes(1);
      const [urlArg, rawArg] = assertSnapshotUrlSafe.mock.calls[0] ?? [];
      expect(urlArg).toBeInstanceOf(URL);
      expect(urlArg?.href).toBe(snapshotUrl);
      expect(rawArg).toBe(snapshotUrl);
      expect(result).toMatchObject({
        ok: false,
        problem: { code: 'sync_cursor_expired', snapshotUrl },
      });
      expect(events.reads).toHaveLength(0);
    });
  });

  describe('export surface', () => {
    it('exposes rejectPrivateOrLocalSnapshotUrl and withRecommendedSnapshotUrlHostPolicy', () => {
      expect(typeof rejectPrivateOrLocalSnapshotUrl).toBe('function');
      expect(typeof withRecommendedSnapshotUrlHostPolicy).toBe('function');
    });

    it('accepts assertSnapshotUrlSafe on SyncPullSnapshotUrlOptions', async () => {
      const options = {
        allowInsecureSnapshotUrl: false,
        assertSnapshotUrlSafe: rejectPrivateOrLocalSnapshotUrl,
      } satisfies SyncPullSnapshotUrlOptions;

      const snapshotUrl = 'https://snapshots.example.com/ok';
      const { result, events } = await pullExpired(snapshotUrl, options);
      expect(result).toMatchObject({
        ok: false,
        problem: { code: 'sync_cursor_expired', snapshotUrl },
      });
      expect(events.reads).toHaveLength(0);
    });
  });
});
