#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const detectedStatuses = new Set(['Killed', 'Timeout', 'CompileError', 'RuntimeError']);
const undetectedStatuses = new Set(['Survived', 'NoCoverage']);
const terminalStatuses = new Set([...detectedStatuses, ...undetectedStatuses, 'Ignored']);

function percentage(numerator, denominator) {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 100;
}

function mutantsFromReport(report) {
  if (!report || typeof report !== 'object' || !report.files || typeof report.files !== 'object') {
    throw new Error('Mutation report must contain a files object.');
  }

  return Object.values(report.files).flatMap((file) => {
    if (!file || typeof file !== 'object' || !Array.isArray(file.mutants)) {
      throw new Error('Every mutation report file must contain a mutants array.');
    }
    return file.mutants;
  });
}

export function summarizeMutationReport(report, domain, sourceReport = undefined) {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new Error('Mutation summary domain must be a non-empty string.');
  }

  const statusCounts = Object.fromEntries([...terminalStatuses].map((status) => [status, 0]));
  for (const mutant of mutantsFromReport(report)) {
    const status = mutant?.status;
    if (!terminalStatuses.has(status)) {
      throw new Error(`Mutation report contains non-terminal or unknown status ${JSON.stringify(status)}.`);
    }
    statusCounts[status] += 1;
  }

  const detected = [...detectedStatuses].reduce((total, status) => total + statusCounts[status], 0);
  const survived = statusCounts.Survived;
  const noCoverage = statusCounts.NoCoverage;
  const ignored = statusCounts.Ignored;
  const scored = detected + survived + noCoverage;
  const covered = detected + survived;

  return {
    schemaVersion: 1,
    kind: 'colp-mutation-domain-summary',
    domain,
    ...(sourceReport ? { sourceReport } : {}),
    thresholds: report.thresholds ?? null,
    totals: {
      mutants: scored + ignored,
      scored,
      covered,
      detected,
      killed: statusCounts.Killed,
      timeout: statusCounts.Timeout,
      compileError: statusCounts.CompileError,
      runtimeError: statusCounts.RuntimeError,
      survived,
      noCoverage,
      ignored,
    },
    scores: {
      mutation: percentage(detected, scored),
      covered: percentage(detected, covered),
    },
  };
}

export function aggregateMutationSummaries(summaries, revision = undefined) {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    throw new Error('At least one mutation domain summary is required.');
  }

  const domains = [...summaries].sort((left, right) => left.domain.localeCompare(right.domain));
  const seen = new Set();
  const totalKeys = [
    'mutants', 'scored', 'covered', 'detected', 'killed', 'timeout',
    'compileError', 'runtimeError', 'survived', 'noCoverage', 'ignored',
  ];
  const totals = Object.fromEntries(totalKeys.map((key) => [key, 0]));

  for (const summary of domains) {
    if (summary?.kind !== 'colp-mutation-domain-summary' || typeof summary.domain !== 'string') {
      throw new Error('Aggregate input must contain COLP mutation domain summaries.');
    }
    if (seen.has(summary.domain)) {
      throw new Error(`Duplicate mutation domain summary: ${summary.domain}.`);
    }
    seen.add(summary.domain);
    for (const key of totalKeys) {
      if (!Number.isInteger(summary.totals?.[key]) || summary.totals[key] < 0) {
        throw new Error(`Mutation domain ${summary.domain} has an invalid ${key} total.`);
      }
      totals[key] += summary.totals[key];
    }
    if (
      summary.totals.mutants !== summary.totals.scored + summary.totals.ignored
      || summary.totals.covered !== summary.totals.detected + summary.totals.survived
      || summary.totals.scored !== summary.totals.covered + summary.totals.noCoverage
    ) {
      throw new Error(`Mutation domain ${summary.domain} has inconsistent totals.`);
    }
  }

  return {
    schemaVersion: 1,
    kind: 'colp-mutation-suite-summary',
    ...(revision ? { revision } : {}),
    domains,
    totals,
    scores: {
      executionWeightedMutation: percentage(totals.detected, totals.scored),
      executionWeightedCovered: percentage(totals.detected, totals.covered),
    },
  };
}

