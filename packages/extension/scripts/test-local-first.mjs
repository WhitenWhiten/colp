// Real node:test suites over temporary ESM transpilation. No production files or imports are rewritten.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const work = await mkdtemp(join(tmpdir(), 'known-local-first-tests-'));
const modules = ['personal-sync-policy', 'personal-sync-connection', 'personal-sync-commands', 'metadata-reassociation', 'native-tree-proof', 'personal-sync-fetch', 'sync-failure-class'];
try {
  await writeFile(join(work, 'package.json'), '{"type":"module"}\n');
  for (const name of modules) {
    const file = join(root, 'src', `${name}.ts`);
    const source = await readFile(file, 'utf8');
    const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022, strict: true } });
    if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
        getCanonicalFileName: value => value, getCurrentDirectory: () => root, getNewLine: () => '\n',
      }));
    }
    await mkdir(join(work, 'src'), { recursive: true });
    await writeFile(join(work, 'src', `${name}.js`), result.outputText);
  }
  const tests = (await readdir(join(root, 'lifecycle-tests'))).filter(file => file.endsWith('.test.mjs')).sort();
  for (const file of tests) {
    const target = join(work, 'lifecycle-tests', file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(root, 'lifecycle-tests', file)));
  }
  const result = spawnSync(process.execPath, ['--test', ...tests.map(file => join(work, 'lifecycle-tests', file))], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(work, { recursive: true, force: true }); }
