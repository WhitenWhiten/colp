import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/** Registry files under `protocol/`, oldest protocol version first. */
export const registryFiles = Object.freeze(['requirements.yaml', 'requirements-0.2.yaml']);

export const profileDependencies = Object.freeze({
  core: Object.freeze([]),
  publication: Object.freeze(['core']),
  feed: Object.freeze(['publication']),
  publisher: Object.freeze(['publication']),
  sync: Object.freeze(['core']),
  'mcp-read': Object.freeze(['core']),
  'mcp-write': Object.freeze(['mcp-read', 'publisher']),
});

export const profiles = Object.freeze(Object.keys(profileDependencies));

/** Schema version of `src/conformance/generated/evidence.json`. */
export const evidenceSchemaVersion = 2;

const levels = new Set(['MUST', 'MUST_NOT', 'SHOULD', 'SHOULD_NOT', 'MAY']);
const requirementFields = new Set([
  'id',
  'level',
  'profile',
  'source',
  'requirement',
  'implementation',
  'tests',
]);
const requirementIdPattern = /^[A-Z]+-[0-9]{4}$/u;
const testIdPattern = /^[a-z0-9][a-z0-9._:-]*$/u;
const sourcePattern =
  /^(?<file>SPECIFICATION\.md|docs\/[0-9]{2}-[a-z0-9-]+\.md)#(?<anchor>colp-section-[0-9]+(?:-[0-9]+)*)$/u;
const evidenceTagPattern = /\[evidence:([a-z0-9][a-z0-9._:-]*)\]/gu;

export async function readRegistry(protocolRoot, name) {
  return parse(await readFile(resolve(protocolRoot, name), 'utf8'));
}

/** Structural checks for one registry file. Returns a list of error messages. */
export function validateRegistry(registry, label = 'registry') {
  if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
    return [`${label} must be an object.`];
  }
  const errors = [];
  if (
    (typeof registry.version !== 'string' && typeof registry.version !== 'number') ||
    String(registry.version).length === 0
  ) {
    errors.push(`${label} needs a non-empty version.`);
  }
  if (!Array.isArray(registry.requirements)) {
    errors.push(`${label} must contain requirements[].`);
    return errors;
  }
  const seen = new Set();
  for (const [index, requirement] of registry.requirements.entries()) {
    const where = `${label} requirements[${index}]`;
    if (requirement === null || typeof requirement !== 'object' || Array.isArray(requirement)) {
      errors.push(`${where} must be an object.`);
      continue;
    }
    const id = typeof requirement.id === 'string' ? requirement.id : where;
    for (const key of Object.keys(requirement)) {
      if (!requirementFields.has(key)) errors.push(`${id} has an unknown field: ${key}`);
    }
    if (!requirementIdPattern.test(requirement.id ?? '')) errors.push(`${where} has an invalid id.`);
    if (seen.has(requirement.id)) errors.push(`Duplicate requirement id: ${id}`);
    seen.add(requirement.id);
    if (!levels.has(requirement.level)) errors.push(`${id} has an invalid level.`);
    if (!profiles.includes(requirement.profile)) errors.push(`${id} has an unknown profile.`);
    if (!sourcePattern.test(requirement.source ?? '')) {
      errors.push(`${id} source must look like docs/NN-name.md#colp-section-N.`);
    }
    if (typeof requirement.requirement !== 'string' || requirement.requirement.trim() === '') {
      errors.push(`${id} needs requirement text.`);
    }
    for (const field of ['implementation', 'tests']) {
      if (
        !Array.isArray(requirement[field]) ||
        requirement[field].some((value) => typeof value !== 'string' || value.length === 0)
      ) {
        errors.push(`${id} ${field} must be an array of non-empty strings.`);
      }
    }
    if (Array.isArray(requirement.tests)) {
      for (const testId of requirement.tests) {
        if (typeof testId === 'string' && !testIdPattern.test(testId)) {
          errors.push(`${id} has an invalid test id: ${testId}`);
        }
      }
    }
  }
  return errors;
}

