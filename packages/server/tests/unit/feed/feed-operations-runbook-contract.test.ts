import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const runbook = new URL('../../../docs/runbooks/feed-projection-operations.md', import.meta.url);
const cli = new URL('../../../scripts/phase5-feed-operations.ts', import.meta.url);
const operationsConfig = new URL('../../../scripts/phase5-operations-config.ts', import.meta.url);
const fixture = new URL('../../fixtures/phase5/feed-operations-runbook.json', import.meta.url);

test('P5-24 runbook commands bind the production operations CLI and cover owned recovery controls', async () => {
  const [doc, source, configSource, contractText] = await Promise.all([
    readFile(runbook, 'utf8'), readFile(cli, 'utf8'), readFile(operationsConfig, 'utf8'),
    readFile(fixture, 'utf8'),
  ]);
  const contract = JSON.parse(contractText) as { commands: string[]; forbidden: string[] };
  for (const command of contract.commands) {
    assert.match(doc, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  for (const token of ['owner', 'threshold', 'suppression', 'diagnosis', 'beforeWatermark',
    'afterWatermark', 'beforeItemIds', 'afterItemIds', 'N/N-1', 'rollback', 'unknown outcome']) {
    assert.match(doc, new RegExp(token, 'iu'));
  }
  for (const forbidden of contract.forbidden) {
    assert.doesNotMatch(`${doc}\n${source}`, new RegExp(forbidden, 'iu'));
  }
  assert.match(source, /createPostgresSocialFeedOperationsRepository/u);
  assert.match(source, /createPostgresSocialFeedWorkerRepository/u);
  assert.match(source, /createPostgresSocialFeedProjectionRepository/u);
  assert.match(source, /loadFeedOperationsBindings/u);
  assert.match(source, /loadPhase5OperationsConfig/u);
  assert.doesNotMatch(`${source}\n${configSource}`, /\bloadConfig\b|config-auth|OIDC_/u);
  assert.match(source, /feedOperationsSourceDigest/u);
  assert.match(source, /runbookDigest/u);
  assert.match(source, /status', '--porcelain'/u);
  assert.match(source, /rev-parse', 'HEAD'/u);
  assert.match(source, /await link\(temporary, absolute\)/u);
  assert.match(doc, /--evidence-output/u);
});
