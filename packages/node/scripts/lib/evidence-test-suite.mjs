export const processOnlyEvidenceTestPaths = Object.freeze([
  'tests/conformance/r01-bundled-evidence-revision-contract.test.ts',
  'tests/conformance/r02-mcp-write-progress-boundary-contract.test.ts',
]);

export function evidenceVitestArguments(reportPath, coverage = false) {
  if (typeof reportPath !== 'string' || reportPath.length === 0) {
    throw new TypeError('Evidence report path must be a non-empty string.');
  }
  if (typeof coverage !== 'boolean') {
    throw new TypeError('Evidence coverage selection must be boolean.');
  }
  return Object.freeze([
    'run',
    ...(coverage ? ['--coverage'] : []),
    // Preserve human-readable failure diagnostics beside the attested JSON report.
    '--reporter=default',
    '--reporter=json',
    '--outputFile',
    reportPath,
    ...processOnlyEvidenceTestPaths.flatMap((path) => ['--exclude', path]),
  ]);
}
