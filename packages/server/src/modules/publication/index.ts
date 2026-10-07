import type { PublicationCursorKeyring } from './application/index.js';

export * from './application/index.js';

export function createPublicationModule(cursorKeys?: PublicationCursorKeyring): {
  readonly name: 'publication';
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  return Object.freeze({
    name: 'publication',
    async start() {},
    async stop() { cursorKeys?.destroy(); },
  });
}
