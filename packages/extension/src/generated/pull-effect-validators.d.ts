export interface StandaloneValidator { (value: unknown): boolean; readonly errors?: readonly unknown[] | null }
export const syncPullV02: StandaloneValidator;
export const syncSnapshotV02: StandaloneValidator;
export const authoritativeEffectPage: StandaloneValidator;
export const syncAckResult: StandaloneValidator;
