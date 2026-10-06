import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set([
  '.cjs', '.css', '.env', '.example', '.html', '.js', '.json', '.jsx', '.md',
  '.mjs', '.pem', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);
const alwaysScanNames = new Set(['.env', '.envrc', 'id_rsa', 'id_ecdsa', 'id_ed25519', '.npmrc']);
const excluded = /(^|[\\/])(\.git|node_modules|dist|coverage)([\\/]|$)|package-lock\.json$/;
const readChunkBytes = 64 * 1024;
const credentialPatterns = [
  { rule: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { rule: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  {
    rule: 'quoted-credential',
    pattern: /\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token)\s*=\s*['"]([^'"\s]{8,})['"]/i,
  },
  {
    rule: 'quoted-credential',
    pattern: /\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*['"]([^'"\s]{8,})['"]/i,
    configOnly: true,
  },
  {
    // The product's own account-credential format. Without an explicit rule the
    // generic high-entropy pattern misses it whenever the assignment key is not
    // literally `secret|token|password|credential` (the shapes in
    // Known-Backend/src/modules/auth/application/account-credentials/secret.ts).
    rule: 'known-account-credential',
    pattern: /\bkn_[pc]_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}\b/,
  },
  {
    rule: 'unquoted-env',
    pattern: /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY))=((?!['"`$])[A-Za-z0-9_./+=-]{8,})/,
  },
];
const annotationPattern = /(?:\/\/|\/\*|#)\s*secret-scan:\s*allow\s+['"]([^'"\s]+)['"]/g;
const malformedAnnotationPattern = /(?:\/\/|\/\*|#)\s*secret-scan:\s*allow\b/;
const quotedLiteralPattern = /['"]([^'"\s]+)['"]/;
const realCredentialShapes = [
  /\bkn_[pc]_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /^[A-Za-z0-9/+=]{40}$/,
  /^[0-9a-fA-F]{64}$/,
];
const highEntropyPattern = /\b(?:secret|token|password|credential)\w*\s*[:=]\s*['"]([A-Za-z0-9+/=_-]{32,})['"]/gi;
const placeholderLiteral = /^(?:changeme|placeholder|redacted|example|dummy|todo|your[-_].+|change-me\b.*|known_test_only|password|passwd|forbidden|replace-.+|dev-[a-z0-9-]+|<.*>|<.+|.+change-me|\$\{[^}]+\})$/i;
const configExtensions = new Set(['.env', '.example', '.json', '.md', '.sh', '.sql', '.toml', '.txt', '.yaml', '.yml']);

function walk(directory, scanRoot, includeGenerated) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    const relativePath = relative(scanRoot, path);
    if (!includeGenerated && excluded.test(relativePath)) return [];
    if (includeGenerated && /(^|[\\/])(\.git|node_modules)([\\/]|$)|package-lock\.json$/.test(relativePath)) {
      return [];
    }
    const stat = statSync(path);
    if (stat.isDirectory()) return walk(path, scanRoot, includeGenerated);
    return stat.isFile() && shouldScanPath(path) ? [path] : [];
  });
}

function shouldScanPath(path) {
  const base = path.split(/[/\\]/).pop() ?? '';
  if (alwaysScanNames.has(base)) return true;
  return textExtensions.has(extname(path).toLowerCase());
}

export function gitTrackedFiles(root = repositoryRoot) {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' });
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8') || 'git ls-files failed');
  return result.stdout.toString('utf8').split('\0').filter(Boolean).flatMap((relativePath) => {
    if (excluded.test(relativePath)) return [];
    if (!shouldScanPath(relativePath)) return [];
    return [resolve(root, relativePath)];
  });
}

/** The product's own credential format, as {@link realCredentialShapes} lists it. */
const PRODUCT_CREDENTIAL_SHAPE = /\bkn_[pc]_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}\b/;
const KNOWN_ALLOWLIST_KEYS = new Set([
  'path', 'paths', 'literal', 'literalParts', 'literalBase64', 'reason', 'owner', 'expires', 'fixture',
]);

