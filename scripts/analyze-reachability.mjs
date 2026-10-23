#!/usr/bin/env node
// Run from the repository root after installing packages/server dependencies.
// This is a conservative source graph, not a proof about arbitrary runtime input.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(root, 'packages/server/package.json'));
const ts = require('typescript');
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean);
const files = [...new Set(tracked)].filter((file) =>
  /\.(?:[cm]?[jt]sx?|lean|py|sh)$/.test(file) && existsSync(path.join(root, file)));
const fileSet = new Set(files);
const edges = new Map(files.map((file) => [file, new Set()]));
const dynamicImports = [];

function resolveModule(from, specifier) {
  if (specifier === '@known/product-v1') return 'packages/web/src/generated/colp-server-v1.ts';
  if (specifier === '@known/product-v1-client') return 'packages/server/generated/openapi/product-v1.client.ts';
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return [
    target, target.replace(/\.[cm]?js$/, '.ts'), target.replace(/\.js$/, '.tsx'),
    ...['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs'].map((suffix) => target + suffix),
  ].find((candidate) => fileSet.has(candidate));
}

for (const file of files) {
  const text = readFileSync(path.join(root, file), 'utf8');
  if (file.endsWith('.lean')) {
    for (const match of text.matchAll(/^import (\S+)/gm)) {
      const target = `formal/sync/${match[1].replaceAll('.', '/')}.lean`;
      if (fileSet.has(target)) edges.get(file).add(target);
    }
    continue;
  }
  // Shell/Python entrypoints are retained below; do not parse their embedded code as JS.
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal.text;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        specifier = node.arguments[0].text;
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        dynamicImports.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          expression: node.getText(source) });
      }
    }
    if (specifier) {
      const target = resolveModule(file, specifier);
      if (target) edges.get(file).add(target);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const sdkEntries = [...readFileSync(path.join(root, 'packages/node/tsup.config.ts'), 'utf8')
  .matchAll(/'(src\/[^']+\.ts)'/g)].map((match) => `packages/node/${match[1]}`);
// Named outputs are also imported by extension evidence RPCs through chrome.runtime.getURL.
const extensionEntries = [
  'service-worker', 'entry/options', 'entry/popup', 'entry/capture-tabs', 'sync-state-store',
  'chrome-bookmark-tree', 'bookmark-privacy', 'bookmark-event-queue', 'bookmark-import-plan', 'import-preview',
].map((entry) => `packages/extension/src/${entry}.ts`);
const runtimeRoots = [
  ...sdkEntries, ...extensionEntries,
  // automation-ajv-plugin.mjs replaces package imports with these modules at bundle time.
  'packages/extension/src/automation/ajv-standalone.ts',
  'packages/extension/src/automation/ajv-formats-standalone.ts',
  'packages/extension/src/generated/automation-validators.js',
  'packages/web/src/main.tsx', 'packages/conformance/src/index.mjs',
  ...files.filter((file) => file.startsWith('packages/conformance/bin/')),
  ...['cli/index', 'bootstrap/api', 'bootstrap/worker', 'bootstrap/self-hosted',
    'infrastructure/database/migrate', 'infrastructure/seed/run']
    .map((entry) => `packages/server/src/${entry}.ts`),
  // Migrations are discovered by directory enumeration and imported using computed URLs.
  ...files.filter((file) => file.startsWith('packages/server/migrations/')),
];
const supportRoots = files.filter((file) =>
  /(?:^|\/)(?:scripts|e2e|model-tests|examples)\//.test(file)
  || /\.(?:test|spec|bench|typecheck)\.[cm]?[jt]sx?$/.test(file)
  || /\.config\.[cm]?[jt]s$/.test(file) || /\.d\.[cm]?ts$/.test(file)
  || /^(?:deploy|formal|protocol)\//.test(file));

function reachable(roots) {
  const seen = new Set();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file) || !fileSet.has(file)) continue;
    seen.add(file);
    pending.push(...edges.get(file));
  }
  return seen;
}

const runtime = reachable(runtimeRoots);
const supported = reachable([...runtimeRoots, ...supportRoots]);
const production = files.filter((file) => /^packages\/[^/]+\/(?:src|generated)\//.test(file)
  && !/(?:\.(?:test|test-helper|test-mocks)\.|\.d\.[cm]?ts$|\/test\/)/.test(file));
const report = {
  method: 'Conservative transitive import/re-export/type-import graph with separate runtime and supported test/tool roots.',
  limitations: [
    'Computed imports and source-reading contract tests need manual review; missing static edges are candidates, never automatic deletion.',
    'All developer scripts, examples, formal models and declarations are supported roots, including manually invoked tools.',
    'SDK public exports are roots even without repository consumers. Published/vendored package versions are independent artifacts.',
    'CSS selectors are checked separately by packages/web/scripts/check-dead-classes.mjs, including dynamic class prefixes.',
    'Declaration cleanup additionally uses TypeScript symbol reachability, whole-repository name checks and noUnused diagnostics.',
  ],
  summary: { codeFiles: files.length, productionModules: production.length,
    runtimeReachable: production.filter((file) => runtime.has(file)).length,
    supportOnly: production.filter((file) => supported.has(file) && !runtime.has(file)).length,
    unreachable: production.filter((file) => !supported.has(file)).length },
  runtimeRoots, supportRoots,
  unreachable: production.filter((file) => !supported.has(file)),
  supportOnly: production.filter((file) => supported.has(file) && !runtime.has(file)),
  dynamicImports,
  graph: production.map((file) => ({ file, imports: [...edges.get(file)].sort(),
    reachability: runtime.has(file) ? 'runtime' : supported.has(file) ? 'support' : 'unreachable' })),
};
const output = process.argv[2];
if (output) {
  mkdirSync(path.dirname(path.resolve(root, output)), { recursive: true });
  writeFileSync(path.resolve(root, output), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
} else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
