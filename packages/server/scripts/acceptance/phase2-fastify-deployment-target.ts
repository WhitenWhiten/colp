import type { FastifyInstance } from 'fastify';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import {
  createPhase2DeploymentTarget,
  type Phase2PostgresProbe,
  type Phase2PublicationDeploymentTarget,
  type Phase2PublicationDeploymentTargetOptions,
} from './phase2-publication-acceptance.js';

export interface StartPhase2FastifyDeploymentTargetOptions
  extends Omit<Phase2PublicationDeploymentTargetOptions, 'postgres'> {
  readonly app: FastifyInstance;
  readonly database: DatabaseRuntime;
  readonly listen: {
    readonly host: '127.0.0.1' | 'localhost' | '::1';
    readonly port: number;
  };
}

export interface StartedPhase2FastifyDeploymentTarget {
  readonly target: Phase2PublicationDeploymentTarget;
  close(): Promise<void>;
}

/** Real Fastify + PostgreSQL lifecycle adapter used by P2-16 deployment probes. */
export async function startPhase2FastifyDeploymentTarget(
  options: StartPhase2FastifyDeploymentTargetOptions,
): Promise<StartedPhase2FastifyDeploymentTarget> {
  if (!Number.isSafeInteger(options.listen.port)
      || options.listen.port < 1 || options.listen.port > 65_535) {
    throw new RangeError('Phase 2 Fastify deployment port must be between 1 and 65535');
  }
  const expectedOrigin = new URL(options.manifestUrl).origin;
  const postgres = createPhase2PostgresProbe(options.database);
  await postgres.verify();
  let listening = false;
  try {
    const address = await options.app.listen(options.listen);
    listening = true;
    const actualOrigin = normalizeListenOrigin(address, options.listen.host);
    if (actualOrigin !== expectedOrigin) {
      throw new Error(
        `Fastify deployment origin ${actualOrigin} does not match Manifest origin ${expectedOrigin}`,
      );
    }
    const target = createPhase2DeploymentTarget({ ...options, postgres });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      target,
      close() {
        closePromise ??= options.app.close();
        return closePromise;
      },
    });
  } catch (error: unknown) {
    if (listening) await options.app.close().catch(() => undefined);
    throw error;
  }
}

export function createPhase2PostgresProbe(database: DatabaseRuntime): Phase2PostgresProbe {
  return Object.freeze({
    async verify() {
      await database.verifyReady();
      const result = await database.pool.query<{
        version: string;
        database: string;
      }>('select version() as version, current_database() as database');
      const row = result.rows[0];
      if (!row?.version || !row.database) {
        throw new Error('PostgreSQL readiness query returned no server identity');
      }
      return Object.freeze({
        engine: 'postgresql' as const,
        version: row.version,
        database: row.database,
      });
    },
  });
}

function normalizeListenOrigin(address: string, configuredHost: string): string {
  const url = new URL(address);
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = configuredHost;
  return url.origin;
}
