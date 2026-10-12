/**
 * Settings booleans are `.toggle` buttons with `role="switch"` (chrome.css);
 * their state lives in `aria-checked`, so the same attribute drives the look,
 * the screen-reader announcement and the saved value.
 */
export function switchOn(control: Pick<Element, 'getAttribute'> | null | undefined): boolean {
  return control?.getAttribute('aria-checked') === 'true';
}

export function setSwitch(control: Pick<Element, 'setAttribute'> | null | undefined, on: boolean): void {
  control?.setAttribute('aria-checked', String(on));
}

/** Flips the switch on click (unless disabled) and reports the new value. */
export function onSwitch(control: (Pick<Element, 'getAttribute' | 'setAttribute' | 'addEventListener'> & { disabled?: boolean }) | null | undefined,
  handler: (on: boolean) => void): void {
  control?.addEventListener('click', () => {
    if (control.disabled) return;
    const on = !switchOn(control);
    setSwitch(control, on);
    handler(on);
  });
}
