/**
 * Docs/status contract: pin bookmark-favicon docs to Implemented
 * (not Deployment-proven). This is **not** a favicon runtime proof.
 *
 * Production favicon behavior can change while these Markdown / OpenAPI
 * pins stay green. Runtime proof lives in the existing Postgres and
 * HTTP suites — do not invent a second HTTP suite:
 * `tests/integration/product/product-public-bookmark-icon-postgres.integration.test.ts`,
 * `tests/integration/collections/bookmark-icons-postgres.integration.test.ts`,
 * `tests/unit/collections/bookmark-favicon-http.test.ts`.
 *
 * Anti-false-positive: bind the plan **status line**, phase-status **table
 * rows**, and OpenAPI `info.version` — not “the word Implemented appears
 * somewhere”. BF-I is optional extra that has landed and is not a gap for
 * the main-track Implemented record.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const repoRoot = resolve(backendRoot, '..');

function readRepo(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function readBackend(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), 'utf8');
}

function pin(source: string, token: string, label: string): void {
  assert.match(source, new RegExp(escapeRegExp(token), 'u'), label);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function firstLineStarting(source: string, prefix: string, label: string): string {
  const line = source.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, label);
  return line!;
}

const plan = readRepo('docs/plans/completed/known-backend/bookmark-favicon-development-plan.md');
const phaseStatus = readBackend('docs/09-phase-execution-status.md');
const roadmap = readBackend('docs/06-delivery-roadmap.md');
const docsReadme = readBackend('docs/README.md');
const openapiSource = readBackend('openapi/product-v1.yaml');

test('plan header status line is Implemented, not Proposed, and not Deployment-proven', () => {
  const statusLine = firstLineStarting(plan, '> 状态：', 'plan header status blockquote');

  pin(statusLine, '状态：**Implemented', 'status token is on the header line');
  pin(statusLine, '2026-08-20', 'Implemented date');
  pin(statusLine, 'BF-01..BF-07', 'main track on the status line');
  assert.match(
    statusLine,
    /非 Deployment-proven|not Deployment-proven/iu,
    'header must say not Deployment-proven',
  );
  assert.doesNotMatch(statusLine, /状态：\*\*Proposed/u, 'must not still claim Proposed');
  assert.doesNotMatch(
    statusLine,
    /状态：\*\*Deployment-proven/u,
    'must not claim Deployment-proven as current status',
  );
  pin(statusLine, '实施记录', 'past-tense: plan is the implementation record');
  assert.doesNotMatch(
    plan,
    /本文是后续实施与验收合同，不表示其中任务已经完成/u,
    'future-tense contract sentence must be gone',
  );
});

test('Implemented record is BF-01..BF-07; optional BF-I landed as extra and is not a gap', () => {
  pin(plan, 'BF-01..BF-07', 'main-track span');
  assert.match(plan, /BF-01\.\.BF-07[^\n]*已落地/u, 'main track landed');
  assert.match(
    plan,
    /Implemented 记录是主轨道 BF-01\.\.BF-07|主轨道 BF-01\.\.BF-07[^\n]*Implemented/u,
    'BF-01..BF-07 is the Implemented record',
  );
  assert.match(plan, /BF-I[^\n]*不是缺口/u, 'BF-I is not a gap for that record');
  assert.match(
    plan,
    /BF-I[^\n]*(?:不在本记录|不在该记录)|(?:不在本记录|不在该记录)[^\n]*BF-I/u,
    'BF-I is outside the Implemented record',
  );
  pin(plan, '### BF-I（可选，BF-08 之后）', 'BF-I remains optional after BF-08');
  pin(plan, '已作为可选额外能力落地', 'BF-I landed as optional extra');
  pin(plan, '仍不在该 Implemented 记录内', 'BF-I is still not required for the main-track Implemented record');
  assert.match(
    plan,
    /可选 \*\*BF-I\*\*[^\n]*仍非 Deployment-proven/u,
    'BF-I remains not Deployment-proven',
  );
});

test('explicit non-gaps remain: no Web upload UI, no COLP Attachment, no backfill, cross-origin skip is contract', () => {
  pin(plan, '### 1.3 明确不包含', 'non-goals section');
  pin(plan, '本增量不做 Web 上传/删除 UI', 'no Web upload UI');
  pin(plan, '本计划 Product `iconUrl` **不是** COLP Attachment 物化', 'not COLP Attachment');
  pin(plan, '本增量不做存量 backfill', 'no inventory backfill');
  pin(
    plan,
    '因此跨源 favicon 捕获失败是本增量的预期行为，不是后续顺手补权限。',
    'cross-origin capture skip is contract',
  );
});

test('current Product OpenAPI info.version matches the generated bundle; the favicon plan records 1.22.0', () => {
  const openapi = parse(openapiSource) as { info?: { version?: string } };
  const generated = parse(readBackend('generated/openapi/product-v1.bundle.yaml')) as { info?: { version?: string } };
  assert.equal(openapi.info?.version, generated.info?.version, 'openapi/product-v1.yaml info.version');

  pin(plan, '当前 Product OpenAPI `info.version` 为 **1.22.0**', 'plan records favicon increment version');
  assert.doesNotMatch(
    plan,
    /当前 Product OpenAPI `info\.version` 为 \*\*1\.21\.0\*\*/u,
    '1.21.0 must not still be described as current',
  );
  pin(plan, 'stripAdditiveOptionalProperties', '1.21.0→1.22.0 additive optional-field history');
  assert.match(plan, /1\.21\.0/u, 'keep 1.21.0 as history');
});

