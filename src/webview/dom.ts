/** Minimal DOM helpers for the viewer UI. */

type Child = Node | string | null | undefined | false;

interface Props {
  readonly class?: string;
  readonly title?: string;
  readonly text?: string;
  readonly hidden?: boolean;
  /** Attributes set verbatim, such as `role` or `aria-label`. */
  readonly attrs?: Readonly<Record<string, string>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.title) element.title = props.title;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.hidden) element.hidden = true;
  for (const [name, value] of Object.entries(props.attrs ?? {})) element.setAttribute(name, value);
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) element.append(child);
  }
  return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Outline icons on a 16×16 grid; each entry is the `d` of one or more stroked paths. */
const ICONS = {
  sidebar: ["M2.5 3.5h11v9h-11z", "M6 3.5v9"],
  chevronUp: ["M4 10l4-4 4 4"],
  chevronDown: ["M4 6l4 4 4-4"],
  minus: ["M4 8h8"],
  plus: ["M4 8h8", "M8 4v8"],
  search: ["M10.2 10.2L13.5 13.5", "M7 3a4 4 0 1 1 0 8a4 4 0 0 1 0-8z"],
  notes: ["M3.5 2.5h9v11h-9z", "M5.5 5.5h5", "M5.5 8h5", "M5.5 10.5h3"],
  close: ["M4.5 4.5l7 7", "M11.5 4.5l-7 7"],
  warning: ["M8 2.5l6 10.5h-12z", "M8 6.5v3", "M8 11.4v.2"],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("pv-icon");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export interface ButtonOptions {
  readonly label: string;
  readonly icon?: IconName;
  readonly text?: string;
  readonly class?: string;
  readonly onClick: () => void;
}

/** A toolbar button. The label is both its tooltip and its accessible name. */
export function button(options: ButtonOptions): HTMLButtonElement {
  const element = h(
    "button",
    {
      class: `pv-button${options.class ? ` ${options.class}` : ""}`,
      title: options.label,
      attrs: { type: "button", "aria-label": options.label },
    },
    options.icon ? icon(options.icon) : null,
    options.text ? h("span", { text: options.text }) : null,
  );
  element.addEventListener("click", options.onClick);
  return element;
}

export function setPressed(element: HTMLElement, pressed: boolean): void {
  element.setAttribute("aria-pressed", String(pressed));
}

/** Resolves after the browser has had `frames` chances to lay out and paint, or after `timeoutMs`. */
export function settle(frames = 2, timeoutMs = 300): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // Animation frames stop while the tab is hidden; the timer keeps a reload from stalling.
    const timer = setTimeout(finish, timeoutMs);
    const step = (remaining: number): void => {
      if (remaining <= 0) finish();
      else requestAnimationFrame(() => step(remaining - 1));
    };
    step(frames);
  });
}

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
