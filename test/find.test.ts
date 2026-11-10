import { describe, expect, it } from "vitest";
import { type FindQuery, compileFindQuery, escapeRegExp, findMatches, firstMatchFrom, stepMatch } from "../src/shared/find";

const query = (text: string, options: Partial<Omit<FindQuery, "text">> = {}): FindQuery => ({
  text,
  matchCase: false,
  wholeWord: false,
  regex: false,
  ...options,
});

function patternOf(q: FindQuery): RegExp {
  const compiled = compileFindQuery(q);
  if (!compiled.ok || !compiled.pattern) throw new Error("expected an expression");
  return compiled.pattern;
}

/** Fails instead of hanging when a search stops advancing through the text. */
class CountingRegExp extends RegExp {
  calls = 0;
  override exec(text: string): RegExpExecArray | null {
    if (++this.calls > 10_000) throw new Error("the search does not advance");
    return super.exec(text);
  }
}

/** The pieces of `text` that a query finds. */
function found(q: FindQuery, text: string): string[] {
  const { source, flags } = patternOf(q);
  return findMatches(new CountingRegExp(source, flags), text).map(({ start, end }) => text.slice(start, end));
}

describe("escapeRegExp", () => {
  it("makes every character of the text literal", () => {
    const text = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
    expect(new RegExp(`^${escapeRegExp(text)}$`).test(text)).toBe(true);
    expect(new RegExp(escapeRegExp("a.b")).test("axb")).toBe(false);
  });
});

describe("compileFindQuery", () => {
  it("has nothing to search for when the text is empty", () => {
    expect(compileFindQuery(query(""))).toEqual({ ok: true, pattern: undefined });
  });

  it("searches plain text literally and without regard to case", () => {
    expect(found(query("a.b"), "A.B axb a.b")).toEqual(["A.B", "a.b"]);
    expect(found(query("("), "f(x)")).toEqual(["("]);
  });

  it("can match case", () => {
    expect(found(query("Deck", { matchCase: true }), "deck Deck DECK")).toEqual(["Deck"]);
  });

  it("matches whole words where the query begins and ends with a word character", () => {
    expect(found(query("cat", { wholeWord: true }), "a cat, concatenate, CAT")).toEqual(["cat", "CAT"]);
  });

  it("asks for no word boundary next to a character that is not part of a word", () => {
    expect(found(query("(draft)", { wholeWord: true }), "x(draft)y")).toEqual(["(draft)"]);
    // Japanese has no spaces between words; a boundary there would never match.
    expect(found(query("日本", { wholeWord: true }), "日本語のスライド")).toEqual(["日本"]);
  });

  it("takes the text as a regular expression when asked to", () => {
    expect(found(query("sl[iy]de\\d+", { regex: true }), "Slide12 slyde3 slide")).toEqual(["Slide12", "slyde3"]);
    expect(found(query("\\p{Script=Hiragana}+", { regex: true }), "これは pen です")).toEqual(["これは", "です"]);
  });

  it("reports an expression that cannot be compiled", () => {
    const compiled = compileFindQuery(query("(", { regex: true }));
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.error).not.toBe("");
  });
});

describe("findMatches", () => {
  it("returns every match in order", () => {
    expect(findMatches(/an/g, "banana")).toEqual([
      { start: 1, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it("stops at the limit", () => {
    expect(findMatches(/a/g, "banana", 2)).toHaveLength(2);
    expect(findMatches(/a/g, "banana", 0)).toEqual([]);
  });

  it("starts from the beginning each time, wherever the expression was left", () => {
    const pattern = /a/g;
    pattern.lastIndex = 4;
    expect(findMatches(pattern, "banana")).toHaveLength(3);
    expect(findMatches(pattern, "banana")).toHaveLength(3);
  });

  it("finds every match of an expression without the global flag too", () => {
    expect(findMatches(new CountingRegExp("a"), "banana")).toHaveLength(3);
  });

  it("leaves out matches of nothing", () => {
    expect(findMatches(new CountingRegExp("x*", "g"), "axxb")).toEqual([{ start: 1, end: 3 }]);
    expect(findMatches(new CountingRegExp("^", "gm"), "one\ntwo")).toEqual([]);
    expect(findMatches(new CountingRegExp("a|", "g"), "banana")).toHaveLength(3);
  });

  it("gets past characters outside the Basic Multilingual Plane in Unicode mode", () => {
    // "😀" and "𠮷" take two code units each; the "x" is at index 6.
    const text = "a😀b𠮷x";
    expect(findMatches(new CountingRegExp("x*", "gu"), text)).toEqual([{ start: 6, end: 7 }]);
    expect(findMatches(new CountingRegExp("^", "gu"), "😀")).toEqual([]);
    expect(findMatches(new CountingRegExp("\\b", "gu"), "a😀b c")).toEqual([]);
    expect(findMatches(new CountingRegExp("(?=😀)", "gu"), text)).toEqual([]);
    expect(findMatches(new CountingRegExp("x*", "gv"), text)).toEqual([{ start: 6, end: 7 }]);
  });

  it("matches such a character as one character in Unicode mode", () => {
    expect(findMatches(/./gu, "a😀")).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 3 },
    ]);
  });

  it("works with what the find bar compiles", () => {
    expect(found(query("x*", { regex: true }), "a😀xx🎯x")).toEqual(["xx", "x"]);
    expect(found(query("x*"), "a x* b")).toEqual(["x*"]);
  });
});

describe("firstMatchFrom", () => {
  it("picks the first match on or after the slide being viewed", () => {
    expect(firstMatchFrom([0, 0, 2, 5], 0)).toBe(0);
    expect(firstMatchFrom([0, 0, 2, 5], 1)).toBe(2);
    expect(firstMatchFrom([0, 0, 2, 5], 2)).toBe(2);
    expect(firstMatchFrom([0, 0, 2, 5], 3)).toBe(3);
  });

  it("wraps to the first match when none follows", () => {
    expect(firstMatchFrom([0, 1], 4)).toBe(0);
    expect(firstMatchFrom([], 0)).toBe(0);
  });
});

describe("stepMatch", () => {
  it("moves forwards and backwards, wrapping at the ends", () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(-1, 3, 1)).toBe(0);
  });

  it("has no position when there are no matches", () => {
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});