/** Checks that every `source` points at an existing `<a id="..."></a>` anchor. */
export async function validateSourceAnchors(requirements, protocolRoot) {
  const errors = [];
  const anchorsByFile = new Map();
  for (const requirement of requirements) {
    const match = sourcePattern.exec(requirement.source ?? '');
    if (match?.groups === undefined) continue;
    const { file, anchor } = match.groups;
    if (!anchorsByFile.has(file)) {
      const source = await readFile(resolve(protocolRoot, file), 'utf8').catch(() => undefined);
      anchorsByFile.set(
        file,
        source === undefined
          ? undefined
          : new Set([...source.matchAll(/<a id="([^"]+)"><\/a>/gu)].map((item) => item[1])),
      );
    }
    const anchors = anchorsByFile.get(file);
    if (anchors === undefined) {
      errors.push(`${requirement.id} points at a missing file: ${file}`);
    } else if (!anchors.has(anchor)) {
      errors.push(`${requirement.id} points at a missing anchor: ${requirement.source}`);
    }
  }
  return errors;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

/**
 * Digest of the registry fields that decide evidence: IDs, levels, profiles and
 * test IDs. Editing requirement wording or sources does not invalidate evidence.
 */
export function requirementsDigest(registry) {
  const relevant = {
    version: String(registry.version),
    requirements: registry.requirements.map(({ id, level, profile, tests }) => ({
      id,
      level,
      profile,
      tests,
    })),
  };
  return `sha256:${createHash('sha256').update(canonicalJson(relevant)).digest('hex')}`;
}

/**
 * Reads a Vitest JSON report and returns the evidence test IDs whose tagged
 * tests all passed. A test is tagged by putting `[evidence:<test-id>]` in its
 * `describe` or `it` name.
 */
export function collectPassingTestIds(report, knownTestIds) {
  if (report?.success !== true || !Array.isArray(report.testResults)) {
    throw new Error('The Vitest report is incomplete or the test run failed.');
  }
  const statuses = new Map();
  for (const result of report.testResults) {
    for (const assertion of result.assertionResults ?? []) {
      const name = assertion.fullName ?? assertion.title ?? '';
      for (const match of name.matchAll(evidenceTagPattern)) {
        const list = statuses.get(match[1]) ?? [];
        list.push(assertion.status);
        statuses.set(match[1], list);
      }
    }
  }
  const passing = new Set();
  for (const [testId, list] of statuses) {
    if (!knownTestIds.has(testId)) throw new Error(`Unregistered evidence tag: [evidence:${testId}]`);
    if (list.every((status) => status === 'passed')) passing.add(testId);
  }
  return passing;
}

/** Requirements with at least one test, all of which passed. */
export function passedRequirementIds(registry, passingTestIds) {
  return registry.requirements
    .filter(
      (requirement) =>
        requirement.tests.length > 0 &&
        requirement.tests.every((testId) => passingTestIds.has(testId)),
    )
    .map((requirement) => requirement.id);
}

export function createEvidence({ registry, packageVersion, passingTestIds }) {
  return {
    schemaVersion: evidenceSchemaVersion,
    protocolVersion: String(registry.version),
    packageVersion,
    requirementsDigest: requirementsDigest(registry),
    passedRequirementIds: passedRequirementIds(registry, passingTestIds),
  };
}

/** Checks that committed evidence still matches the registry and package. */
export function validateEvidence(evidence, { registry, packageVersion }) {
  const errors = [];
  if (evidence?.schemaVersion !== evidenceSchemaVersion) {
    errors.push(`evidence.json schemaVersion must be ${evidenceSchemaVersion}.`);
  }
  if (evidence?.protocolVersion !== String(registry.version)) {
    errors.push('evidence.json protocolVersion does not match the registry.');
  }
  if (evidence?.packageVersion !== packageVersion) {
    errors.push('evidence.json packageVersion does not match package.json.');
  }
  if (evidence?.requirementsDigest !== requirementsDigest(registry)) {
    errors.push('evidence.json is stale: requirement IDs, levels, profiles or tests changed.');
  }
  const known = new Map(registry.requirements.map((requirement) => [requirement.id, requirement]));
  for (const id of evidence?.passedRequirementIds ?? []) {
    if (!known.has(id)) errors.push(`evidence.json lists an unknown requirement: ${id}`);
    else if (known.get(id).tests.length === 0) errors.push(`evidence.json lists ${id}, which has no tests.`);
  }
  return errors;
}

export function profileClosure(profile, result = new Set()) {
  if (result.has(profile)) return result;
  result.add(profile);
  for (const dependency of profileDependencies[profile]) profileClosure(dependency, result);
  return result;
}
