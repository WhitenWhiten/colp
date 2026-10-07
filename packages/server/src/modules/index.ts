export interface ApplicationModule {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export * from './access-policy/index.js';
export * from './attachments/index.js';
export * from './collections/index.js';
export * from './commands/index.js';
export * from './community/index.js';
export * from './identity/index.js';
export * from './mcp/index.js';
export * from './publisher/index.js';
export * from './publication/index.js';
export * from './reading-progress/index.js';
export * from './search/index.js';
export * from './social/index.js';
export * from './reports/index.js';
