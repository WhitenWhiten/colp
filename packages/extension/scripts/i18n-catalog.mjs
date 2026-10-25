#!/usr/bin/env node
/* The extension's copy catalog. English lives at the call site (t / tn in
   src/i18n.ts, data-i18n attributes in the HTML pages); this script extracts
   it into _locales/en/messages.json and checks every translation against it.

     node scripts/i18n-catalog.mjs          check (also run by tests/i18n-catalog.test.ts)
     node scripts/i18n-catalog.mjs --write  regenerate _locales/en/messages.json
     node scripts/i18n-catalog.mjs --todo   print the entries a translation is missing, as JSON
     node scripts/i18n-catalog.mjs --apply <locale> <file.json>
                                            merge {"key": "translation"} into that locale

   A translated entry keeps the English it was translated from in its
   "description"; when the English changes, the translation reads as stale. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from 'parse5';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TRANSLATIONS = ['zh_CN'];
const PAGES = ['popup.html', 'options.html', 'capture-tabs.html', 'site-adapters.html'];
const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt', 'data-tip'];
const KEY = /^[a-z][A-Za-z0-9_]*$/u;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const normalize = (text) => text.replace(/\s+/gu, ' ').trim();

/** Every key the code and pages use, with its English and where it is used. */
export function extract() {
  const messages = new Map(), errors = [];
  const add = (key, message, site) => {
    if (!KEY.test(key)) { errors.push(`${site}: invalid key "${key}"`); return; }
    const known = messages.get(key);
    if (known && known.message !== message) errors.push(`${site}: "${key}" is "${message}" here but "${known.message}" at ${known.sites[0]}`);
    else if (known) known.sites.push(site);
    else messages.set(key, { message, sites: [site] });
  };
  for (const path of sourceFiles(resolve(root, 'src'))) {
    const file = relative(root, path), source = ts.createSourceFile(file, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const names = new Map();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !/\/i18n\.js$/u.test(statement.moduleSpecifier.text)) continue;
      for (const element of statement.importClause?.namedBindings?.elements ?? []) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === 't' || imported === 'tn') names.set(element.name.text, imported);
      }
    }
    if (file === 'src/i18n.ts') names.set('t', 't');
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
        const site = `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const kind = names.get(node.expression.text), [first] = node.arguments;
        const key = literal(first);
        const english = kind === 't' ? [literal(node.arguments[1])] : [literal(node.arguments[2]), literal(node.arguments[3])];
        if (file === 'src/i18n.ts' && key === undefined) { /* the helpers' own forwarding calls */ }
        else if (key === undefined || english.some((text) => text === undefined)) errors.push(`${site}: ${kind}() needs a literal key and literal English`);
        else if (kind === 't') add(key, english[0], site);
        else { add(`${key}_one`, english[0], site); add(`${key}_other`, english[1], site); }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const page of PAGES) {
    const walk = (node) => {
      for (const attribute of node.attrs ?? []) {
        const site = `${page}:${node.sourceCodeLocation?.startLine}`;
        if (attribute.name === 'data-i18n') {
          if (node.childNodes.some((child) => child.nodeName !== '#text' && child.nodeName !== '#comment')) errors.push(`${site}: data-i18n on an element with child elements`);
          add(attribute.value, normalize(node.childNodes.filter((child) => child.nodeName === '#text').map((child) => child.value).join('')), site);
        } else if (attribute.name.startsWith('data-i18n-')) {
          const target = attribute.name.slice('data-i18n-'.length), value = node.attrs.find((item) => item.name === target)?.value;
          if (!ATTRIBUTES.includes(target) || value === undefined) errors.push(`${site}: ${attribute.name} has no ${target} to translate`);
          else add(attribute.value, normalize(value), site);
        }
      }
      for (const child of node.content?.childNodes ?? node.childNodes ?? []) walk(child);
    };
    walk(parse(readFileSync(resolve(root, page), 'utf8'), { sourceCodeLocationInfo: true }));
  }
  const lower = new Map();
  for (const key of messages.keys()) {
    const other = lower.get(key.toLowerCase());
    if (other) errors.push(`"${key}" and "${other}" differ only in case; Chrome treats keys case-insensitively`);
    lower.set(key.toLowerCase(), key);
  }
  return { messages, errors };
}

const read = (locale) => {
  const path = resolve(root, '_locales', locale, 'messages.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
};
const slots = (text) => [...new Set(text.match(/\$[1-9]/gu) ?? [])].sort().join(',');

/** en/messages.json as the code says it should be: the extracted copy plus the manifest's own entries. */
export function englishCatalog({ messages, errors }) {
  const current = read('en'), manifest = readFileSync(resolve(root, 'manifest.base.json'), 'utf8');
  const catalog = {};
  for (const [, key] of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/gu)) {
    if (current[key]) catalog[key] = current[key];
    else errors.push(`manifest.base.json uses __MSG_${key}__ but en/messages.json has no "${key}"`);
  }
  for (const key of [...messages.keys()].sort()) {
    if (catalog[key]) errors.push(`"${key}" is both a manifest entry and in the code`);
    else catalog[key] = { message: messages.get(key).message };
  }
  return catalog;
}

/** Entries a translation lacks or translated from English that has since changed. */
export function translationGaps(english, locale) {
  const translated = read(locale), gaps = {}, errors = [];
  for (const [key, entry] of Object.entries(english)) {
    const target = translated[key];
    // Languages without a singular (zh) never select `_one`, so it may stay English.
    if (!target && key.endsWith('_one') && translated[`${key.slice(0, -4)}_other`]) continue;
    if (!target) gaps[key] = { english: entry.message };
    else if (target.description !== entry.message) gaps[key] = { english: entry.message, previousEnglish: target.description, current: target.message };
    else if (slots(target.message) !== slots(entry.message)) errors.push(`${locale}: "${key}" uses ${slots(target.message) || 'no'} substitutions; English uses ${slots(entry.message) || 'none'}`);
  }
  for (const key of Object.keys(translated)) if (!english[key]) errors.push(`${locale}: "${key}" is not in the English catalog`);
  return { gaps, errors };
}

export function check() {
  const extracted = extract(), english = englishCatalog(extracted), errors = [...extracted.errors];
  if (JSON.stringify(read('en')) !== JSON.stringify(english)) errors.push('_locales/en/messages.json is out of date; run node scripts/i18n-catalog.mjs --write');
  // Chrome reads "$word$" as a named placeholder; an undefined one ("$1$2") stops the extension from loading.
  for (const locale of ['en', ...TRANSLATIONS]) {
    for (const [key, entry] of Object.entries(read(locale))) {
      if (/\$[A-Za-z0-9_@]+\$/u.test(entry.message.replace(/\$\$/gu, ''))) errors.push(`${locale}: "${key}" contains "$…$", which Chrome reads as an undefined placeholder; separate the substitutions`);
    }
  }
  for (const locale of TRANSLATIONS) {
    const result = translationGaps(english, locale);
    errors.push(...result.errors);
    const missing = Object.keys(result.gaps);
    if (missing.length) errors.push(`${locale}: ${missing.length} entries missing or stale (run --todo): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--write') {
    const extracted = extract(), english = englishCatalog(extracted);
    if (extracted.errors.length) { for (const error of extracted.errors) console.error(`i18n: ${error}`); process.exit(1); }
    writeFileSync(resolve(root, '_locales/en/messages.json'), `${JSON.stringify(english, null, 2)}\n`);
    console.log(`i18n: wrote ${Object.keys(english).length} English entries`);
  } else if (mode === '--apply') {
    const [locale, file] = process.argv.slice(3);
    if (!TRANSLATIONS.includes(locale) || !file) { console.error('i18n: --apply <locale> <file.json>'); process.exit(1); }
    const english = englishCatalog(extract()), translated = read(locale), incoming = JSON.parse(readFileSync(resolve(file), 'utf8'));
    for (const [key, message] of Object.entries(incoming)) {
      if (!english[key]) { console.error(`i18n: "${key}" is not in the English catalog`); process.exit(1); }
      translated[key] = { message, description: english[key].message };
    }
    const sorted = Object.fromEntries(Object.keys(english).filter((key) => translated[key]).map((key) => [key, translated[key]]));
    mkdirSync(resolve(root, '_locales', locale), { recursive: true });
    writeFileSync(resolve(root, '_locales', locale, 'messages.json'), `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`i18n: ${locale} has ${Object.keys(sorted).length} of ${Object.keys(english).length} entries`);
  } else if (mode === '--todo') {
    const extracted = extract(), english = englishCatalog(extracted), todo = {};
    for (const locale of TRANSLATIONS) {
      const { gaps } = translationGaps(english, locale);
      for (const [key, gap] of Object.entries(gaps)) gap.sites = extracted.messages.get(key)?.sites ?? ['manifest.base.json'];
      todo[locale] = gaps;
    }
    console.log(JSON.stringify(todo, null, 2));
  } else {
    const errors = check();
    for (const error of errors) console.error(`i18n: ${error}`);
    if (errors.length) process.exit(1);
    console.log('i18n: catalog and translations are current');
  }
}
