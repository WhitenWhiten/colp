import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(
  projectRoot,
  'tests',
  'performance',
  'baselines',
  'publication-snapshot-delivery.json',
);
const hostBaselinePath = resolve(
  projectRoot,
  'reports',
  'publication-snapshot-delivery-host-baseline.json',
);
const reportPath = resolve(
  projectRoot,
  process.argv[2] ?? 'reports/publication-snapshot-delivery-current.json',
);
const COMPARE_MODES = new Set(['skip', 'relative']);

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${path}`, { cause: error });
  }
}

async function readJsonIfPresent(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`${label} is invalid: ${path}`, { cause: error });
  }
}

function finiteNumber(value, label, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${label} must be a finite number greater than or equal to ${minimum}.`);
  }
  return value;
}

function nodeMajor(version, label) {
  const match = String(version).trim().match(/^v?(\d+)/u);
  if (!match) {
    throw new TypeError(`${label} Node version ${JSON.stringify(version)} must start with a major number.`);
  }
  return Number(match[1]);
}

function readEnvironment(source, label) {
  const platform = source?.platform;
  const node = source?.node;
  if (typeof platform !== 'string' || platform.length === 0) {
    throw new TypeError(`${label} environment.platform must be a non-empty string.`);
  }
  if (typeof node !== 'string' || node.length === 0) {
    throw new TypeError(`${label} environment.node must be a non-empty string.`);
  }
  return { platform, node, nodeMajor: nodeMajor(node, label) };
}

function environmentsMatch(left, right) {
  return left.platform === right.platform && left.nodeMajor === right.nodeMajor;
}

function formatEnvironment(environment) {
  return `${environment.platform} / Node ${environment.nodeMajor}`;
}

