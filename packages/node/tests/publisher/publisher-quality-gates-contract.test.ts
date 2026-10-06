import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import coverageConfig from '../../vitest.config.js';
import publisherCoverageConfig from '../../vitest.publisher.config.js';

/** The v8 coverage fields these gate tests assert (structural, not vitest's union). */
type CoverageView = {
  readonly include?: readonly string[];
  readonly thresholds?: Record<string, unknown>;
  readonly reportsDirectory?: string;
};




const packageRoot = resolve(import.meta.dirname, '..', '..');
const testingDocPath = resolve(packageRoot, 'docs', 'TESTING.md');
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
) as { readonly scripts?: Readonly<Record<string, string>> };

/** Locked Publisher floor; must match vitest.publisher.config.ts and TESTING.md. */
const publisherFloor = {
  branches: 88,
  functions: 99,
  lines: 90,
  statements: 88,
} as const;

/** Extracts the Publisher four-tuple from docs/TESTING.md Baseline gates. */
function parsePublisherFloorFromTestingDoc(markdown: string): {
  readonly branches: number;
  readonly functions: number;
  readonly lines: number;
  readonly statements: number;
} {
  const match =
    /Independent Publisher gate[\s\S]*?branches\s+(\d+)\s*\/\s*functions\s+(\d+)\s*\/\s*lines\s+(\d+)\s*\/\s*statements\s+(\d+)/u.exec(
      markdown,
    );
  expect(match).not.toBeNull();
  const branches = Number(match?.[1]);
  const functions = Number(match?.[2]);
  const lines = Number(match?.[3]);
  const statements = Number(match?.[4]);
  expect([branches, functions, lines, statements].every(Number.isInteger)).toBe(true);
  return { branches, functions, lines, statements };
}

describe('Publisher quality gate configuration [review:publisher.coverage-gate]', () => {
  it('keeps TESTING.md Publisher floor identical to vitest.publisher thresholds', () => {
    const documented = parsePublisherFloorFromTestingDoc(readFileSync(testingDocPath, 'utf8'));
    const thresholds = (publisherCoverageConfig.test?.coverage as CoverageView | undefined)?.thresholds;

    expect(documented).toEqual(publisherFloor);
    expect(thresholds).toEqual(publisherFloor);
  });

  it('gates only src/publisher and keeps the aggregate universe separate', () => {
    expect((publisherCoverageConfig.test?.coverage as CoverageView | undefined)?.include).toEqual(['src/publisher/**/*.ts']);
    expect(publisherCoverageConfig.test?.coverage?.reportsDirectory).toBe('coverage/publisher');
    expect((coverageConfig.test?.coverage as CoverageView | undefined)?.include).not.toContain('src/publisher/**/*.ts');
    expect((coverageConfig.test?.coverage as CoverageView | undefined)?.include).not.toContain('src/security/**/*.ts');
  });

  it('runs the Publisher coverage script in check before the Security coverage script', () => {
    expect(packageJson.scripts?.['test:coverage:publisher']).toBe(
      'vitest run --config vitest.publisher.config.ts --coverage',
    );

    const check = packageJson.scripts?.check ?? '';
    const publisherIdx = check.indexOf('npm run test:coverage:publisher');
    const securityIdx = check.indexOf('npm run test:coverage:security');
    expect(publisherIdx).toBeGreaterThan(-1);
    expect(securityIdx).toBeGreaterThan(publisherIdx);
  });
});
