import {
  PptxViewer,
  type SlideHandle,
  type TextIndexEntry,
  type TextSearchResult,
  buildTextIndex,
} from "@aiden0z/pptx-renderer";
import { registerPreprocessor, use } from "echarts/core";
import { LegacyGridContainLabel } from "echarts/features";
import { MAX_FIND_RESULTS, findMatches } from "../shared/find";
import { type ZoomMode, format } from "../shared/protocol";
import {
  type ListLayout,
  type Size,
  alignedScrollTop,
  clampZoom,
  currentSlide,
  rescaleOffset,
  resolveScale,
  slideAt,
  slideFits,
  slideTop,
  stepZoom,
  wheelZoomFactor,
} from "../shared/zoom";
import type { Deck } from "./deck";
import { clamp, describeError, h, settle } from "./dom";
import { TextHighlighter } from "./highlight";

// The renderer draws charts with ECharts, and this module shares its instance of the library.
// The renderer asks for axis labels to be kept inside the plot area in a way that ECharts 6 only
// honours once this feature is installed; without it the labels of some charts are cut off.
use([LegacyGridContainLabel]);

// A chart is drawn again each time its slide scrolls back into view and each time the file
// reloads. Without this it would replay its entrance animation every time.
registerPreprocessor((option) => {
  option.animation = false;
});

/** Spacing of the slide list in CSS pixels. The style sheet receives the same values as custom properties. */
const PADDING = { x: 16, y: 24 } as const;
const GAP = 28;
/** Slides farther from the view than this many viewport heights are removed from the document. */
const OVERSCAN_VIEWPORTS = 1.5;
/** Large enough that the renderer lays out every placeholder at once instead of waiting on animation frames. */
const PLACEHOLDER_BATCH = 1_000_000;
const LINE_SCROLL = 60;
const MAX_PROBLEMS = 200;

/**
 * The box the renderer draws around the shape of the current search match, for the cases where
 * the matching text itself cannot be marked. Its border keeps the same width on screen at any zoom.
 */
const MATCH_BOX = {
  className: "pv-match-box",
  padding: 4,
  borderRadius: 4,
  borderColor: "rgba(245, 130, 0, 0.95)",
  backgroundColor: "rgba(255, 170, 0, 0.1)",
  boxShadow: "none",
  style: { "border-width": "calc(2px / var(--pv-scale, 1))" },
  scrollIntoView: false,
} as const;

/** Whether two pieces of text read the same, however their white space is written. */
const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, " ") === b.replace(/\s+/g, " ");

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where a stage is scrolled to, in terms that survive the file being reloaded. */
export interface StagePosition {
  readonly index: number;
  /** Distance of the view's top edge below the top of slide `index`, in CSS pixels. */
  readonly offset: number;
  /** Height of a slide when the position was taken, which `offset` is relative to. */
  readonly slideHeight: number;
  readonly left: number;
  readonly pinned: boolean;
}

export interface StageLabels {
  /** Accessible name of a slide; `{0}` is its number. */
  readonly slide: string;
  readonly hidden: string;
}

export interface StageHooks {
  /** The slide counted as current changed. */
  readonly onSlideChange: (index: number) => void;
  /** The zoom mode or the effective zoom changed. */
  readonly onZoomChange: () => void;
  /** Part of the file could not be drawn. Called once per distinct problem, with how many there are so far. */
  readonly onProblem: (message: string, count: number) => void;
}

/**
 * The scrolling list of slides for one version of the file. A reload builds a new stage next to
 * the old one and swaps them, so the viewer never shows a half-drawn presentation.
 *
 * The renderer draws every slide at its natural size; the stage scales them with CSS custom
 * properties (see `.pv-list` in the style sheet), which makes zooming a style change rather than
 * a redraw.
 */
