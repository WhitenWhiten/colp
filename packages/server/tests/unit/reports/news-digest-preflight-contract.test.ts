import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(backendRoot, 'tests/fixtures/reports');
const repositoryRoot = resolve(backendRoot, '..');
const adrPath = resolve(repositoryRoot, 'docs/decisions/reports-news-digest-preflight-adr.md');

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as Record<string, unknown>;
}

function validateFixture(dataName: string, schemaName: string): void {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schema = readJson(schemaName);
  const data = readJson(dataName);
  const validate = ajv.compile(schema);
  assert.equal(validate(data), true, `${dataName}: ${ajv.errorsText(validate.errors)}`);
}

test('ND-01 ADR and machine-readable fixtures are present and schema-valid', () => {
  const adr = readFileSync(adrPath, 'utf8');
  assert.match(adr, /live reference/u);
  assert.match(adr, /63/u);
  assert.match(adr, /public source/u);
  assert.match(adr, /explicit indexing opt-in/u);
  assert.match(adr, /Search、Feed、OG.*Non-Goal/u);
  validateFixture('news-digest-terminology.v1.json', 'news-digest-terminology.v1.schema.json');
  validateFixture('news-digest-acceptance.v1.json', 'news-digest-acceptance.v1.schema.json');
});

test('ND-01 terminology has one canonical vocabulary and no snapshot alias', () => {
  const fixture = readJson('news-digest-terminology.v1.json') as {
    terms: Array<{ canonical: string; forbidden: string[] }>;
  };
  const canonical = fixture.terms.map((term) => term.canonical);
  assert.equal(new Set(canonical).size, canonical.length);
  assert.ok(canonical.includes('live reference'));
  assert.ok(canonical.includes('DigestEdition'));
  assert.ok(fixture.terms.find((term) => term.canonical === 'DigestEdition')?.forbidden.includes('snapshot'));
});

test('ND-01 acceptance fixture covers every frozen decision and boundary', () => {
  const fixture = readJson('news-digest-acceptance.v1.json') as {
    scenarios: Array<{ id: string; decision: string; indexable?: boolean; validation?: string }>;
  };
  const decisions = new Set(fixture.scenarios.map((scenario) => scenario.decision));
  for (const decision of ['live-reference', 'slug-63-limit', 'public-source', 'explicit-indexing-opt-in', 'non-goals']) {
    assert.ok(decisions.has(decision), `missing ${decision} scenario`);
  }
  assert.ok(fixture.scenarios.some((scenario) => scenario.id === 'ND01-SLUG-001' && scenario.validation === 'accept'));
  assert.ok(fixture.scenarios.some((scenario) => scenario.id === 'ND01-SLUG-002' && scenario.validation === 'reject'));
  assert.ok(fixture.scenarios.some((scenario) => scenario.id === 'ND01-INDEX-001' && scenario.indexable === true));
  assert.ok(fixture.scenarios.some((scenario) => scenario.id === 'ND01-INDEX-003' && scenario.indexable === false));
});
