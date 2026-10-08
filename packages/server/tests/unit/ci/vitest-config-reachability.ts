/**
 * Workspace ownership and leftover --config reachability for Known-Backend.
 *
 * Default discovery is `vitest.config.ts` `test.projects` (`unit` / `static` /
 * `system` / `postgres` / `redis` / `browser` / `evidence`). A leftover `vitest*.config.ts`
 * is not owned by a filename substring in a comment, exclude list, unused
 * local npm script, or this contract suite. Remaining dedicated configs are
 * owned when either:
 *   1. they are a workspace project file, or
 *   2. workflow `run:` → npm script (transitive) → (mjs spawn) → `vitest --config`, or
 *   3. they sit on the size-1 allowlist.
 *
 * Coverage collect scripts still pass dedicated coverage configs. They are
 * not workspace projects (they intentionally collect the same behavior tests
 * with a different source inventory).
 */

export const UNREACHABLE_VITEST_CONFIG_ALLOWLIST = [] as const;

export const WORKSPACE_PROJECT_CONFIGS = [
  'vitest.browser.config.ts',
  'vitest.evidence.config.ts',
  'vitest.postgres.config.ts',
  'vitest.redis.config.ts',
  'vitest.static.config.ts',
  'vitest.system.config.ts',
  'vitest.unit.config.ts',
] as const;

export const COVERAGE_VITEST_CONFIGS = [
  'vitest.coverage.config.ts',
  'vitest.focused-coverage.config.ts',
  'vitest.phase4-5-coverage.config.ts',
] as const;

/**
 * Ticket-level dedicated configs are fully retired: every focused script now
 * selects workspace projects (`--project`) plus explicit file lists. This
 * array must stay empty; a new `--config` leftover is a regression.
 */
export const REMAINING_DEDICATED_VITEST_CONFIGS = [] as const;

const NPM_RUN_RE = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g;
const CONFIG_FLAG_RE = /--config(?:\s+|=|['"\s,]+)(vitest\.[A-Za-z0-9._-]+\.config\.ts)/g;
const PROJECT_FLAG_RE = /--project(?:\s+|=|['"\s,]+)([A-Za-z0-9._-]+)/g;
const LISTED_TEST_RE = /\btests\/(?:unit|integration)\/[A-Za-z0-9._/-]+\.test\.ts\b/g;
const SPAWNED_SCRIPT_RE = /\b(?:node|tsx)(?:\s+--import\s+\S+)?\s+(scripts\/[A-Za-z0-9._/-]+\.(?:mjs|js|ts))\b/g;
const VITEST_CONFIG_NAME_RE = /^vitest\.[A-Za-z0-9._-]+\.config\.ts$/;

export function stripJsComments(source: string): string {
  let output = '';
  let index = 0;
  let state: 'code' | 'squote' | 'dquote' | 'template' | 'line' | 'block' = 'code';
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        output += char;
      }
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        index += 2;
        output += ' ';
        continue;
      }
      index += 1;
      continue;
    }
    if (state === 'squote') {
      output += char;
      if (char === '\\') {
        output += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === '\'') state = 'code';
      index += 1;
      continue;
    }
    if (state === 'dquote') {
      output += char;
      if (char === '\\') {
        output += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === '"') state = 'code';
      index += 1;
      continue;
    }
    if (state === 'template') {
      output += char;
      if (char === '\\') {
        output += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === '`') state = 'code';
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      state = 'line';
      index += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block';
      index += 2;
      continue;
    }
    if (char === '\'') {
      state = 'squote';
      output += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      state = 'dquote';
      output += char;
      index += 1;
      continue;
    }
    if (char === '`') {
      state = 'template';
      output += char;
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

export function stripShellComments(source: string): string {
  return source.replace(/(^|[\t ])#[^\n]*/g, '$1');
}

export function extractNpmRunScripts(command: string): string[] {
  const names: string[] = [];
  NPM_RUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NPM_RUN_RE.exec(command)) !== null) {
    names.push(match[1]!);
  }
  return names;
}

export function extractVitestConfigFlags(command: string): string[] {
  const names: string[] = [];
  CONFIG_FLAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONFIG_FLAG_RE.exec(command)) !== null) {
    names.push(match[1]!);
  }
  return names;
}

export function extractVitestProjectFlags(command: string): string[] {
  const names: string[] = [];
  PROJECT_FLAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROJECT_FLAG_RE.exec(command)) !== null) {
    names.push(match[1]!);
  }
  return names;
}

export function extractListedTestFiles(command: string): string[] {
  LISTED_TEST_RE.lastIndex = 0;
  return command.match(LISTED_TEST_RE) ?? [];
}

export function extractSpawnedScriptPaths(command: string): string[] {
  const paths: string[] = [];
  SPAWNED_SCRIPT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPAWNED_SCRIPT_RE.exec(command)) !== null) {
    paths.push(match[1]!);
  }
  return paths;
}