export class Stage {
  /** The scroll container. */
  readonly element: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly viewer: PptxViewer;
  private readonly resizeObserver: ResizeObserver;
  private readonly highlighter = new TextHighlighter();
  private readonly problems = new Set<string>();
  private mode: ZoomMode;
  private scale = 1;
  private index = 0;
  /**
   * After a jump the target stays the current slide until the user scrolls, even where the list
   * cannot scroll far enough to align it, and zooming or resizing keeps presenting that slide.
   */
  private pin: { readonly index: number; readonly top: number } | undefined;
  private renderedHeight = 0;
  private wheel: { factor: number; origin: Point | undefined; frame: number } = { factor: 1, origin: undefined, frame: 0 };
  /** The text of every shape and table cell, built when the first search needs it. */
  private textIndex: readonly TextIndexEntry[] | undefined;
  private results: readonly TextSearchResult[] = [];
  private match: TextSearchResult | undefined;
  private matchToken = 0;
  private disposed = false;

  constructor(
    private readonly deck: Deck,
    zoom: ZoomMode,
    private readonly labels: StageLabels,
    private readonly hooks: StageHooks,
  ) {
    this.mode = typeof zoom === "number" ? clampZoom(zoom) : zoom;
    this.list = h("div", { class: "pv-list" });
    this.list.style.setProperty("--pv-pad-x", `${PADDING.x}px`);
    this.list.style.setProperty("--pv-pad-y", `${PADDING.y}px`);
    this.list.style.setProperty("--pv-gap", `${GAP}px`);
    this.element = h("div", { class: "pv-scroller", attrs: { tabindex: "0" } }, this.list);

    this.viewer = new PptxViewer(this.list, {
      fitMode: "none",
      scrollContainer: this.element,
      // Nothing is fetched from the network; the content security policy forbids it as well.
      externalMedia: "block",
      pdfjs: false,
      onSlideRendered: (index, element) => this.onSlideRendered(index, element),
      onSlideUnmounted: (index) => this.highlighter.clear(index),
      onSlideError: (index, error) => this.problem(`slide ${index + 1}: ${describeError(error)}`),
      onNodeError: (nodeId, error) => this.problem(`element ${nodeId}: ${describeError(error)}`),
    });
    // A link to another slide goes through the renderer's own navigation, which glides until the
    // slide is centred. It lands like every other jump instead.
    this.viewer.goToSlide = (index) => {
      this.goTo(index);
      return Promise.resolve();
    };

    this.element.addEventListener("scroll", () => this.updateCurrent(), { passive: true });
    this.element.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.resizeObserver = new ResizeObserver(() => this.onResize());
  }

  /** Draws the list. The stage must already be in the document, where it has a size to fit to. */
  async render(): Promise<void> {
    this.applyScale(this.fittedScale());
    this.viewer.load(this.deck.presentation);
    await this.renderList();
    if (!this.disposed) this.resizeObserver.observe(this.element);
  }

  /** Resolves once the slides in view have been laid out and their images decoded, or after a short wait. */
  async settled(): Promise<void> {
    await settle(2);
    const loading = [...this.list.querySelectorAll("img")].filter((image) => !image.complete);
    if (loading.length === 0) return;
    await Promise.race([
      Promise.all(loading.map((image) => image.decode().catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 800)),
    ]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.wheel.frame);
    this.resizeObserver.disconnect();
    this.highlighter.dispose();
    this.viewer.destroy();
    this.element.remove();
  }

  // --- What is shown -------------------------------------------------------------------------

  get slideCount(): number {
    return this.deck.presentation.slides.length;
  }

  get slideSize(): Size {
    return { width: this.deck.presentation.width, height: this.deck.presentation.height };
  }

  /** Index of the slide being viewed. */
  get current(): number {
    return this.index;
  }

  get problemCount(): number {
    return this.problems.size;
  }

  isHidden(index: number): boolean {
    return this.deck.hidden[index] === true;
  }

