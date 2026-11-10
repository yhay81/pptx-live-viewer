/** Zoom and scroll geometry of the slide list. Pure math, shared with the tests. */
import type { ZoomMode } from "./protocol";

export const MIN_ZOOM = 10;
export const MAX_ZOOM = 400;

/** Percentages the zoom buttons step through. */
export const ZOOM_STEPS: readonly number[] = [10, 25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];

/** Percentages offered in the zoom menu. */
export const ZOOM_PRESETS: readonly number[] = [50, 75, 100, 125, 150, 200, 300, 400];

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Vertical arrangement of the slide list: equal-height slides separated by a gap. */
export interface ListLayout {
  readonly count: number;
  /** Height of one slide as displayed, in CSS pixels. */
  readonly slideHeight: number;
  readonly paddingY: number;
  readonly gap: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function clampZoom(percent: number): number {
  return Number.isFinite(percent) ? clamp(percent, MIN_ZOOM, MAX_ZOOM) : 100;
}

/**
 * Scale (1 = 100%) a slide is drawn at for a zoom mode. A viewport that has no size yet
 * (a hidden editor) falls back to 100% rather than collapsing the slide.
 */
export function resolveScale(mode: ZoomMode, viewport: Size, slide: Size, padding: { x: number; y: number }): number {
  if (typeof mode === "number") return clampZoom(mode) / 100;
  const width = viewport.width - padding.x * 2;
  const height = viewport.height - padding.y * 2;
  if (!(slide.width > 0) || !(slide.height > 0) || width <= 0) return 1;
  const byWidth = width / slide.width;
  if (mode === "width") return clampZoom(byWidth * 100) / 100;
  if (height <= 0) return 1;
  return clampZoom(Math.min(byWidth, height / slide.height) * 100) / 100;
}

/** The next larger or smaller step from the current percentage. */
export function stepZoom(percent: number, direction: 1 | -1): number {
  const tolerance = 0.5; // a fitted 99.8% steps to 110%, not to 100%
  if (direction > 0) return ZOOM_STEPS.find((step) => step > percent + tolerance) ?? MAX_ZOOM;
  return ZOOM_STEPS.findLast((step) => step < percent - tolerance) ?? MIN_ZOOM;
}

/**
 * Zoom factor for one wheel event with Ctrl/Cmd held. A trackpad pinch sends many small deltas,
 * a mouse wheel few large ones; clamping keeps one wheel notch to a moderate step.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaY;
  return Math.exp(-clamp(pixels, -24, 24) * 0.01);
}

/**
 * Where a point lies after a slide changed size, as a distance from the slide's leading edge.
 * Inside the slide the point moves with it; in the padding and the gaps around it, which keep
 * their size, it keeps its distance from the nearer edge of the slide.
 */
export function rescaleOffset(offset: number, before: number, after: number): number {
  if (offset <= 0 || !(before > 0)) return offset;
  if (offset >= before) return after + (offset - before);
  return (offset / before) * after;
}

export function slideTop(layout: ListLayout, index: number): number {
  return layout.paddingY + index * (layout.slideHeight + layout.gap);
}

/** Index of the slide whose row (the slide plus half of the gap on either side) contains `y`. */
export function slideAt(layout: ListLayout, y: number): number {
  if (layout.count <= 0) return 0;
  const pitch = layout.slideHeight + layout.gap;
  if (!(pitch > 0)) return 0;
  return clamp(Math.floor((y - layout.paddingY + layout.gap / 2) / pitch), 0, layout.count - 1);
}

/**
 * The slide the viewer counts as current. For slides smaller than the viewport it is the topmost
 * slide that is at least half visible; for a slide taller than the viewport, the one at its centre.
 */
export function currentSlide(layout: ListLayout, scrollTop: number, viewportHeight: number): number {
  const probe = Math.min(viewportHeight, layout.slideHeight + layout.gap) / 2;
  return slideAt(layout, scrollTop + probe);
}

/** Whether a whole slide can be seen at once, without scrolling vertically. */
export function slideFits(layout: ListLayout, viewportHeight: number): boolean {
  return layout.slideHeight <= viewportHeight;
}

/**
 * Scroll offset that presents a slide: centred when it fits in the viewport, otherwise with its
 * top edge just below the top padding.
 */
export function alignedScrollTop(layout: ListLayout, index: number, viewportHeight: number): number {
  const offset = slideFits(layout, viewportHeight) ? (viewportHeight - layout.slideHeight) / 2 : layout.paddingY;
  return Math.max(0, slideTop(layout, index) - offset);
}

export function formatZoom(percent: number): string {
  return `${Math.round(percent)}%`;
}
