export type * from './generated.js';
export type * from './strict.js';

import type { ColpContracts } from './generated.js';

export type ColpContractName = keyof ColpContracts;
export type ColpContract<Name extends ColpContractName> = ColpContracts[Name];
