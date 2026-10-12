/** Open a destination's disclosure ancestors before announcing and scrolling to it. */
export function revealPageSection(id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    if (element.tagName === 'DETAILS') (element as HTMLDetailsElement).open = true;
  }
  requestAnimationFrame(() => { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); });
}
