import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';
import ts from 'typescript';

const backendRoot = resolve(import.meta.dirname, '../../..');

async function readSource(relativePath: string): Promise<string> {
  return readFile(resolve(backendRoot, relativePath), 'utf8');
}

/**
 * Identifier references in a TypeScript source file, ignoring comments and string
 * literals. Absence gates use the AST instead of substring matching so that a comment
 * or log string mentioning a symbol can never satisfy the gate (no false green) and
 * equivalent refactors cannot trip it (no false red).
 */
function referencedIdentifiers(relativePath: string): string[] {
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(resolve(backendRoot, relativePath), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const identifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return identifiers;
}

test('R5-03 public outbox-continuation gate wraps PostgreSQL via with-postgres', async () => {
  const packageJson = JSON.parse(await readSource('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:phase5:outbox-continuation'],
    'node scripts/with-postgres.mjs -- npm run test:phase5:outbox-continuation:inner',
  );
  const inner = packageJson.scripts['test:phase5:outbox-continuation:inner'] ?? '';
  assert.match(inner, /outbox-continuation-static\.test\.ts/u);
  assert.match(inner, /outbox-continuation\.test\.ts/u);
  assert.match(inner, /outbox-continuation-postgres\.integration\.test\.ts/u);
});

test('R5-03 does not inject continuation into non-feed production routes', () => {
  // Static disable-mode gate: R5-04 owns live Feed fan-out continuation; every other
  // production route must stay continuation-free. Enforced on AST identifier references
  // (see referencedIdentifiers) rather than source substrings: formatting refactors
  // cannot trip it, and comments or strings mentioning the symbol cannot satisfy it.
  const sources = [
    'src/infrastructure/notifications/social-notification-worker-route.ts',
    'src/infrastructure/outbox/social-collection-change.ts',
    'src/infrastructure/outbox/collection-mutation-events.ts',
    'src/infrastructure/outbox/publication-cache-purge.ts',
    'src/infrastructure/outbox/sync-conflict.ts',
  ];
  for (const relativePath of sources) {
    assert.equal(
      referencedIdentifiers(relativePath).includes('OutboxContinuationRequested'),
      false,
      `${relativePath} must not reference OutboxContinuationRequested yet`,
    );
  }
});

test('R5-03 closed schema and index export the continuation surface', async () => {
  const schema = JSON.parse(
    await readSource('tests/fixtures/phase5/remediation/r5-03-outbox-continuation.schema.json'),
  ) as {
    properties: {
      format: { const: string };
      task: { const: string };
    };
  };
  assert.equal(schema.properties.format.const, 'known.phase5.remediation.r5-03.v1');
  assert.equal(schema.properties.task.const, 'R5-03');

  // Module-export evidence is loaded at runtime rather than matched against source text.
  const { OutboxContinuationRequested, OutboxDeliveryError } = await import('../../../src/infrastructure/outbox/index.js');
  assert.equal(typeof OutboxContinuationRequested, 'function');
  const continuation = new OutboxContinuationRequested();
  assert.equal(continuation instanceof Error, true,
    'continuation must remain a normal Error subclass');
  assert.equal(continuation instanceof OutboxDeliveryError, false,
    'continuation must not be an OutboxDeliveryError: it is normal control flow, not delivery failure');
});
