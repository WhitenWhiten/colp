#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySelfHostedPreset } from '../bootstrap/self-hosted-preset.js';
import { loadConfig } from '../bootstrap/config.js';
import { composeBetterAuthComposition } from '../bootstrap/composition.js';
import { registerFatalProcessHandlers } from '../bootstrap/process-lifecycle.js';
import { startSelfHosted } from '../bootstrap/self-hosted.js';
import {
  createDatabaseRuntime,
  maintenanceDatabaseRuntimeOptions,
  runMigrations,
  type DatabaseRuntime,
} from '../infrastructure/database/index.js';
import { COLP_SETUP_TOKEN_HEADER, type BetterAuthInstance } from '../infrastructure/auth/better-auth-runtime.js';
import { prepareColpInstance } from '../infrastructure/auth/colp-instance-settings.js';
import type { AuthEmailSender } from '../modules/auth/index.js';
import { createLogger } from '../infrastructure/telemetry/index.js';
import { version } from '../version.js';
import { ExportCliError, exportOwnedCollections } from './export.js';

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  '08000', '08001', '08003', '08004', '08006', '08007',
  '57P01', '57P02', '57P03',
]);

class CliExit extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'CliExit';
  }
}

interface CreateUserCommand {
  readonly kind: 'create-user';
  readonly username: string;
  readonly email: string | undefined;
}

interface ResetPasswordCommand {
  readonly kind: 'reset-password';
  readonly username: string;
}

const USAGE = `usage: colp-server <command>

  start                                 run the self-hosted server
  migrate                               apply pending database migrations
  create-user --username <name> [--email <address>]
  reset-password --username <name>      (the password is prompted, never passed as an argument)
  export --username <name> --out <dir>  export the user's collections
  setup-token                           print the first-run owner setup token
  ready                                 exit 0 when the local server answers GET /ready with 200
  --version                             print server, library and protocol versions
  --help, -h, help                      print this message
`;

type Command =
  | { readonly kind: 'start' }
  | { readonly kind: 'migrate' }
  | { readonly kind: 'version' }
  | { readonly kind: 'help' }
  | { readonly kind: 'setup-token' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'export'; readonly username: string; readonly out: string }
  | CreateUserCommand
  | ResetPasswordCommand;

const cliAuthEmail: AuthEmailSender = {
  async sendAuthEmail() {
    return {
      outcome: 'email_delivery_unavailable',
      correlationId: 'colp-server-cli',
      redactedReason: 'the cli does not send mail',
    };
  },
};

function oneLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  const redacted = line.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://[redacted]');
  return redacted.length > 0 ? redacted : 'cli failed';
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'cli failed';
}

function isDatabaseUnreachable(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const record = value as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === 'string' && NETWORK_CODES.has(record.code)) return true;
    if (typeof record.message === 'string'
      && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo|connect timeout|Connection terminated|could not connect|the database system is (?:starting up|shutting down)|sorry, too many clients/i.test(record.message)) {
      return true;
    }
    if (record.cause !== undefined && visit(record.cause)) return true;
    if (Array.isArray(record.errors)) {
      for (const item of record.errors) {
        if (visit(item)) return true;
      }
    }
    return false;
  };
  return visit(error);
}

function isConfigError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return / is required\b| must be |^COLP_[A-Z0-9_]+/u.test(error.message);
}

function exitCodeFor(error: unknown): number {
  if (isDatabaseUnreachable(error)) return 4;
  if (isConfigError(error)) return 2;
  return 1;
}

function stderrLine(error: unknown, code: number): string {
  const line = oneLine(error instanceof CliExit ? error.message : messageOf(error));
  if (code === 4 && !(error instanceof CliExit)) return `database unreachable: ${line}`;
  return line;
}

function migrationDirectory(): string | undefined {
  const bundled = resolve('dist/migrations');
  const compiled = import.meta.url.includes(`${sep}dist${sep}`);
  if (compiled && existsSync(bundled)) return bundled;
  return undefined;
}

