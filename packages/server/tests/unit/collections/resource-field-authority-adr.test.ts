import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'vitest';

const backendRoot = resolve(import.meta.dirname, '../../..');
const docsRoot = resolve(backendRoot, 'docs');
const adr0007Path = resolve(docsRoot, 'adr/0007-resource-field-authority.md');
const adr0001Path = resolve(docsRoot, 'adr/0001-canonical-mutation-boundary.md');
const adr0014Path = resolve(docsRoot, 'adr/0014-versioned-outbox-event-envelope.md');
const dataTxPath = resolve(docsRoot, '02-data-and-transactions.md');
const moduleBoundariesPath = resolve(docsRoot, '01-module-boundaries.md');
const openDecisionsPath = resolve(docsRoot, '07-open-decisions.md');
const phaseStatusPath = resolve(docsRoot, '09-phase-execution-status.md');
const phase2AcceptancePath = resolve(docsRoot, 'evidence/phase2-acceptance-2026-07-24.md');
const developPromptsRoot = resolve(docsRoot, 'develop prompts');
const migrationsReadmePath = resolve(backendRoot, 'migrations/README.md');
const productApiContractPath = resolve(docsRoot, '08-phase1-product-api-contract.md');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return path === developPromptsRoot ? [] : markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

/** Resolve markdown links that point at files under docs/ or backend root. */
function localMarkdownTargets(sourcePath: string, source: string): string[] {
  const targets: string[] = [];
  const linkRe = /\[[^\]]*]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(source)) !== null) {
    const raw = match[1].split('#')[0]?.trim() ?? '';
    if (!raw || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('mailto:')) {
      continue;
    }
    const decoded = decodeURIComponent(raw);
    targets.push(resolve(dirname(sourcePath), decoded));
  }
  return targets;
}

test('ADR-0007 locks the canonical payload_json authority transition contract', () => {
  assert.ok(existsSync(adr0007Path), 'ADR-0007 must exist');
  const adr = read(adr0007Path);

  // Must not claim implementation already exists.
  assert.match(adr, /实现尚未完成|尚未实现|实现未因|不表示.*已在代码中存在|as-is/i);
  assert.doesNotMatch(
    adr,
    /资源级\s*`payload_json`\s*列已落地|dual-write\s*已完成|tasks?\s*15\s*[-–—]\s*20\s*已完成/i,
  );

  // Target authority and migration shape.
  assert.match(adr, /payload_json/);
  assert.match(adr, /expand/i);
  assert.match(adr, /dual-write/i);
  assert.match(adr, /dual-read/i);
  assert.match(adr, /[Cc]ontract/);
  assert.match(adr, /[Rr]ollback|[回]滚/);
  assert.match(adr, /可观测|observability|resource_authority_mismatch/i);

  // Tasks 15–20 executable mapping.
  for (const task of ['15', '16', '17', '18', '19', '20']) {
    assert.match(adr, new RegExp(`\\*\\*${task}\\*\\*|Task\\s+${task}|任务\\s*${task}|\\b${task}\\b.*Canonical|\\b${task}\\b.*payload|\\b${task}\\b.*Product|\\b${task}\\b.*Publisher|\\b${task}\\b.*[Mm]ove|\\b${task}\\b.*[Nn]ode|\\b${task}\\b.*adapter|\\b${task}\\b.*[Bb]ackfill`), `task ${task} contract`);
  }

  // Event version terminology (ADR-0014).
  assert.match(adr, /event_version/);
  assert.doesNotMatch(
    adr,
    /用\s*`schema_version`\s*指代事件|事件版本字段名使用\s*`schema_version`/,
  );

  // Frozen external API must remain out of scope for redefinition.
  assert.match(adr, /ADR-0015|08-phase1-product-api-contract|冻结的外部 Product API/);
});

test('ADR-0007 local links and related architecture files resolve', () => {
  const requiredFiles = [
    adr0007Path,
    adr0001Path,
    adr0014Path,
    dataTxPath,
    moduleBoundariesPath,
    openDecisionsPath,
    phaseStatusPath,
    migrationsReadmePath,
    productApiContractPath,
    resolve(docsRoot, 'adr/README.md'),
    resolve(docsRoot, '04-sync-and-async-integration.md'),
  ];
  for (const path of requiredFiles) {
    assert.ok(existsSync(path), relative(backendRoot, path));
  }

  const adr = read(adr0007Path);
  for (const target of localMarkdownTargets(adr0007Path, adr)) {
    assert.ok(existsSync(target), `broken link from ADR-0007 -> ${relative(backendRoot, target)}`);
  }

  // Related docs must point at ADR-0007.
  for (const [path, needle] of [
    [adr0001Path, '0007-resource-field-authority'],
    [dataTxPath, '0007-resource-field-authority'],
    [moduleBoundariesPath, '0007-resource-field-authority'],
    [openDecisionsPath, '0007-resource-field-authority'],
    [resolve(docsRoot, 'adr/README.md'), '0007-resource-field-authority'],
    [resolve(docsRoot, '04-sync-and-async-integration.md'), '0007-resource-field-authority'],
  ] as const) {
    assert.match(read(path), new RegExp(needle), relative(docsRoot, path));
  }
});

