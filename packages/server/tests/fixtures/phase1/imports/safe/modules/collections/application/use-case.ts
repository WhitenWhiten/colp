import type { IdentityContract } from '../../identity/index.js';
import type { CommandContract } from '../../commands/index.js';

export type SafeUseCase = IdentityContract & CommandContract;
