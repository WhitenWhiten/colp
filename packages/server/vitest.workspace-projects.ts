/**
 * Workspace project names and exclusive include/exclude lists for Known-Backend.
 * Ownership is by project name + glob completeness, not per-slice vitest*.config.ts.
 */

import {
  BROWSER_INCLUDE,
  EVIDENCE_INCLUDE,
  REDIS_INCLUDE,
  SYSTEM_INCLUDE,
} from './scripts/vitest-project-files.mjs';

export { BROWSER_INCLUDE, EVIDENCE_INCLUDE, REDIS_INCLUDE, SYSTEM_INCLUDE };

export const WORKSPACE_PROJECT_NAMES = [
  'browser',
  'evidence',
  'postgres',
  'redis',
  'static',
  'system',
  'unit',
] as const;

export type WorkspaceProjectName = (typeof WORKSPACE_PROJECT_NAMES)[number];

export const UNIT_INCLUDE = ['tests/unit/**/*.test.ts'] as const;

export const UNIT_EXCLUDE = [
  'tests/unit/**/*-static.test.ts',
  ...BROWSER_INCLUDE.filter((file) => file.startsWith('tests/unit/')),
  ...EVIDENCE_INCLUDE.filter((file) => file.startsWith('tests/unit/')),
  ...SYSTEM_INCLUDE,
] as const;

export const STATIC_INCLUDE = ['tests/unit/**/*-static.test.ts'] as const;

export const STATIC_EXCLUDE = EVIDENCE_INCLUDE.filter((file) => file.endsWith('-static.test.ts'));

export const POSTGRES_INCLUDE = ['tests/integration/**/*.integration.test.ts'] as const;

export const POSTGRES_EXCLUDE = [
  ...REDIS_INCLUDE,
  ...BROWSER_INCLUDE.filter((file) => file.startsWith('tests/integration/')),
  ...EVIDENCE_INCLUDE.filter((file) => file.startsWith('tests/integration/')),
] as const;
