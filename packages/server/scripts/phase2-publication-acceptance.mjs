/**
 * Fail-closed Phase 2 publication acceptance entrypoint.
 *
 * The adapter module owns deployment-specific server fixture orchestration
 * and must return every required probe. This runner owns protocol traversal and
 * immutable evidence assembly. Run this script through tsx so the adapter may
 * compose production TypeScript modules.
 */
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { runPhase2PublicationAcceptance } from './acceptance/phase2-publication-acceptance.js';
import { redactSensitiveText } from '../src/infrastructure/telemetry/index.js';

const adapterPath = process.env.KNOWN_PHASE2_ACCEPTANCE_ADAPTER?.trim()
  ?? resolve('scripts/phase2-publication-acceptance-adapter.ts');

let deployment;
try {
  const absoluteAdapterPath = isAbsolute(adapterPath) ? adapterPath : resolve(adapterPath);
  const adapter = await import(pathToFileURL(absoluteAdapterPath).href);
  const createDeployment = adapter.createPhase2AcceptanceDeployment ?? adapter.default;
  if (typeof createDeployment !== 'function') {
    throw new TypeError(
      'Phase 2 acceptance adapter must export createPhase2AcceptanceDeployment or default',
    );
  }
  deployment = await createDeployment({ env: process.env });
  if (!deployment || typeof deployment !== 'object') {
    throw new TypeError('Phase 2 acceptance adapter returned no deployment');
  }
  if (!deployment.target || !deployment.expectations) {
    throw new TypeError('Phase 2 acceptance adapter must return target and expectations');
  }
  if (typeof deployment.close !== 'function') {
    throw new TypeError('Phase 2 acceptance adapter must return a close lifecycle function');
  }

  const evidence = await runPhase2PublicationAcceptance(
    deployment.target,
    deployment.expectations,
  );
  const serialized = `${JSON.stringify(evidence)}\n`;
  const outputPath = process.env.KNOWN_PHASE2_ACCEPTANCE_OUTPUT?.trim();
  if (outputPath) await writeEvidenceExclusively(resolve(outputPath), serialized);
  process.stdout.write(serialized);
} catch (error) {
  failClosed(redactSensitiveText(error));
} finally {
  if (deployment && typeof deployment.close === 'function') {
    try {
      await deployment.close();
    } catch (error) {
      failClosed(`deployment cleanup failed: ${redactSensitiveText(error)}`);
    }
  }
}

async function writeEvidenceExclusively(path, serialized) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function failClosed(message) {
  process.stderr.write(`[phase2-publication-acceptance] FAIL-CLOSED: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}
