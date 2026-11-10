/**
 * Marks every occurrence of the search pattern in the text of rendered slides.
 *
 * It uses the CSS Custom Highlight API, which paints ranges of text (`::highlight(pv-find)` and
 * `::highlight(pv-find-current)` in the style sheet) without touching the elements the renderer
 * created.
 */
import { findMatches } from "../shared/find";

const HIGHLIGHT_NAME = "pv-find";
const CURRENT_NAME = "pv-find-current";
/** A pattern such as "e" matches thousands of times; past this point more marks help nobody. */
const MAX_RANGES_PER_SLIDE = 2000;

interface Registry {
  readonly all: Highlight;
  readonly current: Highlight;
}

let shared: Registry | undefined;

/** The highlights every stage adds its ranges to; `undefined` where the API is missing. */
function registry(): Registry | undefined {
  if (shared) return shared;
  if (typeof Highlight !== "function" || typeof CSS === "undefined" || !("highlights" in CSS)) return undefined;
  const all = new Highlight();
  const current = new Highlight();
  current.priority = 1; // painted over the mark the same text has as one of all matches
  CSS.highlights.set(HIGHLIGHT_NAME, all);
  CSS.highlights.set(CURRENT_NAME, current);
  shared = { all, current };
  return shared;
}

/** A stretch of a block's text: a text node, or a line break, which has no node to point into. */
interface Piece {
  readonly node: Text | undefined;
  readonly start: number;
  readonly length: number;
}

/** The nearest ancestor that starts its own line of text, which is where a match cannot continue past. */
function blockOf(node: Node, root: Element, known: Map<Element, Element>): Element {
  const path: Element[] = [];
  let element = node.parentElement;
  let block: Element = root;
  while (element && element !== root) {
    const cached = known.get(element);
    if (cached) {
      block = cached;
      break;
    }
    path.push(element);
    const display = getComputedStyle(element).display;
    if (!display.startsWith("inline") && display !== "contents") {
      block = element;
      break;
    }
    element = element.parentElement;
  }
  for (const visited of path) known.set(visited, block);
  return block;
}

function rangeOver(pieces: readonly Piece[], from: number, to: number): Range | undefined {
  // A match that begins or ends at a line break is marked from or up to the text next to the break.
  let first: { node: Text; offset: number } | undefined;
  let last: { node: Text; offset: number } | undefined;
  for (const piece of pieces) {
    if (!piece.node) continue;
    const end = piece.start + piece.length;
    if (end <= from || piece.start >= to) continue;
    first ??= { node: piece.node, offset: Math.max(0, from - piece.start) };
    last = { node: piece.node, offset: Math.min(piece.length, to - piece.start) };
  }
  if (!first || !last) return undefined;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset);
  return range;
}

function findRanges(root: Element, pattern: RegExp): Range[] {
  const blocks = new Map<Element, { pieces: Piece[]; text: string }>();
  const known = new Map<Element, Element>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node instanceof Text ? node : undefined;
    // A line break inside a paragraph is a new line in the paragraph's text, as it is for the search.
    const data = text ? text.data : node instanceof HTMLBRElement ? "\n" : "";
    if (data === "") continue;
    const key = blockOf(node, root, known);
    let block = blocks.get(key);
    if (!block) {
      block = { pieces: [], text: "" };
      blocks.set(key, block);
    }
    block.pieces.push({ node: text, start: block.text.length, length: data.length });
    block.text += data;
  }

  const ranges: Range[] = [];
  for (const { pieces, text } of blocks.values()) {
    for (const { start, end } of findMatches(pattern, text, MAX_RANGES_PER_SLIDE - ranges.length)) {
      const range = rangeOver(pieces, start, end);
      if (range) ranges.push(range);
    }
    if (ranges.length >= MAX_RANGES_PER_SLIDE) break;
  }
  return ranges;
}

export class TextHighlighter {
  private readonly ranges = new Map<number, Range[]>();
  private pattern: RegExp | undefined;
  private current: Range | undefined;

  /** Sets the pattern to mark and forgets the marks of the previous one. Slides are marked by `apply`. */
  setPattern(pattern: RegExp | undefined): void {
    for (const index of [...this.ranges.keys()]) this.clear(index);
    // A private copy: `exec` keeps its position on the expression object.
    this.pattern = pattern && new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  }

  /** Marks the matches in one rendered slide, replacing any marks it had. */
  apply(index: number, slide: Element): void {
    this.clear(index);
    const highlights = registry();
    if (!this.pattern || !highlights) return;
    const ranges = findRanges(slide, this.pattern);
    if (ranges.length === 0) return;
    for (const range of ranges) highlights.all.add(range);
    this.ranges.set(index, ranges);
  }

  /** The marks of a slide in reading order; none when the slide is not drawn or nothing in it matches. */
  rangesOf(index: number): readonly Range[] {
    return this.ranges.get(index) ?? [];
  }

  /** Paints one mark as the current match; `undefined` paints none. */
  setCurrent(range: Range | undefined): void {
    if (this.current) shared?.current.delete(this.current);
    this.current = range;
    if (range) registry()?.current.add(range);
  }

  clear(index: number): void {
    const ranges = this.ranges.get(index);
    if (!ranges) return;
    if (this.current && ranges.includes(this.current)) this.setCurrent(undefined);
    for (const range of ranges) shared?.all.delete(range);
    this.ranges.delete(index);
  }

  dispose(): void {
    this.setPattern(undefined);
    this.setCurrent(undefined);
  }
}
