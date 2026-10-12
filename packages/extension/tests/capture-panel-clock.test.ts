import { expect, it } from 'vitest';
import { createPanelClock } from '../src/capture/panel-clock.js';
it('starts after presentation, pauses during interaction and preserves a response window', () => {
  let now = 0; const clock = createPanelClock(3000, () => now);
  now = 20000; expect(clock.ready()).toBe(false); clock.present();
  now += 2800; clock.pause('hover'); now += 10000; expect(clock.finish()).toBe(false);
  clock.resume('hover'); expect(clock.remaining()).toBe(1200);
  now += 1199; expect(clock.finish()).toBe(false); now++; expect(clock.finish()).toBe(true); expect(clock.finish()).toBe(false);
});
it('a negative click, blur or explicit close wins the timer race', () => {
  let now = 0; const clock = createPanelClock(3000, () => now); clock.present();
  now = 3000; clock.stop(); expect(clock.finish()).toBe(false);
});
it('keeps independent pause reasons and supports manual closing', () => {
  let now = 0; const clock = createPanelClock(3000, () => now); clock.present(); clock.pause('focus'); clock.pause('path');
  now = 10000; clock.resume('focus'); expect(clock.finish()).toBe(false); clock.resume('path');
  now += 3000; expect(clock.finish()).toBe(true);
  const manual = createPanelClock(0, () => now); manual.present(); now += 999999; expect(manual.finish()).toBe(false);
});
