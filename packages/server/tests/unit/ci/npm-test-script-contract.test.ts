import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');

function readPackageJson(): {
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
} {
  return JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    readonly scripts: Readonly<Record<string, string>>;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(path);
    return [path];
  });
}

function toRepoRelative(path: string): string {
  return path.slice(backendRoot.length + 1).replaceAll('\\', '/');
}

/**
 * Policy allowlist for fast-check module imports under tests/.
 * Adding a property suite requires one entry here and a short why-comment —
 * not a frozen singleton path and not a roadmap sentence.
 */
const FAST_CHECK_IMPORT_ALLOWLIST = [
  // allocatePosition is the only property-tested surface today.
  'tests/unit/collections/position-allocator-property.test.ts',
] as const;

test('npm test delegates to unit tests and cannot pick up tests/integration', () => {
  const { scripts } = readPackageJson();
  assert.notEqual(scripts.test, 'vitest run', 'bare vitest run would discover integration suites');
  assert.doesNotMatch(
    scripts.test ?? '',
    /tests\/integration/u,
    'npm test must not reference tests/integration',
  );
  assert.equal(scripts.test, 'npm run test:unit', 'npm test must delegate to the unit script');
  assert.equal(scripts['test:unit'], 'vitest run --project unit');
  assert.doesNotMatch(scripts['test:unit'] ?? '', /tests\/integration/u);
});

test('Known-Backend pins fast-check as its own devDependency; imports stay on the allowlist', () => {
  const packageJson = readPackageJson();
  assert.equal(
    Object.hasOwn(packageJson.dependencies ?? {}, 'fast-check'),
    false,
    'fast-check belongs in Known-Backend devDependencies, not production dependencies',
  );
  assert.ok(
    packageJson.devDependencies?.['fast-check'],
    'Known-Backend package.json devDependencies must include fast-check (not colp’s copy)',
  );

  const testSources = walkFiles(resolve(backendRoot, 'tests')).filter((path) => path.endsWith('.ts'));
  const imported = new Set(
    testSources
      .filter((path) => /from ['"]fast-check['"]/u.test(readFileSync(path, 'utf8')))
      .map(toRepoRelative),
  );
  const allowed = new Set<string>(FAST_CHECK_IMPORT_ALLOWLIST);

  for (const path of imported) {
    assert.ok(
      allowed.has(path),
      `${path} imports fast-check but is not on FAST_CHECK_IMPORT_ALLOWLIST; add an entry with a why-comment`,
    );
  }
  for (const path of allowed) {
    assert.ok(
      imported.has(path),
      `${path} is allowlisted but has no fast-check import; remove the stale allowlist entry`,
    );
  }
});
