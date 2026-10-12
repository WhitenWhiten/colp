import { ICON_STROKE_WIDTH, ICON_VIEW_BOX, SHARED_ICON_PATHS, isFilledIcon,
  type IconName } from '../design/icon-paths.js';

export type { IconName };

function paintIcon(svg: SVGSVGElement, name: IconName): void {
  for (const [key, value] of Object.entries({ viewBox: ICON_VIEW_BOX, fill: 'none', stroke: 'currentColor',
    'stroke-width': String(ICON_STROKE_WIDTH), 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false', 'data-icon': name })) svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', SHARED_ICON_PATHS[name]);
  if (isFilledIcon(name)) {
    path.setAttribute('fill', 'currentColor'); path.setAttribute('stroke', 'none'); path.setAttribute('data-fill', '');
  }
  svg.replaceChildren(path);
}

/** Same geometry and accessibility as the web Icon, without a React dependency. */
export function createIcon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
  paintIcon(svg, name);
  return svg;
}

/** Keep placeholder IDs, sizing and visibility: popup consumers retain these nodes. */
export function hydrateIcons(root: ParentNode): void {
  for (const svg of Array.from(root.querySelectorAll<SVGSVGElement>('svg[data-icon]'))) {
    const name = svg.dataset.icon;
    if (name && Object.hasOwn(SHARED_ICON_PATHS, name)) paintIcon(svg, name as IconName);
  }
}
