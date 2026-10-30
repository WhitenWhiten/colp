import { createLane } from '../automation/lane.js';
import { record } from '../automation/closed-value.js';
import { deviceResultPage } from '../automation/device-bridge-result.js';
import { sourceDigest } from './source-db.js';
import type { SiteAgentManagement } from './agent-runtime.js';
import type { TransportState } from './transport.js';
import type { SiteCollection } from './contracts.js';

export function createSiteAgentManager(ports: {
  ready(): Promise<void>; state(): Promise<TransportState>; configuration(): Promise<unknown>;
  archive: { valid(raw: unknown): boolean; handle(raw: unknown, guard?: () => Promise<void>): Promise<unknown> };
  connection(enabled: boolean, guard: () => Promise<void>): Promise<void>;
  collections(): Promise<{ items: readonly SiteCollection[]; nextCursor: string | null; reading?: boolean; failed?: string | null } | null>;
  readCollections(cursor: string | null): Promise<unknown>; importStatus(): Promise<unknown>; wake(): void;
}) {
  const lane = createLane();
  const snapshot = async () => {
    const [state, configuration] = await Promise.all([ports.state(), ports.configuration()]);
    const revision = sourceDigest({ enabled: state.enabled, generation: state.generation, sourceGeneration: state.sourceGeneration,
      accountId: state.accountId, candidateAccount: state.candidateAccount, sourceUnresolved: state.sourceUnresolved, configuration: configuration ?? null });
    return { state, configuration: configuration ?? null, revision };
  };
  return (input: SiteAgentManagement) => lane(async () => {
    await input.assertCurrent(); await ports.ready();
    const before = await snapshot();
    const guard = async () => {
      await input.assertCurrent();
      if (typeof input.revision !== 'string' || (await snapshot()).revision !== input.revision) throw Error('adapter_configuration_changed');
    };
    if (input.operation === 'configuration') return { revision: before.revision, enabled: before.state.enabled,
      connected: !!before.state.accountId && !before.state.sourceUnresolved, sourceAccount: before.state.accountId,
      candidateAccount: before.state.candidateAccount, configuration: before.configuration };
    if (input.operation === 'collections') {
      if (input.request?.mode === 'refresh') {
        await guard();
        const sourceCursor = input.request.sourceCursor;
        if (sourceCursor !== undefined && sourceCursor !== null && typeof sourceCursor !== 'string') throw Error('invalid_cursor');
        return ports.readCollections(typeof sourceCursor === 'string' ? sourceCursor : null);
      }
      const catalog = await ports.collections();
      if (!catalog) return { items: [], nextCursor: null, sourceCursor: null, reading: false, reason: 'refreshCatalogRequired', revision: before.revision };
      const digest = sourceDigest({ configuration: before.revision, items: catalog.items });
      let start = 0;
      if (input.cursor) {
        let cursor: unknown; try { cursor = JSON.parse(input.cursor); } catch { throw Error('invalid_cursor'); }
        if (!record(cursor) || cursor.digest !== digest || !Number.isSafeInteger(cursor.index)
          || Number(cursor.index) < 0 || Number(cursor.index) >= catalog.items.length) throw Error('invalid_cursor');
        start = Number(cursor.index) + 1;
      }
      return deviceResultPage(input.requestId, catalog.items.slice(start), { revision: before.revision,
        sourceCursor: catalog.nextCursor, reading: catalog.reading ?? false, problem: catalog.failed ?? null }, {
        cursorFor: item => JSON.stringify({ digest, index: catalog.items.indexOf(item) }),
      });
    }
    if (input.operation === 'import_get') {
      const job = await ports.importStatus();
      if (!record(job)) return { job: null };
      return { job: Object.fromEntries(['id', 'phase', 'reason', 'authorization', 'selected', 'progress', 'preview', 'coverage', 'omissions', 'approvalId']
        .filter(key => job[key] !== undefined).map(key => [key, job[key]])) };
    }
    await guard();
    let raw: unknown;
    if (input.operation === 'configure') {
      if (input.request?.operation === 'enable' && typeof input.request.enabled === 'boolean') {
        await ports.connection(input.request.enabled, guard);
        const current = await snapshot(); return { revision: current.revision, enabled: current.state.enabled, configured: true };
      }
      const { operation, ...change } = input.request ?? {};
      raw = operation === 'archive' ? { ...change, kind: 'known.siteAdapters.archive.configure' }
        : operation === 'disable_archive' ? { kind: 'known.siteAdapters.archive.disable' } : null;
    } else if (input.operation === 'import_preview') raw = { kind: 'known.siteAdapters.import.start' };
    else if (input.operation === 'import_approve') raw = { ...input.request, kind: 'known.siteAdapters.import.approve' };
    else throw Error('adapter_operation_unsupported');
    if (!ports.archive.valid(raw)) throw Error('adapter_configuration_invalid');
    const result = await ports.archive.handle(raw, guard);
    ports.wake();
    return { revision: (await snapshot()).revision, result };
  });
}
