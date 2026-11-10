import type { SlideHandle } from "@aiden0z/pptx-renderer";
import { type ViewerStrings, format } from "../shared/protocol";
import type { Size } from "../shared/zoom";
import { describeError, h } from "./dom";

/** Width used when the frame has not been laid out yet (the sidebar is hidden). */
const FALLBACK_WIDTH = 140;
/** Time per animation frame spent drawing thumbnails; scrolling the sidebar stays smooth. */
const FRAME_BUDGET_MS = 10;
/** How long the sidebar's width has to stay the same before thumbnails are drawn again for it. */
const RESIZE_SETTLE_MS = 150;

/** What the sidebar needs from the presentation on show. A stage provides it. */
export interface ThumbnailSource {
  readonly slideCount: number;
  readonly slideSize: Size;
  isHidden(index: number): boolean;
  renderThumbnail(index: number, container: HTMLElement, width: number): SlideHandle | null;
}

interface Item {
  readonly row: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly frame: HTMLSpanElement;
  handle: SlideHandle | undefined;
  /** Width of the frame the thumbnail was drawn for. */
  width: number;
  /** Close enough to the visible part of the sidebar to be worth drawing. */
  near: boolean;
  /** Drawn from an earlier version of the file. */
  stale: boolean;
  queued: boolean;
}

/**
 * The sidebar of slide thumbnails. Each thumbnail is a complete small rendering of its slide, so
 * only those near the visible part of the sidebar exist, and they are drawn a few per frame.
 *
 * After a reload the old thumbnails stay in place until their replacements are drawn, which
 * keeps the sidebar from flashing empty. The sidebar is narrower in a narrow editor; thumbnails
 * drawn for another width are scaled to fit at once and drawn again when the width has settled.
 */
