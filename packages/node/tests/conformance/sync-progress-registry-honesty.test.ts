/**
 * Process-integrity gates for SYNC-0010…0026 (SYNC-V-001, SYNC-V-014).
 *
 * These tests do NOT evaluate the merge algorithm itself. They lock in honesty
 * between progress status, Requirement Registry mappings, on-disk evidence tags,
 * implementation modules, and TRACEABILITY registration.
 *
 * Assumptions about the bugfix end-state (SYNC-V-001 / SYNC-V-014):
 * 1. Any SYNC-0010…0026 row still marked `Accepted` in progress has non-empty
 *    `implementation` and `tests` in the live registry, and those evidence names
 *    actually appear as `[evidence:…]` markers under `packages/node/tests/**`.
 * 2. Implementation package names map to real modules under `packages/node/src/<name>`.
 * 3. SYNC-0016 and SYNC-0017 no longer share identical full `requirement` /
 *    `selector.quote` strings (keywordOrdinal-only splits are not sufficient).
 * 4. While `packages/node/src/sync` has no three-way merge API that consumes
 *    base/current/incoming, SYNC-0017 must not be `Accepted` in progress.
 * 5. TRACEABILITY rows for Accepted IDs must not report `None registered` for
 *    Implementation / Tests (registry + generator must be regenerated together).
 *
 * Pre-fix trees with Accepted + empty registry mappings (or identical 0016/0017
 * quotes, or Accepted 0017 without merge) are expected to fail these gates.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const registryPath = resolve(packageRoot, 'fixtures', 'protocol', 'requirements.yaml');
const generatedRequirementsPath = resolve(
  packageRoot,
  'src',
  'conformance',
  'generated',
  'requirements.json',
);
const progressPath = resolve(packageRoot, 'docs', 'progress', 'SYNC.md');
const traceabilityPath = resolve(packageRoot, 'docs', 'TRACEABILITY.md');
const testsRoot = resolve(packageRoot, 'tests');
const srcRoot = resolve(packageRoot, 'src');
const syncSrcRoot = resolve(srcRoot, 'sync');

const TARGET_IDS = Object.freeze(
  Array.from({ length: 17 }, (_, index) => `SYNC-${String(index + 10).padStart(4, '0')}`),
);

const EVIDENCE_PATTERN = /\[evidence:([a-z0-9][a-z0-9._:-]*)\]/gu;
const PROGRESS_ROW =
  /^\|\s*(?<id>SYNC-\d{4})\s*\|\s*(?<status>[^|]+?)\s*\|\s*(?<evidence>\d+)\s*\|/u;

type RegistryRequirement = {
  readonly id: string;
  readonly requirement: string;
  readonly implementation: readonly string[];
  readonly tests: readonly string[];
  readonly selector?: {
    readonly quote?: string;
    readonly keywordOrdinal?: number;
    readonly quoteOrdinal?: number;
    readonly section?: string;
    readonly marker?: string;
  };
};

type ProgressRow = {
  readonly id: string;
  readonly status: string;
  readonly evidenceTests: number;
};

type TraceabilityRow = {
  readonly id: string;
  readonly implementation: string;
  readonly tests: string;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root: string, suffix: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) return collectFiles(fullPath, suffix);
      if (entry.isFile() && entry.name.endsWith(suffix)) return [fullPath];
      return [];
    }),
  );
  return nested.flat();
}

async function loadRegistryById(): Promise<Map<string, RegistryRequirement>> {
  const source = await readFile(registryPath, 'utf8');
  const registry = parse(source) as { requirements?: RegistryRequirement[] };
  expect(Array.isArray(registry.requirements)).toBe(true);
  const byId = new Map<string, RegistryRequirement>();
  for (const requirement of registry.requirements ?? []) {
    byId.set(requirement.id, requirement);
  }
  return byId;
}

async function loadGeneratedById(): Promise<Map<string, RegistryRequirement>> {
  const source = await readFile(generatedRequirementsPath, 'utf8');
  const artifact = JSON.parse(source) as { requirements?: RegistryRequirement[] };
  expect(Array.isArray(artifact.requirements)).toBe(true);
  const byId = new Map<string, RegistryRequirement>();
  for (const requirement of artifact.requirements ?? []) {
    byId.set(requirement.id, requirement);
  }
  return byId;
}

async function loadProgressRows(): Promise<Map<string, ProgressRow>> {
  const markdown = await readFile(progressPath, 'utf8');
  const rows = new Map<string, ProgressRow>();
  for (const line of markdown.split(/\r?\n/u)) {
    const match = PROGRESS_ROW.exec(line.trim());
    if (match?.groups?.id === undefined || match.groups.status === undefined) continue;
    rows.set(match.groups.id, {
      id: match.groups.id,
      status: match.groups.status.trim(),
      evidenceTests: Number(match.groups.evidence),
    });
  }
  return rows;
}

async function loadTraceabilityRows(): Promise<Map<string, TraceabilityRow>> {
  const markdown = await readFile(traceabilityPath, 'utf8');
  const rows = new Map<string, TraceabilityRow>();
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    // Columns: ID | Level | Profile | Requirement | Source | Implementation | Tests | Registry | Evidence
    const cells = trimmed
      .replace(/^\|/u, '')
      .replace(/\|$/u, '')
      .split('|')
      .map((cell) => cell.trim());
    const idMatch = /^`(?<id>SYNC-\d{4})`$/u.exec(cells[0] ?? '');
    if (idMatch?.groups?.id === undefined || cells.length < 7) continue;
    rows.set(idMatch.groups.id, {
      id: idMatch.groups.id,
      implementation: cells[5] ?? '',
      tests: cells[6] ?? '',
    });
  }
  return rows;
}

async function collectEvidenceIdsFromTests(): Promise<Set<string>> {
  const files = await collectFiles(testsRoot, '.ts');
  const evidenceIds = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(EVIDENCE_PATTERN)) {
      if (match[1] !== undefined) evidenceIds.add(match[1]);
    }
  }
  return evidenceIds;
}

async function implementationModuleExists(name: string): Promise<boolean> {
  // Follow package layout used by registered CORE/SYNC mappings: src/<module>/.
  const candidates = [
    resolve(srcRoot, name),
    resolve(srcRoot, `${name}.ts`),
    resolve(srcRoot, name, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return true;
  }
  return false;
}

/**
 * Behavioral detection of a production three-way merge API.
 * Contract-only base/value key-set checks are intentionally insufficient.
 */
