import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { supportedProfiles } from '../../src/index.js';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const targetRequirementIds = ['MCP-0003', 'MCP-0004', 'MCP-0005', 'MCP-0007'] as const;

type EvidenceArtifact = {
  readonly sourceRevision: string;
  readonly reportDigest?: string;
  readonly passedRequirementIds: readonly string[];
};

type RequirementRecord = {
  readonly id: string;
  readonly level: string;
  readonly profile: string;
};

type RequirementsArtifact = {
  readonly requirements: readonly RequirementRecord[];
};

function readJson<Value>(...segments: readonly string[]): Value {
  return JSON.parse(readFileSync(resolve(packageRoot, ...segments), 'utf8')) as Value;
}

function tableRows(source: string): readonly (readonly string[])[] {
  return source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
}

function requireRow(
  rows: readonly (readonly string[])[],
  firstCell: string,
  documentName: string,
): readonly string[] {
  const matches = rows.filter((cells) => cells[0] === firstCell);
  expect(matches, `${documentName} must contain exactly one ${firstCell} row`).toHaveLength(1);
  return matches[0]!;
}

describe('R-01 repository-tracked MCP Write release evidence boundary', () => {
  const evidence = readJson<EvidenceArtifact>(
    'src',
    'conformance',
    'generated',
    'evidence.json',
  );
  const registry = readJson<RequirementsArtifact>(
    'src',
    'conformance',
    'generated',
    'requirements.json',
  );
  const traceability = readFileSync(resolve(packageRoot, 'docs', 'TRACEABILITY.md'), 'utf8');
  const traceabilityRows = tableRows(traceability);
  const progressRows = tableRows(
    readFileSync(resolve(packageRoot, 'docs', 'progress', 'MCP_WRITE.md'), 'utf8'),
  );

  it('keeps a verified tracked artifact non-self-referential', () => {
    expect(evidence.sourceRevision).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(evidence.passedRequirementIds.length).toBeGreaterThan(0);
    expect(evidence.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(traceability).toMatch(/tracked artifact is the release certificate/u);
  });

  it('accepts MCP Write evidence after the 2026-07-28 migration (COLP-MCP-15)', () => {
    const progressHeader = requireRow(progressRows, 'Requirement', 'MCP_WRITE.md');
    const releaseEvidenceIndex = progressHeader.indexOf('Release evidence');
    const currentReviewStatusIndex = progressHeader.indexOf('Current review status');
    expect(releaseEvidenceIndex).toBeGreaterThan(0);
    expect(currentReviewStatusIndex).toBeGreaterThan(0);

    for (const requirementId of targetRequirementIds) {
      const traceabilityRow = requireRow(
        traceabilityRows,
        `\`${requirementId}\``,
        'TRACEABILITY.md',
      );
      const progressRow = requireRow(progressRows, `\`${requirementId}\``, 'MCP_WRITE.md');
      expect(traceabilityRow.at(-1)).toBe('Verified');
      expect(progressRow[releaseEvidenceIndex]).toMatch(/accepted|verified/i);
      expect(progressRow[currentReviewStatusIndex]).toMatch(/accepted/i);
      expect(progressRow[currentReviewStatusIndex]).toMatch(/2026-07-28/i);
    }
  });

  it('restores the public mcp-write capability through repository release evidence', () => {
    const dependencyClosure = new Set(['core', 'publication', 'publisher', 'mcp-read', 'mcp-write']);
    const requiredIds = registry.requirements.filter(
      ({ level, profile }) =>
        dependencyClosure.has(profile) && (level === 'MUST' || level === 'MUST_NOT'),
    );
    const profile = requireRow(
      traceabilityRows,
      '`mcp-write`',
      'TRACEABILITY.md profile inventory',
    );
    const packageJson = readJson<{ readonly scripts: Readonly<Record<string, string>> }>('package.json');

    expect(requiredIds.length).toBeGreaterThan(0);
    expect(profile[2]).toBe(String(requiredIds.length));
    expect(Number(profile[3])).toBeGreaterThan(0);
    expect(Number(profile[3])).toBe(Number(profile[2]));
    expect(profile[4]).toBe('Evidence complete');
    expect(supportedProfiles).toContain('mcp-write');
    expect(supportedProfiles).toContain('mcp-read');
    expect(packageJson.scripts['check:release-evidence']).toContain('--all-supported');
  });
});