function rejectPasswordArgument(argv: readonly string[]): void {
  for (const token of argv) {
    if (token === '--password' || token.startsWith('--password=')) {
      throw new CliExit(2, 'password must not be passed as an argument');
    }
  }
}

function parseFlags(rest: readonly string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) break;
    if (!token.startsWith('--') || token === '--') throw new CliExit(2, `unexpected argument ${token}`);
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (name.length === 0 || !allowed.has(name)) throw new CliExit(2, `unknown option --${name || token}`);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const value = inline !== undefined ? inline : rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CliExit(2, `--${name} requires a value`);
    if (inline === undefined) index += 1;
    if (value.length === 0) throw new CliExit(2, `--${name} requires a value`);
    if (flags.has(name)) throw new CliExit(2, `duplicate option --${name}`);
    flags.set(name, value);
  }
  return flags;
}

function parseCommand(argv: readonly string[]): Command {
  rejectPasswordArgument(argv);
  const args = argv.slice(2);
  if (args.length === 0) {
    throw new CliExit(2, 'usage: colp-server <start|migrate|create-user|reset-password|export|setup-token|ready|--version|--help>');
  }
  const head = args[0];
  if (head === '--help' || head === '-h' || head === 'help') {
    if (args.length !== 1) throw new CliExit(2, 'usage: colp-server --help');
    return { kind: 'help' };
  }
  if (head === '--version') {
    if (args.length !== 1) throw new CliExit(2, 'usage: colp-server --version');
    return { kind: 'version' };
  }
  if (head === 'export') {
    const flags = parseFlags(args.slice(1), new Set(['username', 'out']));
    const username = flags.get('username');
    const out = flags.get('out');
    if (username === undefined) throw new CliExit(2, 'export requires --username <name>');
    if (out === undefined) throw new CliExit(2, 'export requires --out <dir>');
    return { kind: 'export', username, out };
  }
  if (head === 'start') {
    if (args.length !== 1) throw new CliExit(2, 'usage: colp-server start');
    return { kind: 'start' };
  }
  if (head === 'migrate') {
    if (args.length !== 1) throw new CliExit(2, 'usage: colp-server migrate');
    return { kind: 'migrate' };
  }
  if (head === 'ready') {
    if (args.length !== 1) throw new CliExit(2, 'usage: colp-server ready');
    return { kind: 'ready' };
  }
  if (head === 'setup-token') {
    if (args.length !== 1) throw new CliExit(2, 'usage: colp-server setup-token');
    return { kind: 'setup-token' };
  }
  if (head === 'create-user') {
    const flags = parseFlags(args.slice(1), new Set(['username', 'email']));
    const username = flags.get('username');
    if (username === undefined) throw new CliExit(2, 'create-user requires --username <name>');
    return { kind: 'create-user', username, email: flags.get('email') };
  }
  if (head === 'reset-password') {
    const flags = parseFlags(args.slice(1), new Set(['username']));
    const username = flags.get('username');
    if (username === undefined) throw new CliExit(2, 'reset-password requires --username <name>');
    return { kind: 'reset-password', username };
  }
  throw new CliExit(2, `unknown command ${head ?? ''}`.trim());
}

async function readStdinLines(): Promise<readonly string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolveLine, reject) => {
    const input = process.stdin;
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    let settled = false;
    const cleanup = (): void => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stderr.write('\n');
      action();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          finish(() => resolveLine(value));
          return;
        }
        if (char === '\u0003') {
          finish(() => reject(new CliExit(2, 'password entry cancelled')));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char < ' ' && char !== '\t') continue;
        value += char;
      }
    };
    input.on('data', onData);
  });
}

