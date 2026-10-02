/**
 * @fileoverview The pre-check `cern_opendata_search_records` runs on `query`
 * before sending it: unbalanced parentheses, range brackets and double quotes,
 * and a trailing escape. The portal answers such a query with a 400 or, on
 * some requests, a 500 that no retry clears, so it is refused without one.
 * @module services/cern-opendata/query-syntax
 */

/** The first delimiter problem in a query, `position` counted from 1. */
export interface DelimiterProblem {
  /** The delimiter: `(`, `)`, `[`, `]`, `{`, `}`, `"`, or `\` for a trailing escape. */
  character: string;
  position: number;
  /** `unclosed` opener, `unopened` closer, or a `dangling_escape` that ends the query. */
  problem: 'unclosed' | 'unopened' | 'dangling_escape';
}

/**
 * The first unbalanced delimiter in an OpenSearch `query_string`, or
 * `undefined` when every one is balanced. One pass: `\` escapes the next
 * character, a `"` phrase is skipped to its closing `"`, and `(` closes with
 * `)`. A range opened by `[` or `{` closes with `]` or `}` (mixed pairs are
 * valid range syntax) and, as in the parser's range state, holds no group or
 * nested range: `(`, `)`, `[` and `{` inside it are bound text. A `"` there
 * opens a quoted bound only where a bound starts, right after the opener or a
 * space, and only when another `"` follows; any other `"` is bound text too
 * (`[A" TO B]` is a range from `A"`). A closer with no matching opener is
 * reported where it stands; otherwise the open range, the innermost open
 * group, or an open phrase.
 */
export function findUnbalancedDelimiter(query: string): DelimiterProblem | undefined {
  const groups: number[] = [];
  let phraseAt = 0;
  let rangeAt = 0;
  for (let i = 0; i < query.length; i++) {
    const character = query.charAt(i);
    if (character === '\\') {
      if (i === query.length - 1) return { character, position: i + 1, problem: 'dangling_escape' };
      i++;
    } else if (phraseAt > 0) {
      if (character === '"') phraseAt = 0;
    } else if (rangeAt > 0) {
      if (character === ']' || character === '}') rangeAt = 0;
      else if (
        character === '"' &&
        (i === rangeAt || query.charAt(i - 1) === ' ') &&
        query.indexOf('"', i + 1) >= 0
      ) {
        phraseAt = i + 1;
      }
    } else if (character === '"') {
      phraseAt = i + 1;
    } else if (character === '[' || character === '{') {
      rangeAt = i + 1;
    } else if (character === '(') {
      groups.push(i + 1);
    } else if (character === ')' || character === ']' || character === '}') {
      if (character !== ')' || groups.pop() === undefined) {
        return { character, position: i + 1, problem: 'unopened' };
      }
    }
  }
  if (phraseAt > 0) return { character: '"', position: phraseAt, problem: 'unclosed' };
  if (rangeAt > 0)
    return { character: query.charAt(rangeAt - 1), position: rangeAt, problem: 'unclosed' };
  const innermost = groups.at(-1);
  return innermost === undefined
    ? undefined
    : { character: '(', position: innermost, problem: 'unclosed' };
}
