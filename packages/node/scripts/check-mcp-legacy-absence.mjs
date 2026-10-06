/**
 * COLP-MCP-15: Legacy MCP absence gate (source + declarations + tarball).
 *
 * Scans production source, generated declarations and the actual packed
 * tarball for Legacy MCP wire symbols. Intended for CI after `npm run build`
 * (declaration scan needs `dist/`; the tarball scan packs the package).
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { scanLegacyMcpAbsence } from './lib/legacy-mcp-absence.mjs';

const execFileAsync = promisify(execFile);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(packageRoot, 'src');
const distRoot = resolve(packageRoot, 'dist');

function assertNoArguments() {
  for (const argument of process.argv.slice(2)) {
    throw new Error(`Unknown Legacy MCP absence gate argument: ${argument}`);
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function readContents(paths) {
  const contents = [];
  for (const path of paths) {
    contents.push({ path, content: await readFile(path, 'utf8') });
  }
  return contents;
}

function packageRelative(path) {
  return path.replaceAll('\\', '/').replace(`${packageRoot.replaceAll('\\', '/')}/`, '');
}

async function main() {
  assertNoArguments();

  const sourcePaths = (await collectFiles(sourceRoot)).filter(
    (path) => !/[\\/]generated[\\/]/u.test(path) && !path.endsWith('.map'),
  );
  const distExists = await readdir(distRoot).then(() => true).catch(() => false);
  if (!distExists) {
    throw new Error('Legacy MCP absence gate requires a prior `npm run build` (dist/ missing).');
  }
  const declarationPaths = (await collectFiles(distRoot)).filter((path) =>
    /\.d\.(?:ts|cts)$/u.test(path));
  if (declarationPaths.length === 0) {
    throw new Error('Legacy MCP absence gate found no declaration files under dist/.');
  }

  // Pack and extract the actual production tarball (dist + README + package.json).
  const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  const tarballName = `${packageJson.name.replace('@', '').replace('/', '-')}-${packageJson.version}.tgz`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'colp-legacy-absence-'));
  const tarballFiles = [];
  try {
    await execFileAsync(npmExecutable, ['pack', '--pack-destination', temporaryDirectory], {
      cwd: packageRoot,
      shell: process.platform === 'win32',
    });
    await execFileAsync('tar', ['-xzf', resolve(temporaryDirectory, tarballName), '-C', temporaryDirectory], {
      cwd: packageRoot,
      shell: process.platform === 'win32',
    });
    const extractedPaths = await collectFiles(resolve(temporaryDirectory, 'package'));
    for (const path of extractedPaths) {
      tarballFiles.push({ path: packageRelative(path), content: await readFile(path, 'utf8') });
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const report = scanLegacyMcpAbsence({
    sourceFiles: await readContents(sourcePaths),
    declarationFiles: await readContents(declarationPaths),
    tarballFiles,
  });
  if (!report.ok) {
    throw new Error(
      'Legacy MCP absence gate failed:\n- '
      + report.findings
        .map((finding) => `${finding.path}:${finding.line} Legacy MCP symbol ${finding.symbol}`)
        .join('\n- '),
    );
  }
  console.log(
    `Legacy MCP absence accepted: ${report.scanned.sourceFiles} source files, `
    + `${report.scanned.declarationFiles} declarations, ${report.scanned.tarballFiles} tarball files scanned.`,
  );
}

await main();