test('related docs state as-is inconsistency and do not claim payload authority is implemented', () => {
  const dataTx = read(dataTxPath);
  assert.match(dataTx, /当前不一致|as-is/i);
  assert.match(dataTx, /尚无.*payload_json|资源级 `payload_json`/);
  assert.match(dataTx, /to-be|稳定态/);
  assert.doesNotMatch(dataTx, /资源级 `payload_json` 列已存在于生产 schema/);

  const modules = read(moduleBoundariesPath);
  assert.match(modules, /As-is|as-is|尚未|to-be/i);
  assert.match(modules, /tasks?\s*15/i);

  const kd022 = read(openDecisionsPath);
  assert.match(kd022, /KD-022/);
  assert.match(kd022, /expand\/migrate\/contract|payload_json/);
  assert.match(kd022, /实现未因 Accepted|tasks?\s*15/i);

  const adr0001 = read(adr0001Path);
  assert.match(adr0001, /0007-resource-field-authority/);
  assert.match(adr0001, /不表示全部生产写路径已接入|tasks?\s*16/);
});

test('architecture status remains owned only by 09-phase-execution-status', () => {
  const canonical = read(phaseStatusPath);
  for (const [phase, status] of [
    ['Phase 0', 'Verified'],
    ['Phase 1', 'Verified'],
  ] as const) {
    assert.match(canonical, new RegExp(`\\| ${phase}[^|]*\\| \\*\\*${status}\\*\\* \\|`), phase);
  }

  // ADR-0007 and related updated docs must not smuggle execution status tokens.
  const scoped = [
    adr0007Path,
    adr0001Path,
    dataTxPath,
    moduleBoundariesPath,
    openDecisionsPath,
    resolve(docsRoot, '04-sync-and-async-integration.md'),
    resolve(docsRoot, 'adr/README.md'),
  ];
  for (const path of scoped) {
    const source = read(path);
    const label = relative(docsRoot, path);
    assert.doesNotMatch(source, /当前实施阶段：|实现证据：|实现验证：/, label);
    assert.doesNotMatch(
      source,
      /\b(?:Not started|Trial evidence|Deployment-proven)\b|\*\*(?:Verified|Ready|In progress|Not started)\*\*/,
      label,
    );
  }
});

test('event_version terminology is consistent across authority and outbox ADRs', () => {
  const adr0007 = read(adr0007Path);
  const adr0014 = read(adr0014Path);
  const dataTx = read(dataTxPath);
  const syncDoc = read(resolve(docsRoot, '04-sync-and-async-integration.md'));

  for (const [label, source] of [
    ['ADR-0007', adr0007],
    ['ADR-0014', adr0014],
    ['02-data-and-transactions', dataTx],
    ['04-sync-and-async-integration', syncDoc],
  ] as const) {
    assert.match(source, /event_version/, label);
  }

  // Must not redefine outbox event version as schema_version in the migration contract.
  assert.match(adr0007, /禁止用含义不清的 `schema_version`|不用 `schema_version` 指代事件版本|event_version/);
  assert.match(adr0014, /event_version/);
  assert.match(adr0014, /不再使用含义不明确的 `schema_version`|schema_version/);
});

test('docs tree still has a single phase execution status owner', () => {
  // Keep the same invariant as phase-execution-status.test.ts for files we touch.
  const phase4aOwnerPrivatePath = resolve(docsRoot, 'evidence/phase4a-owner-private.md');
  const phase4aI16AcceptancePath = resolve(docsRoot, 'evidence/phase4a-i16-acceptance.md');
  for (const path of markdownFiles(docsRoot)) {
    if (path === phaseStatusPath) continue;
    const source = read(path);
    const label = relative(docsRoot, path);
    const phase3EntryReviewPath = resolve(docsRoot, 'evidence/phase3-sync-http-composition-review-2026-07-25.md');
    const statusSource = path === phase2AcceptancePath || path === phase3EntryReviewPath
      || path === phase4aOwnerPrivatePath || path === phase4aI16AcceptancePath
      ? source.replaceAll('Deployment-proven', 'production-deployment-boundary')
      : source;
    assert.doesNotMatch(source, /当前实施阶段：|实现证据：|实现验证：/, label);
    assert.doesNotMatch(
      statusSource,
      /\b(?:Not started|Trial evidence|Deployment-proven)\b|\*\*(?:Verified|Ready|In progress|Not started)\*\*/,
      label,
    );
    if (path === phase2AcceptancePath) {
      assert.match(source, /不是[^\n]*生产[^\n]*Deployment-proven/iu, label);
      assert.doesNotMatch(source, /\*\*Deployment-proven\*\*/u, label);
    }
    if (path === phase3EntryReviewPath) {
      assert.match(source, /not `Deployment-proven`/u, label);
      assert.doesNotMatch(source, /\*\*Deployment-proven\*\*/u, label);
    }
    if (path === phase4aOwnerPrivatePath) {
      assert.match(source, /状态：\*\*AUDIT RECORD/u, label);
      assert.match(source, /不证明当前 HEAD/u, label);
      assert.doesNotMatch(source, /状态：\*\*PENDING|\*\*PENDING\*\*/u, label);
    }
    if (path === phase4aI16AcceptancePath) {
      assert.match(source, /delivery contract/u, label);
      assert.doesNotMatch(source, /Phase 4A[^\n]*\*\*Verified\*\*/u, label);
    }
  }
});

test('migrations README remains a referenced expand/contract deployment rule', () => {
  const readme = read(migrationsReadmePath);
  assert.match(readme, /expand\/contract/i);
  const adr = read(adr0007Path);
  assert.match(adr, /migrations\/README\.md/);
  assert.ok(existsSync(migrationsReadmePath));
});