async function hasThreeWayMergeApi(syncRoot: string): Promise<boolean> {
  if (!(await pathExists(syncRoot))) return false;
  const files = await collectFiles(syncRoot, '.ts');
  // A merge helper must mention all three roles in a parameter list / object pattern.
  const threeWaySignature =
    /(?:function|const)\s+[A-Za-z0-9_]*[Mm]erge[A-Za-z0-9_]*\b[\s\S]{0,400}?\((?:[^)]*\bbase\b[^)]*\bcurrent\b[^)]*\bincoming\b|[^)]*\bcurrent\b[^)]*\bbase\b[^)]*\bincoming\b|[^)]*\bbase\b[^)]*\bincoming\b[^)]*\bcurrent\b)[^)]*\)/u;
  const threeWayObjectArgs =
    /\b(?:mergeThreeWay|threeWayMerge|mergeBaseCurrentIncoming|applyThreeWayMerge|mergeTypedUpdate)\b[\s\S]{0,300}?\bbase\b[\s\S]{0,200}?\bcurrent\b[\s\S]{0,200}?\bincoming\b/u;
  const destructuredTriple =
    /\(\s*\{\s*[^}]*\bbase\b[^}]*\bcurrent\b[^}]*\bincoming\b[^}]*\}\s*[:)]\)/u;

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (threeWaySignature.test(source) || threeWayObjectArgs.test(source) || destructuredTriple.test(source)) {
      return true;
    }
    // Positional (base, current, incoming) near a merge-related identifier.
    if (
      /\b[Mm]erge\b/.test(source) &&
      /\(\s*base\s*[,:)]/.test(source) &&
      /\bcurrent\b/.test(source) &&
      /\bincoming\b/.test(source)
    ) {
      // Require the three names to appear together inside one parameter list.
      if (/\([^)]*\bbase\b[^)]*\bcurrent\b[^)]*\bincoming\b[^)]*\)/u.test(source)) {
        return true;
      }
    }
  }
  return false;
}

function nonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);
}