function findBenchmark(report, name) {
  const matches = [];
  for (const file of report.files ?? []) {
    for (const group of file.groups ?? []) {
      for (const benchmark of group.benchmarks ?? []) {
        if (benchmark.name === name) matches.push(benchmark);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one benchmark named ${JSON.stringify(name)}, found ${matches.length}.`);
  }
  return matches[0];
}

function hostReferenceHz(host, benchmarkName) {
  if (host && typeof host.reference === 'object' && host.reference !== null) {
    return finiteNumber(host.reference.hz, 'Same-host throughput', Number.EPSILON);
  }
  if (typeof host?.hz === 'number') {
    return finiteNumber(host.hz, 'Same-host throughput', Number.EPSILON);
  }
  return finiteNumber(findBenchmark(host, benchmarkName).hz, 'Same-host throughput', Number.EPSILON);
}

function hostEnvironment(host, label) {
  if (host && typeof host.reference === 'object' && host.reference !== null && host.reference.environment) {
    return readEnvironment(host.reference.environment, label);
  }
  if (host?.environment) return readEnvironment(host.environment, label);
  return null;
}

function measureCalibrationHz() {
  const sample = '{"id":"n1","kind":"bookmark","url":"https://example.test/"}';
  const warmup = 1_000;
  const iterations = 50_000;
  for (let index = 0; index < warmup; index += 1) JSON.parse(sample);
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) JSON.parse(sample);
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  if (!(seconds > 0)) {
    throw new Error('Calibration micro-benchmark completed too quickly to measure.');
  }
  return iterations / seconds;
}

function skipMismatch(message) {
  console.warn(message);
  console.warn('Publication delivery: skipping absolute-Hz comparison (exit 0).');
}

async function compareToReference({
  baseline,
  referenceHz,
  referenceLabel,
}) {
  const minimumRatio = finiteNumber(
    baseline.policy?.minimumThroughputRatio,
    'Minimum throughput ratio',
    Number.EPSILON,
  );
  const maximumRme = finiteNumber(
    baseline.policy?.maximumRelativeMarginOfErrorPercent,
    'Maximum relative margin of error',
    Number.EPSILON,
  );
  const report = await readJson(reportPath, 'Publication delivery benchmark report');
  const current = findBenchmark(report, baseline.benchmark);
  const currentHz = finiteNumber(current.hz, 'Current throughput', Number.EPSILON);
  const currentRme = finiteNumber(current.rme, 'Current relative margin of error');
  const ratio = currentHz / referenceHz;
  const minimumHz = referenceHz * minimumRatio;
  const calibrationHz = measureCalibrationHz();

  console.log([
    `Publication delivery: ${currentHz.toFixed(2)} plans/s`,
    `reference: ${referenceHz.toFixed(2)} plans/s (${referenceLabel})`,
    `ratio: ${(ratio * 100).toFixed(1)}%`,
    `RME: ${currentRme.toFixed(2)}%`,
    `calibration: ${calibrationHz.toFixed(2)} JSON.parse/s (diagnostic; not a gate)`,
  ].join('; '));

  if (currentRme > maximumRme) {
    throw new Error(
      `Publication delivery benchmark is too noisy: ${currentRme.toFixed(2)}% RME exceeds ${maximumRme.toFixed(2)}%.`,
    );
  }
  if (currentHz < minimumHz) {
    throw new Error(
      `Publication delivery throughput regressed below ${minimumRatio * 100}% of ${referenceLabel}: `
      + `${currentHz.toFixed(2)} < ${minimumHz.toFixed(2)} plans/s.`,
    );
  }
}

const baseline = await readJson(baselinePath, 'Publication delivery baseline');

if (baseline.schemaVersion !== 1 || typeof baseline.benchmark !== 'string') {
  throw new TypeError('Publication delivery baseline schema is unsupported.');
}

const compareMode = baseline.compareMode ?? 'skip';
if (!COMPARE_MODES.has(compareMode)) {
  throw new TypeError(
    `Publication delivery compareMode must be "skip" or "relative", received ${JSON.stringify(compareMode)}.`,
  );
}

const referenceHz = finiteNumber(baseline.reference?.hz, 'Baseline throughput', Number.EPSILON);
const minimumRatio = finiteNumber(
  baseline.policy?.minimumThroughputRatio,
  'Minimum throughput ratio',
  Number.EPSILON,
);
const committedEnvironment = readEnvironment(baseline.reference?.environment, 'Baseline');
const currentEnvironment = readEnvironment(
  { platform: process.platform, node: process.version },
  'Current process',
);

if (environmentsMatch(currentEnvironment, committedEnvironment)) {
  await compareToReference({
    baseline,
    referenceHz,
    referenceLabel: `committed ${formatEnvironment(committedEnvironment)}`,
  });
} else {
  console.warn([
    `Publication delivery: this process is ${formatEnvironment(currentEnvironment)};`,
    `committed baseline is ${formatEnvironment(committedEnvironment)} at ${referenceHz.toFixed(2)} plans/s.`,
    `Not using that absolute Hz as a ${(minimumRatio * 100).toFixed(0)}% gate on a different platform or Node major.`,
  ].join(' '));

  if (compareMode === 'skip') {
    skipMismatch('Publication delivery: compareMode=skip.');
  } else {
    const host = await readJsonIfPresent(hostBaselinePath, 'Same-host publication delivery baseline');
    if (host === null) {
      skipMismatch(
        `Publication delivery: compareMode=relative and no same-host artifact at ${hostBaselinePath}.`,
      );
    } else {
      const hostEnv = hostEnvironment(host, 'Same-host baseline');
      if (hostEnv === null) {
        skipMismatch(
          'Publication delivery: same-host artifact does not record environment; refusing to treat it as this machine.',
        );
      } else if (!environmentsMatch(currentEnvironment, hostEnv)) {
        skipMismatch(
          `Publication delivery: same-host artifact is ${formatEnvironment(hostEnv)}; this process is ${formatEnvironment(currentEnvironment)}.`,
        );
      } else {
        await compareToReference({
          baseline,
          referenceHz: hostReferenceHz(host, baseline.benchmark),
          referenceLabel: `same-host ${formatEnvironment(hostEnv)}`,
        });
      }
    }
  }
}
