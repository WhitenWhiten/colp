import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyRequirementOccurrence } from '../../scripts/lib/requirement-classification.mjs';
import { scanMarkdownSource } from '../../scripts/lib/requirement-coverage.mjs';

const execFileAsync = promisify(execFile);
const checker = resolve(import.meta.dirname, '..', '..', 'scripts', 'check-requirement-coverage.mjs');
const temporaryRoots: string[] = [];
const quote = 'Clients MUST preserve state and SHOULD NOT guess paths.';

async function fixture(records: string): Promise<{ protocolRoot: string; registryPath: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'colp-requirements-'));
  temporaryRoots.push(root);
  const protocolRoot = resolve(root, 'protocol');
  await mkdir(resolve(protocolRoot, 'docs'), { recursive: true });
  await writeFile(
    resolve(protocolRoot, 'SPECIFICATION.md'),
    [
      '# Fixture',
      '',
      'The words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` follow BCP 14.',
      '',
      '## 1. Rules',
      '',
      quote,
      '',
      '```text',
      'Code MUST not count.',
      '```',
      '',
    ].join('\n'),
  );
  const registryPath = resolve(root, 'requirements.yaml');
  await writeFile(registryPath, `version: 0.1\nrequirements:\n${records}`);
  return { protocolRoot, registryPath };
}

function record(id: string, level: string, keywordOrdinal: number, selectedQuote = quote): string {
  return [
    `  - id: ${id}`,
    `    level: ${level}`,
    '    profile: core',
    '    source: SPECIFICATION.md',
    `    requirement: ${JSON.stringify(selectedQuote)}`,
    '    selector:',
    '      section: "1"',
    `      quote: ${JSON.stringify(selectedQuote)}`,
    '      quoteOrdinal: 1',
    `      keywordOrdinal: ${keywordOrdinal}`,
    '    implementation: []',
    '    tests: []',
    '',
  ].join('\n');
}

async function runChecker(records: string): Promise<string> {
  const { protocolRoot, registryPath } = await fixture(records);
  try {
    const result = await execFileAsync(process.execPath, [
      checker,
      '--protocol-root',
      protocolRoot,
      '--registry',
      registryPath,
    ]);
    return `${result.stdout}${result.stderr}`;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`);
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Requirement Registry coverage', () => {
  it('covers every keyword occurrence independently', async () => {
    await expect(
      runChecker(record('CORE-0001', 'MUST', 1) + record('CORE-0002', 'SHOULD_NOT', 2)),
    ).resolves.toMatch(/2 occurrences/u);
  });

  it('fails when an occurrence is missing', async () => {
    await expect(runChecker(record('CORE-0001', 'MUST', 1))).rejects.toThrow(
      /Missing requirement/u,
    );
  });

  it('fails when two records cover one occurrence', async () => {
    await expect(
      runChecker(record('CORE-0001', 'MUST', 1) + record('CORE-0002', 'MUST', 1)),
    ).rejects.toThrow(/Duplicate coverage/u);
  });

  it('fails when a selector is stale', async () => {
    await expect(
      runChecker(
        record('CORE-0001', 'MUST', 1, 'Clients MUST preserve something else.') +
          record('CORE-0002', 'SHOULD_NOT', 2),
      ),
    ).rejects.toThrow(/Stale normative selector/u);
  });

  it('classifies by heading section instead of mutable line numbers', () => {
    const baseline = ['# Spec', '', '## 9. HTTP baseline', '', '- Requests MUST use UTF-8.'].join(
      '\n',
    );
    const padded = [
      '# Spec',
      '',
      '',
      '<!-- COLP-REQ CORE-9999 -->',
      '',
      '## 9. HTTP baseline',
      '',
      '',
      '<!-- unrelated marker -->',
      '',
      '- Requests MUST use UTF-8.',
    ].join('\n');
    const first = scanMarkdownSource(baseline, 'SPECIFICATION.md')[0]!;
    const second = scanMarkdownSource(padded, 'SPECIFICATION.md')[0]!;

    expect(first.section).toBe('9');
    expect(second.section).toBe('9');
    expect(classifyRequirementOccurrence(first)).toEqual(['publication', 'PUB']);
    expect(classifyRequirementOccurrence(second)).toEqual(['publication', 'PUB']);
  });
});