  /** Draws a small copy of a slide into `container`. The caller disposes of the returned handle. */
  renderThumbnail(index: number, container: HTMLElement, width: number): SlideHandle | null {
    return this.disposed ? null : this.viewer.renderThumbnailToContainer(index, container, { width });
  }

  focus(): void {
    this.element.focus({ preventScroll: true });
  }

  // --- Zoom ----------------------------------------------------------------------------------

  get zoomMode(): ZoomMode {
    return this.mode;
  }

  /** The zoom actually in effect, as a percentage of the slide's natural size. */
  get zoomPercent(): number {
    return this.scale * 100;
  }

  /** Changes the zoom, keeping the point of the slide under `origin` (by default the centre of the view) in place. */
  setZoom(mode: ZoomMode, origin?: Point): void {
    this.mode = typeof mode === "number" ? clampZoom(mode) : mode;
    if (this.mode === "fit") {
      // "Fit" means seeing a whole slide, so the current one is brought fully into view.
      const index = this.index;
      this.applyScale(this.fittedScale());
      this.align(index);
    } else {
      this.rescale(origin);
    }
    this.hooks.onZoomChange();
  }

  zoomStep(direction: 1 | -1): void {
    this.setZoom(stepZoom(this.zoomPercent, direction));
  }

  // --- Navigation ----------------------------------------------------------------------------

  /** Shows a slide: centred when it fits in the view, otherwise from its top edge. */
  goTo(index: number): void {
    if (this.slideCount === 0 || !Number.isFinite(index)) return;
    this.align(clamp(Math.trunc(index), 0, this.slideCount - 1));
  }

  next(): void {
    this.goTo(this.index + 1);
  }

  previous(): void {
    this.goTo(this.index - 1);
  }

  /** Whether a whole slide is visible at once, in which case the arrow and paging keys move by slide. */
  get showsWholeSlide(): boolean {
    return slideFits(this.layout, this.element.clientHeight);
  }

  get scrollsSideways(): boolean {
    return this.element.scrollWidth > this.element.clientWidth + 1;
  }

  scrollLines(dx: number, dy: number): void {
    this.element.scrollBy({ left: dx * LINE_SCROLL, top: dy * LINE_SCROLL, behavior: "auto" });
  }

  scrollPages(pages: number): void {
    this.element.scrollBy({ top: pages * Math.max(LINE_SCROLL, this.element.clientHeight - LINE_SCROLL), behavior: "auto" });
  }

  capture(): StagePosition {
    const layout = this.layout;
    return {
      index: this.index,
      offset: this.element.scrollTop - slideTop(layout, this.index),
      slideHeight: layout.slideHeight,
      left: this.element.scrollLeft,
      pinned: this.pin !== undefined,
    };
  }

  /** Scrolls to where another stage was, so that a reload leaves the view where the user had it. */
  restore(position: StagePosition): void {
    if (this.slideCount === 0) return;
    if (position.index >= this.slideCount) {
      this.goTo(this.slideCount - 1); // the slide being viewed was removed
      return;
    }
    const index = Math.max(0, position.index);
    const layout = this.layout;
    if (position.pinned && slideFits(layout, this.element.clientHeight)) {
      this.align(index); // a whole slide that was jumped to is presented the way the jump did
    } else {
      this.mount(index);
      const offset = rescaleOffset(position.offset, position.slideHeight, layout.slideHeight);
      this.element.scrollTop = Math.max(0, slideTop(layout, index) + offset);
      this.pin = position.pinned ? { index, top: this.element.scrollTop } : undefined;
    }
    this.element.scrollLeft = position.left;
    this.updateCurrent();
  }

  // --- Search --------------------------------------------------------------------------------

