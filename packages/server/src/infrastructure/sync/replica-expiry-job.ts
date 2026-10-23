import type { PostgresReplicaLifecycleService } from './replica-lifecycle-postgres.js';

export class ReplicaExpiryJob {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly lifecycle: Pick<PostgresReplicaLifecycleService, 'expireDue'>,
    private readonly options: {
      readonly intervalMs: number;
      readonly batchSize: number;
      readonly onResult?: (count: number) => void;
      readonly onError: (error: unknown) => void;
    }) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1
      || !Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
      throw new TypeError('Invalid Replica expiry schedule.');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  tick(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(): Promise<void> {
    try {
      const result = await this.lifecycle.expireDue({ limit: this.options.batchSize });
      this.options.onResult?.(result.expiredReplicaIds.length);
    } catch (error) { this.options.onError(error); }
  }
}
