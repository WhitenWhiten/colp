import { pathToFileURL } from 'node:url';
import { requiredReleaseJobs } from './sync-acceptance-manifest.mjs';

/** Release only the exact main-branch commit tested by a full CI run. */
export async function verifyCiAcceptance({ repository, sha, token, fetchJson }) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '') || !/^[0-9a-f]{40}$/u.test(sha ?? '')) {
    throw new Error('A repository and full release commit SHA are required');
  }
  const request = fetchJson ?? (async path => {
    if (!token) throw new Error('An actions:read GitHub token is required');
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub acceptance lookup failed (${response.status})`);
    return response.json();
  });
  const runs = await pages(request, `/actions/workflows/colp-ci.yml/runs?head_sha=${sha}`, 'workflow_runs');
  const candidates = runs.filter(run => run.head_sha === sha && run.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run.event)
    && run.status === 'completed' && run.conclusion === 'success');
  for (const run of candidates) {
    const jobs = await pages(request, `/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
    if (requiredReleaseJobs.every(name => jobs.some(job => job.name === name
        && job.status === 'completed' && job.conclusion === 'success'))) return run;
  }
  throw new Error(`No complete sync acceptance run passed for release commit ${sha}. `
    + 'Run colp-ci with full verification on this exact main commit, then retry the release.');
}

async function pages(request, path, key) {
  const items = [];
  for (let page = 1; page <= 50; page += 1) {
    const result = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(result[key])) throw new Error(`Invalid GitHub acceptance response: ${key}`);
    items.push(...result[key]);
    if (result[key].length < 100) return items;
  }
  throw new Error('GitHub acceptance response exceeds the pagination bound');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await verifyCiAcceptance({ repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA, token: process.env.GH_TOKEN });
  process.stdout.write(`Sync acceptance verified: ${run.html_url}\n`);
}