test('phase execution status rows stay Phase 3/4A/5 as-is and do not list bookmark favicon as a phase exit', () => {
  const phase3 = firstLineStarting(phaseStatus, '| Phase 3：', 'Phase 3 table row');
  const phase4a = firstLineStarting(phaseStatus, '| Phase 4A：', 'Phase 4A table row');
  const phase5 = firstLineStarting(phaseStatus, '| Phase 5：', 'Phase 5 table row');

  pin(phase3, '| Phase 3：Browser Sync | **Verified** |', 'Phase 3 Verified cell');
  pin(
    phase4a,
    '| Phase 4A：附件上传 | **Verified** |',
    'Phase 4A Verified cell',
  );
  pin(phase5, '| Phase 5：社交、Feed 与通知 MVP | **Verified** |', 'Phase 5 Verified cell');

  assert.doesNotMatch(
    phaseStatus,
    /bookmark favicon|Bookmark Favicon|书签图标|favicon 增量/iu,
    'bookmark favicon must not appear as a phase exit in 09-phase-execution-status.md',
  );
});

test('delivery roadmap records bookmark favicon as an independent Product increment without changing Phase 3/4A/5', () => {
  const libraryHeading = '### Library Management 增量能力';
  const faviconHeading = '### Bookmark Favicon 增量能力';
  const phase3Heading = '## 4. Phase 3：Browser Sync';
  const libraryIdx = roadmap.indexOf(libraryHeading);
  const faviconIdx = roadmap.indexOf(faviconHeading);
  const phase3Idx = roadmap.indexOf(phase3Heading);

  assert.ok(libraryIdx >= 0, 'Library Management subsection exists');
  assert.ok(faviconIdx >= 0, 'Bookmark Favicon subsection exists');
  assert.ok(phase3Idx >= 0, 'Phase 3 heading exists');
  assert.ok(
    libraryIdx < faviconIdx && faviconIdx < phase3Idx,
    'Bookmark Favicon subsection is after Library Management and before Phase 3',
  );

  const subsection = roadmap.slice(faviconIdx, phase3Idx);
  pin(subsection, '独立 Product increment', 'independent Product increment');
  pin(subsection, '1.22.0', 'OpenAPI 1.22.0');
  pin(subsection, '公开 GET', 'public GET');
  pin(subsection, 'Session/helper', 'Session/helper write');
  pin(subsection, '公开页', 'public-only CDN surface');
  assert.match(subsection, /不改变 Phase 3\/4A\/5 完成/u, 'does not change Phase 3/4A/5 completion');
  pin(subsection, '不是生产部署证明', 'not production deployment proof (avoid Deployment-proven token in this file)');
  pin(
    subsection,
    'bookmark-favicon-development-plan.md',
    'links the plan',
  );

  pin(roadmap, '## 4. Phase 3：Browser Sync', 'Phase 3 section heading unchanged');
  pin(roadmap, '### Phase 4A：附件上传', 'Phase 4A section heading unchanged');
  pin(roadmap, '## 6. Phase 5：社交、Feed 与通知 MVP', 'Phase 5 section heading unchanged');
  pin(
    roadmap,
    '- Phase 2 Publication 与公开 Profile 投影保持 `Verified`，可提供稳定、权限过滤后的公开 Collection identity；',
    'Phase 5 entry Verified wording unchanged',
  );
});

test('backend docs README lists Bookmark Favicon among development plans', () => {
  pin(
    docsReadme,
    'Phase 2/2B/3/4A/5 与 Library Management、Bookmark Favicon 开发计划',
    'plans table mentions Bookmark Favicon',
  );
});
