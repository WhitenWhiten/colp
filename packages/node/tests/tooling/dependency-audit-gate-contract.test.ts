import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, string>>;
};
const workflow = parse(
  readFileSync(resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml'), 'utf8'),
) as {
  readonly jobs?: Readonly<Record<string, {
    readonly needs?: string | readonly string[];
    readonly steps?: readonly Readonly<{ readonly run?: string }>[];
  }>>;
};

describe('COLP dependency audit gate [SYNC-Q-005]', () => {
  it('blocks High findings on both the production and full trees', () => {
    expect(packageJson.scripts?.['scan:dependencies']).toBe(
      'npm audit --omit=dev --audit-level=high && npm audit --audit-level=high',
    );
  });

  it('pins fast-uri past GHSA-7p8r-x3mc-p8w7 until AJV declares the patched range', () => {
    expect(packageJson.overrides?.['fast-uri']).toBe('3.1.6');
    expect(packageJson.overrides?.['js-yaml']).toBe('4.3.2');
    expect(packageJson.overrides?.['nanoid']).toBe('3.3.18');
  });

  it('wires dependency-audit into colp-ci and ci-gate', () => {
    const job = workflow.jobs?.['dependency-audit'];
    expect(job?.needs).toBe('changes');
    expect(job?.steps?.some((step) => step.run === 'npm run scan:dependencies')).toBe(true);
    const needs = workflow.jobs?.['ci-gate']?.needs;
    expect(Array.isArray(needs) ? needs : []).toContain('dependency-audit');
  });
});
