import { readdir, readFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';

const normativePattern = /\b(MUST NOT|SHOULD NOT|MUST|SHOULD|MAY)\b/g;

const registryLevels = Object.freeze({
  MAY: 'MAY',
  MUST: 'MUST',
  'MUST NOT': 'MUST_NOT',
  SHOULD: 'SHOULD',
  'SHOULD NOT': 'SHOULD_NOT',
});

function normalizePath(path) {
  return path.split(sep).join('/');
}

function isBcp14Declaration(line) {
  const keywordCount = [...line.matchAll(normativePattern)].length;
  normativePattern.lastIndex = 0;
  return keywordCount >= 3 && /BCP\s*14|RFC\s*2119|RFC\s*8174/i.test(line);
}

export function scanMarkdownSource(source, sourcePath) {
  const occurrences = [];
  const quoteCounts = new Map();
  let fence = undefined;
  let section = undefined;

  for (const [lineIndex, rawLine] of source.split(/\r?\n/u).entries()) {
    const trimmed = rawLine.trim();
    const fenceMatch = /^(?<marker>`{3,}|~{3,})/u.exec(trimmed);
    if (fenceMatch?.groups?.marker) {
      const marker = fenceMatch.groups.marker[0];
      if (fence === undefined) {
        fence = marker;
      } else if (marker === fence) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined || trimmed.length === 0 || isBcp14Declaration(trimmed)) {
      continue;
    }

    const heading = /^#{1,6}\s+(\d+(?:\.\d+)*)\b/u.exec(trimmed);
    if (heading?.[1] !== undefined) {
      section = heading[1];
      continue;
    }

    const matches = [...trimmed.matchAll(normativePattern)];
    normativePattern.lastIndex = 0;
    if (matches.length === 0) {
      continue;
    }

    const quoteOrdinal = (quoteCounts.get(trimmed) ?? 0) + 1;
    quoteCounts.set(trimmed, quoteOrdinal);
    for (const [keywordIndex, match] of matches.entries()) {
      const keyword = match[1];
      if (keyword === undefined) {
        continue;
      }
      occurrences.push(
        Object.freeze({
          source: sourcePath,
          section,
          line: lineIndex + 1,
          quote: trimmed,
          quoteOrdinal,
          keywordOrdinal: keywordIndex + 1,
          level: registryLevels[keyword],
        }),
      );
    }
  }

  return Object.freeze(occurrences);
}

export async function scanProtocolSources(protocolRoot) {
  const docsRoot = resolve(protocolRoot, 'docs');
  const docNames = (await readdir(docsRoot))
    .filter((name) => name.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right));
  const sourcePaths = ['SPECIFICATION.md', ...docNames.map((name) => `docs/${name}`)];
  const occurrenceGroups = await Promise.all(
    sourcePaths.map(async (sourcePath) =>
      scanMarkdownSource(await readFile(resolve(protocolRoot, sourcePath), 'utf8'), sourcePath),
    ),
  );
  return Object.freeze(occurrenceGroups.flat());
}

export async function scanRequirementMarkers(protocolRoot) {
  const docsRoot = resolve(protocolRoot, 'docs');
  const docNames = (await readdir(docsRoot))
    .filter((name) => name.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right));
  const sourcePaths = ['SPECIFICATION.md', ...docNames.map((name) => `docs/${name}`)];
  const markerGroups = await Promise.all(
    sourcePaths.map(async (sourcePath) => {
      const source = await readFile(resolve(protocolRoot, sourcePath), 'utf8');
      const markers = [];
      let section = undefined;
      let fence = undefined;
      for (const rawLine of source.split(/\r?\n/u)) {
        const line = rawLine.trim();
        const fenceMatch = /^(?<marker>`{3,}|~{3,})/u.exec(line);
        if (fenceMatch?.groups?.marker) {
          const marker = fenceMatch.groups.marker[0];
          if (fence === undefined) fence = marker;
          else if (fence === marker) fence = undefined;
          continue;
        }
        if (fence !== undefined) continue;
        const heading = /^#{1,6}\s+(\d+(?:\.\d+)*)\b/u.exec(line);
        if (heading?.[1] !== undefined) section = heading[1];
        for (const match of line.matchAll(/<!--\s*COLP-REQ\s+([A-Z]+-[0-9]{4})\s*-->/gu)) {
          markers.push(Object.freeze({ id: match[1], source: sourcePath, section }));
        }
      }
      return markers;
    }),
  );
  return Object.freeze(markerGroups.flat());
}

