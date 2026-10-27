import { expect, test } from 'vitest';
import { createSettingsRequestOrder } from '../src/site-adapters/settings-request-order.js';

test('an action invalidates earlier reads and excludes polling replies until it finishes', () => {
  const order = createSettingsRequestOrder(), before = order.read(), action = order.action('configure')!;
  expect(before()).toBe(false); expect(order.pending).toBe('configure');
  expect(order.action('approve')).toBeNull();
  const during = order.read(); expect(during()).toBe(false);
  action.finish(); expect(during()).toBe(false); expect(before()).toBe(false);
  expect(order.pending).toBeNull(); expect(order.read()()).toBe(true);
});
test('only the latest read may replace visible state, while action replies are independent of intervening polls', () => {
  const order = createSettingsRequestOrder(), first = order.read(), latest = order.read();
  expect(first()).toBe(false); expect(latest()).toBe(true);
  const action = order.action('configure')!; order.read();
  expect(action.current()).toBe(true); action.finish();
  order.action('prepare'); expect(action.current()).toBe(false);
});
