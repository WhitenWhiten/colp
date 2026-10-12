/**
 * Toolbar filters read "Label: value" (the web select-menu pill). The pill
 * wraps a real <select>; this keeps the visible value in step with it.
 */
export function paintSelectPills(root: ParentNode = document): void {
  for (const pill of Array.from(root.querySelectorAll<HTMLElement>('.select-pill'))) {
    const select = pill.querySelector('select'), value = pill.querySelector('[data-pill-value]');
    if (select && value) value.textContent = select.options[select.selectedIndex]?.textContent ?? '';
  }
}

export function bindSelectPills(root: ParentNode = document): void {
  for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>('.select-pill select'))) {
    select.addEventListener('change', () => { paintSelectPills(select.closest('.select-pill')!.parentElement ?? root); });
  }
  paintSelectPills(root);
}
