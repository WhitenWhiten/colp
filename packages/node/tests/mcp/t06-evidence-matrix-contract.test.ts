import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  T06_EVIDENCE_MATRIX,
  T06_REVIEW_BULLET_IDS,
} from './t06-evidence-matrix.js';

const execFileAsync = promisify(execFile);

describe('T-06 machine-readable boundary evidence matrix', () => {
  it('binds every review bullet exactly once to concrete test files and test names', () => {
    expect(T06_EVIDENCE_MATRIX.map(({ id }) => id)).toEqual(T06_REVIEW_BULLET_IDS);

    const references = T06_EVIDENCE_MATRIX.flatMap(({ id, evidence }) =>
      evidence.map((reference) => ({ id, ...reference })));
    expect(references.length).toBeGreaterThan(T06_REVIEW_BULLET_IDS.length);

    for (const area of T06_EVIDENCE_MATRIX) {
      expect(area.reviewBullet.length).toBeGreaterThan(0);
      expect(area.evidence.length, area.id).toBeGreaterThan(0);
      for (const reference of area.evidence) {
        expect(reference.testName.length, area.id).toBeGreaterThan(0);
        expect(
          existsSync(resolve(import.meta.dirname, '..', '..', reference.file)),
          `${area.id}: ${reference.file}`,
        ).toBe(true);
      }
    }
  });

  it('resolves every reference to a test name actually collected by Vitest', async () => {
    const projectRoot = resolve(import.meta.dirname, '..', '..');
    const files = [...new Set(T06_EVIDENCE_MATRIX.flatMap(({ evidence }) =>
      evidence.map(({ file }) => file)))];
    const vitestCli = resolve(projectRoot, 'node_modules', 'vitest', 'vitest.mjs');
    const { stdout } = await execFileAsync(process.execPath, [
      vitestCli,
      'list',
      ...files,
      '--json',
    ], {
      cwd: projectRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    const collected = JSON.parse(stdout) as Array<Readonly<{ name: string; file: string }>>;

    for (const area of T06_EVIDENCE_MATRIX) {
      for (const reference of area.evidence) {
        const expectedFile = resolve(projectRoot, reference.file).replaceAll('\\', '/');
        expect(
          collected.some(({ file, name }) =>
            file.replaceAll('\\', '/') === expectedFile
            && (name === reference.testName || name.endsWith(` > ${reference.testName}`))),
          `${area.id}: ${reference.file} > ${reference.testName}`,
        ).toBe(true);
      }
    }
    // `vitest list` spawns a second Vitest and collects several files; under a
    // loaded full run it exceeded 30s, so the budget is generous.
  }, 120_000);

  it('labels every host-owned residual instead of presenting it as library behavior', () => {
    const hostResiduals = T06_EVIDENCE_MATRIX.flatMap((area) =>
      area.evidence
        .filter(({ kind }) => kind === 'host_residual')
        .map((reference) => ({ area, reference })));

    expect(hostResiduals.length).toBeGreaterThan(0);
    for (const { area } of hostResiduals) {
      expect('residualContract' in area ? area.residualContract : undefined, area.id)
        .toEqual(expect.any(String));
    }
    expect(hostResiduals.map(({ reference }) => reference.testName)).toEqual(expect.arrayContaining([
      expect.stringContaining('concealment'),
      expect.stringContaining('read-only'),
      expect.stringContaining('pre-parse'),
    ]));
  });
});
