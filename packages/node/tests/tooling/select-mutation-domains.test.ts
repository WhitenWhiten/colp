import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Local optional-shard selector only. GitHub Actions has no mutation jobs.
// @ts-expect-error TS7016 -- executable local selector is plain JavaScript.
import { criticalMutationDomains, selectMutationDomains } from '../../scripts/select-mutation-domains.mjs';

const scriptPath = resolve(import.meta.dirname, '..', '..', 'scripts', 'select-mutation-domains.mjs');

describe('critical mutation domain selection', () => {
  it('selects every bounded shard for a full local run', () => {
    expect(selectMutationDomains({
      full: true,
      core: false,
      mcp: false,
      security: false,
      sync: false,
    })).toEqual([...criticalMutationDomains]);
  });

  it('expands only the affected logical domains in stable matrix order', () => {
    expect(selectMutationDomains({
      full: false,
      core: true,
      mcp: false,
      security: false,
      sync: true,
    })).toEqual(['core', 'sync']);
    expect(selectMutationDomains({
      full: false,
      core: false,
      mcp: true,
      security: false,
      sync: false,
    })).toEqual(['mcp-change-plan', 'mcp-write', 'mcp-read']);
    expect(selectMutationDomains({
      full: false,
      core: false,
      mcp: false,
      security: false,
      sync: false,
    })).toEqual([]);
  });

  it('runs as a cross-platform CLI and emits JSON consumable by fromJSON', () => {
    const output = execFileSync(process.execPath, [
      scriptPath,
      '--full', 'false',
      '--core', 'false',
      '--mcp', 'true',
      '--security', 'true',
      '--sync', 'false',
    ], { encoding: 'utf8' });

    expect(JSON.parse(output)).toEqual([
      'mcp-change-plan',
      'mcp-write',
      'mcp-read',
      'security',
    ]);
  });
});