  /**
   * Every occurrence of `pattern` in the text of the slides, in reading order, up to
   * MAX_FIND_RESULTS of them. The renderer supplies the text; the matching is done here, because
   * the renderer's own search never returns from an expression that can match nothing when the
   * text has characters outside the Basic Multilingual Plane, such as emoji.
   */
  search(pattern: RegExp): readonly TextSearchResult[] {
    const results: TextSearchResult[] = [];
    if (!this.disposed) {
      this.textIndex ??= buildTextIndex(this.deck.presentation);
      for (const entry of this.textIndex) {
        if (results.length >= MAX_FIND_RESULTS) break;
        for (const { start, end } of findMatches(pattern, entry.text, MAX_FIND_RESULTS - results.length)) {
          results.push({ ...entry, matchStart: start, matchEnd: end, snippet: "" });
        }
      }
    }
    this.results = results;
    return results;
  }

  /** Highlights every occurrence of `pattern` in the slides on screen, or removes the highlights. */
  setSearchPattern(pattern: RegExp | undefined): void {
    this.highlighter.setPattern(pattern);
    if (!pattern) return;
    for (const index of this.viewer.getMountedSlides()) {
      const slide = this.slideElement(index);
      if (slide) this.highlighter.apply(index, slide);
    }
  }

  /** Marks one result of the last search as the current one, scrolling to it when asked. `undefined` removes the mark. */
  selectMatch(match: TextSearchResult | undefined, reveal: boolean): void {
    this.match = match;
    if (match && reveal) this.reveal(match);
    void this.drawMatch();
  }

  // --- Internals -----------------------------------------------------------------------------

  private get layout(): ListLayout {
    return {
      count: this.slideCount,
      slideHeight: this.deck.presentation.height * this.scale,
      paddingY: PADDING.y,
      gap: GAP,
    };
  }

  /** Displayed width of a slide and the distance of its left edge from the list's left edge. */
  private get horizontal(): { readonly width: number; readonly left: number } {
    const width = this.deck.presentation.width * this.scale;
    return { width, left: Math.max(PADDING.x, (this.element.clientWidth - width) / 2) };
  }

  private fittedScale(): number {
    const viewport = { width: this.element.clientWidth, height: this.element.clientHeight };
    return resolveScale(this.mode, viewport, this.slideSize, PADDING);
  }

  private applyScale(requested: number): void {
    const { width, height } = this.slideSize;
    // A whole number of pixels across keeps the slide's edges sharp. The height is rounded down
    // so that the slide always covers its frame.
    const displayWidth = Math.max(1, Math.round(width * requested));
    const scale = width > 0 ? displayWidth / width : requested;
    this.scale = scale;
    const style = this.list.style;
    style.setProperty("--pv-scale", String(scale));
    style.setProperty("--pv-slide-w", `${displayWidth}px`);
    style.setProperty("--pv-slide-h", `${Math.max(1, Math.floor(height * scale))}px`);
    // In the fitting modes the content never needs to scroll sideways; a rounding error must not add a scroll bar.
    this.element.classList.toggle("pv-fitted", typeof this.mode !== "number");
  }

  /**
   * Applies the scale for the current zoom mode while keeping the point under `origin` (by default
   * the centre of the view) where it is.
   */
  private rescale(origin?: Point): void {
    const scroller = this.element;
    const x = origin?.x ?? scroller.clientWidth / 2;
    const y = origin?.y ?? scroller.clientHeight / 2;
    const pinned = this.pin?.index;

    const before = this.layout;
    const beforeX = this.horizontal;
    const index = slideAt(before, scroller.scrollTop + y);
    const dy = scroller.scrollTop + y - slideTop(before, index);
    const dx = scroller.scrollLeft + x - beforeX.left;

    this.applyScale(this.fittedScale());

    const after = this.layout;
    const afterX = this.horizontal;
    scroller.scrollTop = Math.max(0, slideTop(after, index) + rescaleOffset(dy, before.slideHeight, after.slideHeight) - y);
    scroller.scrollLeft = Math.max(0, afterX.left + rescaleOffset(dx, beforeX.width, afterX.width) - x);

    if (pinned === undefined || (origin !== undefined && index !== pinned)) {
      // The view was scrolled freely, or the pointer picked another slide to zoom in on.
      this.pin = undefined;
    } else if (index !== pinned || slideFits(after, scroller.clientHeight)) {
      // The slide that was jumped to is not the one at the centre of the view (it is small, or at
      // the end of the list), or it now fits: present it the way the jump did.
      this.align(pinned);
      return;
    } else {
      this.pin = { index: pinned, top: scroller.scrollTop };
    }
    this.updateCurrent();
  }

