export interface StandaloneValidator { (value: unknown): boolean; readonly errors?: readonly unknown[] | null }
export const operation: StandaloneValidator;
export const createNodeOperationPayload: StandaloneValidator;
export const nodeContentUpdateOperationPayload: StandaloneValidator;
export const moveOperationPayload: StandaloneValidator;
export const deleteOperationPayload: StandaloneValidator;
