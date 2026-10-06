/**
 * Check Reflect.ownKeys(array) in linear time without reading array elements.
 * Callers still validate the prototype and every property's data descriptor.
 * Array index keys precede `length`; extra string/symbol keys and holes fail.
 */
export function hasDenseArrayOwnKeys(keys: readonly PropertyKey[], length: number): boolean {
  if (keys.length !== length + 1 || keys[length] !== 'length') return false;
  for (let index = 0; index < length; index += 1) {
    if (keys[index] !== String(index)) return false;
  }
  return true;
}
