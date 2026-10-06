import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { protocolExampleContracts } from '../../src/conformance/index.js';
import { createValidatorRegistry, type DefinitionName } from '../../src/schema/index.js';

const examplesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

describe('normative protocol examples', () => {
  const registry = createValidatorRegistry();

  it('maps every synchronized example to an explicit contract', async () => {
    const fixtures = (await readdir(examplesRoot)).filter((name) => name.endsWith('.json')).sort();
    expect(fixtures).toEqual(Object.keys(protocolExampleContracts).sort());
  });

  for (const [fileName, contractName] of Object.entries(protocolExampleContracts)) {
    it(`${fileName} satisfies $defs/${contractName}`, async () => {
      const source = await readFile(resolve(examplesRoot, fileName), 'utf8');
      const value: unknown = JSON.parse(source);
      const result = registry.validate(contractName as DefinitionName, value);

      expect(result.valid, result.valid ? undefined : JSON.stringify(result.errors, null, 2)).toBe(true);
    });
  }
});