  private align(index: number): void {
    this.mount(index);
    this.element.scrollTop = alignedScrollTop(this.layout, index, this.element.clientHeight);
    this.pin = { index, top: this.element.scrollTop };
    this.updateCurrent();
  }

  /** Scrolls to a search result: to its slide when the slide fits in the view, otherwise to the matching text itself. */
  private reveal(match: TextSearchResult): void {
    const scroller = this.element;
    const index = match.slideIndex;
    if (this.showsWholeSlide && !this.scrollsSideways) {
      this.align(index);
      return;
    }
    this.mount(index);
    // Where the match is in the list: its text when that can be told, otherwise the middle of its shape.
    const text = this.rangeOf(match)?.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const centreX = text
      ? scroller.scrollLeft + text.left - view.left + text.width / 2
      : this.horizontal.left + (match.bounds.x + match.bounds.w / 2) * this.scale;
    const centreY = text
      ? scroller.scrollTop + text.top - view.top + text.height / 2
      : slideTop(this.layout, index) + (match.bounds.y + match.bounds.h / 2) * this.scale;
    scroller.scrollTop = Math.max(0, centreY - scroller.clientHeight / 2);
    scroller.scrollLeft = Math.max(0, centreX - scroller.clientWidth / 2);
    this.pin = { index, top: scroller.scrollTop };
    this.updateCurrent();
  }

  /**
   * The text of a search result in the rendered slide, if its slide is drawn.
   *
   * The renderer reports results by shape, not by where the text ended up in the document, so a
   * result is found by its position among the results of its slide. That is trusted only when the
   * marks found in the rendered text agree with the results in number and the mark at that position
   * reads the same; a slide number or a list's generated numbering, for example, is text on screen
   * that the search does not know.
   */
  private rangeOf(match: TextSearchResult): Range | undefined {
    const ranges = this.highlighter.rangesOf(match.slideIndex);
    if (ranges.length === 0) return undefined;
    let position = -1;
    let count = 0;
    for (const result of this.results) {
      if (result.slideIndex !== match.slideIndex) continue;
      if (result === match) position = count;
      count += 1;
    }
    const range = count === ranges.length ? ranges[position] : undefined;
    const expected = match.text.slice(match.matchStart, match.matchEnd);
    return range && sameText(range.toString(), expected) ? range : undefined;
  }

  private updateCurrent(): void {
    if (this.disposed || this.slideCount === 0) return;
    const scroller = this.element;
    let index: number;
    if (this.pin && Math.abs(scroller.scrollTop - this.pin.top) <= 1) {
      index = this.pin.index;
    } else {
      this.pin = undefined;
      index = currentSlide(this.layout, scroller.scrollTop, scroller.clientHeight);
    }
    if (index !== this.index) {
      this.index = index;
      this.hooks.onSlideChange(index);
    }
  }

  private onWheel(event: WheelEvent): void {
    // A trackpad pinch arrives as a wheel event with the Ctrl key set.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const bounds = this.element.getBoundingClientRect();
    this.wheel.factor *= wheelZoomFactor(event.deltaY, event.deltaMode);
    this.wheel.origin = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    if (this.wheel.frame !== 0) return;
    this.wheel.frame = requestAnimationFrame(() => {
      const { factor, origin } = this.wheel;
      this.wheel = { factor: 1, origin: undefined, frame: 0 };
      const base = typeof this.mode === "number" ? this.mode : this.zoomPercent;
      this.setZoom(base * factor, origin);
    });
  }

