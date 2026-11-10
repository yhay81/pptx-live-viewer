import { describe, expect, it } from "vitest";
import {
  type ListLayout,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_PRESETS,
  ZOOM_STEPS,
  alignedScrollTop,
  clampZoom,
  currentSlide,
  formatZoom,
  rescaleOffset,
  resolveScale,
  slideAt,
  slideFits,
  slideTop,
  stepZoom,
  wheelZoomFactor,
} from "../src/shared/zoom";

const PADDING = { x: 16, y: 24 };
const WIDE = { width: 1280, height: 720 };
/** Five slides 100 px high, 24 px of padding above the first, 28 px between them. */
const layout: ListLayout = { count: 5, slideHeight: 100, paddingY: 24, gap: 28 };

describe("clampZoom", () => {
  it("keeps a percentage within the supported range", () => {
    expect(clampZoom(150)).toBe(150);
    expect(clampZoom(5)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
  });

  it("falls back to 100% for something that is not a number", () => {
    expect(clampZoom(Number.NaN)).toBe(100);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe("resolveScale", () => {
  it("uses a percentage as it is, within the range", () => {
    expect(resolveScale(150, { width: 10, height: 10 }, WIDE, PADDING)).toBe(1.5);
    expect(resolveScale(5, { width: 10, height: 10 }, WIDE, PADDING)).toBe(0.1);
  });

  it("fits the whole slide, limited by width or by height", () => {
    // 1000 x 600 leaves 968 x 552 inside the padding: the width is the tighter side.
    expect(resolveScale("fit", { width: 1000, height: 600 }, WIDE, PADDING)).toBeCloseTo(968 / 1280, 10);
    // 2000 x 600 leaves 1968 x 552: now the height is.
    expect(resolveScale("fit", { width: 2000, height: 600 }, WIDE, PADDING)).toBeCloseTo(552 / 720, 10);
  });

  it("fits the width regardless of the height", () => {
    expect(resolveScale("width", { width: 2000, height: 100 }, WIDE, PADDING)).toBeCloseTo(1968 / 1280, 10);
    expect(resolveScale("width", { width: 1000, height: 0 }, WIDE, PADDING)).toBeCloseTo(968 / 1280, 10);
  });

  it("keeps a fitted slide within the zoom range", () => {
    expect(resolveScale("fit", { width: 100, height: 100 }, { width: 10000, height: 10000 }, PADDING)).toBe(MIN_ZOOM / 100);
    expect(resolveScale("width", { width: 5000, height: 100 }, { width: 100, height: 100 }, PADDING)).toBe(MAX_ZOOM / 100);
  });

  it("shows 100% while the viewport or the slide has no size", () => {
    expect(resolveScale("fit", { width: 0, height: 0 }, WIDE, PADDING)).toBe(1);
    expect(resolveScale("width", { width: 20, height: 500 }, WIDE, PADDING)).toBe(1);
    expect(resolveScale("fit", { width: 1000, height: 0 }, WIDE, PADDING)).toBe(1);
    expect(resolveScale("fit", { width: 1000, height: 600 }, { width: 0, height: 0 }, PADDING)).toBe(1);
  });
});

describe("stepZoom", () => {
  it("moves to the next step in either direction", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(66.4, 1)).toBe(67);
    expect(stepZoom(66.4, -1)).toBe(50);
  });

  it("does not stop at a step the zoom is already at, give or take half a percent", () => {
    expect(stepZoom(99.8, 1)).toBe(110);
    expect(stepZoom(100.3, -1)).toBe(90);
  });

  it("stays at the ends of the range", () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(12, -1)).toBe(MIN_ZOOM);
  });

  it("has ascending steps that cover the range, and offers presets from among them", () => {
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual(ZOOM_STEPS);
    expect(ZOOM_STEPS[0]).toBe(MIN_ZOOM);
    expect(ZOOM_STEPS.at(-1)).toBe(MAX_ZOOM);
    for (const preset of ZOOM_PRESETS) expect(ZOOM_STEPS).toContain(preset);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in when the wheel turns away from the user and out the other way", () => {
    expect(wheelZoomFactor(0, 0)).toBe(1);
    expect(wheelZoomFactor(-10, 0)).toBeCloseTo(Math.exp(0.1), 10);
    expect(wheelZoomFactor(-10, 0) * wheelZoomFactor(10, 0)).toBeCloseTo(1, 10);
  });

  it("limits what one event can do", () => {
    expect(wheelZoomFactor(-1000, 0)).toBeCloseTo(Math.exp(0.24), 10);
    expect(wheelZoomFactor(1000, 0)).toBeCloseTo(Math.exp(-0.24), 10);
  });

  it("counts a line as sixteen pixels", () => {
    expect(wheelZoomFactor(1, 1)).toBeCloseTo(Math.exp(-0.16), 10);
  });
});

describe("rescaleOffset", () => {
  it("moves a point inside the slide in proportion", () => {
    expect(rescaleOffset(50, 100, 200)).toBe(100);
    expect(rescaleOffset(0, 100, 200)).toBe(0);
    expect(rescaleOffset(100, 100, 200)).toBe(200);
  });

  it("keeps the distance of a point outside the slide from the slide's nearer edge", () => {
    expect(rescaleOffset(-10, 100, 200)).toBe(-10); // in the padding above
    expect(rescaleOffset(130, 100, 200)).toBe(230); // in the gap below
    expect(rescaleOffset(130, 100, 50)).toBe(80);
  });

  it("leaves the offset alone when the slide had no height", () => {
    expect(rescaleOffset(50, 0, 200)).toBe(50);
  });
});

describe("the slide list", () => {
  it("places each slide below the padding and the slides before it", () => {
    expect(slideTop(layout, 0)).toBe(24);
    expect(slideTop(layout, 2)).toBe(24 + 2 * 128);
  });

  it("finds the slide a position belongs to, splitting each gap in the middle", () => {
    expect(slideAt(layout, 0)).toBe(0);
    expect(slideAt(layout, 24)).toBe(0);
    expect(slideAt(layout, 137)).toBe(0); // 13 px into the gap after the first slide
    expect(slideAt(layout, 138)).toBe(1); // 14 px into it
    expect(slideAt(layout, 100000)).toBe(4);
    expect(slideAt(layout, -500)).toBe(0);
  });

  it("copes with a list that has no slides or no height", () => {
    expect(slideAt({ ...layout, count: 0 }, 300)).toBe(0);
    expect(slideAt({ count: 3, slideHeight: 0, paddingY: 0, gap: 0 }, 300)).toBe(0);
  });

  it("counts the topmost slide that is at least half visible as current", () => {
    expect(currentSlide(layout, 0, 600)).toBe(0);
    expect(currentSlide(layout, 70, 600)).toBe(0); // 54 of its 100 px are still in view
    expect(currentSlide(layout, 80, 600)).toBe(1); // only 44 are
  });

  it("counts the slide at the centre of the view as current when slides are taller than the view", () => {
    const tall: ListLayout = { ...layout, slideHeight: 1000 };
    expect(currentSlide(tall, 0, 600)).toBe(0);
    expect(currentSlide(tall, 700, 600)).toBe(0);
    expect(currentSlide(tall, 800, 600)).toBe(1);
  });

  it("knows whether a whole slide can be seen at once", () => {
    expect(slideFits(layout, 100)).toBe(true);
    expect(slideFits(layout, 99)).toBe(false);
  });

  it("centres a slide that fits and shows a taller one from its top", () => {
    expect(alignedScrollTop(layout, 3, 600)).toBe(24 + 3 * 128 - 250);
    expect(alignedScrollTop(layout, 0, 600)).toBe(0); // cannot scroll above the start
    const tall: ListLayout = { ...layout, slideHeight: 1000 };
    expect(alignedScrollTop(tall, 1, 600)).toBe(1028);
  });
});

describe("formatZoom", () => {
  it("rounds to a whole percentage", () => {
    expect(formatZoom(66.6)).toBe("67%");
    expect(formatZoom(100)).toBe("100%");
  });
});
