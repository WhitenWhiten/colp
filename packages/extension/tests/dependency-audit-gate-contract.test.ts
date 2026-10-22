import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, string>>;
};
const workflow = readFileSync(
  resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml'),
  'utf8',
);

describe('Extension dependency audit gate [SYNC-Q-005]', () => {
  it('blocks High findings on both the production and full trees', () => {
    expect(packageJson.scripts?.['scan:dependencies']).toBe(
      'node ../../scripts/audit-dependencies.mjs --omit=dev --audit-level=high && node ../../scripts/audit-dependencies.mjs --audit-level=high',
    );
  });

  it('pins transitive dependencies past their security advisories', () => {
    expect(packageJson.overrides?.['fast-uri']).toBe('3.1.8');
    expect(packageJson.overrides?.['brace-expansion']).toBe('5.0.12');
    expect(packageJson.overrides?.['js-yaml']).toBe('4.3.2');
    expect(packageJson.overrides?.['nanoid']).toBe('3.3.18');
    expect(packageJson.overrides?.['vite']).toBe('7.3.7');
  });

  it('keeps a blocking workflow audit that fails if a vulnerable lock returns', () => {
    const job = workflow.split('\n  extension:\n')[1]?.split(/\n  [a-z]/u)[0] ?? '';
    expect(job).toContain('run: npm run scan:dependencies');
    expect(job).toContain('working-directory: packages/extension');
    expect(workflow).toContain('      - extension\n');
  });
});
