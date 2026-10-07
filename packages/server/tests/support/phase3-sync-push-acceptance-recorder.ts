import { appendFileSync } from 'node:fs';
import type { Phase3SyncPushAcceptanceScenario } from '../../scripts/acceptance/phase3-sync-push-acceptance.js';

export function recordPhase3SyncPushScenario(scenario: Phase3SyncPushAcceptanceScenario): void {
  const path = process.env.KNOWN_P3_16_SCENARIO_REPORT?.trim();
  const nonce = process.env.KNOWN_P3_16_SCENARIO_NONCE?.trim();
  if (!path && !nonce) return;
  if (!path || !nonce) throw new Error('P3-16 scenario recorder configuration is incomplete');
  appendFileSync(path, `${JSON.stringify({ scenario, nonce, boundary: 'real_http_postgres' })}\n`, {
    encoding: 'utf8', flag: 'a',
  });
}