export function parseIncludePatterns(configSource: string): string[] {
  const stripped = stripJsComments(configSource);
  const includeIndex = stripped.search(/\binclude\s*:/);
  if (includeIndex < 0) return [];
  const after = stripped.slice(includeIndex);
  const bracket = after.indexOf('[');
  if (bracket < 0) return [];
  let depth = 0;
  let end = -1;
  for (let index = bracket; index < after.length; index += 1) {
    const char = after[index];
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return [];
  const block = after.slice(bracket, end + 1);
  return [...block.matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => match[1]!)
    .filter((value) => value.startsWith('tests/') || value.includes('*'));
}

export function fileMatchesInclude(file: string, pattern: string): boolean {
  if (!pattern.includes('*')) return file === pattern;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::GLOBSTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::GLOBSTAR::/g, '.*');
  return new RegExp(`^${escaped}$`, 'u').test(file);
}

export function resolveIncludeFiles(
  patterns: readonly string[],
  existingTestFiles: readonly string[],
): string[] {
  const resolved = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      for (const file of existingTestFiles) {
        if (fileMatchesInclude(file, pattern)) resolved.add(file);
      }
    } else {
      resolved.add(pattern);
    }
  }
  return [...resolved].sort();
}

export function resolveScriptClosure(
  scripts: Readonly<Record<string, string>>,
  roots: readonly string[],
): { commands: string[]; scriptNames: string[] } {
  const scriptNames = new Set<string>();
  const commands: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop();
    if (!name || scriptNames.has(name)) continue;
    const body = scripts[name];
    if (typeof body !== 'string') continue;
    scriptNames.add(name);
    commands.push(body);
    for (const nested of extractNpmRunScripts(stripShellComments(body))) {
      queue.push(nested);
    }
  }
  return { commands, scriptNames: [...scriptNames].sort() };
}

export type ReachabilityInput = {
  readonly workflowRunSteps: readonly string[];
  readonly packageScripts: Readonly<Record<string, string>>;
  readonly readSpawnedScript?: (specifier: string) => string | undefined;
};

export type ReachabilityResult = {
  readonly invokedConfigs: ReadonlySet<string>;
  readonly listedTestFiles: ReadonlySet<string>;
  readonly expandedCommands: readonly string[];
  readonly entryScripts: readonly string[];
};

export function collectCiReachability(input: ReachabilityInput): ReachabilityResult {
  const entryScripts: string[] = [];
  const runCommands: string[] = [];
  for (const step of input.workflowRunSteps) {
    const stripped = stripShellComments(step);
    runCommands.push(stripped);
    entryScripts.push(...extractNpmRunScripts(stripped));
  }
  const closure = resolveScriptClosure(input.packageScripts, entryScripts);
  const invokedConfigs = new Set<string>();
  const listedTestFiles = new Set<string>();
  const expandedCommands = [...runCommands, ...closure.commands];
  const seenScripts = new Set<string>();
  const scriptQueue = [...expandedCommands];

  const consume = (command: string) => {
    for (const name of extractVitestConfigFlags(command)) {
      if (VITEST_CONFIG_NAME_RE.test(name)) invokedConfigs.add(name);
    }
    for (const file of extractListedTestFiles(command)) {
      listedTestFiles.add(file);
    }
    if (!input.readSpawnedScript) return;
    for (const specifier of extractSpawnedScriptPaths(command)) {
      if (seenScripts.has(specifier)) continue;
      seenScripts.add(specifier);
      const source = input.readSpawnedScript(specifier);
      if (typeof source !== 'string') continue;
      const stripped = stripJsComments(source);
      scriptQueue.push(stripped);
      expandedCommands.push(stripped);
      for (const nested of extractNpmRunScripts(stripped)) {
        const nestedClosure = resolveScriptClosure(input.packageScripts, [nested]);
        scriptQueue.push(...nestedClosure.commands);
        expandedCommands.push(...nestedClosure.commands);
      }
    }
  };

  while (scriptQueue.length > 0) {
    consume(scriptQueue.shift()!);
  }

  return {
    invokedConfigs,
    listedTestFiles,
    expandedCommands,
    entryScripts: [...new Set(entryScripts)].sort(),
  };
}

export function isConfigReachable(args: {
  readonly configName: string;
  readonly includeFiles: readonly string[];
  readonly invokedConfigs: ReadonlySet<string>;
  readonly executedFiles: ReadonlySet<string>;
  readonly allowlist?: ReadonlySet<string> | readonly string[];
}): boolean {
  const allowlist = new Set(args.allowlist ?? UNREACHABLE_VITEST_CONFIG_ALLOWLIST);
  if (allowlist.has(args.configName)) return true;
  if (args.invokedConfigs.has(args.configName)) return true;
  if (args.includeFiles.length === 0) return false;
  return args.includeFiles.every((file) => args.executedFiles.has(file));
}

export function collectWorkflowRunSteps(workflow: {
  readonly jobs?: Record<string, { readonly steps?: ReadonlyArray<{ readonly run?: string }> }>;
}): string[] {
  const steps: string[] = [];
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string' && step.run.trim().length > 0) {
        steps.push(step.run);
      }
    }
  }
  return steps;
}
