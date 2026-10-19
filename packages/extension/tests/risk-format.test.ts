import { describe, expect, it } from 'vitest';
import { parseRiskList, RISKLIST_LIMITS, RISKLIST_MAX_BYTES } from '../src/risk/risklist-format.js';

/** Doc 17 §5.2, RS-18.5: `colp.risklist/v1` is closed, and a `domain` entry names one owner's registrable domain, never a public suffix. */
const entry = (over: Record<string, unknown> = {}) => ({ scope: 'domain', value: 'login-example-support.com', kind: 'phishing',
  since: '2026-10-17T00:00:00Z', expires: null, evidenceUrl: 'https://example.org/r/1', ...over });
const doc = (entries: unknown[] = [entry()], over: Record<string, unknown> = {}) => JSON.stringify({ format: 'colp.risklist/v1', id: 'example-phishing',
  name: 'Example phishing list', version: '2026-10-18T06:00:00Z', updatedAt: '2026-10-18T06:00:00Z',
  publisher: { name: 'Example', url: 'https://example.org', feedbackUrl: null }, license: 'MIT', entries, ...over });
const problems = (text: string) => { const parsed = parseRiskList(text); return parsed.ok ? [] : parsed.problems; };

describe('colp.risklist/v1', () => {
  it('reads the example in §5.2, with hosts and prefixes written one way', () => {
    const parsed = parseRiskList(doc([entry(), entry({ scope: 'urlPrefix', value: 'https://Pages.Example.dev/u123/', kind: 'scam', expires: '2026-12-01T00:00:00Z',
      evidenceUrl: null }), entry({ scope: 'host', value: 'Login.Example-Bank.COM.' })]));
    expect(parsed).toMatchObject({ ok: true, list: { id: 'example-phishing', name: 'Example phishing list', version: '2026-10-18T06:00:00Z', license: 'MIT',
      publisher: { name: 'Example', url: 'https://example.org', feedbackUrl: null } } });
    if (!parsed.ok) throw new Error('refused');
    expect(parsed.list.entries.map(({ scope, value }) => [scope, value])).toEqual([['domain', 'login-example-support.com'],
      ['urlPrefix', 'https://pages.example.dev/u123/'], ['host', 'login.example-bank.com']]);
  });

  it('is closed: a key outside the format, a missing key or another format refuses the file', () => {
    expect(problems(doc([entry()], { extra: 1 }))).toEqual([{ pointer: '/extra', code: 'unknownKey' }]);
    expect(problems(doc([{ ...entry(), note: 'x' }]))).toEqual([{ pointer: '/entries/0/note', code: 'unknownKey' }]);
    const { expires: _expires, ...partial } = entry();
    expect(problems(doc([partial]))).toEqual([{ pointer: '/entries/0/expires', code: 'required' }]);
    expect(problems(doc([entry({ kind: 'spam' })]))).toEqual([{ pointer: '/entries/0/kind', code: 'pattern' }]);
    expect(problems(doc([entry({ since: 'yesterday' })]))).toEqual([{ pointer: '/entries/0/since', code: 'invalidDate' }]);
    expect(problems(doc([], { format: 'colp.risklist/v2' }))).toEqual([{ pointer: '/format', code: 'format' }]);
    expect(problems('{')).toEqual([{ pointer: '', code: 'json' }]);
  });

  it('refuses a domain entry that names a public suffix, and a subdomain filed as a domain (RS-18.5)', () => {
    expect(problems(doc([entry({ value: 'github.io' })]))).toEqual([{ pointer: '/entries/0/value', code: 'publicSuffix' }]);
    expect(problems(doc([entry({ value: 'co.uk' })]))).toEqual([{ pointer: '/entries/0/value', code: 'publicSuffix' }]);
    expect(problems(doc([entry({ value: 'pages.user.github.io' })]))).toEqual([{ pointer: '/entries/0/value', code: 'notRegistrable' }]);
    // One owner's site under a shared suffix is a registrable domain; a subdomain may be listed as a host.
    expect(parseRiskList(doc([entry({ value: 'user.github.io' }), entry({ scope: 'host', value: 'pages.user.github.io' })])).ok).toBe(true);
  });

  it('takes a URL prefix only as an http(s) address without query, fragment or user name', () => {
    for (const value of ['https://pages.example.dev/u123/?ref=1', 'https://pages.example.dev/u123/#top', 'https://pages.example.dev/?', 'ftp://pages.example.dev/u123/',
      'https://me@pages.example.dev/u123/', 'pages.example.dev/u123/']) {
      expect(problems(doc([entry({ scope: 'urlPrefix', value })]))).toEqual([{ pointer: '/entries/0/value', code: 'invalidUrl' }]);
    }
  });

  it('names at most ten problems, reads a full file and refuses one over 4 MB', () => {
    expect(problems(doc(Array.from({ length: 30 }, () => entry({ value: 'com' }))))).toHaveLength(RISKLIST_LIMITS.problems);
    const large = doc([entry()], { license: '' }).replace('"license":""', `"license":"${' '.repeat(RISKLIST_MAX_BYTES)}"`);
    expect(problems(large)).toEqual([{ pointer: '', code: 'tooLarge' }]);
    // A full file: the most entries 4 MB holds, read whole.
    const many = Array.from({ length: 30_000 }, (_, index) => entry({ scope: 'host', value: `h${index}.example.com`, since: '2026-10-01', evidenceUrl: null }));
    const full = doc(many);
    expect(new TextEncoder().encode(full).length).toBeLessThan(RISKLIST_MAX_BYTES);
    expect(parseRiskList(full)).toMatchObject({ ok: true, list: { entries: { length: 30_000 } } });
  });
});
