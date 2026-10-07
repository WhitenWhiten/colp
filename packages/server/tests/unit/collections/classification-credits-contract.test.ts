import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';

const root = new URL('../../../../docs/plans/active/cross-module/classification-credits/contracts/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const schema = read('wire.schema.json');
const fixtures = read('golden.json') as { name: string; schema: string; value: Record<string, unknown> }[];
const matrix = read('endpoint-matrix.json');
const api = parse(readFileSync(new URL('../../../openapi/product-v1.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validate = (name: string, value: unknown) => ajv.validate(`${schema.$id}#/$defs/${name}`, value);

describe('CR-00 credits.v1-r2 frozen draft', () => {
  test.each(fixtures)('$name satisfies its shared wire schema', fixture => {
    expect(validate(fixture.schema, fixture.value), JSON.stringify(ajv.errors)).toBe(true);
  });

  test('new and historical receipt branches are exclusive and closed', () => {
    for (const kind of ['preview', 'run']) {
      const legacy = fixtures.find(f => f.name === `legacy-${kind}`)!;
      const current = fixtures.find(f => f.name === `managed-${kind}`)!;
      const legacySchema = kind === 'preview' ? 'LegacyClassificationPreviewResponse' : 'LegacyClassificationRun';
      const currentSchema = kind === 'preview' ? 'CreditClassificationPreviewResponse' : 'CreditClassificationRun';
      expect(validate(currentSchema, legacy.value)).toBe(false);
      expect(validate(legacySchema, current.value)).toBe(false);
      expect(validate(current.schema, { ...current.value, balance: 100 })).toBe(false);
    }
  });

  test('points, sequences, nulls and billing consent reject ambiguous values', () => {
    for (const value of [-1, 0.1, 2147483648, '1', null]) expect(validate('Points', value)).toBe(false);
    for (const value of ['01', '-1', '1e3', 1]) expect(validate('Sequence', value)).toBe(false);
    expect(validate('Sequence', '9007199254740993')).toBe(true);
    expect(validate('CreditBillingConsent', { priceVersion: 'bookmark-classify.v1', maxPoints: 1 })).toBe(true);
    for (const value of [{ priceVersion: 'bookmark-classify.v1' }, { priceVersion: 'A', maxPoints: 1 },
      { priceVersion: 'bookmark-classify.v1', maxPoints: 1, charge: 0 }]) {
      expect(validate('CreditBillingConsent', value)).toBe(false);
    }
    const entry = fixtures.find(f => f.name === 'expired-release')!.value;
    const { expiresAt: _expiresAt, ...missingNull } = entry;
    expect(validate('CreditLedgerEntry', missingNull)).toBe(false);
  });

  test('existing endpoint methods, operation IDs and success statuses remain fixed', () => {
    for (const route of matrix.routes as { method: string; path: string; operationId: string; status: number; change: string }[]) {
      if (route.change === 'new') continue;
      const operation = api.paths[route.path][route.method.toLowerCase()];
      expect(operation.operationId).toBe(route.operationId);
      expect(operation.responses[String(route.status)]).toBeDefined();
    }
    expect(new Set(matrix.routes.map((route: { operationId: string }) => route.operationId)).size).toBe(8);
  });

  test('golden financial deltas and quoted usage reconcile independently of DTO validation', () => {
    for (const fixture of fixtures) {
      const usage = fixture.value.creditUsage as Record<string, number> | undefined;
      if (usage) expect(usage.quotedPoints).toBe(usage.reservedPoints + usage.chargedPoints + usage.releasedPoints);
    }
    const page = fixtures.find(f => f.name === 'ledger')!.value;
    for (const entry of page.items as { pointsDelta: number; availableDelta: number; reservedDelta: number }[]) {
      expect(entry.pointsDelta).toBe(entry.availableDelta + entry.reservedDelta);
    }
  });
});
