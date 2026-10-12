/**
 * Shared KNS-09 acceptance evaluation. Manifests are not pass proofs.
 * A receipt is accepted only when every required gate is a machine-recorded pass
 * for the same tested SHA, with no skipped/cancelled/failed/missing results.
 */
export const REQUIRED_GATE_IDS = Object.freeze([
  'extension.typecheck',
  'extension.lint',
  'extension.source-size',
  'extension.unit',
  'extension.sync-real-stack',
  'extension.phase3-durable-sync-engine',
  'extension.coverage-sync',
  'extension.e2e-first-run-sync',
  'extension.e2e-trash-restore',
  'extension.e2e-phase3-multi-device-recovery',
  'extension.e2e',
  'colp.check',
  'backend.typecheck',
  'backend.lint',
  'backend.unit',
  'backend.openapi',
  'backend.colp-contract',
  'backend.integration',
  'frontend.typecheck',
  'frontend.test',
]);

const TERMINAL_PASS = 'passed';
const REJECT_STATUSES = new Set(['failed', 'skipped', 'cancelled', 'missing']);

export function evaluateAcceptance(input) {
  const reasons = [];
  const expectedCommit = String(input?.expectedCommit ?? '');
  const testedCommit = String(input?.testedCommit ?? '');
  if (!expectedCommit || expectedCommit === 'unknown') reasons.push('tested_commit_missing');
  if (!testedCommit || testedCommit === 'unknown') reasons.push('gate_commit_missing');
  if (expectedCommit && testedCommit && expectedCommit !== testedCommit) reasons.push('tested_commit_mismatch');
  const dirty = Array.isArray(input?.dirtyInputPaths) ? input.dirtyInputPaths.filter(Boolean) : [];
  if (dirty.length > 0) reasons.push('dirty_input_tree');
  const gates = Array.isArray(input?.gates) ? input.gates : [];
  const byId = new Map();
  for (const gate of gates) {
    if (!gate || typeof gate !== 'object') continue;
    const id = String(gate.id ?? '');
    if (!id) {
      reasons.push('gate_id_missing');
      continue;
    }
    byId.set(id, gate);
  }
  const required = Array.isArray(input?.requiredIds) && input.requiredIds.length > 0
    ? input.requiredIds : [...REQUIRED_GATE_IDS];
  for (const id of required) {
    const gate = byId.get(id);
    if (!gate) {
      reasons.push(`missing:${id}`);
      continue;
    }
    const status = String(gate.status ?? '');
    const exitCode = Number(gate.exitCode);
    if (REJECT_STATUSES.has(status)) reasons.push(`${status}:${id}`);
    else if (status !== TERMINAL_PASS) reasons.push(`status_invalid:${id}`);
    if (!Number.isInteger(exitCode) || exitCode !== 0) reasons.push(`exit:${id}`);
    if (gate.testedCommit && String(gate.testedCommit) !== testedCommit) reasons.push(`sha:${id}`);
  }
  const unique = [...new Set(reasons)];
  return {
    verdict: unique.length === 0 ? 'accepted' : 'rejected',
    reasons: unique,
    requiredIds: required,
  };
}

export const INDEXED_DB_NAME = 'known-phase3-indexeddb-entry';

export function indexedDbPin(schemaSource) {
  const match = String(schemaSource ?? '').match(/DATABASE_VERSION = (\d+)/u);
  if (!match) throw new Error('DATABASE_VERSION missing');
  return { name: INDEXED_DB_NAME, version: Number(match[1]) };
}

export function rollbackPin(version) {
  return `close known.kns09.mutations.v1; drain queue; never install v${version - 1} over v${version}`;
}

export function requireSchemaVersion(schemaSource, expected) {
  const pin = indexedDbPin(schemaSource);
  if (pin.version !== expected) {
    throw new Error(`KNS-09 requires DATABASE_VERSION = ${expected}`);
  }
  return pin;
}

export function inputDirtyPaths(porcelain) {
  const lines = String(porcelain ?? '').split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const dirty = [];
  for (const line of lines) {
    const path = line.slice(3).replace(/^.* -> /u, '').trim();
    if (!path) continue;
    if (isAcceptanceArtifact(path)) continue;
    if (isInputPath(path)) dirty.push(path);
  }
  return dirty;
}

function isAcceptanceArtifact(path) {
  return path.startsWith('test-results/')
    || path.startsWith('packages/extension/test-results/')
    || path.startsWith('packages/extension/coverage/')
    || /\/coverage\//u.test(path);
}

function isInputPath(path) {
  return /^(packages|protocol|scripts|\.github)\//u.test(path)
    || path === 'package.json'
    || path === 'package-lock.json';
}
