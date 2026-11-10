/** Turns what is typed in the find bar into a regular expression. Pure, shared with the tests. */

export interface FindQuery {
  readonly text: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

export type CompiledQuery =
  /** `pattern` is `undefined` when there is nothing to search for. */
  { readonly ok: true; readonly pattern: RegExp | undefined } | { readonly ok: false; readonly error: string };

const isWordCharacter = (character: string): boolean => /^\w$/.test(character);

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a global expression for a query. "Whole word" follows the editor's rule: a boundary is
 * required only on a side where the query itself begins or ends with a word character, so that
 * text in scripts without spaces, or a query such as "(draft)", can still be found.
 */
export function compileFindQuery(query: FindQuery): CompiledQuery {
  if (query.text === "") return { ok: true, pattern: undefined };
  let source = query.regex ? query.text : escapeRegExp(query.text);
  if (query.wholeWord) {
    if (isWordCharacter(query.text.charAt(0))) source = `\\b${source}`;
    if (isWordCharacter(query.text.charAt(query.text.length - 1))) source = `${source}\\b`;
  }
  try {
    return { ok: true, pattern: new RegExp(source, query.matchCase ? "gu" : "giu") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** More matches than this are not collected; the find bar then shows the count with a "+". */
export const MAX_FIND_RESULTS = 20_000;

/** A stretch of text that an expression matched: from `start` up to, not including, `end`. */
export interface TextMatch {
  readonly start: number;
  readonly end: number;
}

/**
 * Every match of an expression in `text`, in order, up to `limit` of them. Matches of nothing are
 * left out: an expression such as `x*` or `^` matches the empty string at every position, which
 * is of no use to someone searching.
 */
export function findMatches(pattern: RegExp, text: string, limit = Number.POSITIVE_INFINITY): TextMatch[] {
  const matches: TextMatch[] = [];
  // Without the "g" flag `exec` would start from the beginning every time.
  const expression = pattern.global || pattern.sticky ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  const unicode = /[uv]/.test(expression.flags);
  expression.lastIndex = 0;
  while (matches.length < limit) {
    const match = expression.exec(text);
    if (!match) break;
    if (match[0].length > 0) {
      matches.push({ start: match.index, end: match.index + match[0].length });
      continue;
    }
    // Step over one character. In Unicode mode that is a whole code point: from the second half
    // of a surrogate pair the expression would match at the start of the pair again, without end.
    const wide = unicode && (text.codePointAt(expression.lastIndex) ?? 0) > 0xffff;
    expression.lastIndex += wide ? 2 : 1;
  }
  return matches;
}

/** Position of the first of `slides` (ascending slide indexes of the matches) at or after `from`, wrapping to 0. */
export function firstMatchFrom(slides: readonly number[], from: number): number {
  const position = slides.findIndex((slide) => slide >= from);
  return position === -1 ? 0 : position;
}

/** Steps through `count` matches in either direction, wrapping around. */
export function stepMatch(position: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  return (((position + direction) % count) + count) % count;
}