async function readConfirmedPassword(): Promise<string> {
  let first: string;
  let second: string;
  if (process.stdin.isTTY) {
    first = await readHiddenLine('Password: ');
    second = await readHiddenLine('Confirm password: ');
  } else {
    const lines = await readStdinLines();
    if (lines.length !== 2) throw new CliExit(2, 'password must be entered twice');
    first = lines[0] ?? '';
    second = lines[1] ?? '';
  }
  if (first.length === 0) throw new CliExit(2, 'password is required');
  if (first !== second) throw new CliExit(2, 'passwords do not match');
  return first;
}

function openMigrator(): DatabaseRuntime {
  applySelfHostedPreset(process.env);
  const config = loadConfig();
  return createDatabaseRuntime(config.databaseUrl, {
    maxConnections: 1,
    connectionTimeoutMs: config.database.connectionTimeoutMs,
    idleTimeoutMs: config.database.idleTimeoutMs,
    applicationName: 'colp-migrator',
    production: config.nodeEnv === 'production',
    ssl: config.databaseSsl,
    ...maintenanceDatabaseRuntimeOptions(),
  });
}

async function migrate(): Promise<void> {
  const database = openMigrator();
  try {
    const directory = migrationDirectory();
    await (directory === undefined
      ? runMigrations(database.db, 'latest')
      : runMigrations(database.db, 'latest', directory));
    await prepareColpInstance(database.db, { singleOwner: process.env.COLP_MULTI_USER !== 'true' });
  } finally {
    await database.close();
  }
}

async function withAuth(work: (auth: BetterAuthInstance) => Promise<void>): Promise<void> {
  applySelfHostedPreset(process.env);
  const config = loadConfig();
  const database = createDatabaseRuntime(config.databaseUrl, {
    maxConnections: 2,
    connectionTimeoutMs: config.database.connectionTimeoutMs,
    idleTimeoutMs: config.database.idleTimeoutMs,
    applicationName: 'colp-server-cli',
    production: config.nodeEnv === 'production',
    ssl: config.databaseSsl,
    ...maintenanceDatabaseRuntimeOptions(),
  });
  try {
    const composition = composeBetterAuthComposition({
      config,
      db: database.db,
      authEmail: cliAuthEmail,
      logger: createLogger('silent'),
    });
    const auth = composition.betterAuth;
    if (auth === undefined) throw new CliExit(2, 'Better Auth is not enabled');
    await work(auth);
  } finally {
    await database.close();
  }
}

function authErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('body' in error)) return undefined;
  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null || !('code' in body)) return undefined;
  return typeof body.code === 'string' ? body.code : undefined;
}

function throwAuthFailure(error: unknown): never {
  if (isDatabaseUnreachable(error)) throw error;
  const code = authErrorCode(error);
  if (code === 'registration_closed') throw new CliExit(3, 'registration closed');
  if (code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'
    || code === 'USER_ALREADY_EXISTS'
    || code === 'USERNAME_IS_ALREADY_TAKEN') {
    throw new CliExit(3, 'user already exists');
  }
  if (code === 'USER_NOT_FOUND') throw new CliExit(3, 'unknown user');
  if (code === 'INVALID_EMAIL') throw new CliExit(2, 'invalid email');
  if (code === 'INVALID_USERNAME' || code === 'USERNAME_TOO_SHORT' || code === 'USERNAME_TOO_LONG') {
    throw new CliExit(2, 'invalid username');
  }
  if (code === 'PASSWORD_TOO_SHORT') throw new CliExit(2, 'password must be at least 8 characters');
  if (code === 'PASSWORD_TOO_LONG' || code === 'INVALID_PASSWORD') {
    throw new CliExit(2, 'invalid password');
  }
  throw error;
}

function signupEmail(username: string, email: string | undefined): string {
  if (email !== undefined) return email;
  return `${username.trim().toLowerCase()}@users.invalid`;
}

