export interface StandaloneValidator { (value: unknown): boolean; readonly errors?: readonly unknown[] | null }
export const bookmarkUrl: StandaloneValidator;
export const conversionPreview: StandaloneValidator;
