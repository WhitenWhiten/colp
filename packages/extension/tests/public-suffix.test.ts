import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeHost } from '@know-n/colp/automation';
import { describe, expect, it } from 'vitest';
import { PUBLIC_SUFFIX_COMMIT } from '../src/generated/public-suffix-list.js';
import { isPublicSuffix, parentDomains, publicSuffix, registrableDomain, unicodeHost } from '../src/automation/public-suffix.js';

/** Doc 17 RW-03, RS-09.2, RS-09.4: the vendored Public Suffix List, ICANN and PRIVATE, and how hosts are read against it. */
describe('the Public Suffix List', () => {
  it('finds the registrable domain under ICANN and PRIVATE suffixes', () => {
    expect(registrableDomain('a.b.co.uk')).toBe('b.co.uk');
    expect(publicSuffix('a.b.co.uk')).toBe('co.uk');
    expect(registrableDomain('user.github.io')).toBe('user.github.io');
    expect(registrableDomain('docs.user.github.io')).toBe('user.github.io');
    expect(registrableDomain('github.io')).toBeNull();
    expect(registrableDomain('docs.team.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('arxiv.org')).toBe('arxiv.org');
  });

  it('follows wildcard and exception rules', () => {
    // *.kawasaki.jp with !city.kawasaki.jp
    expect(publicSuffix('www.foo.kawasaki.jp')).toBe('foo.kawasaki.jp');
    expect(registrableDomain('www.foo.kawasaki.jp')).toBe('www.foo.kawasaki.jp');
    expect(publicSuffix('www.city.kawasaki.jp')).toBe('kawasaki.jp');
    expect(registrableDomain('www.city.kawasaki.jp')).toBe('city.kawasaki.jp');
  });

  it('names the suffixes a rule would cover sites of many owners with, and stays silent for numbers and single names', () => {
    expect(isPublicSuffix('github.io')).toBe(true);
    expect(isPublicSuffix('edu')).toBe(true);
    expect(isPublicSuffix('co.uk')).toBe(true);
    expect(isPublicSuffix('arxiv.org')).toBe(false);
    expect(isPublicSuffix('localhost')).toBe(false);
    expect(isPublicSuffix('10.0.0.1')).toBe(false);
    expect(registrableDomain('localhost')).toBeNull();
    expect(registrableDomain('10.0.0.1')).toBeNull();
    expect(publicSuffix('[::1]')).toBeNull();
    expect(publicSuffix('not a host')).toBeNull();
  });

  it('lists a host’s parents up to its registrable domain', () => {
    expect(parentDomains('a.b.example.co.uk')).toEqual(['a.b.example.co.uk', 'b.example.co.uk', 'example.co.uk']);
    expect(parentDomains('Example.org.')).toEqual(['example.org']);
    expect(parentDomains('localhost')).toEqual(['localhost']);
    expect(parentDomains('github.io')).toEqual(['github.io']);
  });

  it('reads a host the way the evaluator does before any lookup, and never folds look-alikes (RS-09.4)', () => {
    expect(registrableDomain(' WWW.Example.CO.UK. ')).toBe('example.co.uk');
    expect(registrableDomain('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
    expect(unicodeHost('xn--e1afmkfd.xn--p1ai')).toBe('пример.рф');
    const cyrillic = normalizeHost('раураl.com')!;
    expect(cyrillic).toMatch(/^xn--/u);
    expect(cyrillic).not.toBe('paypal.com');
    expect(unicodeHost(cyrillic)).toBe('раураl.com');
    expect(registrableDomain('раураl.com')).toBe(cyrillic);
    expect(unicodeHost('paypal.com')).toBeNull();
    expect(unicodeHost('xn--zz!.com')).toBeNull();
  });

  it('is generated from the vendored copy at its pinned commit, and stays small', () => {
    const root = resolve(import.meta.dirname, '..');
    const version = readFileSync(resolve(root, 'third_party/public-suffix-list/VERSION'), 'utf8');
    expect(version).toContain(`commit: ${PUBLIC_SUFFIX_COMMIT}`);
    expect(statSync(resolve(root, 'src/generated/public-suffix-list.ts')).size).toBeLessThan(200 * 1024);
  });
});
