import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

const planPath = resolve(
  import.meta.dirname,
  '../../../../docs/plans/completed/known-backend/phase2-development-plan.md',
);
const source = readFileSync(planPath, 'utf8');

test('Phase 2 plan defines 17 ordered one-commit tasks with production and test scope', () => {
  const tasks = [...source.matchAll(/^### (P2-\d{2})：`([^`]+)`$/gmu)];
  const expectedIds = Array.from(
    { length: 17 },
    (_, index) => `P2-${String(index + 1).padStart(2, '0')}`,
  );

  assert.deepEqual(tasks.map((match) => match[1]), expectedIds);
  assert.equal(new Set(tasks.map((match) => match[2])).size, expectedIds.length);

  for (const [index, task] of tasks.entries()) {
    const start = task.index;
    const end = tasks[index + 1]?.index ?? source.indexOf('\n## 4.', start);
    const section = source.slice(start, end);
    assert.match(section, /- 生产范围（`[^`]*src\/\*\*`[^）]*）：/u, task[1]);
    assert.match(section, /- 测试范围（`[^`]*(?:tests\/\*\*|\.test\.tsx)[^`]*`/u, task[1]);
    assert.match(section, /- 完成标准：/u, task[1]);
    assert.match(section, /- 不包含：/u, task[1]);
  }
});

test('Phase 2 plan covers the fixed surfaces and every roadmap exit gate', () => {
  for (const required of [
    '/.well-known/collection-protocol',
    '/colp/v0.1/directory',
    '/colp/v0.1/collections/{collectionId}',
    '/colp/v0.1/collections/{collectionId}/snapshot',
    '/api/v1/collections/{slug}',
    'REPEATABLE READ READ ONLY',
    'snapshot_expired',
    'public/member cache partition',
    'cursor rotation/restart',
    'CDN purge',
    'assertProfileClaims',
    '74/74',
  ]) {
    assert.ok(source.includes(required), required);
  }

  assert.match(source, /Phase 2B[^\n]*不进入/u);
  assert.match(source, /P2-01 至 P2-17 顺序/u);
});
