import { readFile } from 'node:fs/promises';

/**
 * Copy assertions read source as it read before i18n: a plain t('key', 'English')
 * becomes 'English' and data-i18n attributes drop out of the HTML.
 */
export function englishSource(source: string): string {
  return source
    .replace(/\bt\('[A-Za-z0-9_]+', ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\)/gu, (_, english: string) => english)
    .replace(/ data-i18n(?:-[a-z-]+)?="[A-Za-z0-9_]+"/gu, '');
}

export async function readEnglishSource(url: URL | string): Promise<string> {
  return englishSource(await readFile(url, 'utf8'));
}
