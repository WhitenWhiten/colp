/** Allocation-free accounting before JSON canonicalization or XML escaping.
 * Browser-safe: no Buffer, TextEncoder, or Node builtins. Counts UTF-8 bytes,
 * including repeated references at every occurrence in the serialized value.
 */
export class TextByteBudget {
  private used = 0;

  constructor(readonly limit: number, readonly label: string) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`${label} byte budget must be a positive safe integer.`);
    }
  }

  get remaining(): number { return this.limit - this.used; }
  get bytes(): number { return this.used; }

  charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remaining) {
      throw new RangeError(`${this.label} exceeds the maximum byte budget.`);
    }
    this.used += bytes;
  }

  raw(text: string): void { this.text(text, 'raw'); }
  jsonString(text: string): void { this.text(text, 'json'); }
  xmlText(text: string): void { this.text(text, 'xml'); }

  private text(text: string, mode: 'raw' | 'json' | 'xml'): void {
    // UTF-16 code units are a lower bound on all three encodings. This check
    // rejects an oversized string before scanning it or allocating its encoding.
    const quotes = mode === 'json' ? 2 : 0;
    if (text.length > this.remaining - quotes) this.charge(this.remaining + 1);
    this.charge(quotes);
    // Native scanning avoids a method call per byte for large ordinary JSON
    // strings while retaining allocation-free accounting and exact escapes.
    if (mode === 'json' && !/[\x00-\x1f"\\\x80-\uffff]/.test(text)) {
      this.charge(text.length);
      return;
    }
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (mode === 'json') {
        if (code === 34 || code === 92 || code === 8 || code === 9
          || code === 10 || code === 12 || code === 13) {
          this.charge(2); continue;
        }
        if (code < 32) { this.charge(6); continue; }
      }
      if (mode === 'xml') {
        if (code === 38) { this.charge(5); continue; }
        if (code === 60 || code === 62) { this.charge(4); continue; }
        if (code === 34 || code === 39) { this.charge(6); continue; }
      }
      if (code >= 0xd800 && code <= 0xdbff
        && text.charCodeAt(index + 1) >= 0xdc00
        && text.charCodeAt(index + 1) <= 0xdfff) {
        this.charge(4); index += 1;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        this.charge(mode === 'json' ? 6 : 3);
      } else {
        this.charge(code < 128 ? 1 : code < 2048 ? 2 : 3);
      }
    }
  }
}
