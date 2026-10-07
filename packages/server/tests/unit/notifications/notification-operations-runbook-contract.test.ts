import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('P5-25 runbook binds every operation to production ports and source-bound atomic evidence', async () => {
  const [doc, source, configSource, contractText] = await Promise.all([
    readFile(new URL('../../../docs/runbooks/notification-operations.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/phase5-notification-operations.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/phase5-operations-config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../fixtures/phase5/notification-operations-runbook.json', import.meta.url), 'utf8'),
  ]);
  const contract = JSON.parse(contractText) as { commands: string[]; forbidden: string[] };
  for (const command of contract.commands) assert.match(doc,
    new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  for (const token of ['owner', 'threshold', 'suppression', 'diagnosis', 'beforePreferences',
    'afterPreferences', 'beforeNotifications', 'afterNotifications', 'beforeDeliveries',
    'afterDeliveries', 'N/N-1', 'rollback', 'unknown outcome', 'drill', 'inclusive cutoff']) {
    assert.match(doc, new RegExp(token, 'iu'));
  }
  for (const forbidden of contract.forbidden) assert.doesNotMatch(`${doc}\n${source}`,
    new RegExp(forbidden, 'iu'));
  assert.match(source, /createPostgresNotificationOperationsRepository/u);
  assert.match(source, /createPostgresNotificationAuthorityRepository/u);
  assert.match(source, /status', '--porcelain'/u);
  assert.match(source, /rev-parse', 'HEAD'/u);
  assert.match(source, /await link\(temporary, absolute\)/u);
  assert.match(source, /loadNotificationOperationsBindings/u);
  assert.match(source, /loadPhase5OperationsConfig/u);
  assert.doesNotMatch(`${source}\n${configSource}`, /\bloadConfig\b|config-auth|OIDC_/u);
  assert.match(source, /notificationAcceptanceSourceDigest/u);
  assert.match(source, /runbookDigest/u);
  assert.match(source, /phase5-notification-operations-acceptance-bindings/u);
  assert.match(source, /resolve\(parent, basename\(absolute\)\)/u);
  assert.ok(source.indexOf('await assertEvidenceOutput(evidenceOutput)')
    < source.indexOf('createDatabaseRuntime(config.databaseUrl'),
  'evidence destination must fail closed before database operations');
});