export function loadAllowlist(allowlistPath = resolve(repositoryRoot, 'scripts/secret-scan-allowlist.json')) {
  const document = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  const entries = (document.literals ?? []).map((entry) => {
    let literal = entry.literal;
    if (!literal && Array.isArray(entry.literalParts)) literal = entry.literalParts.join('');
    if (!literal && entry.literalBase64) literal = Buffer.from(entry.literalBase64, 'base64').toString('utf8');
    // `paths` lets one documented fixture literal cover every file that pins the
    // same value, without ever becoming a directory or glob exemption.
    return { ...entry, literal, paths: entry.path ? [entry.path] : entry.paths };
  });
  for (const entry of entries) {
    if (!Array.isArray(entry.paths) || entry.paths.length === 0 || !entry.literal
        || !entry.reason || !entry.owner || !entry.expires) {
      throw new Error('secret-scan allowlist entries must set path or paths, literal/literalParts/literalBase64, reason, owner, expires');
    }
    // `expires` is compared as a string against today's ISO date, so ANY other
    // spelling silently never expires: `expires: "soon"` is lexicographically
    // greater than every `YYYY-MM-DD` and the entry stayed exempt forever. The
    // format, and that it is a real calendar date, are checked here.
    const expiryDate = typeof entry.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(entry.expires)
      ? new Date(`${entry.expires}T00:00:00Z`) : null;
    if (expiryDate === null || Number.isNaN(expiryDate.getTime())
        || expiryDate.toISOString().slice(0, 10) !== entry.expires) {
      throw new Error(`secret-scan allowlist expires must be a real ISO date (YYYY-MM-DD): `
        + `${String(entry.expires)} (${entry.paths.join(', ')})`);
    }
    // The allowlist file is skipped by the scan itself (it stores exactly the
    // literals being searched for), which made it the one file where a real
    // credential could sit unreported. It is validated as data instead: unknown
    // keys are rejected so a value cannot be parked under one, and every
    // credential-shaped literal must be justified as a fixture.
    for (const key of Object.keys(entry)) {
      if (!KNOWN_ALLOWLIST_KEYS.has(key)) {
        throw new Error(`secret-scan allowlist entry has an unrecognized key: ${key}`);
      }
    }
    if (PRODUCT_CREDENTIAL_SHAPE.test(entry.literal) && entry.fixture !== true) {
      throw new Error(`secret-scan allowlist entry for the product credential shape must set fixture: true (${entry.paths.join(', ')})`);
    }
    for (const path of entry.paths) {
      if (typeof path !== 'string' || path.endsWith('/') || path.includes('*')) {
        throw new Error(`directory or glob allowlist is forbidden: ${path}`);
      }
      // An entry may not exempt the allowlist itself. The scan skips this file
      // because it necessarily contains the literals being searched for, so
      // naming it here let a REAL credential sit in the one file with no scanner
      // over it — `fixture: true` satisfied the shape check and the documented
      // `--write` then produced an exemption for it. Nothing in this repository
      // has a legitimate reason to allowlist this path.
      // Match by BASENAME, not by the full path. The first version of this guard
      // compared `scripts/secret-scan-allowlist.json` exactly or as a `/`-suffixed
      // tail, so a bare `secret-scan-allowlist.json` walked straight through: the
      // JS scanner matches paths exactly and stayed inert, while the generator
      // emitted a `$`-anchored regex that gitleaks matches UNANCHORED — so the real
      // file was exempted and all five gates exited 0 with a verbatim credential in
      // the tree. Nothing legitimate exempts this filename under any spelling.
      const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
      if (normalized.split('/').pop() === 'secret-scan-allowlist.json') {
        throw new Error(`an allowlist entry may not exempt the allowlist itself: ${path}`);
      }
    }
  }
  return entries;
}

function allowlistExemption(entries, candidates, literal) {
  return entries.find((entry) => entry.paths.some((path) => candidates.includes(path)) && entry.literal === literal) ?? null;
}

function allMatches(line, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...line.matchAll(new RegExp(pattern.source, flags))];
}

function matchLiteral(rule, match) {
  if (rule === 'unquoted-env') return match[2] ?? match[0];
  return match[1] ?? match[0];
}

function isRealCredentialShape(literal) {
  return realCredentialShapes.some((shape) => shape.test(literal));
}

function isPlaceholder(literal) {
  return placeholderLiteral.test(literal) && !isRealCredentialShape(literal);
}

function highEntropyLiterals(line) {
  const values = [];
  for (const match of allMatches(line, highEntropyPattern)) {
    const value = match[1];
    const frequencies = new Map();
    for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
    const entropy = [...frequencies.values()].reduce((sum, count) => {
      const probability = count / value.length;
      return sum - probability * Math.log2(probability);
    }, 0);
    if (entropy >= 3.5) values.push(value);
  }
  return values;
}

