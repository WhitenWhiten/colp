import type { AuthoritativeEffectPage, SyncPullEventV02, SyncPullV02 } from '@know-n/colp/types';
import type { JsonObject, PullPageInput } from './sync-state-store.js';
import type { PullApplierOptions, PullCursorAuthority } from './pull-applier-types.js';
import { colpCredentialHeaders } from './auth-client.js';
import { downloadAuthoritativeEffectPages } from './effect-page-download.js';
import { sessionTransportBudget } from './colp-transport-budget-browser.js';
import { readBoundedJson } from './json-response.js';
import { syncPullV02 } from './generated/pull-effect-validators.js';
import { withPullFreeze } from './pull-recovery-freeze.js';
import { assertUniqueEvents, byteLength, digest, plainJson, record, validateEffectPages,
  validatePullEvent } from './pull-codec.js';

type PullOperationEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;

export interface PullPageApplyRuntime {
  preflight(event: PullOperationEvent, stagedCreates: ReadonlySet<string>): Promise<void>;
  preflightMapping(colpId: string, stagedCreates: ReadonlySet<string>,
    role: 'member' | 'parent' | 'target'): Promise<unknown>;
  resume(): Promise<void>;
}

export function assertPullApplierGate(options: PullApplierOptions): void {
  if (options.session.acceptedProtocolVersion !== '0.2' || options.session.collectionId !== options.scope.collectionId
      || options.session.conversionPolicy?.separator !== 'preserve_remote'
      || !options.effectPageTemplate.includes('{effectId}') || !options.effectPageTemplate.includes('{pageNumber}')
      || new URL(options.effectPageTemplate.replace('{effectId}', 'probe').replace('{pageNumber}', '1')).origin
        !== options.effectPageAuthority) throw new Error('pull_effect_gate_closed');
}

