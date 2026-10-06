import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { requirementsDigest, validateEvidenceArtifact } from './lib/conformance-evidence.mjs';
import {
  scanProtocolSources,
  scanRequirementMarkers,
  scanSectionAnchors,
  summarizeCoverage,
  validateRequirementCoverage,
} from './lib/requirement-coverage.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const protocolRoot = resolve(repositoryRoot, 'protocol');
const canonicalRegistryPath = resolve(protocolRoot, 'requirements.yaml');
const registryPath = resolve(packageRoot, 'fixtures', 'protocol', 'requirements.yaml');
const canonicalVersionedRegistryPath = resolve(protocolRoot, 'requirements-0.2.yaml');
const versionedRegistryPath = resolve(packageRoot, 'fixtures', 'protocol', 'requirements-0.2.yaml');
const packagePath = resolve(packageRoot, 'package.json');
const evidencePath = resolve(packageRoot, 'src', 'conformance', 'generated', 'evidence.json');
const outputPath = resolve(packageRoot, 'docs', 'TRACEABILITY.md');
const jsonOutputPath = resolve(packageRoot, 'src', 'conformance', 'generated', 'requirements.json');
const checkOnly = process.argv.includes('--check');

const [canonicalRegistrySource, registrySource, canonicalVersionedRegistrySource, versionedRegistrySource, packageSource, evidenceSource, occurrences, markers, sectionAnchors] =
  await Promise.all([
    readFile(canonicalRegistryPath, 'utf8'),
    readFile(registryPath, 'utf8'),
    readFile(canonicalVersionedRegistryPath, 'utf8'),
    readFile(versionedRegistryPath, 'utf8'),
    readFile(packagePath, 'utf8'),
    readFile(evidencePath, 'utf8'),
    scanProtocolSources(protocolRoot),
    scanRequirementMarkers(protocolRoot),
    scanSectionAnchors(protocolRoot),
  ]);

if (canonicalRegistrySource !== registrySource) {
  throw new Error('Canonical and package Requirement Registries differ. Run npm run sync:protocol.');
}
if (canonicalVersionedRegistrySource !== versionedRegistrySource) {
  throw new Error('Canonical and package COLP 0.2 Requirement Registries differ. Run npm run sync:protocol.');
}

const registry = parse(registrySource);
const versionedRegistry = parse(versionedRegistrySource);
const coverageRegistry = {
  version: '0.1+0.2',
  requirements: [...registry.requirements, ...versionedRegistry.requirements],
};
const packageJson = JSON.parse(packageSource);
const evidence = JSON.parse(evidenceSource);
if (!registry || !Array.isArray(registry.requirements)) {
  throw new TypeError('Protocol requirement registry must contain requirements[].');
}

const profiles = ['core', 'publication', 'feed', 'publisher', 'sync', 'mcp-read', 'mcp-write'];
const levels = new Set(['MUST', 'MUST_NOT', 'SHOULD', 'SHOULD_NOT', 'MAY']);
const seen = new Set();
for (const requirement of registry.requirements) {
  for (const field of ['id', 'level', 'profile', 'source', 'requirement']) {
    if (typeof requirement[field] !== 'string' || requirement[field].length === 0) {
      throw new TypeError(`Requirement is missing ${field}: ${JSON.stringify(requirement)}`);
    }
  }
  if (!levels.has(requirement.level)) {
    throw new TypeError(`Unsupported requirement level for ${requirement.id}: ${requirement.level}`);
  }
  if (!profiles.includes(requirement.profile)) {
    throw new TypeError(`Unsupported profile for ${requirement.id}: ${requirement.profile}`);
  }
  if (!Array.isArray(requirement.implementation) || !Array.isArray(requirement.tests)) {
    throw new TypeError(`Requirement ${requirement.id} must declare implementation[] and tests[].`);
  }
  if (seen.has(requirement.id)) throw new TypeError(`Duplicate requirement ID: ${requirement.id}`);
  seen.add(requirement.id);
}

const coverageErrors = validateRequirementCoverage(coverageRegistry, occurrences, markers, sectionAnchors);
if (coverageErrors.length > 0) {
  throw new Error(`Requirement coverage failed:\n- ${coverageErrors.join('\n- ')}`);
}

const registryDigest = requirementsDigest(registry);
const evidenceContext = {
  protocolVersion: String(registry.version),
  packageVersion: packageJson.version,
  requirementsDigest: registryDigest,
  requirements: registry.requirements,
};
const evidenceErrors = validateEvidenceArtifact(evidence, evidenceContext);
if (evidenceErrors.length > 0) {
  throw new Error(`Bundled conformance evidence is invalid:\n- ${evidenceErrors.join('\n- ')}`);
}

const profileDependencies = Object.freeze({
  core: [],
  publication: ['core'],
  feed: ['publication'],
  publisher: ['publication'],
  sync: ['core'],
  'mcp-read': ['core'],
  'mcp-write': ['mcp-read', 'publisher'],
});