function lastQuotedValue(text) {
  const matches = [...text.matchAll(new RegExp(quotedLiteralPattern.source, 'g'))];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

function firstQuotedValue(text) {
  const match = text.match(quotedLiteralPattern);
  return match ? match[1] : null;
}

function isAdjacent(line, annotationIndex, annotationLength, literal) {
  const before = line.slice(0, annotationIndex);
  const after = line.slice(annotationIndex + annotationLength);
  return lastQuotedValue(before) === literal || firstQuotedValue(after) === literal;
}

function resolveExemption(line, reportPath, lineNumber, warnings) {
  const annotations = [...line.matchAll(annotationPattern)];
  if (annotations.length === 0) {
    if (malformedAnnotationPattern.test(line)) {
      warnings.push(`${reportPath}:${lineNumber}: secret-scan annotation must name exactly one literal (secret-scan: allow '<literal>')`);
    }
    return null;
  }
  if (annotations.length > 1) {
    warnings.push(`${reportPath}:${lineNumber}: multiple secret-scan annotations on one line; nothing exempted`);
    return null;
  }
  const annotation = annotations[0];
  const literal = annotation[1];
  const index = annotation.index ?? 0;
  const length = annotation[0].length;
  if (isRealCredentialShape(literal)) {
    warnings.push(`${reportPath}:${lineNumber}: secret-scan annotation names a real credential shape; annotation ignored`);
    return null;
  }
  const outside = line.slice(0, index) + line.slice(index + length);
  if (!outside.includes(literal)) {
    warnings.push(`${reportPath}:${lineNumber}: secret-scan annotation literal is not on this line; annotation ignored`);
    return null;
  }
  if (!isAdjacent(line, index, length, literal)) {
    warnings.push(`${reportPath}:${lineNumber}: secret-scan annotation is not adjacent to the named literal; annotation ignored`);
    return null;
  }
  return literal;
}

function containsBinaryByte(path) {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(readChunkBytes);
  try {
    let bytesRead;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (buffer.subarray(0, bytesRead).includes(0)) return true;
    } while (bytesRead > 0);
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Visit every text line using bounded-size file reads.  The decoder preserves
 * UTF-8 characters split across chunk boundaries; only the current line is
 * retained, so secrets after the first megabyte are not silently omitted.
 */
function forEachScanLine(path, visit) {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(readChunkBytes);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let lineNumber = 0;
  try {
    let bytesRead;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) visit(line.endsWith('\r') ? line.slice(0, -1) : line, ++lineNumber);
    } while (bytesRead > 0);
    pending += decoder.end();
    if (pending.length > 0 || lineNumber === 0) {
      visit(pending.endsWith('\r') ? pending.slice(0, -1) : pending, ++lineNumber);
    }
  } finally {
    closeSync(fd);
  }
}

function pathCandidates(file, scanRoot, repoRoot) {
  const fromScan = relative(scanRoot, file).split('\\').join('/');
  const fromRepo = relative(repoRoot, file).split('\\').join('/');
  return [...new Set([fromScan, fromRepo])];
}

export function scanFiles({
  files,
  scanRoot,
  repoRoot = repositoryRoot,
  allowlist = loadAllowlist(),
  today = new Date().toISOString().slice(0, 10),
}) {
  const findings = [];
  const warnings = [];
  for (const file of files) {
    if (containsBinaryByte(file)) continue;
    const candidates = pathCandidates(file, scanRoot, repoRoot);
    const reportPath = relative(scanRoot, file).split('\\').join('/');
    // These two files store exactly the literals the scanners look for, split
    // into parts or spelled out as exemptions. Scanning them would only ever
    // report their own exemptions. They are not left unguarded by that:
    // `loadAllowlist` validates the allowlist as data on every scan (unknown
    // keys rejected, every credential-shaped literal required to be marked a
    // fixture), and the gitleaks exemption block is generated from it rather
    // than hand-written.
    if (reportPath === 'scripts/secret-scan-allowlist.json' || reportPath === '.gitleaks.toml') continue;
    forEachScanLine(file, (line, lineNumber) => {
      const exempted = resolveExemption(line, reportPath, lineNumber, warnings);
      const report = (rule, literal) => {
        if (literal === exempted || isPlaceholder(literal)) return;
        const allowed = allowlistExemption(allowlist, candidates, literal);
        if (allowed) {
          if (allowed.expires < today) findings.push(`${reportPath}:${lineNumber}:allowlist-expired`);
          return;
        }
        findings.push(`${reportPath}:${lineNumber}:${rule}`);
      };
      for (const { rule, pattern, configOnly } of credentialPatterns) {
        if (configOnly && !configExtensions.has(extname(file).toLowerCase())) continue;
        for (const match of allMatches(line, pattern)) report(rule, matchLiteral(rule, match));
      }
      for (const value of highEntropyLiterals(line)) report('high-entropy', value);
    });
  }
  return { findings: [...new Set(findings)], warnings, filesScanned: files.length };
}

export function resolveScanTargets(argv, repoRoot = repositoryRoot) {
  const rootOption = argv.indexOf('--root');
  const artifactOption = argv.indexOf('--artifact');
  if (artifactOption >= 0) {
    const scanRoot = resolve(argv[artifactOption + 1] ?? '');
    return { scanRoot, files: walk(scanRoot, scanRoot, true), mode: 'artifact' };
  }
  if (rootOption >= 0) {
    const scanRoot = resolve(argv[rootOption + 1] ?? '');
    return { scanRoot, files: walk(scanRoot, scanRoot, false), mode: 'root' };
  }
  return { scanRoot: repoRoot, files: gitTrackedFiles(repoRoot), mode: 'tracked' };
}

function main(argv = process.argv.slice(2)) {
  const { scanRoot, files } = resolveScanTargets(argv);
  const { findings, warnings, filesScanned } = scanFiles({ files, scanRoot });
  for (const warning of warnings) console.warn(warning);
  if (findings.length > 0) {
    console.error(`possible secrets detected:\n${findings.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.info(`secret scan: ok (${filesScanned} files)`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();
