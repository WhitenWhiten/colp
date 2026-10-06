/** Compile the shipped quickstart's exact import snippet in the external consumer. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function verifyPublisherQuickstartConsumer({ consumerRoot, installedPackage, packageRoot }) {
  const document = await readFile(resolve(installedPackage, 'docs/PUBLISHER_QUICKSTART.md'), 'utf8');
  const importSection = document.split(/^## Import\r?$/mu)[1]?.split(/^## /mu)[0];
  const snippets = [...(importSection ?? '').matchAll(/\x60{3}ts\r?\n([\s\S]*?)\r?\n\x60{3}/gu)];
  assert.equal(snippets.length, 1, 'Publisher quickstart must contain one checked import example.');
  const source = [
    snippets[0][1],
    'export type HostTransaction = PublisherTransaction;',
    'export type HostUnitOfWork = PublisherUnitOfWork<HostTransaction>;',
    "if (typeof executePublisherIdempotencyBoundary !== 'function') {",
    "  throw new Error('The documented Publisher boundary is not callable.');",
    '}', '',
  ].join('\n');
  for (const extension of ['mts', 'cts']) {
    await writeFile(resolve(consumerRoot, 'publisher-quickstart.' + extension), source);
  }
  const config = resolve(consumerRoot, 'publisher-quickstart.tsconfig.json');
  await writeFile(config, JSON.stringify({
    compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, skipLibCheck: true, types: [], noEmitOnError: true,
      outDir: './publisher-quickstart-dist',
    },
    files: ['./publisher-quickstart.mts', './publisher-quickstart.cts'],
  }));
  const compiler = resolve(packageRoot, 'node_modules/typescript/bin/tsc');
  try {
    await execFileAsync(process.execPath, [compiler, '--project', config], { cwd: consumerRoot });
  } catch (error) {
    throw new Error('Packed Publisher quickstart failed TypeScript compilation:\n'
      + (error.stdout ?? '') + (error.stderr ?? ''), { cause: error });
  }
  for (const extension of ['mjs', 'cjs']) {
    await execFileAsync(process.execPath,
      [resolve(consumerRoot, 'publisher-quickstart-dist/publisher-quickstart.' + extension)],
      { cwd: consumerRoot });
  }
}
