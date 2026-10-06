import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { validateRequirementRegistry } from './conformance-evidence.mjs';

/** The owned suite covers both versions; certificates retain their own registry. */
export async function readEvidenceReportRegistry(packageRoot) {
  const registries = await Promise.all(['requirements.yaml', 'requirements-0.2.yaml'].map(async (name) => {
    const [canonical, fixture] = await Promise.all([
      readFile(resolve(packageRoot, '../../protocol', name), 'utf8'),
      readFile(resolve(packageRoot, 'fixtures/protocol', name), 'utf8'),
    ]);
    if (canonical !== fixture) throw new Error(`Canonical and package Requirement Registries differ: ${name}`);
    return parse(fixture);
  }));
  const registry = { version: '0.1+0.2', requirements: registries.flatMap((item) => item.requirements) };
  const errors = validateRequirementRegistry(registry);
  if (errors.length) throw new Error(`Invalid evidence report registry:\n- ${errors.join('\n- ')}`);
  return registry;
}
