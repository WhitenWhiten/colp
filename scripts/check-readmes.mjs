/**
 * Keeps the READMEs honest.
 *
 * A translated README keeps its original's commands (```text diagrams aside), links
 * and sections, links to every other language, and shows a screenshot or diagram in
 * its own language wherever one exists. Every local link and image in a README resolves, and every
 * pinned install command names the version the package carries now.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** An original README and its translations, keyed by language. */
export const TRANSLATED = Object.freeze([
  { en: 'README.md', 'zh-CN': 'README.zh-CN.md', ja: 'README.ja.md' },
  { en: 'protocol/README.md', 'zh-CN': 'protocol/README.zh-CN.md', ja: 'protocol/README.ja.md' },
]);
export const UNTRANSLATED = Object.freeze(['packages/node/README.md', 'packages/conformance/README.md', 'packages/server/README.md',
  'packages/web/README.md', 'packages/extension/README.md', 'deploy/INSTALL.md']);
export const PINNED = Object.freeze({ '@know-n/colp': 'packages/node/package.json', '@know-n/colp-conformance': 'packages/conformance/package.json' });

const LANGUAGES = ['en', 'zh-CN', 'ja'];
const FENCE = /^```[^\n]*\n[\s\S]*?^```/gmu;
const TARGET = /(?:\]\(|(?:href|src|srcset)=")([^)"\s]+)/gu;
const PIN = /(@know-n\/colp(?:-conformance)?)@(\d+\.\d+\.\d+[\w.-]*)/gu;
/** Other spellings of the reference package's version: a packed tarball, and the package README's version note. */
const NODE_VERSION = /know-n-colp-(\d+\.\d+\.\d+[\w.-]*?)\.tgz|\*\*Package version:\*\* `([^`]+)`/gu;
const LANGUAGE_SUFFIX = /\.(?:en|zh-CN|ja)(?=\.)/u;

const prose = (text) => text.replace(FENCE, '');
/** Code a reader runs or copies. A ```text block is a diagram or sample output, and its labels may be translated. */
const commands = (text) => (text.match(FENCE) ?? []).filter((block) => !/^```text\n/u.test(block));
const targets = (text) => [...prose(text).matchAll(TARGET)].map((match) => match[1]);
const local = (target) => !/^(?:[a-z][a-z+.-]*:|#|\/\/)/iu.test(target);
const path = (target) => target.replace(/[?#].*$/u, '');
const resolveFrom = (readme, target) => posix.normalize(posix.join(posix.dirname(readme), decodeURI(path(target))));
const isImage = (target) => /\.(?:png|gif|svg|webp|jpe?g)$/iu.test(path(target));

/** A localized asset name: `x.svg` → `x.ja.svg`, `x.dark.svg` → `x.ja.dark.svg`, `x.en.png` → `x.ja.png`. */
function localized(target, language) {
  const plain = path(target).replace(LANGUAGE_SUFFIX, '');
  return plain.replace(/(\.dark)?(\.[a-z]+)$/iu, `.${language}$1$2`);
}

/** Link targets a translation must share with its original: other languages' READMEs aside, images by their unlocalized name. */
function sharedTargets(text, readmes) {
  return [...new Set(targets(text).map(path).filter((target) => target && !readmes.has(posix.basename(target)))
    .map((target) => (isImage(target) ? target.replace(LANGUAGE_SUFFIX, '') : target)))].sort();
}

/** `read(path)` returns a repository file's text, `exists(path)` checks a repository-relative path. */
export function checkReadmes({ read, exists }) {
  const errors = [];
  const versions = Object.fromEntries(Object.entries(PINNED).map(([name, manifest]) => [name, JSON.parse(read(manifest)).version]));
  const check = (readme, language) => {
    const text = read(readme);
    for (const target of targets(text).filter(local)) {
      const file = resolveFrom(readme, target);
      if (file && !exists(file)) errors.push(`${readme}: ${target} does not exist`);
      if (!isImage(target) || !language) continue;
      // English is every language's fallback; any other language's image is a mistake.
      const shown = path(target).match(LANGUAGE_SUFFIX)?.[0].slice(1);
      if (shown && shown !== language && shown !== 'en') errors.push(`${readme}: ${target} is another language's image`);
      const own = localized(target, language);
      if (language !== 'en' && path(target) !== own && exists(resolveFrom(readme, own))) errors.push(`${readme}: shows ${target}, but ${own} exists`);
    }
    for (const [, name, version] of text.matchAll(PIN)) {
      if (version !== versions[name]) errors.push(`${readme}: pins ${name}@${version}, but the package is ${versions[name]}`);
    }
    for (const [match, tarball, note] of text.matchAll(NODE_VERSION)) {
      if ((tarball ?? note) !== versions['@know-n/colp']) errors.push(`${readme}: ${match} names ${tarball ?? note}, but @know-n/colp is ${versions['@know-n/colp']}`);
    }
    return text;
  };
  for (const group of TRANSLATED) {
    const files = new Set(Object.values(group).map((file) => posix.basename(file)));
    const original = check(group.en, 'en');
    for (const language of LANGUAGES) {
      const readme = group[language];
      if (!exists(readme)) { errors.push(`${readme} is missing`); continue; }
      const text = language === 'en' ? original : check(readme, language);
      for (const other of LANGUAGES.filter((code) => code !== language)) {
        const name = posix.basename(group[other]);
        if (!targets(text).some((target) => posix.basename(path(target)) === name)) errors.push(`${readme}: does not link to ${name}`);
      }
      if (language === 'en') continue;
      if (JSON.stringify(commands(text)) !== JSON.stringify(commands(original))) errors.push(`${readme}: commands differ from ${group.en}`);
      const sections = (value) => (value.replace(FENCE, '').match(/^#{1,6} /gmu) ?? []).join('');
      if (sections(text) !== sections(original)) errors.push(`${readme}: sections differ from ${group.en}`);
      const ours = sharedTargets(text, files), theirs = sharedTargets(original, files);
      for (const target of theirs.filter((value) => !ours.includes(value))) errors.push(`${readme}: missing link ${target} from ${group.en}`);
      for (const target of ours.filter((value) => !theirs.includes(value))) errors.push(`${readme}: links ${target}, which ${group.en} does not`);
    }
  }
  for (const readme of UNTRANSLATED) if (exists(readme)) check(readme);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkReadmes({ read: (file) => readFileSync(join(repository, file), 'utf8'), exists: (file) => existsSync(join(repository, file)) });
  for (const error of errors) process.stderr.write(`readmes: ${error}\n`);
  if (errors.length > 0) process.exitCode = 1;
  else process.stdout.write(`readmes: ${TRANSLATED.length * LANGUAGES.length + UNTRANSLATED.length} files agree\n`);
}