export function occurrenceKey(occurrence) {
  return JSON.stringify([
    occurrence.source,
    occurrence.quote,
    occurrence.quoteOrdinal,
    occurrence.keywordOrdinal,
  ]);
}

export function stableSectionAnchor(section) {
  return `colp-section-${section.replaceAll('.', '-')}`;
}

export async function scanSectionAnchors(protocolRoot) {
  const docsRoot = resolve(protocolRoot, 'docs');
  const docNames = (await readdir(docsRoot))
    .filter((name) => name.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right));
  const sourcePaths = ['SPECIFICATION.md', ...docNames.map((name) => `docs/${name}`)];
  const groups = await Promise.all(
    sourcePaths.map(async (sourcePath) => {
      const source = await readFile(resolve(protocolRoot, sourcePath), 'utf8');
      return [...source.matchAll(/<a\s+id="(colp-section-[0-9-]+)"\s*><\/a>/gu)].map((match) =>
        Object.freeze({ id: match[1], source: sourcePath }),
      );
    }),
  );
  return Object.freeze(groups.flat());
}

function registrySourcePath(source) {
  return source.split('#', 1)[0];
}

function requirementOccurrence(requirement) {
  if (
    typeof requirement.source !== 'string' ||
    typeof requirement.selector?.quote !== 'string' ||
    typeof requirement.selector.section !== 'string' ||
    !Number.isSafeInteger(requirement.selector.quoteOrdinal) ||
    requirement.selector.quoteOrdinal < 1 ||
    !Number.isSafeInteger(requirement.selector.keywordOrdinal) ||
    requirement.selector.keywordOrdinal < 1
  ) {
    return undefined;
  }
  return {
    source: registrySourcePath(requirement.source),
    section: requirement.selector.section,
    quote: requirement.selector.quote,
    quoteOrdinal: requirement.selector.quoteOrdinal,
    keywordOrdinal: requirement.selector.keywordOrdinal,
  };
}

