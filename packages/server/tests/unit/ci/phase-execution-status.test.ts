import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { test } from 'vitest';

const docsRoot = resolve(import.meta.dirname, '../../../docs');
const canonicalStatusPath = resolve(docsRoot, '09-phase-execution-status.md');
const phase2AcceptancePath = resolve(docsRoot, 'evidence/phase2-acceptance-2026-07-24.md');
const phase3EntryReviewPath = resolve(docsRoot, 'evidence/phase3-sync-http-composition-review-2026-07-25.md');
const phase4aOwnerPrivatePath = resolve(docsRoot, 'evidence/phase4a-owner-private.md');
const phase4aI16AcceptancePath = resolve(docsRoot, 'evidence/phase4a-i16-acceptance.md');
const developPromptsRoot = resolve(docsRoot, 'develop prompts');

/** Closed enum from docs/09-phase-execution-status.md §1. Bold/backticks are not part of the value. */
const PHASE_EXECUTION_STATUSES = [
  'Not started',
  'Ready',
  'In progress',
  'Trial evidence',
  'Implemented / Awaiting current-revision acceptance',
  'Verified',
  'Deployment-proven',
] as const;

type PhaseExecutionStatus = (typeof PHASE_EXECUTION_STATUSES)[number];

interface PhaseStatusRow {
  readonly phase: string;
  readonly status: PhaseExecutionStatus;
  readonly evidence: string;
  readonly nextGate: string;
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return path === developPromptsRoot ? [] : markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

function stripCellDecorators(cell: string): string {
  return cell.replaceAll('**', '').replaceAll('`', '').trim();
}

function isPhaseExecutionStatus(value: string): value is PhaseExecutionStatus {
  return (PHASE_EXECUTION_STATUSES as readonly string[]).includes(value);
}

function parseCanonicalStatusTable(markdown: string): readonly PhaseStatusRow[] {
  const currentStatusSection = markdown.split(/^## 2\. 当前状态\s*$/mu)[1]?.split(/^## /mu)[0];
  assert.ok(currentStatusSection, 'canonical doc must have a current-status table');

  const rows: PhaseStatusRow[] = [];
  for (const line of currentStatusSection.split(/\r?\n/u)) {
    if (!/^\| Phase \d/u.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const phaseMatch = /^(Phase \d+[A-Z]?)/u.exec(cells[0] ?? '');
    if (!phaseMatch?.[1]) continue;
    const status = stripCellDecorators(cells[1] ?? '');
    assert.ok(
      isPhaseExecutionStatus(status),
      `${phaseMatch[1]} status cell must be a closed enum value, got ${status}`,
    );
    rows.push({
      phase: phaseMatch[1],
      status,
      evidence: cells[2] ?? '',
      nextGate: cells[3] ?? '',
    });
  }
  return rows;
}

function requirePhaseRow(
  rows: readonly PhaseStatusRow[],
  phase: string,
): PhaseStatusRow {
  const row = rows.find((candidate) => candidate.phase === phase);
  assert.ok(row, `${phase} canonical status row`);
  return row;
}

function deniesDeploymentProven(text: string): boolean {
  return /不是[^|]*Deployment-proven|not[^|]*Deployment-proven/iu.test(text);
}

function rowDeniesDeploymentProven(row: PhaseStatusRow): boolean {
  return deniesDeploymentProven(`${row.evidence}|${row.nextGate}`);
}

test('one canonical document owns every phase execution status', () => {
  const canonical = readFileSync(canonicalStatusPath, 'utf8');
  const rows = parseCanonicalStatusTable(canonical);
  for (const [phase, status] of [
    ['Phase 0', 'Verified'],
    ['Phase 1', 'Verified'],
    ['Phase 2', 'Verified'],
    ['Phase 2B', 'Verified'],
    ['Phase 3', 'Verified'],
    ['Phase 4A', 'Verified'],
    ['Phase 4B', 'Verified'],
    ['Phase 5', 'Verified'],
  ] as const) {
    assert.equal(requirePhaseRow(rows, phase).status, status, phase);
  }

  for (const path of markdownFiles(docsRoot)) {
    if (path === canonicalStatusPath) continue;
    const source = readFileSync(path, 'utf8');
    const label = relative(docsRoot, path);
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
      assert.ok(deniesDeploymentProven(source), label);
      assert.doesNotMatch(source, /\*\*Deployment-proven\*\*/u, label);
    }
    if (path === phase3EntryReviewPath) {
      assert.ok(deniesDeploymentProven(source), label);
      assert.doesNotMatch(source, /\*\*Deployment-proven\*\*/u, label);
    }
    if (path === phase4aOwnerPrivatePath) {
      // The P11 delivery contract is an audit record for the historical
      // run; it must not smuggle a status claim or regress to PENDING.
      assert.match(source, /AUDIT RECORD/u, label);
      assert.doesNotMatch(source, /状态：\*\*PENDING|\*\*PENDING\*\*/u, label);
    }
    if (path === phase4aI16AcceptancePath) {
      // Historical I16 delivery contract: may name the Verified gate but
      // must never claim Phase 4A is currently Verified.
      assert.match(source, /delivery contract/u, label);
      assert.doesNotMatch(source, /^\| Phase 4A[^|\n]*\|[^|\n]*Verified/mu, label);
    }
  }
});

test('Phase 2 is Verified by a retained acceptance record without claiming production deployment', () => {
  const canonical = readFileSync(canonicalStatusPath, 'utf8');
  const row = requirePhaseRow(parseCanonicalStatusTable(canonical), 'Phase 2');
  assert.equal(row.status, 'Verified');
  assert.match(row.evidence, /\.\/evidence\/phase2-acceptance-2026-07-24\.md/u);
  assert.ok(rowDeniesDeploymentProven(row));
  assert.notEqual(row.status, 'Deployment-proven');
});

test('Phase 2B is Verified by its retained acceptance record without claiming deployment proof', () => {
  const canonical = readFileSync(canonicalStatusPath, 'utf8');
  const row = requirePhaseRow(parseCanonicalStatusTable(canonical), 'Phase 2B');
  assert.equal(row.status, 'Verified');
  assert.match(row.evidence, /\.\/evidence\/phase2b-acceptance-2026-07-26\.md/u);
  assert.ok(rowDeniesDeploymentProven(row));
  assert.notEqual(row.status, 'Deployment-proven');
});

test('Phase 3 is Verified by the P3-39 release gate without claiming production deployment', () => {
  const canonical = readFileSync(canonicalStatusPath, 'utf8');
  const row = requirePhaseRow(parseCanonicalStatusTable(canonical), 'Phase 3');
  assert.equal(row.status, 'Verified');
  assert.match(row.evidence, /\.\/evidence\/phase3-sync-profile-release-2026-07-31\.md/u);
  assert.ok(rowDeniesDeploymentProven(row));
  assert.notEqual(row.status, 'Deployment-proven');
});