function dependencyClosure(profile, result = new Set()) {
  if (result.has(profile)) return result;
  result.add(profile);
  for (const dependency of profileDependencies[profile]) dependencyClosure(dependency, result);
  return result;
}

const passedIds = new Set(evidence.passedRequirementIds);
const coverage = summarizeCoverage(coverageRegistry, occurrences);
const escapeCell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const sourceSelector = (requirement) =>
  requirement.selector.marker !== undefined
    ? `${requirement.source} (marker ${requirement.selector.marker})`
    : `${requirement.source} (keyword ${requirement.selector.keywordOrdinal})`;

const profileRows = profiles.map((profile) => {
  const closure = dependencyClosure(profile);
  const required = registry.requirements.filter(
    (requirement) =>
      closure.has(requirement.profile) &&
      (requirement.level === 'MUST' || requirement.level === 'MUST_NOT'),
  );
  const verified = required.filter((requirement) => passedIds.has(requirement.id)).length;
  const claim = required.length > 0 && verified === required.length ? 'Evidence complete' : 'Not claimed';
  return `| \`${profile}\` | ${profileDependencies[profile].map((item) => `\`${item}\``).join(', ') || 'None'} | ${required.length} | ${verified} | ${claim} |`;
});

const lines = [
  '# Protocol Traceability',
  '',
  'Generated from the canonical `protocol/requirements.yaml`. Do not edit this file manually.',
  '',
  `Registry coverage: **${coverage.registered} records** cover **${coverage.occurrences} BCP14 occurrences** (${coverage.required} MUST / MUST NOT and ${coverage.advisory} advisory) across ${coverage.sources} normative Markdown sources. Existing derived design obligations use explicit non-normative HTML markers.`,
  '',
  `Repository evidence: schema v${evidence.schemaVersion}, attested source revision \`${evidence.sourceRevision}\`, requirements digest \`${registryDigest}\`, **${passedIds.size} verified records**. Registered is not synonymous with verified. The tracked artifact is the release certificate; its source revision predates the certificate commit and remains valid only while protected release source is unchanged.`,
  '',
  '## Profile inventory',
  '',
  '| Profile | Direct dependencies | Required records in transitive closure | Verified | Package evidence |',
  '|---|---|---:|---:|---|',
  ...profileRows,
  '',
  '## Requirement records',
  '',
  '| ID | Level | Profile | Requirement | Source selector | Implementation | Tests | Registry | Bundled evidence |',
  '|---|---|---|---|---|---|---|---|---|',
  ...coverageRegistry.requirements.map((requirement) => {
    const implementation = requirement.implementation.map((item) => `\`${item}\``).join(', ');
    const tests = requirement.tests.map((item) => `\`${item}\``).join(', ');
    const verification = passedIds.has(requirement.id) ? 'Verified' : 'Pending execution';
    return `| \`${requirement.id}\` | ${requirement.level} | \`${requirement.profile}\` | ${escapeCell(requirement.requirement)} | ${escapeCell(sourceSelector(requirement))} | ${implementation || 'None registered'} | ${tests || 'None registered'} | Registered | ${verification} |`;
  }),
  '',
  '## Evidence format',
  '',
  'The tracked JSON artifact binds `protocolVersion`, `packageVersion`, the SHA-256 digest of the canonical Requirement Registry, an earlier fully tested source revision, the owned test-report digest, and passed Requirement IDs. The release gate requires that revision to be an ancestor of the current `HEAD`, permits only this artifact and generated `TRACEABILITY.md` to change in the protected COLP scope afterward, reruns the complete evidence-bearing Vitest suite, and requires its passed Requirement IDs to match the tracked certificate. External reports and caller-supplied revisions are rejected. Runtime configuration cannot add passed Requirement or test IDs. Profile claims additionally require opaque evidence returned after package-owned deployment black-box scenarios pass; endpoint and port availability alone is insufficient.',
  '',
].join('\n');

const generatedRegistry = {
  protocolVersion: String(registry.version),
  packageVersion: packageJson.version,
  requirementsDigest: registryDigest,
  requirements: registry.requirements,
};
const jsonSource = `${JSON.stringify(generatedRegistry, null, 2)}\n`;

if (checkOnly) {
  const [current, currentJson] = await Promise.all([
    readFile(outputPath, 'utf8'),
    readFile(jsonOutputPath, 'utf8'),
  ]);
  if (current !== lines || currentJson !== jsonSource) {
    throw new Error('Traceability outputs are stale. Run npm run generate:traceability.');
  }
} else {
  await mkdir(dirname(jsonOutputPath), { recursive: true });
  await Promise.all([
    writeFile(outputPath, lines, 'utf8'),
    writeFile(jsonOutputPath, jsonSource, 'utf8'),
  ]);
}

console.log(
  `${checkOnly ? 'Checked' : 'Generated'} ${coverageRegistry.requirements.length} records covering ${occurrences.length} normative occurrences; ${passedIds.size} verified.`,
);