export function validateRequirementCoverage(registry, occurrences, markers = [], sectionAnchors = []) {
  const errors = [];
  if (!registry || !Array.isArray(registry.requirements)) {
    return Object.freeze(['Protocol requirement registry must contain requirements[].']);
  }

  const occurrenceByKey = new Map(occurrences.map((item) => [occurrenceKey(item), item]));
  const coveredByKey = new Map();
  const markerSources = new Map();
  for (const marker of markers) {
    const sources = markerSources.get(marker.id) ?? [];
    sources.push(marker);
    markerSources.set(marker.id, sources);
  }
  const sectionAnchorSources = new Map();
  for (const anchor of sectionAnchors) {
    const sources = sectionAnchorSources.get(anchor.id) ?? [];
    sources.push(anchor.source);
    sectionAnchorSources.set(anchor.id, sources);
  }
  const ids = new Set();

  for (const requirement of registry.requirements) {
    if (typeof requirement.id !== 'string' || requirement.id.length === 0) {
      errors.push(`Requirement has no stable ID: ${JSON.stringify(requirement)}`);
      continue;
    }
    if (ids.has(requirement.id)) {
      errors.push(`Duplicate requirement ID: ${requirement.id}`);
    }
    ids.add(requirement.id);

    if (requirement.classification === 'auto') {
      const anchor = stableSectionAnchor(requirement.selector?.section ?? '');
      const expectedSource = `${registrySourcePath(requirement.source)}#${anchor}`;
      if (requirement.source !== expectedSource) {
        errors.push(`Auto-classified requirement ${requirement.id} has a non-navigable source.`);
      }
      const anchorSources = sectionAnchorSources.get(anchor) ?? [];
      const sourceMatches = anchorSources.filter(
        (source) => source === registrySourcePath(requirement.source),
      );
      if (sourceMatches.length === 0) {
        errors.push(`Missing section anchor for ${requirement.id}: ${expectedSource}`);
      } else if (sourceMatches.length > 1) {
        errors.push(`Duplicate section anchor for ${requirement.id}: ${expectedSource}`);
      }
    }

    if (typeof requirement.selector?.marker === 'string') {
      if (requirement.selector.marker !== requirement.id) {
        errors.push(`Requirement ${requirement.id} points to marker ${requirement.selector.marker}.`);
      }
      const sources = markerSources.get(requirement.id) ?? [];
      const expectedSource = registrySourcePath(requirement.source);
      if (sources.length === 0) {
        errors.push(`Stale traceability marker for ${requirement.id}: ${expectedSource}`);
      } else if (sources.length > 1) {
        errors.push(
          `Duplicate traceability marker for ${requirement.id}: ${sources.map((item) => item.source).join(', ')}`,
        );
      } else if (sources[0].source !== expectedSource) {
        errors.push(
          `Traceability marker source mismatch for ${requirement.id}: registry=${expectedSource}, marker=${sources[0].source}`,
        );
      } else if (requirement.selector.section !== sources[0].section) {
        errors.push(`Traceability marker section mismatch for ${requirement.id}.`);
      }
      continue;
    }
    const selector = requirementOccurrence(requirement);
    if (selector === undefined) {
      errors.push(`Requirement ${requirement.id} has no exact selector.`);
      continue;
    }
    const key = occurrenceKey(selector);
    const occurrence = occurrenceByKey.get(key);
    if (occurrence === undefined) {
      errors.push(`Stale normative selector for ${requirement.id}: ${selector.source}`);
      continue;
    }
    if (requirement.level !== occurrence.level) {
      errors.push(
        `Normative level mismatch for ${requirement.id}: registry=${requirement.level}, source=${occurrence.level}`,
      );
    }
    if (selector.section !== occurrence.section) {
      errors.push(
        `Normative section mismatch for ${requirement.id}: registry=${selector.section}, source=${occurrence.section ?? 'unknown'}`,
      );
    }
    const coveringIds = coveredByKey.get(key) ?? [];
    coveringIds.push(requirement.id);
    coveredByKey.set(key, coveringIds);
  }

  for (const marker of markers) {
    if (!ids.has(marker.id)) {
      errors.push(`Unregistered traceability marker ${marker.id}: ${marker.source}`);
    }
  }

  for (const occurrence of occurrences) {
    const key = occurrenceKey(occurrence);
    const coveringIds = coveredByKey.get(key) ?? [];
    if (coveringIds.length === 0) {
      errors.push(
        `Missing requirement for ${occurrence.source}:${occurrence.line} keyword ${occurrence.keywordOrdinal} (${occurrence.level}): ${occurrence.quote}`,
      );
    } else if (coveringIds.length > 1) {
      errors.push(
        `Duplicate coverage for ${occurrence.source}:${occurrence.line} keyword ${occurrence.keywordOrdinal}: ${coveringIds.join(', ')}`,
      );
    }
  }

  return Object.freeze(errors);
}

export function summarizeCoverage(registry, occurrences) {
  const required = occurrences.filter(
    (occurrence) => occurrence.level === 'MUST' || occurrence.level === 'MUST_NOT',
  ).length;
  return Object.freeze({
    sources: new Set(occurrences.map((occurrence) => occurrence.source)).size,
    occurrences: occurrences.length,
    required,
    advisory: occurrences.length - required,
    registered: registry.requirements.length,
  });
}

export function displayProtocolRoot(protocolRoot) {
  return basename(protocolRoot) || normalizePath(relative(resolve(protocolRoot, '..'), protocolRoot));
}
