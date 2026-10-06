import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  scanRequirementMarkers,
  scanSectionAnchors,
  scanProtocolSources,
  summarizeCoverage,
  validateRequirementCoverage,
} from './lib/requirement-coverage.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : resolve(process.argv[index + 1]);
}

const protocolRoot = option('--protocol-root', resolve(repositoryRoot, 'protocol'));
const registryPath = option('--registry', resolve(packageRoot, 'fixtures/protocol/requirements.yaml'));
const versionedRegistryPath = resolve(packageRoot, 'fixtures/protocol/requirements-0.2.yaml');
const customRegistry = process.argv.includes('--registry');
const [registry, versionedRegistry] = await Promise.all([
  readFile(registryPath, 'utf8').then(parse),
  customRegistry
    ? Promise.resolve({ requirements: [] })
    : readFile(versionedRegistryPath, 'utf8').then(parse),
]);
const coverageRegistry = {
  version: '0.1+0.2',
  requirements: [...registry.requirements, ...versionedRegistry.requirements],
};
const [occurrences, markers, sectionAnchors] = await Promise.all([
  scanProtocolSources(protocolRoot),
  scanRequirementMarkers(protocolRoot),
  scanSectionAnchors(protocolRoot),
]);
const errors = validateRequirementCoverage(coverageRegistry, occurrences, markers, sectionAnchors);

if (errors.length > 0) {
  throw new Error(`Requirement coverage failed:\n- ${errors.join('\n- ')}`);
}

const summary = summarizeCoverage(coverageRegistry, occurrences);
console.log(
  `Requirement coverage complete: ${summary.occurrences} occurrences (${summary.required} required, ${summary.advisory} advisory) across ${summary.sources} sources.`,
);
