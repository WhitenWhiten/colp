import { Client, type ClientConfig } from 'pg';
import { settleBestEffort } from '../async/best-effort.js';

/** Single-use query cancellation connections never enter the business pool. */
export class PostgresControlClient extends Client {
  constructor(config: ClientConfig) {
    super(config);
    // pg emits socket errors in addition to rejecting the in-flight query.
    // The query rejection is authoritative; the event must not kill the process.
    this.on('error', () => undefined);
  }

  override end(): Promise<void>;
  override end(callback: (error: Error) => void): void;
  override end(callback?: (error: Error) => void): Promise<void> | void {
    if (callback) return super.end(callback);
    // Kysely's control connection finally calls end without awaiting it.
    return settleBestEffort(super.end(),
      'the cancellation query outcome is authoritative and this disconnected client is never reused');
  }
}
