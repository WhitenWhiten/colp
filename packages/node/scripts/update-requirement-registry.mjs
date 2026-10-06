import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { classifyRequirementOccurrence } from './lib/requirement-classification.mjs';
import {
  occurrenceKey,
  scanRequirementMarkers,
  scanProtocolSources,
  scanSectionAnchors,
  stableSectionAnchor,
  validateRequirementCoverage,
} from './lib/requirement-coverage.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const protocolRoot = resolve(repositoryRoot, 'protocol');
const registryPath = resolve(protocolRoot, 'requirements.yaml');
const registry = parse(await readFile(registryPath, 'utf8'));

if (!registry || !Array.isArray(registry.requirements)) {
  throw new TypeError('Protocol requirement registry must contain requirements[].');
}

function sourcePath(source) {
  return source.split('#', 1)[0];
}

function sectionNumber(source) {
  const fragment = source.split('#', 2)[1];
  const match = /^(\d+(?:-\d+)*)/u.exec(fragment ?? '');
  return match?.[1]?.replaceAll('-', '.');
}

function addMarker(source, requirementId, requirementSource) {
  const marker = `<!-- COLP-REQ ${requirementId} -->`;
  if (source.includes(marker)) {
    return source;
  }
  const section = sectionNumber(requirementSource);
  if (section === undefined) {
    throw new Error(`Cannot locate source section for ${requirementId}: ${requirementSource}`);
  }
  const escapedSection = section.replaceAll('.', '\\.');
  const headingPattern = new RegExp(`^(#{2,6}\\s+${escapedSection}(?:\\.|\\s).*)$`, 'mu');
  if (!headingPattern.test(source)) {
    throw new Error(`Cannot find section ${section} for ${requirementId}: ${requirementSource}`);
  }
  return source.replace(headingPattern, `$1\n\n${marker}`);
}

function addSectionAnchor(source, section) {
  const anchor = `<a id="${stableSectionAnchor(section)}"></a>`;
  if (source.includes(anchor)) return source;
  const escapedSection = section.replaceAll('.', '\\.');
  const headingPattern = new RegExp(`^(#{2,6}\\s+${escapedSection}(?:\\.|\\s).*)$`, 'mu');
  if (!headingPattern.test(source)) {
    throw new Error(`Cannot find section ${section} for stable anchor.`);
  }
  return source.replace(headingPattern, `${anchor}\n\n$1`);
}

const markerRequirements = registry.requirements.filter(
  (requirement) => requirement.selector === undefined,
);
for (const requirement of registry.requirements) {
  if (typeof requirement.selector?.marker === 'string') {
    requirement.selector.section ??= sectionNumber(requirement.source);
  }
}
const requirementsBySource = Map.groupBy(markerRequirements, (requirement) =>
  sourcePath(requirement.source),
);

for (const [relativePath, requirements] of requirementsBySource) {
  const path = resolve(protocolRoot, relativePath);
  let source = await readFile(path, 'utf8');
  for (const requirement of requirements) {
    source = addMarker(source, requirement.id, requirement.source);
    requirement.selector = { marker: requirement.id, section: sectionNumber(requirement.source) };
  }
  await writeFile(path, source, 'utf8');
}

const occurrences = await scanProtocolSources(protocolRoot);
const sectionsBySource = Map.groupBy(occurrences, (occurrence) => occurrence.source);
for (const [relativePath, sourceOccurrences] of sectionsBySource) {
  const path = resolve(protocolRoot, relativePath);
  let source = await readFile(path, 'utf8');
  for (const section of new Set(sourceOccurrences.map((occurrence) => occurrence.section))) {
    source = addSectionAnchor(source, section);
  }
  await writeFile(path, source, 'utf8');
}
const occurrenceByKey = new Map(occurrences.map((occurrence) => [occurrenceKey(occurrence), occurrence]));
for (const requirement of registry.requirements) {
  if (typeof requirement.selector?.quote !== 'string') continue;
  const occurrence = occurrenceByKey.get(
    occurrenceKey({
      source: sourcePath(requirement.source),
      quote: requirement.selector.quote,
      quoteOrdinal: requirement.selector.quoteOrdinal,
      keywordOrdinal: requirement.selector.keywordOrdinal,
    }),
  );
  if (occurrence === undefined) continue;
  requirement.selector.section = occurrence.section;
  if (requirement.classification === undefined) requirement.classification = 'auto';
  if (requirement.classification === 'auto') {
    [requirement.profile] = classifyRequirementOccurrence(occurrence);
    requirement.source = `${occurrence.source}#${stableSectionAnchor(occurrence.section)}`;
  }
}