async function createUser(username: string, email: string | undefined, password: string): Promise<void> {
  await migrate();
  await withAuth(async (auth) => {
    const body = {
      name: username.trim(),
      email: signupEmail(username, email),
      password,
      username: username.trim(),
    };
    // The operator has the shell, so the CLI presents the first-run token itself.
    const headers = new Headers({ [COLP_SETUP_TOKEN_HEADER]: process.env.COLP_SETUP_TOKEN ?? '' });
    try {
      await auth.api.signUpEmail({ body, headers });
    } catch (error: unknown) {
      throwAuthFailure(error);
    }
  });
}

interface AuthUserRow {
  readonly id: string;
}

async function resetPassword(username: string, password: string): Promise<void> {
  await withAuth(async (auth) => {
    const normalized = username.trim().toLowerCase();
    const ctx = await auth.$context;
    const found = await ctx.adapter.findOne<AuthUserRow>({
      model: 'user',
      where: [{ field: 'username', value: normalized }],
    });
    if (found === null || typeof found.id !== 'string' || found.id.length === 0) {
      throw new CliExit(3, 'unknown user');
    }
    const token = randomBytes(24).toString('base64url');
    await ctx.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: found.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    try {
      await auth.api.resetPassword({ body: { newPassword: password, token } });
    } catch (error: unknown) {
      throwAuthFailure(error);
    }
  });
}

/**
 * Asks the server in this container for /ready. Scripts call it through
 * `docker compose exec`, so the check does not depend on the host trusting
 * Caddy's certificate or reaching the public origin.
 */
async function checkReady(): Promise<void> {
  const port = process.env.PORT?.trim() || '3000';
  let status: number;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(5_000) });
    status = response.status;
  } catch {
    throw new CliExit(1, 'not ready: the server is not answering yet');
  }
  if (status !== 200) throw new CliExit(1, `not ready: /ready returned ${status}`);
  process.stdout.write('ready\n');
}

async function start(): Promise<void> {
  const processLogger = createLogger(process.env.LOG_LEVEL?.trim() || 'info');
  registerFatalProcessHandlers({ logger: processLogger });
  await startSelfHosted();
}

async function main(): Promise<boolean> {
  const command = parseCommand(process.argv);
  if (command.kind === 'ready') {
    await checkReady();
    return false;
  }
  if (command.kind === 'setup-token') {
    applySelfHostedPreset(process.env);
    process.stdout.write(`${process.env.COLP_SETUP_TOKEN ?? ''}\n`);
    return false;
  }
  if (command.kind === 'help') {
    process.stdout.write(USAGE);
    return false;
  }
  if (command.kind === 'version') {
    process.stdout.write(`colp-server ${version.server}\n`);
    process.stdout.write(`@know-n/colp ${version.colp}\n`);
    process.stdout.write(`protocols ${version.protocols.join(' ')}\n`);
    return false;
  }
  if (command.kind === 'export') {
    try {
      await migrate();
      await exportOwnedCollections({ username: command.username, outDir: command.out });
    } catch (error: unknown) {
      if (error instanceof ExportCliError) throw new CliExit(error.code, error.message);
      throw error;
    }
    return false;
  }
  if (command.kind === 'start') {
    await start();
    return true;
  }
  if (command.kind === 'migrate') {
    await migrate();
    return false;
  }
  const password = await readConfirmedPassword();
  if (command.kind === 'create-user') {
    await createUser(command.username, command.email, password);
    return false;
  }
  await resetPassword(command.username, password);
  return false;
}

/** npm `bin` links point here, so compare real paths, not the link path. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href;
  } catch {
    return false;
  }
}

const invoked = invokedDirectly();

if (invoked) {
  void main().then((keepAlive) => {
    if (!keepAlive) process.exit(0);
  }).catch((error: unknown) => {
    const code = error instanceof CliExit ? error.code : exitCodeFor(error);
    process.stderr.write(`${stderrLine(error, code)}\n`);
    process.exit(code);
  });
}
