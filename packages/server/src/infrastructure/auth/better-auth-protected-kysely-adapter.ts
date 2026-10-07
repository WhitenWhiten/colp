import { kyselyAdapter } from '@better-auth/kysely-adapter';
import type {
  BetterAuthOptions,
  DBAdapter,
  DBAdapterInstance,
  DBTransactionAdapter,
  JoinOption,
  Where,
} from 'better-auth';
import type { Kysely } from 'kysely';
import {
  createBetterAuthSessionTokenProtector,
  type BetterAuthSessionTokenProtectionOptions,
  type BetterAuthSessionTokenProtector,
} from './better-auth-session-token-protection.js';

const SESSION_MODEL = 'session';
const TOKEN_FIELD = 'token';
const LOOKUP_FIELD = 'tokenLookupHash';

/**
 * Better Auth adapter decorator that keeps the library-facing token contract
 * plaintext while PostgreSQL receives only authenticated ciphertext plus a
 * keyed equality lookup. Every adapter operation, including transaction-bound
 * operations and joined session output, crosses this boundary.
 */
export function createProtectedBetterAuthKyselyAdapter(
  db: Kysely<unknown>,
  protection: BetterAuthSessionTokenProtectionOptions,
): DBAdapterInstance {
  const protector = createBetterAuthSessionTokenProtector(protection);
  const baseFactory = kyselyAdapter(db, { type: 'postgres', transaction: true });
  const factory = (options: BetterAuthOptions): DBAdapter => (
    wrapAdapter(baseFactory(options), protector)
  );

  // Better Auth's runtime recognizes a DBAdapter factory by callability, but
  // its schema generator independently looks for the legacy `{ db, type }`
  // shape. Preserve both views so `getMigrations()` and the CLI keep working
  // without bypassing protection for runtime queries.
  return Object.assign(factory, {
    db,
    type: 'postgres' as const,
    transaction: true,
  }) as DBAdapterInstance;
}

function wrapAdapter(base: DBAdapter, protector: BetterAuthSessionTokenProtector): DBAdapter {
  const operations = wrapTransactionAdapter(base, protector);
  return {
    ...operations,
    async transaction<R>(callback: (transaction: DBTransactionAdapter) => Promise<R>): Promise<R> {
      return base.transaction((transaction) => callback(wrapTransactionAdapter(transaction, protector)));
    },
  };
}

function wrapTransactionAdapter(
  base: DBTransactionAdapter,
  protector: BetterAuthSessionTokenProtector,
): DBTransactionAdapter {
  return {
    id: `${base.id}:protected-session-token`,
    async create<T extends Record<string, unknown>, R = T>(input: {
      model: string;
      data: Omit<T, 'id'>;
      select?: string[];
      forceAllowId?: boolean;
    }): Promise<R> {
      const result = await base.create<T, R>({
        ...input,
        data: protectWrite(input.model, input.data, protector, true) as Omit<T, 'id'>,
      });
      return revealResult(input.model, input.select, undefined, result, protector);
    },
    async findOne<T>(input: {
      model: string;
      where: Where[];
      select?: string[];
      join?: JoinOption;
    }): Promise<T | null> {
      const result = await base.findOne<T>({
        ...input,
        where: protectWhere(input.model, input.where, protector),
      });
      return result === null
        ? null
        : revealResult(input.model, input.select, input.join, result, protector);
    },
    async findMany<T>(input: {
      model: string;
      where?: Where[];
      limit?: number;
      select?: string[];
      sortBy?: { field: string; direction: 'asc' | 'desc' };
      offset?: number;
      join?: JoinOption;
    }): Promise<T[]> {
      const result = await base.findMany<T>({
        ...input,
        ...(input.where === undefined
          ? {}
          : { where: protectWhere(input.model, input.where, protector) }),
      });
      return result.map((row) => revealResult(input.model, input.select, input.join, row, protector));
    },
    async count(input: { model: string; where?: Where[] }): Promise<number> {
      return base.count({
        ...input,
        ...(input.where === undefined
          ? {}
          : { where: protectWhere(input.model, input.where, protector) }),
      });
    },
    async update<T>(input: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }): Promise<T | null> {
      const result = await base.update<T>({
        ...input,
        where: protectWhere(input.model, input.where, protector),
        update: protectWrite(input.model, input.update, protector, false),
      });
      return result === null ? null : revealResult(input.model, undefined, undefined, result, protector);
    },
    async updateMany(input: {
      model: string;
      where: Where[];
      update: Record<string, unknown>;
    }): Promise<number> {
      return base.updateMany({
        ...input,
        where: protectWhere(input.model, input.where, protector),
        update: protectWrite(input.model, input.update, protector, false),
      });
    },
    async delete<_T>(input: { model: string; where: Where[] }): Promise<void> {
      await base.delete({ ...input, where: protectWhere(input.model, input.where, protector) });
    },
    async deleteMany(input: { model: string; where: Where[] }): Promise<number> {
      return base.deleteMany({
        ...input,
        where: protectWhere(input.model, input.where, protector),
      });
    },
    async consumeOne<T>(input: { model: string; where: Where[] }): Promise<T | null> {
      const result = await base.consumeOne<T>({
        ...input,
        where: protectWhere(input.model, input.where, protector),
      });
      return result === null ? null : revealResult(input.model, undefined, undefined, result, protector);
    },
    async incrementOne<T>(input: {
      model: string;
      where: Where[];
      increment: Record<string, number>;
      set?: Record<string, unknown>;
    }): Promise<T | null> {
      const result = await base.incrementOne<T>({
        ...input,
        where: protectWhere(input.model, input.where, protector),
        ...(input.set === undefined
          ? {}
          : { set: protectWrite(input.model, input.set, protector, false) }),
      });
      return result === null ? null : revealResult(input.model, undefined, undefined, result, protector);
    },
    ...(base.createSchema === undefined ? {} : { createSchema: base.createSchema.bind(base) }),
    ...(base.options === undefined ? {} : { options: base.options }),
  };
}

