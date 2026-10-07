/**
 * Bounded background scheduler for MCP Write Plan expiry and retention.
 */
import type { Phase4bMcpWriteRetentionPurgeResult } from './write-operations.js';

export const DEFAULT_MCP_WRITE_MAINTENANCE_INTERVAL_MS = 60_000;
export const MCP_WRITE_MAINTENANCE_INTERVAL_MIN_MS = 1_000;
export const MCP_WRITE_MAINTENANCE_INTERVAL_MAX_MS = 3_600_000;

export interface Phase4bMcpWriteMaintenancePort {
  readonly expireDuePlans: () => number | PromiseLike<number>;
  readonly purgeRetained: () =>
    Phase4bMcpWriteRetentionPurgeResult | PromiseLike<Phase4bMcpWriteRetentionPurgeResult>;
}

export interface Phase4bMcpWriteMaintenanceResult {
  readonly expiredPlans: number;
  readonly purge: Phase4bMcpWriteRetentionPurgeResult;
}

export interface Phase4bMcpWriteMaintenanceJobOptions {
  readonly intervalMs: number;
  readonly onResult?: (result: Phase4bMcpWriteMaintenanceResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface Phase4bMcpWriteMaintenanceJobLike {
  start(): void;
  stop(): void;
}

export class McpWriteMaintenanceJob {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly operations: Phase4bMcpWriteMaintenancePort,
    private readonly options: Phase4bMcpWriteMaintenanceJobOptions,
  ) {
    if (
      !Number.isSafeInteger(options.intervalMs)
      || options.intervalMs < MCP_WRITE_MAINTENANCE_INTERVAL_MIN_MS
      || options.intervalMs > MCP_WRITE_MAINTENANCE_INTERVAL_MAX_MS
    ) {
      throw new TypeError(
        'MCP Write maintenance interval must be a safe integer between '
        + `${MCP_WRITE_MAINTENANCE_INTERVAL_MIN_MS} and ${MCP_WRITE_MAINTENANCE_INTERVAL_MAX_MS}.`,
      );
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const expiredPlans = await this.operations.expireDuePlans();
      const purge = await this.operations.purgeRetained();
      this.options.onResult?.(Object.freeze({ expiredPlans, purge }));
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
    }
  }
}
