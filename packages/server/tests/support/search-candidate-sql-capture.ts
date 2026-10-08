import { PostgresQueryCompiler, type CompiledQuery, type Kysely, type OperationNode } from 'kysely';
import type { DatabaseSchema } from '../../src/infrastructure/database/index.js';
import { createPostgresSearchCandidatePort } from '../../src/infrastructure/search/index.js';

/**
 * Runs the REAL `createPostgresSearchCandidatePort` through its full input
 * validation, normalization and SQL-assembly path, but intercepts query
 * execution so the compiled SQL and bound parameters can be asserted without
 * a PostgreSQL server (FIX-L-021: parameterization, authority recheck and
 * threshold wiring are proven from the production function's compiled output
 * instead of regex-matching source text).
 *
 * The fake executor mirrors the Kysely `RawBuilder.execute` contract:
 * `getExecutor()` -> `transformQuery`/`compileQuery`/`executeQuery`. The
 * session-config probe returns a backend pid; the candidate query returns no
 * rows, which is enough for the port to complete with `{ items: [], hasMore:
 * false }`. With `deferCandidateQuery` the candidate query stays in flight
 * until `resolveCandidateQuery()` so tests can abort it mid-execution and
 * capture the `pg_cancel_backend` cancellation query.
 */
export interface CapturedSearchSql {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export interface SearchSqlCapture {
  readonly port: ReturnType<typeof createPostgresSearchCandidatePort>;
  readonly queries: CapturedSearchSql[];
  /** Resolves once the candidate query is in flight (used to abort mid-flight). */
  readonly candidateQueryStarted: Promise<void>;
  /** Releases the deferred candidate query; only valid with `deferCandidateQuery`. */
  readonly resolveCandidateQuery: () => void;
}

export function capturePostgresSearchSql(options: { readonly deferCandidateQuery?: boolean } = {}): SearchSqlCapture {
  const deferCandidateQuery = options.deferCandidateQuery === true;
  const queries: CapturedSearchSql[] = [];
  let markCandidateStarted: () => void = () => undefined;
  const candidateQueryStarted = new Promise<void>((resolve) => { markCandidateStarted = resolve; });
  let releaseCandidate: () => void = () => undefined;
  const candidateRelease = new Promise<void>((resolve) => { releaseCandidate = resolve; });
  let candidateStarted = false;

  const compiler = new PostgresQueryCompiler();
  const executor = {
    async provideConnection<T>(work: (connection: { collectSessionInfo(): Promise<void>; cancelQuery(): Promise<void> }) => Promise<T>): Promise<T> {
      return work({ collectSessionInfo: async () => {}, cancelQuery: async () => {
        // Driver control channel, deliberately separate from the business executor.
        queries.push({ sql: 'SELECT pg_cancel_backend($1)', parameters: [4242] });
      } });
    },
    compileQuery(node: OperationNode, queryId: { readonly queryId: string }): CompiledQuery {
      return compiler.compileQuery(node, queryId);
    },
    transformQuery(node: OperationNode): OperationNode {
      return node;
    },
    async executeQuery(compiledQuery: CompiledQuery) {
      queries.push({ sql: compiledQuery.sql, parameters: compiledQuery.parameters });
      // Session-config probe: the port requires a real backend pid.
      if (compiledQuery.sql.includes('pg_backend_pid')) {
        return { rows: [{ backend_pid: 4242 }] };
      }
      // Abort cancellation query: must never be deferred or it deadlocks.
      if (compiledQuery.sql.includes('pg_cancel_backend')) {
        return { rows: [] };
      }
      if (!candidateStarted) {
        candidateStarted = true;
        markCandidateStarted();
        if (deferCandidateQuery) await candidateRelease;
      }
      return { rows: [] };
    },
  };
  const transaction = { getExecutor: () => executor };
  const db = {
    transaction() {
      return { execute: (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) };
    },
    getExecutor: () => executor,
  } as unknown as Kysely<DatabaseSchema>;

  return {
    port: createPostgresSearchCandidatePort(db),
    queries,
    candidateQueryStarted,
    resolveCandidateQuery: releaseCandidate,
  };
}
