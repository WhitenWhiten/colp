import { TextByteBudget } from '../shared/text-budget.js';
import type { AtomFeedDocument, AtomLink } from './atom.js';

export const MAX_ATOM_XML_BYTES = 8 * 1024 * 1024;

/** Account for every repeated field and XML escape BEFORE expansion/join. */
export function serializeBoundedAtom(document: AtomFeedDocument, maxBytes = MAX_ATOM_XML_BYTES): string {
  const budget = new TextByteBudget(maxBytes, 'Atom XML');
  const chunks: string[] = [];
  const literal = (text: string): void => { budget.raw(text); chunks.push(text); };
  const escaped = (text: string): void => {
    budget.xmlText(text);
    chunks.push(text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'));
  };
  const element = (name: string, value: string, indent: number): void => {
    literal(`${' '.repeat(indent)}<${name}>`);
    escaped(value);
    literal(`</${name}>\n`);
  };
  const link = (value: AtomLink, indent: number): void => {
    literal(`${' '.repeat(indent)}<link rel="`); escaped(value.rel);
    literal('" href="'); escaped(value.href);
    if (value.type !== undefined) { literal('" type="'); escaped(value.type); }
    literal('"/>\n');
  };
  literal('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n');
  element('id', document.id, 2);
  element('title', document.title, 2);
  element('updated', document.updated, 2);
  for (const value of document.links) link(value, 2);
  for (const entry of document.entries) {
    literal('  <entry>\n');
    element('id', entry.id, 4);
    element('title', entry.title, 4);
    element('updated', entry.updated, 4);
    for (const value of entry.links) link(value, 4);
    if (entry.summary !== undefined) element('summary', entry.summary, 4);
    literal('  </entry>\n');
  }
  literal('</feed>');
  return chunks.join('');
}
