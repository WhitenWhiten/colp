/** Seed commands that create, withdraw, or claim seed-owned rows. */
export const SEED_MUTATING_COMMANDS = Object.freeze(['apply', 'withdraw', 'adopt'] as const);

export type SeedMutatingCommand = (typeof SEED_MUTATING_COMMANDS)[number];

export function isSeedMutatingCommand(command: string): command is SeedMutatingCommand {
  return (SEED_MUTATING_COMMANDS as readonly string[]).includes(command);
}

export class SeedProductionGuardError extends Error {
  readonly code = 'production_guard';

  constructor(message: string) {
    super(message);
    this.name = 'SeedProductionGuardError';
  }
}

/** Already normalized deployment facts resolved by the CLI before any loader runs. */
export interface SeedEnvironmentFacts {
  /** Normalized `NODE_ENV` (`development` | `test` | `production`). */
  readonly nodeEnv: string;
  /** Resolved listener host; a blank HOST falls back to loopback. */
  readonly host: string;
}

export interface SeedProductionGate {
  readonly nodeEnv: string;
  readonly host: string;
  readonly production: boolean;
}

export interface SeedProductionGuardOptions {
  /** Explicit `--allow-production` opt-in from the operator. */
  readonly allowProduction: boolean;
}

/**
 * Credential-free description of the database the seed CLI would mutate.
 * Printed/refused in production so the operator sees the actual target without
 * ever putting a password in a log line.
 */
export function describeDatabaseTarget(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined || databaseUrl.trim() === '') return '<unset>';
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//u, '');
    return `${url.protocol}//${url.hostname}${url.port === '' ? '' : `:${url.port}`}`
      + `${database === '' ? '' : `/${database}`}`;
  } catch {
    return '<non-url target>';
  }
}

/**
 * Refuse mutating seed commands (apply / withdraw / adopt) on
 * `NODE_ENV=production` unless the operator passed `--allow-production`.
 * The resolved listener host and credential-free database target are part of
 * the refusal so a mistyped environment cannot silently mutate the wrong
 * deployment. `--status` is read-only and always allowed.
 */
export function assertSeedProductionAllowed(
  command: string,
  options: SeedProductionGuardOptions,
  facts: SeedEnvironmentFacts,
  databaseUrl: string | undefined,
): SeedProductionGate {
  const production = facts.nodeEnv === 'production';
  if (!production || !isSeedMutatingCommand(command) || options.allowProduction) {
    return Object.freeze({ nodeEnv: facts.nodeEnv, host: facts.host, production });
  }
  throw new SeedProductionGuardError(
    `refusing seed --${command} with NODE_ENV=production `
    + `(HOST=${facts.host}, DATABASE=${describeDatabaseTarget(databaseUrl)}); `
    + 'pass --allow-production to confirm mutating production data',
  );
}
