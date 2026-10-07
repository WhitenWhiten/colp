/**
 * AUTH-FLAGS (AUTH-P1-b) and AUTH-INSTANCE (AUTH-P1-a) static nets.
 * FLAGS: cutover/canary are unused at runtime (comments + parse-only); this
 * file keeps the empty runtime-read allowlist. INSTANCE shrinks
 * betterAuth(buildBetterAuthOptions) from three files to one production
 * construction site (`createBetterAuthRuntime`); composition shares that
 * instance with authority and C3 instead of constructing again.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';
import { readSrc, rel, srcRoot, walk } from '../../support/org-layering-static.js';

const BETTER_AUTH_CONSTRUCTOR_ALLOWLIST = [
  'src/infrastructure/auth/better-auth-runtime.ts',
] as const;
const CUTOVER_FIELD_TYPE_ALLOWLIST = [
  'src/bootstrap/config.ts',
  'src/bootstrap/config-types.ts',
  'src/modules/auth/better-auth-config.ts',
] as const;

test('production betterAuth(buildBetterAuthOptions) stays on the single-constructor allowlist (AUTH-P1-a)', () => {
  const offenders: string[] = [];
  for (const directory of [
    join(srcRoot, 'bootstrap'),
    join(srcRoot, 'infrastructure', 'auth'),
    join(srcRoot, 'modules', 'auth'),
    join(srcRoot, 'transport'),
  ]) {
    for (const path of walk(directory)) {
      const source = readSrc(path);
      if (/betterAuth\s*\(\s*buildBetterAuthOptions/u.test(source)) offenders.push(rel(path));
    }
  }
  assert.deepEqual(offenders.sort(), [...BETTER_AUTH_CONSTRUCTOR_ALLOWLIST].sort());
});

test('cutoverMode and canaryAllowlist are not read outside config types (AUTH-P1-b)', () => {
  const offenders: string[] = [];
  for (const path of walk(srcRoot)) {
    const relativePath = rel(path);
    const source = readSrc(path);
    const readsField = /\.cutoverMode\b/u.test(source) || /\.canaryAllowlist\b/u.test(source);
    if (!readsField) continue;
    if ((CUTOVER_FIELD_TYPE_ALLOWLIST as readonly string[]).includes(relativePath)) continue;
    offenders.push(relativePath);
  }
  assert.deepEqual(offenders, []);
});