export function mutationSummaryMarkdown(summary) {
  const rows = summary.domains.map(({ domain, scores, totals }) => (
    `| ${domain} | ${scores.mutation ?? 'n/a'}% | ${totals.detected} | ${totals.survived} | ${totals.noCoverage} | ${totals.mutants} |`
  ));
  return [
    '## COLP mutation summary',
    '',
    '| Domain | Score | Detected | Survived | No coverage | Mutants |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    `| **Execution-weighted total** | **${summary.scores.executionWeightedMutation ?? 'n/a'}%** | **${summary.totals.detected}** | **${summary.totals.survived}** | **${summary.totals.noCoverage}** | **${summary.totals.mutants}** |`,
    '',
    '_The total weights domain executions; it does not deduplicate mutants shared by overlapping domain configurations._',
    '',
  ].join('\n');
}

export function updateMutationHistory(history, summary, revision, maximumEntries = 30) {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new Error('A revision is required when updating mutation history.');
  }
  if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
    throw new Error('Mutation history maximumEntries must be a positive integer.');
  }

  const existing = history ?? {
    schemaVersion: 1,
    kind: 'colp-mutation-history',
    entries: [],
  };
  if (
    existing.schemaVersion !== 1
    || existing.kind !== 'colp-mutation-history'
    || !Array.isArray(existing.entries)
  ) {
    throw new Error('Mutation history has an unsupported shape.');
  }

  const domains = summary.domains.map(({ domain }) => domain);
  const domainKey = domains.join(',');
  const entries = existing.entries.filter((entry) => (
    entry.revision !== revision || entry.domains?.join(',') !== domainKey
  ));
  entries.push({
    revision,
    domains,
    totals: summary.totals,
    scores: summary.scores,
  });

  return {
    schemaVersion: 1,
    kind: 'colp-mutation-history',
    entries: entries.slice(-maximumEntries),
  };
}

export function mutationHistoryMarkdown(history, domains) {
  const domainKey = domains.join(',');
  const comparable = history.entries
    .filter((entry) => entry.domains?.join(',') === domainKey)
    .slice(-10);
  const rows = comparable.map(({ revision, scores, totals }) => (
    `| ${revision.slice(0, 12)} | ${scores.executionWeightedMutation ?? 'n/a'}% | ${totals.detected} | ${totals.mutants} |`
  ));
  return [
    '## Comparable mutation trend',
    '',
    `Domain set: \`${domainKey}\``,
    '',
    '| Revision | Execution-weighted score | Detected | Mutant executions |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments, received ${JSON.stringify(rest)}.`);
    }
    values.set(option.slice(2), value);
  }
  return { command, values };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required --${name} argument.`);
  return value;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function findDomainSummaries(directory) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findDomainSummaries(path));
    } else if (/^mutation-summary-.+\.json$/.test(entry.name)) {
      matches.push(path);
    }
  }
  return matches;
}

function run(argv) {
  const { command, values } = parseArguments(argv);
  if (command === 'summarize') {
    const inputArgument = required(values, 'input');
    const input = resolve(inputArgument);
    const output = resolve(required(values, 'output'));
    const report = JSON.parse(readFileSync(input, 'utf8'));
    writeJson(output, summarizeMutationReport(report, required(values, 'domain'), inputArgument));
    return;
  }

  if (command === 'aggregate') {
    const inputDirectory = resolve(required(values, 'input-directory'));
    const output = resolve(required(values, 'output'));
    const summaries = findDomainSummaries(inputDirectory)
      .map((path) => JSON.parse(readFileSync(path, 'utf8')));
    const revision = values.get('revision');
    const aggregate = aggregateMutationSummaries(summaries, revision);
    writeJson(output, aggregate);
    let markdown = mutationSummaryMarkdown(aggregate);
    const historyPath = values.get('history');
    if (historyPath) {
      const resolvedHistoryPath = resolve(historyPath);
      const previousHistory = existsSync(resolvedHistoryPath)
        ? JSON.parse(readFileSync(resolvedHistoryPath, 'utf8'))
        : undefined;
      const history = updateMutationHistory(previousHistory, aggregate, revision);
      writeJson(resolvedHistoryPath, history);
      markdown += `\n${mutationHistoryMarkdown(
        history,
        aggregate.domains.map(({ domain }) => domain),
      )}`;
    }
    const githubSummary = values.get('github-summary');
    if (githubSummary) appendFileSync(githubSummary, markdown, 'utf8');
    return;
  }

  throw new Error('Usage: mutation-report.mjs summarize|aggregate [options].');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2));
}