function protectWrite(
  model: string,
  data: object,
  protector: BetterAuthSessionTokenProtector,
  requireToken: boolean,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ...data };
  if (model !== SESSION_MODEL) return record;
  delete record[LOOKUP_FIELD];
  const token = record[TOKEN_FIELD];
  if (token === undefined && !requireToken) return record;
  if (typeof token !== 'string') throw new Error('Better Auth session write requires a token');
  const protectedToken = protector.protect(token);
  record[TOKEN_FIELD] = protectedToken.ciphertext;
  record[LOOKUP_FIELD] = protectedToken.lookupHash;
  return record;
}

function protectWhere(
  model: string,
  where: readonly Where[],
  protector: BetterAuthSessionTokenProtector,
): Where[] {
  if (model !== SESSION_MODEL || !where.some((condition) => condition.field === TOKEN_FIELD)) {
    return [...where];
  }
  if (where.some((condition) => condition.field !== TOKEN_FIELD && condition.connector === 'OR')) {
    throw new Error('Better Auth session token protection cannot combine legacy lookup with unrelated OR clauses');
  }
  const transformed: Where[] = [];
  for (const condition of where) {
    if (condition.field !== TOKEN_FIELD) {
      transformed.push(condition);
      continue;
    }
    const operator = condition.operator ?? 'eq';
    if (operator !== 'eq' && operator !== 'in') {
      throw new Error(`Better Auth session token protection does not support ${operator} lookup`);
    }
    if (condition.mode === 'insensitive') {
      throw new Error('Better Auth session token lookups must be case-sensitive');
    }
    const tokens = operator === 'in' ? condition.value : [condition.value];
    if (!Array.isArray(tokens) || !tokens.every((value) => typeof value === 'string')) {
      throw new Error('Better Auth session token lookup requires string values');
    }
    const tokenValues = tokens as string[];
    const lookupHashes = tokenValues.flatMap((token) => protector.lookupHashes(token));
    const legacyValues = tokenValues
      .map((token) => protector.legacyLookupValue(token))
      .filter((token): token is string => token !== null);
    transformed.push({
      field: LOOKUP_FIELD,
      value: lookupHashes,
      operator: 'in',
      ...(legacyValues.length === 0
        ? { connector: condition.connector ?? 'AND' }
        : { connector: 'OR' as const }),
      mode: 'sensitive',
    });
    if (legacyValues.length > 0) {
      transformed.push({
        field: TOKEN_FIELD,
        value: legacyValues,
        operator: 'in',
        connector: 'OR',
        mode: 'sensitive',
      });
    }
  }
  return transformed;
}

function revealResult<T>(
  model: string,
  _select: readonly string[] | undefined,
  join: JoinOption | undefined,
  result: T,
  protector: BetterAuthSessionTokenProtector,
): T {
  if (!isRecord(result)) return result;
  let revealed: Record<string, unknown> = result;
  if (model === SESSION_MODEL) {
    revealed = revealSessionRecord(revealed, protector);
  }
  if (join !== undefined && SESSION_MODEL in join) {
    const joined = revealed[SESSION_MODEL];
    if (Array.isArray(joined)) {
      revealed = { ...revealed, [SESSION_MODEL]: joined.map((row) => (
        isRecord(row) ? revealSessionRecord(row, protector) : row
      )) };
    } else if (isRecord(joined)) {
      revealed = { ...revealed, [SESSION_MODEL]: revealSessionRecord(joined, protector) };
    }
  }
  return revealed as T;
}

function revealSessionRecord(
  input: Record<string, unknown>,
  protector: BetterAuthSessionTokenProtector,
): Record<string, unknown> {
  const record = { ...input };
  delete record[LOOKUP_FIELD];
  if (!(TOKEN_FIELD in record)) return record;
  if (typeof record[TOKEN_FIELD] !== 'string') {
    throw new Error('Better Auth session row is missing its protected token');
  }
  record[TOKEN_FIELD] = protector.reveal(record[TOKEN_FIELD]);
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
