import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  EventEnvelopeRegistry,
  OutboxDeliveryError,
  OutboxRouter,
  createReportsOutboxRoutes,
  reportsEnvelopeRegistrations,
  validateReportsSeriesChangedV1,
  validateReportsSourceInvalidatedV1,
} from '../../../src/infrastructure/outbox/index.js';

const seriesPayload = {
  contentRevision: 'c1', policyRevision: 'p1', resourceRevision: 'r1',
  seriesId: 'series-1', state: 'active', visibility: 'public',
};

function context(eventType: string, payload: Record<string, unknown>, aggregateType: string, aggregateId: string, scope: string | null) {
  return {
    envelope: {
      event_id: 'event-1', event_type: eventType, event_version: 1,
      aggregate_identity: { aggregate_type: aggregateType, aggregate_id: aggregateId, aggregate_scope: scope },
      aggregate_revision: 'r1', commit_ordinal: '1', occurred_at: '2026-09-04T00:00:00Z', payload,
    }, idempotencyKey: 'event-1', signal: new AbortController().signal,
  } as const;
}

describe('ND-13A report outbox consumer contract', () => {
  test('registers all four closed envelopes and route classes', () => {
    const registry = new EventEnvelopeRegistry(reportsEnvelopeRegistrations);
    const envelope = context('reports.series.changed@1', seriesPayload, 'digest_series', 'series-1', 'series-1').envelope;
    assert.equal(registry.validate(envelope).event_type, 'reports.series.changed@1');
    assert.equal(reportsEnvelopeRegistrations.length, 4);
    const routes = createReportsOutboxRoutes({
      seriesChanged: async () => {}, editionChanged: async () => {},
      sourceInvalidated: async () => {}, publicSurfacePurge: async () => {},
    });
    const inspection = new OutboxRouter(routes).durabilityInspection();
    assert.equal(inspection.routeCount, 4);
    assert.equal(inspection.reportPublicSurfacePurge.allDurable, true);
  });

  test('rejects unknown fields and malformed source bindings before dispatch', async () => {
    assert.equal(validateReportsSeriesChangedV1({ ...seriesPayload, extra: true }), false);
    let called = false;
    const route = createReportsOutboxRoutes({
      seriesChanged: async () => { called = true; }, editionChanged: async () => {},
      sourceInvalidated: async () => {}, publicSurfacePurge: async () => {},
    })[0]!;
    await assert.rejects(route.handle(context('reports.series.changed@1', seriesPayload, 'collection', 'series-1', 'series-1')), OutboxDeliveryError);
    assert.equal(called, false);
  });

  test('rejects unsafe report payload text and non-plain payload objects', () => {
    assert.equal(validateReportsSeriesChangedV1({
      ...seriesPayload, seriesId: ' series-1',
    }), false);
    assert.equal(validateReportsSeriesChangedV1({
      ...seriesPayload, seriesId: 'series-\u0000',
    }), false);
    const sourceEventPayload = {
      collectionId: 'collection-1', contentRevision: 'c1', policyRevision: 'p1',
      sourceEventType: 'collection.updated\n', sourceEventVersion: 1,
    };
    assert.equal(validateReportsSourceInvalidatedV1(sourceEventPayload), false);
    class Payload {}
    const classPayload = Object.assign(new Payload(), seriesPayload);
    assert.equal(validateReportsSeriesChangedV1(classPayload), false);
  });
});