const nextNumbers = new Map();
for (const requirement of registry.requirements) {
  const match = /^([A-Z]+)-(\d{4})$/u.exec(requirement.id);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Unsupported requirement ID: ${requirement.id}`);
  }
  nextNumbers.set(match[1], Math.max(nextNumbers.get(match[1]) ?? 0, Number(match[2])));
}
const covered = new Set(
  registry.requirements
    .filter((requirement) => typeof requirement.selector?.quote === 'string')
    .map((requirement) =>
      occurrenceKey({
        source: sourcePath(requirement.source),
        quote: requirement.selector.quote,
        quoteOrdinal: requirement.selector.quoteOrdinal,
        keywordOrdinal: requirement.selector.keywordOrdinal,
      }),
    ),
);

for (const occurrence of occurrences) {
  const key = occurrenceKey(occurrence);
  if (covered.has(key)) {
    continue;
  }
  const [profile, prefix] = classifyRequirementOccurrence(occurrence);
  const number = (nextNumbers.get(prefix) ?? 0) + 1;
  nextNumbers.set(prefix, number);
  registry.requirements.push({
    id: `${prefix}-${String(number).padStart(4, '0')}`,
    level: occurrence.level,
    profile,
    classification: 'auto',
    source: `${occurrence.source}#${stableSectionAnchor(occurrence.section)}`,
    requirement: occurrence.quote,
    selector: {
      section: occurrence.section,
      quote: occurrence.quote,
      quoteOrdinal: occurrence.quoteOrdinal,
      keywordOrdinal: occurrence.keywordOrdinal,
    },
    implementation: [],
    tests: [],
  });
  covered.add(key);
}

function yamlString(value) {
  return JSON.stringify(value);
}

function yamlList(values) {
  return `[${values.map(yamlString).join(', ')}]`;
}

const yamlLines = [`version: ${registry.version}`, 'requirements:'];
for (const requirement of registry.requirements) {
  yamlLines.push(
    `  - id: ${requirement.id}`,
    `    level: ${requirement.level}`,
    `    profile: ${requirement.profile}`,
    ...(requirement.classification === undefined
      ? []
      : [`    classification: ${requirement.classification}`]),
    `    source: ${yamlString(requirement.source)}`,
    `    requirement: ${yamlString(requirement.requirement)}`,
    '    selector:',
  );
  if (requirement.selector.marker !== undefined) {
    yamlLines.push(
      `      marker: ${requirement.selector.marker}`,
      `      section: ${yamlString(requirement.selector.section)}`,
    );
  } else {
    yamlLines.push(
      `      section: ${yamlString(requirement.selector.section)}`,
      `      quote: ${yamlString(requirement.selector.quote)}`,
      `      quoteOrdinal: ${requirement.selector.quoteOrdinal}`,
      `      keywordOrdinal: ${requirement.selector.keywordOrdinal}`,
    );
  }
  yamlLines.push(
    `    implementation: ${yamlList(requirement.implementation ?? [])}`,
    `    tests: ${yamlList(requirement.tests ?? [])}`,
  );
}

await writeFile(registryPath, `${yamlLines.join('\n')}\n`, 'utf8');

const [markers, sectionAnchors] = await Promise.all([
  scanRequirementMarkers(protocolRoot),
  scanSectionAnchors(protocolRoot),
]);
const coverageErrors = validateRequirementCoverage(
  registry,
  occurrences,
  markers,
  sectionAnchors,
);
if (coverageErrors.length > 0) {
  throw new Error(`Generated invalid registry:\n- ${coverageErrors.join('\n- ')}`);
}

console.log(
  `Registry updated: ${registry.requirements.length} records, ${occurrences.length} normative occurrences.`,
);
