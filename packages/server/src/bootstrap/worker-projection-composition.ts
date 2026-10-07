import type { DatabaseRuntime } from '../infrastructure/database/index.js';
import { PostgresCollectionMutationProjectionSink,createProductionCollectionMutationOutboxRouter,
  type CollectionMutationProjectionSink,type OutboxRoute } from '../infrastructure/outbox/index.js';

/**
 * Compose production outbox projection routes.
 * Refuses transient sinks; never falls back to in-memory completion.
 */
export function composeProductionOutboxProjectionRoutes(options: {
  readonly projectionSink?: CollectionMutationProjectionSink;
  readonly logger?: { info(bindings: object, message: string): void };
}): readonly OutboxRoute[] {
  if (!options.projectionSink) {
    // No durable sink provided (e.g. unit harness without a database). Empty routes
    // keep the worker passive instead of completing through a transient memory sink.
    return Object.freeze([]);
  }
  return createProductionCollectionMutationOutboxRouter({
    sink: options.projectionSink,
    logger: options.logger,
  }).listRoutes();
}
/**
 * Resolve the production projection sink.
 * Database-backed workers always get a durable PostgreSQL sink unless an explicit
 * durable sink is injected (tests/harnesses). Never defaults to memory.
 */
export function resolveProductionProjectionSink(options: {
  readonly database?: DatabaseRuntime;
  readonly projectionSink?: CollectionMutationProjectionSink;
}): CollectionMutationProjectionSink | undefined {
  if (options.projectionSink) return options.projectionSink;
  if (options.database) {
    return new PostgresCollectionMutationProjectionSink(options.database.pool);
  }
  return undefined;
}