export class Thumbnails {
  readonly element: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly observer: IntersectionObserver;
  private readonly resizeObserver: ResizeObserver;
  private readonly items: Item[] = [];
  private readonly queue: number[] = [];
  private source: ThumbnailSource | undefined;
  private current = -1;
  private frame = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly strings: ViewerStrings,
    private readonly onSelect: (index: number) => void,
    private readonly onProblem: (message: string) => void,
  ) {
    this.list = h("ol", { class: "pv-thumb-list" });
    this.element = h("nav", { class: "pv-thumbs", attrs: { "aria-label": strings.thumbnails } }, this.list);
    this.observer = new IntersectionObserver((entries) => this.onIntersection(entries), {
      root: this.element,
      rootMargin: "100% 0px",
    });
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.element);
  }

  /** Shows the thumbnails of a presentation, reusing the rows of the one shown before. */
  update(source: ThumbnailSource): void {
    this.source = source;
    const { width, height } = source.slideSize;
    this.list.style.setProperty("--pv-thumb-aspect", width > 0 && height > 0 ? `${width} / ${height}` : "16 / 9");

    while (this.items.length > source.slideCount) this.removeLast();
    while (this.items.length < source.slideCount) this.append();

    this.items.forEach((item, index) => {
      const hidden = source.isHidden(index);
      const name = format(this.strings.slideLabel, index + 1);
      item.button.classList.toggle("pv-thumb-hidden", hidden);
      item.button.setAttribute("aria-label", hidden ? `${name} (${this.strings.hiddenSlide})` : name);
      item.button.title = hidden ? this.strings.hiddenSlide : "";
      if (item.handle) item.stale = true;
      if (item.near) this.enqueue(index);
    });
    this.setCurrent(Math.min(Math.max(this.current, 0), source.slideCount - 1));
  }

  /** Marks the slide being viewed and scrolls its thumbnail into the visible part of the sidebar. */
  setCurrent(index: number): void {
    const previous = this.items[this.current];
    if (previous && this.current !== index) {
      previous.button.removeAttribute("aria-current");
      previous.button.tabIndex = -1;
    }
    this.current = index;
    const item = this.items[index];
    if (!item) return;
    item.button.setAttribute("aria-current", "true");
    item.button.tabIndex = 0; // the only thumbnail in the tab order; the arrow keys move between them
    if (this.element.contains(document.activeElement) && document.activeElement !== item.button) {
      item.button.focus({ preventScroll: true });
    }
    this.reveal(item.row);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.resizeTimer);
    this.observer.disconnect();
    this.resizeObserver.disconnect();
    for (const item of this.items) item.handle?.dispose();
    this.items.length = 0;
    this.queue.length = 0;
    this.element.remove();
  }

  private append(): void {
    const index = this.items.length;
    const frame = h("span", { class: "pv-thumb-frame", attrs: { "aria-hidden": "true", inert: "" } });
    const button = h(
      "button",
      { class: "pv-thumb", attrs: { type: "button", tabindex: "-1", "data-index": String(index) } },
      h("span", { class: "pv-thumb-number", text: String(index + 1), attrs: { "aria-hidden": "true" } }),
      frame,
    );
    button.addEventListener("click", () => this.onSelect(index));
    const row = h("li", {}, button);
    this.list.append(row);
    this.items.push({ row, button, frame, handle: undefined, width: 0, near: false, stale: false, queued: false });
    this.observer.observe(button);
  }

  private removeLast(): void {
    const item = this.items.pop();
    if (!item) return;
    this.observer.unobserve(item.button);
    item.handle?.dispose();
    item.row.remove();
  }

  private onIntersection(entries: readonly IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.index);
      const item = this.items[index];
      if (!item || item.button !== entry.target) continue;
      item.near = entry.isIntersecting;
      if (item.near) {
        if (!item.handle || item.stale) this.enqueue(index);
      } else {
        item.handle?.dispose();
        item.handle = undefined;
        item.stale = false;
      }
    }
  }

  private onResize(): void {
    let outdated = false;
    for (const item of this.items) {
      if (!item.handle) continue;
      const width = item.frame.clientWidth;
      if (width === 0 || width === item.width) continue;
      item.frame.style.setProperty("--pv-thumb-fit", String(width / item.width));
      outdated = true;
    }
    if (!outdated) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.redrawResized(), RESIZE_SETTLE_MS);
  }

  private redrawResized(): void {
    this.items.forEach((item, index) => {
      if (!item.handle) return;
      const width = item.frame.clientWidth;
      if (width === 0 || width === item.width) return;
      item.stale = true;
      if (item.near) this.enqueue(index);
    });
  }

  private enqueue(index: number): void {
    const item = this.items[index];
    if (!item || item.queued) return;
    item.queued = true;
    this.queue.push(index);
    if (this.frame === 0) this.frame = requestAnimationFrame(() => this.drawQueued());
  }

  private drawQueued(): void {
    this.frame = 0;
    const started = performance.now();
    do {
      const index = this.queue.shift();
      if (index === undefined) return;
      const item = this.items[index];
      if (!item) continue;
      item.queued = false;
      if (item.near) this.draw(item, index);
    } while (performance.now() - started < FRAME_BUDGET_MS);
    if (this.queue.length > 0) this.frame = requestAnimationFrame(() => this.drawQueued());
  }

  private draw(item: Item, index: number): void {
    const previous = item.handle;
    const width = item.frame.clientWidth || FALLBACK_WIDTH;
    let next: SlideHandle | null = null;
    try {
      next = this.source?.renderThumbnail(index, item.frame, width) ?? null;
    } catch (error) {
      this.onProblem(`thumbnail of slide ${index + 1}: ${describeError(error)}`);
    }
    // The new rendering is in place before the old one goes, so the frame is never empty in between.
    previous?.dispose();
    item.frame.style.removeProperty("--pv-thumb-fit");
    item.handle = next ?? undefined;
    item.width = width;
    item.stale = false;
  }

  private reveal(row: HTMLElement): void {
    const view = this.element;
    if (view.clientHeight === 0) return;
    const margin = 8;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top - margin < view.scrollTop) view.scrollTop = top - margin;
    else if (bottom + margin > view.scrollTop + view.clientHeight) view.scrollTop = bottom + margin - view.clientHeight;
  }
}
