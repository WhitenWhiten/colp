/**
 * P1-14: Phase 1 editor performance threshold fixture schema + fail-closed comparison.
 *
 * Production loader: loadPhase1PerformanceThresholds (fail closed on missing/corrupt).
 * Comparator: compareMeasurementsToThresholds from production evidence module (shared with runner).
 * Engineering-trial thresholds must not be relaxed to zeros or above product 4 MiB page budget.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, test } from 'vitest';
import {
  compareMeasurementsToThresholds,
  defaultPhase1ThresholdsPath,
  loadPhase1PerformanceThresholds,
} from '../../../scripts/evidence/index.js';
import { EDITOR_PAGE_MAX_BYTES } from '../../../src/modules/collections/index.js';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = resolve(root, 'tests/fixtures/phase1/performance-thresholds.json');
const schemaPath = resolve(root, 'tests/fixtures/phase1/performance-thresholds.schema.json');

const PRODUCT_MAX_PAGE_BYTES = 4 * 1024 * 1024;
const REQUIRED_NODE_COUNT = 10_000;

type ThresholdKey =
  | 'editorPageP95Ms'
  | 'fullAssemblyMs'
  | 'maxPageBytes'
  | 'maxHeapDeltaBytes'
  | 'sameCollectionLockWaitP95Ms'
  | 'crossCollectionParallelMs';

type ThresholdMap = Record<ThresholdKey, number>;

interface PerformanceThresholdsFixture {
  readonly $schema: string;
  readonly environment: {
    readonly runtime: string;
    readonly database?: string;
    readonly warmupIterations: number;
    readonly measuredIterations: number;
    readonly concurrency: number;
    readonly nodeCount: number;
    readonly pageLimit: number;
  };
  readonly thresholds: ThresholdMap;
}

const THRESHOLD_KEYS: readonly ThresholdKey[] = [
  'editorPageP95Ms',
  'fullAssemblyMs',
  'maxPageBytes',
  'maxHeapDeltaBytes',
  'sameCollectionLockWaitP95Ms',
  'crossCollectionParallelMs',
] as const;

function loadFixture(): PerformanceThresholdsFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as PerformanceThresholdsFixture;
}

function loadSchema(): object {
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
}

function compileValidator() {
  return new Ajv2020({ strict: true, allErrors: true }).compile(loadSchema());
}

describe('P1-14 performance-thresholds fixture schema', () => {
  test('committed fixture validates and locks engineering-trial 10k / 4 MiB contract', () => {
    const fixture = loadFixture();
    const validate = compileValidator();
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));

    assert.equal(fixture.$schema, './performance-thresholds.schema.json');
    assert.equal(fixture.environment.runtime, 'node-22');
    assert.equal(fixture.environment.nodeCount, REQUIRED_NODE_COUNT);
    assert.equal(fixture.environment.pageLimit, 200);
    assert.ok(fixture.environment.measuredIterations >= 10);
    assert.ok(fixture.environment.concurrency >= 1);

    assert.equal(fixture.thresholds.maxPageBytes, PRODUCT_MAX_PAGE_BYTES);
    assert.ok(fixture.thresholds.maxPageBytes <= EDITOR_PAGE_MAX_BYTES);
    for (const key of THRESHOLD_KEYS) {
      const value = fixture.thresholds[key];
      assert.equal(typeof value, 'number', key);
      assert.ok(Number.isFinite(value), key);
      if (key === 'maxHeapDeltaBytes') {
        assert.ok(value >= 0, key);
      } else {
        assert.ok(value > 0, `${key} must be strictly positive (no zero relaxation)`);
      }
    }
  });

  test('production loadPhase1PerformanceThresholds accepts committed fixture and fails closed on corrupt', () => {
    assert.equal(defaultPhase1ThresholdsPath(root), fixturePath);
    const loaded = loadPhase1PerformanceThresholds(fixturePath);
    assert.equal(loaded.environment.nodeCount, REQUIRED_NODE_COUNT);
    assert.equal(loaded.thresholds.maxPageBytes, PRODUCT_MAX_PAGE_BYTES);

    const dir = mkdtempSync(join(tmpdir(), 'known-p114-'));
    const corruptPath = join(dir, 'broken.json');
    writeFileSync(corruptPath, '\u0000\u0000\u0000', 'utf8');
    assert.throws(
      () => loadPhase1PerformanceThresholds(corruptPath),
      /corrupt JSON|unreadable|must be a JSON object/i,
    );
    unlinkSync(corruptPath);

    const zeroPath = join(dir, 'zero-thresholds.json');
    const base = loadFixture();
    writeFileSync(zeroPath, JSON.stringify({
      ...base,
      thresholds: { ...base.thresholds, editorPageP95Ms: 0 },
    }), 'utf8');
    // Loader currently requires finite numbers only; schema rejects zero. Unit evidence
    // still asserts that 0 is not a valid engineering-trial latency threshold via Ajv.
    const zeroLoaded = loadPhase1PerformanceThresholds(zeroPath);
    assert.equal(zeroLoaded.thresholds.editorPageP95Ms, 0);
    const validate = compileValidator();
    assert.equal(validate(zeroLoaded), false, 'zero latency threshold must fail schema');
    unlinkSync(zeroPath);

    assert.throws(
      () => loadPhase1PerformanceThresholds(join(dir, 'missing.json')),
      /missing or unreadable/i,
    );
  });

  test('rejects missing required top-level and threshold fields', () => {
    const validate = compileValidator();
    const base = loadFixture();

    assert.equal(validate({}), false);
    assert.equal(validate({ $schema: base.$schema, environment: base.environment }), false);
    assert.equal(validate({ $schema: base.$schema, thresholds: base.thresholds }), false);

    const missingThreshold = {
      ...base,
      thresholds: { ...base.thresholds },
    } as { thresholds: Partial<ThresholdMap> };
    delete missingThreshold.thresholds.editorPageP95Ms;
    assert.equal(validate(missingThreshold), false);

    const missingEnv = {
      ...base,
      environment: { ...base.environment },
    } as { environment: Partial<PerformanceThresholdsFixture['environment']> };
    delete missingEnv.environment.nodeCount;
    assert.equal(validate(missingEnv), false);
  });

  test('rejects zero / relaxed non-positive latency thresholds (fail closed at schema)', () => {
    const validate = compileValidator();
    const base = loadFixture();

    for (const key of THRESHOLD_KEYS) {
      if (key === 'maxHeapDeltaBytes') continue; // exclusiveMinimum not applied; minimum 0 allowed
      const relaxed = {
        ...base,
        thresholds: { ...base.thresholds, [key]: 0 },
      };
      assert.equal(validate(relaxed), false, `zero ${key} must fail schema`);
    }

    // Negative values also rejected for exclusiveMinimum fields
    const negative = {
      ...base,
      thresholds: { ...base.thresholds, editorPageP95Ms: -1 },
    };
    assert.equal(validate(negative), false);

    // Wrong $schema const
    const wrongSchema = { ...base, $schema: './other.schema.json' };
    assert.equal(validate(wrongSchema), false);

    // Wrong runtime const
    const wrongRuntime = {
      ...base,
      environment: { ...base.environment, runtime: 'node-20' },
    };
    assert.equal(validate(wrongRuntime), false);
  });

  test('rejects measuredIterations below schema minimum and invalid concurrency', () => {
    const validate = compileValidator();
    const base = loadFixture();

    assert.equal(validate({
      ...base,
      environment: { ...base.environment, measuredIterations: 9 },
    }), false);

    assert.equal(validate({
      ...base,
      environment: { ...base.environment, concurrency: 0 },
    }), false);

    assert.equal(validate({
      ...base,
      environment: { ...base.environment, concurrency: 33 },
    }), false);
  });
});

describe('P1-14 threshold comparison fails closed', () => {
  test('each measurement exactly equal to its threshold passes', () => {
    const thresholds = loadFixture().thresholds;
    for (const key of THRESHOLD_KEYS) {
      const result = compareMeasurementsToThresholds({
        [key]: thresholds[key],
      }, thresholds);
      assert.equal(result.pass, false, `${key} alone must fail closed on missing keys`);
    }
    const result = compareMeasurementsToThresholds({
      editorPageP95Ms: thresholds.editorPageP95Ms,
      fullAssemblyMs: thresholds.fullAssemblyMs,
      maxPageBytes: thresholds.maxPageBytes,
      maxHeapDeltaBytes: thresholds.maxHeapDeltaBytes,
      sameCollectionLockWaitP95Ms: thresholds.sameCollectionLockWaitP95Ms,
      crossCollectionParallelMs: thresholds.crossCollectionParallelMs,
    }, thresholds);
    assert.equal(result.pass, true);
    assert.deepEqual(result.violations, []);
  });

  test('any single measurement above threshold fails closed with that key', () => {
    const thresholds = loadFixture().thresholds;
    const base: ThresholdMap = { ...thresholds };

    for (const key of THRESHOLD_KEYS) {
      const measurements: ThresholdMap = {
        ...base,
        [key]: thresholds[key] + 1,
      };
      const result = compareMeasurementsToThresholds(measurements, thresholds);
      assert.equal(result.pass, false, key);
      assert.ok(result.violations.some((v) => v.startsWith(`${key}:`)), result.violations.join('; '));
    }
  });

  test('missing measurement fails closed (does not pass by omission)', () => {
    const thresholds = loadFixture().thresholds;
    const result = compareMeasurementsToThresholds({
      editorPageP95Ms: 1,
      // fullAssemblyMs omitted
      maxPageBytes: 1,
      maxHeapDeltaBytes: 0,
      sameCollectionLockWaitP95Ms: 1,
      crossCollectionParallelMs: 1,
    }, thresholds);
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => v.includes('fullAssemblyMs')));
  });

  test('NaN / Infinity measurements fail closed', () => {
    const thresholds = loadFixture().thresholds;
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = compareMeasurementsToThresholds({
        ...thresholds,
        editorPageP95Ms: bad,
      }, thresholds);
      assert.equal(result.pass, false);
    }
  });
});