describe('SYNC-0010…0026 progress / registry / TRACEABILITY honesty', () => {
  it('loads every SYNC-0010…0026 record from the live registry and generated requirements', async () => {
    const [registry, generated] = await Promise.all([loadRegistryById(), loadGeneratedById()]);

    for (const id of TARGET_IDS) {
      const live = registry.get(id);
      const bundled = generated.get(id);
      expect(live, `${id} missing from fixtures/protocol/requirements.yaml`).toBeDefined();
      expect(bundled, `${id} missing from generated requirements.json`).toBeDefined();
      expect(Array.isArray(live?.implementation), `${id}.implementation must be an array`).toBe(true);
      expect(Array.isArray(live?.tests), `${id}.tests must be an array`).toBe(true);
      // Generated artifact must mirror live registry mappings (TRACEABILITY input).
      expect(bundled?.implementation ?? []).toEqual(live?.implementation ?? []);
      expect(bundled?.tests ?? []).toEqual(live?.tests ?? []);
      expect(bundled?.requirement).toBe(live?.requirement);
      expect(bundled?.selector?.quote).toBe(live?.selector?.quote);
    }
  });

  it('keeps registry tests[] evidence names present as live [evidence:…] markers', async () => {
    const [registry, evidenceIds] = await Promise.all([
      loadRegistryById(),
      collectEvidenceIdsFromTests(),
    ]);

    const missing: string[] = [];
    for (const id of TARGET_IDS) {
      const requirement = registry.get(id);
      expect(requirement, `${id} missing from registry`).toBeDefined();
      const tests = requirement?.tests ?? [];
      if (tests.length === 0) continue;
      expect(nonEmptyStringArray(tests), `${id}.tests must be non-empty strings when present`).toBe(
        true,
      );
      for (const testId of tests) {
        if (!evidenceIds.has(testId)) {
          missing.push(`${id} → tests: ${testId}`);
        }
      }
    }

    expect(missing, `Registry evidence IDs missing from packages/node/tests/**:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });

  it('keeps registry implementation[] modules present under packages/node/src', async () => {
    const registry = await loadRegistryById();
    const missing: string[] = [];

    for (const id of TARGET_IDS) {
      const requirement = registry.get(id);
      expect(requirement, `${id} missing from registry`).toBeDefined();
      const modules = requirement?.implementation ?? [];
      if (modules.length === 0) continue;
      expect(
        nonEmptyStringArray(modules),
        `${id}.implementation must be non-empty strings when present`,
      ).toBe(true);
      for (const moduleName of modules) {
        if (!(await implementationModuleExists(moduleName))) {
          missing.push(`${id} → implementation: ${moduleName}`);
        }
      }
    }

    expect(
      missing,
      `Registry implementation modules missing under packages/node/src:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('refuses Accepted progress without non-empty registry implementation and tests', async () => {
    const [registry, progress] = await Promise.all([loadRegistryById(), loadProgressRows()]);
    const dishonest: string[] = [];

    for (const id of TARGET_IDS) {
      const row = progress.get(id);
      expect(row, `${id} missing from docs/progress/SYNC.md`).toBeDefined();
      if (row?.status !== 'Accepted') continue;

      const requirement = registry.get(id);
      expect(requirement, `${id} missing from registry`).toBeDefined();
      const implementation = requirement?.implementation ?? [];
      const tests = requirement?.tests ?? [];

      if (!nonEmptyStringArray(implementation) || !nonEmptyStringArray(tests)) {
        dishonest.push(
          `${id} is Accepted but registry has implementation=${JSON.stringify(implementation)} tests=${JSON.stringify(tests)}`,
        );
      }
    }

    expect(
      dishonest,
      `Accepted progress without registry mappings (SYNC-V-001):\n${dishonest.join('\n')}`,
    ).toEqual([]);
  });

  it('requires Accepted registry evidence IDs to appear in live tests', async () => {
    const [registry, progress, evidenceIds] = await Promise.all([
      loadRegistryById(),
      loadProgressRows(),
      collectEvidenceIdsFromTests(),
    ]);
    const missing: string[] = [];

    for (const id of TARGET_IDS) {
      const row = progress.get(id);
      if (row?.status !== 'Accepted') continue;
      const requirement = registry.get(id);
      for (const testId of requirement?.tests ?? []) {
        if (!evidenceIds.has(testId)) {
          missing.push(`${id} Accepted → missing [evidence:${testId}]`);
        }
      }
    }

    expect(
      missing,
      `Accepted requirements reference evidence not present in tests:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps TRACEABILITY Implementation/Tests non-empty for Accepted SYNC-0010…0026 rows', async () => {
    const [progress, traceability] = await Promise.all([
      loadProgressRows(),
      loadTraceabilityRows(),
    ]);
    const dishonest: string[] = [];

    for (const id of TARGET_IDS) {
      const progressRow = progress.get(id);
      if (progressRow?.status !== 'Accepted') continue;
      const traceRow = traceability.get(id);
      expect(traceRow, `${id} missing from docs/TRACEABILITY.md`).toBeDefined();
      if (
        traceRow === undefined ||
        traceRow.implementation === 'None registered' ||
        traceRow.tests === 'None registered' ||
        traceRow.implementation.length === 0 ||
        traceRow.tests.length === 0
      ) {
        dishonest.push(
          `${id} is Accepted but TRACEABILITY has implementation=${JSON.stringify(traceRow?.implementation)} tests=${JSON.stringify(traceRow?.tests)}`,
        );
      }
    }

    expect(
      dishonest,
      `Accepted progress with unregistered TRACEABILITY mappings:\n${dishonest.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps SYNC-0016 and SYNC-0017 requirement text distinct (SYNC-V-014)', async () => {
    const registry = await loadRegistryById();
    const left = registry.get('SYNC-0016');
    const right = registry.get('SYNC-0017');
    expect(left, 'SYNC-0016 missing from registry').toBeDefined();
    expect(right, 'SYNC-0017 missing from registry').toBeDefined();

    const leftRequirement = left?.requirement ?? '';
    const rightRequirement = right?.requirement ?? '';
    const leftQuote = left?.selector?.quote ?? '';
    const rightQuote = right?.selector?.quote ?? '';

    // keywordOrdinal-only splits of the same full string are the V-014 defect.
    // Both human-facing fields must differ so a partial copy still fails the gate.
    expect(
      leftRequirement,
      'SYNC-0016 and SYNC-0017 must not share identical requirement text (SYNC-V-014).',
    ).not.toBe(rightRequirement);
    expect(
      leftQuote,
      'SYNC-0016 and SYNC-0017 must not share identical selector.quote text (SYNC-V-014).',
    ).not.toBe(rightQuote);

    // Semantic split: key-set / invalid_document vs three-way merge — not a cosmetic rewrite.
    expect(
      /键集合|key[- ]?set|invalid_document/iu.test(`${leftRequirement}\n${leftQuote}`),
      'SYNC-0016 must retain key-set / invalid_document obligation language',
    ).toBe(true);
    expect(
      /三方合并|Base\s*\/\s*Current\s*\/\s*Incoming|three[- ]?way/iu.test(
        `${rightRequirement}\n${rightQuote}`,
      ),
      'SYNC-0017 must retain Base/Current/Incoming three-way merge obligation language',
    ).toBe(true);
    // Cross-contamination: 0016 must not own the merge MUST; 0017 must not be only key-set.
    expect(
      /三方合并|Base\s*\/\s*Current\s*\/\s*Incoming/u.test(`${leftRequirement}\n${leftQuote}`),
      'SYNC-0016 must not still carry the three-way merge obligation (split incomplete)',
    ).toBe(false);
  });

  it('does not accept SYNC-0017 while three-way merge is unimplemented', async () => {
    const [progress, mergeImplemented] = await Promise.all([
      loadProgressRows(),
      hasThreeWayMergeApi(syncSrcRoot),
    ]);
    const row = progress.get('SYNC-0017');
    expect(row, 'SYNC-0017 missing from docs/progress/SYNC.md').toBeDefined();

    // Honesty: unimplemented merge ⇒ not Accepted. When merge exists, Accepted still
    // requires non-empty registry mappings (covered by the Accepted gates above).
    if (!mergeImplemented) {
      expect(
        row?.status,
        'SYNC-0017 must not be Accepted without a production three-way merge API in packages/node/src/sync (base/current/incoming).',
      ).not.toBe('Accepted');
    }
  });

  it('does not accept SYNC-0018 / SYNC-0020 as production without registry mappings', async () => {
    // Contract-only / sketch rows must not be silently promoted to Accepted while empty.
    // (Overlaps the generic Accepted gate; named here so Netscape / light-pull over-claims fail loudly.)
    const [registry, progress] = await Promise.all([loadRegistryById(), loadProgressRows()]);

    for (const id of ['SYNC-0018', 'SYNC-0020'] as const) {
      const row = progress.get(id);
      expect(row, `${id} missing from docs/progress/SYNC.md`).toBeDefined();
      const requirement = registry.get(id);
      expect(requirement, `${id} missing from registry`).toBeDefined();
      const implementation = requirement?.implementation ?? [];
      const tests = requirement?.tests ?? [];
      if (!nonEmptyStringArray(implementation) || !nonEmptyStringArray(tests)) {
        expect(
          row?.status,
          `${id} must not be Accepted while registry implementation/tests are empty (contract theater)`,
        ).not.toBe('Accepted');
      }
    }
  });

  it('does not hardcode a frozen Accepted map — progress is read live', async () => {
    // Guard against accidental regression to a static table of statuses in this file.
    const selfSource = await readFile(
      resolve(import.meta.dirname, 'sync-progress-registry-honesty.test.ts'),
      'utf8',
    );
    expect(selfSource).not.toMatch(
      /SYNC-0010\s*:\s*['"]Accepted['"][\s\S]*SYNC-0026\s*:\s*['"]Accepted['"]/u,
    );
    // Also refuse a static expected-status dictionary keyed by every target id.
    expect(selfSource).not.toMatch(
      /(?:const|let|var)\s+\w*(?:expected|status)\w*\s*[:=]\s*\{[\s\S]*?SYNC-0010[\s\S]*?SYNC-0026[\s\S]*?\}/u,
    );
    const progress = await loadProgressRows();
    for (const id of TARGET_IDS) {
      expect(progress.has(id), `${id} must appear in live progress table`).toBe(true);
      expect(progress.get(id)?.status.length ?? 0, `${id} status must be non-empty live text`).toBeGreaterThan(0);
    }
  });
});
