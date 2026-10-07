/**
 * Bounded worker inspection tick. Database disconnects and observer failures
 * must never become unhandled rejections; the next scheduled tick stays eligible.
 */
export interface WorkerInspectionTickGate {
  running: boolean;
}

export interface WorkerInspectionTickOptions {
  readonly enabled: boolean;
  readonly gate: WorkerInspectionTickGate;
  readonly inspect: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export async function runWorkerInspectionTick(
  options: WorkerInspectionTickOptions,
): Promise<void> {
  if (!options.enabled || options.gate.running) return;
  options.gate.running = true;
  try {
    await options.inspect();
  } catch (error: unknown) {
    try {
      options.onError(error);
    } catch {
      // The next scheduled tick remains eligible to run.
    }
  } finally {
    options.gate.running = false;
  }
}
