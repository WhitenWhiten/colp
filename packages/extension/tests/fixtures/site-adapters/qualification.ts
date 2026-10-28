import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { validateAdapterImplementation, validateSiteDefinitions } from '../../../src/site-adapters/registry-validation.js';
import { validAdapterMessage, validPageResult, validMembershipResult } from '../../../src/site-adapters/schemas.js';
import { createPageContext } from '../../../src/site-adapters/page-context.js';
import { withReadDeadline } from '../../../src/site-adapters/read-errors.js';
import type { SiteDefinition } from '../../../src/site-adapters/registry-types.js';
import type { SiteAdapter, SiteItem, SiteCollection, ReadContext, AdapterContext } from '../../../src/site-adapters/contracts.js';

/** Reuse for a future adapter with sanitized fixtures. Does not register or enable that site. */
export function qualifySiteAdapter(input: {
  definition: SiteDefinition; accountId: string; item: SiteItem; collection: SiteCollection;
  setup(): SiteAdapter | Promise<SiteAdapter>; cleanup?(): void;
}) {
  describe(`adapter contract: ${input.definition.adapterId}`, () => {
    let adapter: SiteAdapter, context: ReadContext & AdapterContext, controller: AbortController;
    beforeEach(async () => {
      controller = new AbortController(); adapter = await input.setup();
      context = { ...createPageContext({ document, signal: controller.signal, accountId: input.accountId, deadlineAt: Date.now() + 10000,
        routeEpoch: 0, routeEvent: 'fixture-route', controls: false, emit: async () => ({ status: 'accepted', receiptId: 'fixture' }),
        hint: async () => ({ status: 'accepted', receiptId: 'fixture' }), requestCapture: async () => { throw Error('unexpectedHostEffect'); } }), readSessionId: 'fixture-session' };
    });
    afterEach(() => { controller.abort(); adapter?.clear?.(); input.cleanup?.(); });
    test('declares usable host capabilities and a stable source/content identity', async () => {
      expect(validateSiteDefinitions([input.definition])).toHaveLength(1); validateAdapterImplementation(input.definition, adapter);
      expect(input.definition.validateAccount(input.accountId)).toBe(true); expect(input.definition.validateItem(input.item)).toBe(true);
      expect(input.definition.validateCollection(input.collection.id)).toBe(true);
      expect(input.definition.itemUrl(input.item.id)).toBe(input.item.url);
      expect(await withReadDeadline(() => adapter.detectSource(context), context)).toMatchObject({ state: 'signedIn', accountId: input.accountId });
    });
    if (input.definition.capabilities.includes('resolveItem')) test('resolves fixture content through the closed transport schema', async () => {
      const result = await withReadDeadline(() => adapter.resolveItem!(context, input.item.url), context);
      expect(result).toMatchObject({ status: 'resolved', item: { id: input.item.id, url: input.item.url } });
      const message = { protocolVersion: 1 as const, requestId: 'resolve', leaseId: 'lease', capability: 'fixture', operation: 'item.result' as const, resolutionId: 'resolve', result };
      expect(validAdapterMessage(message) && input.definition.validateMessage(message)).toBe(true);
    });
    if (input.definition.capabilities.includes('enumerateCollections')) test('enumerates bounded, validated collection pages', async () => {
      const page = await withReadDeadline(() => adapter.readCollectionsPage!(context, null), context);
      expect(validPageResult({ status: 'ok', kind: 'collections', page })).toBe(true);
      expect(page.items.some(c => c.id === input.collection.id)).toBe(true);
      expect(page.items.every(c => input.definition.validateCollection(c.id))).toBe(true);
      if (input.definition.collectionHierarchy !== undefined) expect(page.items.every(c => c.parentId === null)).toBe(true);
    });
    if (input.definition.capabilities.includes('enumerateItems')) test('enumerates bounded content and replays a continuation without changing its payload', async () => {
      const first = await withReadDeadline(() => adapter.readItemsPage!(context, input.collection.id, null), context);
      expect(validPageResult({ status: 'ok', kind: 'items', collectionId: input.collection.id, page: first })).toBe(true);
      expect(first.items.every(row => input.definition.validateItem(row.item))).toBe(true);
      expect(first.items.some(row => row.item.id === input.item.id)).toBe(true);
      if (first.nextCursor) {
        const next = await adapter.readItemsPage!(context, input.collection.id, first.nextCursor);
        expect(await adapter.readItemsPage!(context, input.collection.id, first.nextCursor)).toEqual(next);
      }
    });
    if (input.definition.capabilities.includes('readMemberships')) test('readback honors the declared negative-evidence boundary', async () => {
      const query = { itemId: input.item.id, collectionIds: [input.collection.id] };
      const result = await withReadDeadline(() => adapter.readMemberships!(context, query), context);
      expect(validMembershipResult(result, query)).toBe(true); expect(result.status).toBe('ok');
      if (result.status === 'ok' && !input.definition.negativeReadback) expect(result.edges.some(edge => edge.state === 'absent')).toBe(false);
      controller.abort();
      await expect(withReadDeadline(() => adapter.readMemberships!(context, query), context)).rejects.toThrow('cancelled');
    });
  });
}
