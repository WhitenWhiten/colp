import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const runbook = new URL('../../../docs/runbooks/redis-hot-data-cache-operations.md', import.meta.url);
const plan = new URL('../../../docs/12-redis-hot-data-cache-plan.md', import.meta.url);
const evidence = new URL('../../../docs/evidence/phase2-publication-redis-evidence.json', import.meta.url);

test('T15 runbook binds the T01 configuration contract and the three cache modes', async () => {
  const doc = await readFile(runbook, 'utf8');
  for (const configName of [
    'KNOWN_CACHE_MODE', 'KNOWN_CACHE_REQUIRED', 'REDIS_URL', 'REDIS_COMMAND_TIMEOUT_MS',
    'REDIS_CONNECT_TIMEOUT_MS', 'REDIS_MAX_RETRIES_PER_REQUEST', 'REDIS_KEY_PREFIX',
    'CACHE_MAX_ENTRY_BYTES', 'CACHE_LOCK_TTL_MS',
    'CACHE_METADATA_SOFT_TTL_MS', 'CACHE_METADATA_HARD_TTL_MS',
    'CACHE_SNAPSHOT_SOFT_TTL_MS', 'CACHE_SNAPSHOT_HARD_TTL_MS',
    'CACHE_DIRECTORY_SOFT_TTL_MS', 'CACHE_DIRECTORY_HARD_TTL_MS',
    'CACHE_PUBLICATION_METADATA_ENABLED', 'CACHE_PUBLICATION_DIRECTORY_ENABLED',
    'CACHE_PUBLICATION_SNAPSHOT_ENABLED',
  ]) {
    assert.match(doc, new RegExp(configName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), configName);
  }
  for (const mode of ['KNOWN_CACHE_MODE=off', 'KNOWN_CACHE_MODE=shadow', 'KNOWN_CACHE_MODE=serve']) {
    assert.match(doc, new RegExp(mode.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), mode);
  }
});

test('T15 runbook maps every minimum alert to real metric/log fields and marks gaps 待补', async () => {
  const doc = await readFile(runbook, 'utf8');
  for (const metric of [
    'cache.read.hit', 'cache.read.miss', 'cache.read.stale', 'cache.read.fallback',
    'cache.read.bad_value', 'cache.read.redis_error', 'cache.read.lock_wait',
    'cache.entry.size_bytes', 'cache.read.latency_ms',
    'cache.circuit.state', 'cache.circuit.open', 'cache.circuit.probe',
    'cache.shadow.digest_mismatch', 'cache.epoch.rotation_total',
    'cache.outbox_invalidation.failure', 'publication.cache_purge.queue_age_ms',
    'cache.worker.readiness',
  ]) {
    assert.match(doc, new RegExp(metric.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), metric);
  }
  // Unimplemented dashboards must be labeled 待补, never claimed as deployed.
  assert.match(doc, /待补/u);
  assert.match(doc, /cache\.outbox_invalidation_age_ms/u);
  assert.match(doc, /queue_age/u);
});

test('T15 runbook documents staged rollout, single-config rollback and honest boundaries', async () => {
  const doc = await readFile(runbook, 'utf8');
  for (const token of ['灰度', 'off 对照', 'shadow', 'serve', 'Metadata', 'Directory', 'Snapshot',
    '回滚', '单个配置变更', '重启', 'API', 'Worker', '撤销窗口', '不承诺', 'hard TTL',
    'phase2-publication-redis-evidence.json', 'evidence:phase2-publication-redis',
    'cache.epoch.rotation_total', '/ready/features/cache', 'disabled']) {
    assert.match(doc, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), token);
  }
  // KEYS/SCAN appear only as prohibitions, never as runnable commands.
  assert.match(doc, /(KEYS|SCAN)[^。\n]{0,60}(禁止|不得|不要)|(禁止|不得|不要)[^。\n]{0,60}(KEYS|SCAN)/iu);
  assert.match(doc, /残留[^。\n]{0,60}(epoch|hard TTL)/iu);
});

test('T15 runbook forbids destructive Redis commands and real secret samples', async () => {
  const doc = await readFile(runbook, 'utf8');
  for (const forbidden of ['FLUSHDB', 'FLUSHALL', 'KEYS *', 'SCAN 0']) {
    assert.doesNotMatch(doc, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), forbidden);
  }
  // Real credential-bearing URLs, bearer tokens and password assignments never appear.
  assert.doesNotMatch(doc, /redis:\/\/[^<\s]+:[^<\s]+@/iu);
  assert.doesNotMatch(doc, /Bearer\s+[A-Za-z0-9._-]{12,}/iu);
  assert.doesNotMatch(doc, /password\s*=\s*[A-Za-z0-9]{8,}/iu);
  // No zero-impact / zero-staleness promises.
  assert.doesNotMatch(doc, /零影响/iu);
  assert.doesNotMatch(doc, /零陈旧/iu);
});

test('T15 runbook references the committed T14 evidence artifact', async () => {
  const [doc, artifact] = await Promise.all([
    readFile(runbook, 'utf8'),
    readFile(evidence, 'utf8'),
  ]);
  assert.match(doc, /phase2-publication-redis-evidence\.json/u);
  const parsed = JSON.parse(artifact) as { format: string; pass: { overall: boolean } };
  assert.equal(parsed.format, 'known.phase2-publication.redis-evidence.v1');
  assert.equal(parsed.pass.overall, true);
});

test('plan status is Implemented with completion date, runbook and evidence links, never Proposed', async () => {
  const planText = await readFile(plan, 'utf8');
  assert.match(planText, /状态[：:]\s*\*\*Implemented\*\*/u);
  assert.doesNotMatch(planText, /状态[：:]\s*\*\*Proposed\*\*/u);
  assert.match(planText, /2026-08-06/u);
  assert.match(planText, /redis-hot-data-cache-operations\.md/u);
  assert.match(planText, /phase2-publication-redis-evidence\.json/u);
});
