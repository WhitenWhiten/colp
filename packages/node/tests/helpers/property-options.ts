/**
 * Fast-check options for discovery runs.
 *
 * The default intentionally leaves `seed` unset so routine runs explore new
 * cases. Fast-check reports the seed and shrink path on failure. Set
 * `COLP_PROPERTY_SEED` to that signed 32-bit integer to reproduce a run.
 */
export function propertyOptions(numRuns: number): Readonly<{
  numRuns: number;
  seed?: number;
}> {
  const rawSeed = process.env.COLP_PROPERTY_SEED;
  if (rawSeed === undefined) return Object.freeze({ numRuns });
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(rawSeed)) {
    throw new TypeError('COLP_PROPERTY_SEED must be a canonical signed integer.');
  }
  const seed = Number(rawSeed);
  if (!Number.isInteger(seed) || seed < -2_147_483_648 || seed > 2_147_483_647) {
    throw new RangeError('COLP_PROPERTY_SEED must fit in a signed 32-bit integer.');
  }
  return Object.freeze({ numRuns, seed });
}
