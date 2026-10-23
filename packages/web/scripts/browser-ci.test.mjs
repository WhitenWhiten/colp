import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = readFileSync(resolve(root, '../../.github/workflows/colp-ci.yml'), 'utf8')
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts

test('required CI lanes execute web E2E and production acceptance under xvfb', () => {
  const browser = workflow.split('  web-browser:')[1]?.split(/\n  [a-z]/u)[0] ?? ''
  const acceptance = workflow.split('  web-acceptance:')[1]?.split(/\n  [a-z]/u)[0] ?? ''
  const gate = workflow.slice(workflow.indexOf('  ci-gate:'))
  assert.match(browser, /shard: \[1, 2, 3, 4\]/u)
  assert.ok(browser.includes('npm run test:e2e -- --shard=${{ matrix.shard }}/4'))
  assert.ok(acceptance.includes('npm run test:acceptance'))
  for (const [job, result] of [['web-browser', 'WEB_BROWSER_RESULT'], ['web-acceptance', 'WEB_ACCEPTANCE_RESULT']]) {
    assert.ok(gate.includes(`- ${job}`))
    assert.ok(gate.includes(`needs.${job}.result`))
    assert.ok(gate.includes(`"$${result}"`))
  }
  assert.ok(scripts['test:e2e'].includes('scripts/with-xvfb.mjs'))
  assert.ok(scripts['test:acceptance'].includes('with-postgres.mjs --isolated-owner'))
  assert.ok(scripts['test:acceptance:inner'].includes('scripts/with-xvfb.mjs'))
  assert.ok(scripts['test:acceptance:inner'].includes('with-self-hosted-browser.mjs'))
})

for (const [directory, config] of [['e2e', 'playwright.config.ts'], ['acceptance', 'playwright.self-hosted.config.ts']]) {
  test(`Playwright independently discovers every ${directory} spec`, () => {
    const files = readdirSync(resolve(root, directory), { recursive: true }).map(String)
      .filter(file => file.endsWith('.spec.ts')).sort()
    const report = JSON.parse(execFileSync(process.execPath, [resolve(root, '../extension/scripts/with-xvfb.mjs'),
      process.execPath, resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', `--config=${config}`,
      '--list', '--reporter=json'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, COLP_ACCEPTANCE_ORIGIN: 'http://127.0.0.1:1' } }))
    assert.deepEqual(report.errors, [])
    const collected = [...new Set(report.suites.map(suite =>
      relative(resolve(root, directory), resolve(report.config.rootDir, suite.file))))].sort()
    assert.deepEqual(collected, files)
    assert.ok(collected.length > 0)
  })
}