export function createPullPageStager(options: PullApplierOptions, now: () => number,
  runtime: PullPageApplyRuntime) {
  async function pull(cursor: string): Promise<void> { await withPullFreeze(options, () => pullValidated(cursor)); }

  async function pullValidated(cursor: string): Promise<void> {
    assertPullApplierGate(options); if (!options.endpoints || !options.credential) throw new Error('pull_transport_unavailable');
    if (options.endpoints.syncEffectPages !== options.effectPageTemplate) throw new Error('effect_endpoint_binding_invalid');
    const endpoint = new URL(options.endpoints.syncPull); endpoint.searchParams.set('sessionId', options.session.sessionId);
    endpoint.searchParams.set('cursor', cursor);
    const headers = { Accept: 'application/json', ...colpCredentialHeaders(options.credential.accessToken), ...(options.origin ? { Origin: options.origin } : {}),
      'Known-Sync-Session': options.session.sessionId, 'Collection-Protocol-Version': '0.2' };
    const response = await (options.fetch ?? fetch)(endpoint, {
      redirect: 'error', cache: 'no-store', credentials: 'omit', headers,
    });
    if (!response.ok) throw new Error('pull_failed');
    const pullBytes = sessionTransportBudget(options.session).pullResponseBytes;
    const body = await readBoundedJson(response, pullBytes, 'pull_page_invalid') as Record<string, unknown>;
    if (!syncPullV02(body) || !Array.isArray(body.events)) throw new Error('pull_page_invalid');
    const validatedEvents = body.events.map((candidate) => validatePullEvent(candidate as SyncPullEventV02));
    assertUniqueEvents(validatedEvents);
    if (validatedEvents.some((candidate) => candidate.kind === 'operation'
      && (candidate.operation.collectionId !== options.scope.collectionId
        || candidate.effect.collectionId !== options.scope.collectionId))) throw new Error('pull_source_binding_invalid');
    const refs = validatedEvents.flatMap((candidate) => candidate.kind !== 'operation'
      || candidate.effect.kind !== 'subtree_deleted' || !('effectRef' in candidate.effect) || !candidate.effect.effectRef
      ? [] : [{ effectId: candidate.effect.effectId, pageCount: candidate.effect.effectRef.pageCount,
        memberCount: candidate.effect.effectRef.memberCount }]);
    const effectPages = refs.length === 0 ? [] : await downloadAuthoritativeEffectPages({
      scope: options.scope, store: options.store, refs,
      template: options.endpoints.syncEffectPages, authority: options.effectPageAuthority,
      headers, remainingBytes: sessionTransportBudget(options.session).effectAggregateBytes - byteLength(body),
      fetch: options.fetch ?? fetch, now,
    });
    await stage({ ...body, effectPages }, {
      reissued: response.headers.get('Known-Sync-Cursor-Reissued') === 'true',
    }); await runtime.resume();
  }

  async function stage(raw: unknown, cursorAuthority: PullCursorAuthority = {}): Promise<void> {
    await withPullFreeze(options, () => stageValidated(raw, cursorAuthority));
  }

  async function stageValidated(raw: unknown, cursorAuthority: PullCursorAuthority = {}): Promise<void> {
    assertPullApplierGate(options);
    if (!record(raw)) throw new Error('pull_page_invalid');
    let suppliedPages = Array.isArray(raw.effectPages) ? raw.effectPages : [];
    const response = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'effectPages'));
    if (!syncPullV02(response) || byteLength(response) > sessionTransportBudget(options.session).pullResponseBytes) {
      throw new Error('pull_page_invalid');
    }
    const pull = response as unknown as SyncPullV02;
    const pageRefs = pull.events.flatMap((candidate) => candidate.kind === 'operation'
      && candidate.effect.kind === 'subtree_deleted' && 'effectRef' in candidate.effect && candidate.effect.effectRef
      ? [{ effectId: candidate.effect.effectId, pageCount: candidate.effect.effectRef.pageCount }] : []);
    if (pageRefs.length && suppliedPages.length === 0) {
      if (!options.endpoints || !options.credential) throw new Error('effect_page_transport_unavailable');
      const headers = { Accept: 'application/json',
        ...colpCredentialHeaders(options.credential.accessToken), ...(options.origin ? { Origin: options.origin } : {}),
        'Known-Sync-Session': options.session.sessionId,
        'Collection-Protocol-Version': '0.2' };
      suppliedPages = await downloadAuthoritativeEffectPages({
        scope: options.scope, store: options.store,
        refs: pageRefs.map((ref) => {
          const event = pull.events.find((candidate) => candidate.kind === 'operation'
            && candidate.effect.effectId === ref.effectId);
          const memberCount = event && event.kind === 'operation' && 'effectRef' in event.effect
            && event.effect.effectRef ? event.effect.effectRef.memberCount : 0;
          return { ...ref, memberCount };
        }),
        template: options.endpoints.syncEffectPages, authority: options.effectPageAuthority,
        headers, remainingBytes: sessionTransportBudget(options.session).effectAggregateBytes,
        fetch: options.fetch ?? fetch, now,
      });
    }
    const seenCursors = new Set<string>();
    const seenOperations = new Set<string>(); const seenEffects = new Set<string>(); const seenConflicts = new Map<string, 'open' | 'resolved'>();
    // Nodes created earlier in this page have no mapping yet; neither do nodes
    // set aside earlier. Events about either stage normally and are decided at apply.
    const stagedCreates = new Set<string>((await options.store.listPullIssues(options.scope)).map((issue) => issue.nodeId));
    if (byteLength({ response, effectPages: suppliedPages })
        > sessionTransportBudget(options.session).effectAggregateBytes) throw new Error('pull_page_invalid');
    const effectPages: AuthoritativeEffectPage[] = suppliedPages.map((page) => plainJson(page) as unknown as AuthoritativeEffectPage);
    const stagedEvents: PullPageInput['events'][number][] = [];
    for (const candidate of pull.events) {
      const event = validatePullEvent(candidate);
      if (seenCursors.has(event.cursor)) throw new Error('pull_event_duplicate'); seenCursors.add(event.cursor);
      if (event.kind === 'conflict') {
        const prior = seenConflicts.get(event.conflict.id);
        // A dismiss publishes the resolution at a later commit, so both states
        // can occur on one page. Repeated states and backwards transitions fail.
        if (prior !== undefined && (prior !== 'open' || event.conflict.status !== 'resolved')) {
          throw new Error('pull_event_duplicate');
        }
        seenConflicts.set(event.conflict.id, event.conflict.status); const conflictDigest = digest(event.conflict);
        stagedEvents.push({ eventId: `${event.cursor}:conflict:${event.conflict.id}`, cursor: event.cursor,
          operationId: `conflict:${event.conflict.id}`, effectId: `conflict:${event.conflict.id}`,
          effectDigest: conflictDigest, operationDigest: conflictDigest, kind: 'conflict',
          payload: event as unknown as JsonObject, initialState: 'authority_committed' }); continue; }
      const eventId = `${event.cursor}:${event.operation.opId}`;
      if (seenOperations.has(event.operation.opId) || seenEffects.has(event.effect.effectId)) {
        throw new Error('pull_event_duplicate');
      }
      seenOperations.add(event.operation.opId); seenEffects.add(event.effect.effectId);
      if (event.operation.collectionId !== options.scope.collectionId || event.effect.collectionId !== options.scope.collectionId) {
        throw new Error('pull_source_binding_invalid');
      }
      if (event.operation.replicaId === options.scope.replicaId
          && event.operation.source?.adapterProfile === 'known-conflict-resolution') {
        const queued = (await options.store.listQueue(options.scope, undefined, event.operation.sequence - 1, 1))[0];
        if (queued?.sequence === event.operation.sequence && queued.opId !== event.operation.opId
            && queued.status !== 'terminal' && queued.status !== 'rejected') {
          // Old deployments allocated server resolutions from this browser's
          // lane. Preserve the unexecuted intent and expose the rebuild exit.
          throw new Error('legacy_resolution_sequence_collision');
        }
      }
      const pages = effectPages.filter((page) => page.effectId === event.effect.effectId);
      if (event.effect.kind === 'subtree_deleted' && 'effectRef' in event.effect && event.effect.effectRef) {
        validateEffectPages(pages, { ...event.effect.effectRef, effectId: event.effect.effectId });
        for (const member of pages.flatMap((page) => page.members)) {
          await runtime.preflightMapping(member, stagedCreates, 'member');
        }
      } else if (pages.length) throw new Error('unexpected_effect_page');
      await runtime.preflight(event, stagedCreates);
      if (event.effect.kind === 'node_created' || event.effect.kind === 'node_restored') stagedCreates.add(event.effect.node.id);
      const localEvent = event.effect.kind === 'subtree_deleted' && 'effectRef' in event.effect && event.effect.effectRef
        ? { ...event, verifiedMembers: pages.flatMap((page) => page.members) } : event;
      stagedEvents.push({ eventId, cursor: event.cursor, operationId: event.operation.opId,
        effectId: event.effect.effectId, effectDigest: event.effect.effectDigest,
        operationDigest: event.effect.operationDigest, kind: event.effect.kind,
        payload: plainJson(localEvent) });
    }
    const [cursorRow, scopeRow, leftoverPages] = await Promise.all([
      options.store.getCursor(options.scope), options.store.getScope(options.scope),
      options.store.listPullPages(options.scope, ['staged'])]);
    const previousCursor = cursorRow?.cursor ?? scopeRow?.checkpoint?.cursor;
    if (!previousCursor) throw new Error('pull_cursor_missing');
    if (leftoverPages.some((page) => page.previousCursor === previousCursor)) throw new Error('pull_page_pending');
    const cursorChanged = pull.nextCursor !== previousCursor;
    if ((pull.events.length === 0 && cursorChanged !== (cursorAuthority.reissued === true))
        || (pull.events.length > 0 && pull.events.at(-1)?.cursor !== pull.nextCursor)) {
      throw new Error('pull_cursor_chain_invalid');
    }
    const pageId = digest({ previousCursor, nextCursor: pull.nextCursor, events: stagedEvents.map((event) => event.eventId) });
    const localSequenceFloor = pull.events.reduce((floor, event) => event.kind === 'operation'
      && event.operation.replicaId === options.scope.replicaId
      ? Math.max(floor, event.operation.sequence + 1) : floor, 0);
    if (localSequenceFloor > 0) await options.store.advanceSequenceFloor(options.scope, localSequenceFloor);
    await options.store.stagePullPage(options.scope, { pageId, previousCursor, nextCursor: pull.nextCursor,
      collectionRevision: pull.collectionRevision, pageDigest: digest(response), events: stagedEvents,
      effectPages: effectPages.map((page) => { const source = pull.events.find((event) => event.kind === 'operation'
        && event.effect.effectId === page.effectId) as Extract<SyncPullEventV02, { kind: 'operation' }> | undefined;
        return { eventId: `${source?.cursor ?? 'missing'}:${source?.operation.opId ?? 'missing'}`, effectId: page.effectId,
        pageNumber: page.pageNumber, pageDigest: page.pageDigest, previousPageDigest: page.previousPageDigest,
        payload: page as unknown as JsonObject }; }) });
    const leaseGeneration = scopeRow?.lease.generation;
    await options.store.putScopeDiagnostic(options.scope, { kind: 'pull_page_authority', code: pageId, details: {
      pageId, previousCursor, authorityGeneration: scopeRow?.generation ?? options.scope.generation,
      ...(typeof leaseGeneration === 'string' ? { leaseGeneration } : {}) } });
  }

  return Object.freeze({ pull, stage });
}