  private onResize(): void {
    if (this.disposed) return;
    const { clientWidth, clientHeight } = this.element;
    if (clientWidth === 0 || clientHeight === 0) return; // hidden; keep the layout for when it returns
    if (this.renderedHeight === 0) {
      // The list was built while it had no height, so the renderer keeps no slides ready beyond the view.
      void this.renderList();
    }
    const before = this.scale;
    const pinned = this.pin?.index;
    if (pinned !== undefined) {
      // A slide that was jumped to stays presented the way the jump left it.
      if (typeof this.mode !== "number") this.applyScale(this.fittedScale());
      this.align(pinned);
    } else if (this.mode === "fit") {
      const index = this.index;
      this.applyScale(this.fittedScale());
      if (this.scale !== before) this.align(index); // "fit" means seeing a whole slide
    } else if (this.mode === "width") {
      this.rescale({ x: clientWidth / 2, y: 0 });
    }
    if (this.scale !== before) this.hooks.onZoomChange();
    this.updateCurrent();
  }

  private async renderList(): Promise<void> {
    const position = this.renderedHeight === 0 ? this.capture() : undefined;
    this.renderedHeight = this.element.clientHeight;
    await this.viewer.renderList({
      windowed: true,
      batchSize: PLACEHOLDER_BATCH,
      initialSlides: 1,
      overscanViewport: OVERSCAN_VIEWPORTS,
    });
    if (this.disposed) return;
    this.list.querySelectorAll<HTMLElement>(":scope > [data-slide-index]").forEach((item, index) => {
      const number = String(index + 1);
      item.dataset.pvLabel = this.isHidden(index) ? `${number} · ${this.labels.hidden}` : number;
      item.setAttribute("role", "group");
      item.setAttribute("aria-label", format(this.labels.slide, index + 1));
    });
    if (position) this.restore(position);
  }

  private onSlideRendered(index: number, element: HTMLElement): void {
    // The renderer reports thumbnails through the same callback; only slides of the list concern the stage.
    if (element.parentElement?.dataset.pptxThumbnail === "true") return;
    this.highlighter.apply(index, element);
    if (this.match?.slideIndex === index) void this.drawMatch();
  }

  /** Marks the current search result, if its slide is in the document: its text, or failing that its shape. */
  private async drawMatch(): Promise<void> {
    const token = ++this.matchToken;
    this.viewer.clearSearchHighlights();
    this.highlighter.setCurrent(undefined);
    const match = this.match;
    // A slide that is not mounted gets its mark when it is drawn; see onSlideRendered.
    if (!match || this.disposed || !this.viewer.isSlideMounted(match.slideIndex)) return;
    const range = this.rangeOf(match);
    if (range) {
      this.highlighter.setCurrent(range);
      return;
    }
    const handle = await this.viewer.highlightSearchResult(match, MATCH_BOX);
    if (token !== this.matchToken) handle?.dispose();
  }

  private slideElement(index: number): HTMLElement | null {
    const frame = this.list.querySelector<HTMLElement>(`:scope > [data-slide-index="${index}"] > div`);
    const slide = frame?.dataset.mounted === "1" ? frame.firstElementChild : null;
    return slide instanceof HTMLElement ? slide : null;
  }

  /**
   * Draws a slide now instead of when the renderer's intersection observer notices it, so a jump
   * lands on a finished slide rather than a blank frame. This reaches into a private member of
   * the renderer, whose version is pinned in package.json; without it the observer still mounts
   * the slide a moment later.
   */
  private mount(index: number): void {
    const ensure = (this.viewer as unknown as { ensureListSlideMountedFn?: unknown }).ensureListSlideMountedFn;
    if (typeof ensure === "function") (ensure as (slide: number) => void)(index);
  }

  private problem(message: string): void {
    if (this.problems.has(message) || this.problems.size >= MAX_PROBLEMS) return;
    this.problems.add(message);
    this.hooks.onProblem(message, this.problems.size);
  }
}
