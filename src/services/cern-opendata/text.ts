/**
 * @fileoverview Rendering helpers for upstream-authored text in `format()`,
 * notices and error messages: HTML to plain text, fenced free text,
 * neutralized inline slots and notice values, printable URLs, character caps,
 * and counts that agree with their noun. Portal text is data, never
 * instructions, so it is fenced or neutralized before it reaches markdown;
 * `structuredContent` keeps every string as received.
 * @module services/cern-opendata/text
 */

/** The portal origin; relative portal paths are resolved against it. */
export const PORTAL_ORIGIN = 'https://opendata.cern.ch';

/** Rendered in place of an absent optional value — never `0`, `false` or `''`. */
export const NOT_AVAILABLE = 'Not available';

/** A `Map`, so a reference named like an object member (`&constructor;`) matches nothing. */
const NAMED_ENTITIES = new Map(
  Object.entries({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ensp: ' ',
    emsp: ' ',
    thinsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    laquo: '«',
    raquo: '»',
    bull: '•',
    middot: '·',
    times: '×',
    divide: '÷',
    plusmn: '±',
    deg: '°',
    micro: 'µ',
    le: '≤',
    ge: '≥',
    ne: '≠',
    asymp: '≈',
    rarr: '→',
    larr: '←',
    harr: '↔',
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    eta: 'η',
    mu: 'μ',
    nu: 'ν',
    pi: 'π',
    sigma: 'σ',
    tau: 'τ',
    phi: 'φ',
    psi: 'ψ',
    Upsilon: 'Υ',
    copy: '©',
    reg: '®',
    trade: '™',
    sup2: '²',
    sup3: '³',
  }),
);

/** Decode named and numeric character references; unknown or invalid ones stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const codePoint =
        ref[1] === 'x' || ref[1] === 'X'
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      const valid =
        codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
      return valid ? String.fromCodePoint(codePoint) : whole;
    }
    return NAMED_ENTITIES.get(ref) ?? whole;
  });
}

/** Resolve a portal-relative path (`/record/3521`) to an absolute URL; other values pass through. */
export function absoluteUrl(url: string): string {
  return url.startsWith('/') && !url.startsWith('//') ? `${PORTAL_ORIGIN}${url}` : url;
}

const URL_UNSAFE = new Map([
  ['[', '%5B'],
  [']', '%5D'],
  [' ', '%20'],
  ['<', '%3C'],
  ['>', '%3E'],
  ['|', '%7C'],
  ['(', '%28'],
  [')', '%29'],
  ['`', '%60'],
  ['"', '%22'],
  ['\\', '%5C'],
]);

/**
 * A URL ready to print in markdown: relative portal paths made absolute, and
 * brackets, spaces, angle brackets, pipes, parentheses, backticks, quotes,
 * backslashes, line breaks and control characters percent-encoded.
 */
export function printUrl(url: string): string {
  let out = '';
  for (const char of absoluteUrl(url.trim())) {
    const codePoint = char.codePointAt(0) ?? 0;
    const encoded = URL_UNSAFE.get(char);
    if (encoded) out += encoded;
    else if (isControl(codePoint) || isLineBreak(codePoint) || isBidiControl(codePoint)) {
      out += encodeURIComponent(char);
    } else out += char;
  }
  return out;
}

/**
 * `text` cut at every tag that opens with a match of `opener` (a global regex)
 * and runs to the next `>`, the tags dropped: what `text.split` returns for
 * `opener` followed by `[^>]*>`. One pass, where the regex rescans the rest of
 * the text from every opener that has no `>` after it.
 */
export function splitTags(text: string, opener: RegExp): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const open of text.matchAll(opener)) {
    if (open.index < from) continue;
    const close = text.indexOf('>', open.index + open[0].length);
    if (close < 0) break;
    parts.push(text.slice(from, open.index));
    from = close + 1;
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * Opens a tag, comment or processing instruction, as in the HTML tokenizer: a
 * `<` followed by an ASCII letter, `/`, `!` or `?`. Any other `<` is text.
 */
const TAG_OPEN = /<(?=[A-Za-z/!?])/g;

/** A `<` that {@link TAG_OPEN} does not open a tag at. */
const BARE_LT = /<(?![A-Za-z/!?])/g;

/**
 * `text` with every tag dropped, from a {@link TAG_OPEN} `<` to the next `>`.
 * A bare `<` (`|eta| < 2.4`) is text, and a tag with no `>` after it stays.
 */
export function stripTags(text: string): string {
  return splitTags(text, TAG_OPEN).join('');
}

/** Opens a block element; {@link splitTags} runs the tag to its `>`. */
const BLOCK_TAG = /<\/?(?:p|div|li|ul|ol|h[1-6]|blockquote|tr|table|pre|dt|dd|dl|hr)\b/gi;

/** Opens a table cell; {@link splitTags} runs the tag to its `>`. */
const CELL_TAG = /<t[dh]\b/gi;

/**
 * Ends an anchor: its `</a>`, or the table-structure tag where the HTML parser
 * closes the cell the anchor sits in (`<td`, `<th`, `<tr`, `</td`, `</th`,
 * `</tr`, `</table`).
 */
const ANCHOR_END = /<\/a\s*>|<\/?t[dhr]\b|<\/table\b/gi;

/** `html` without comments; a `<!--` with no `-->` after it stays, and so does the rest. */
function dropComments(html: string): string {
  let out = '';
  let from = 0;
  for (let open = html.indexOf('<!--'); open >= 0; open = html.indexOf('<!--', from)) {
    const close = html.indexOf('-->', open + 4);
    if (close < 0) break;
    out += html.slice(from, open);
    from = close + 3;
  }
  return out + html.slice(from);
}

/**
 * `html` without `<script>` and `<style>` elements, each from its opening tag
 * to the next closing tag of the same name. An element with no closing tag
 * stays, and once one has none, no later element of that name can close.
 */
function dropScripts(html: string): string {
  let out = '';
  let from = 0;
  const unclosed = new Set<string>();
  for (const open of html.matchAll(/<(?:script|style)\b/gi)) {
    const name = open[0].slice(1).toLowerCase();
    if (open.index < from || unclosed.has(name)) continue;
    const tagEnd = html.indexOf('>', open.index + open[0].length);
    if (tagEnd < 0) break;
    const closer = new RegExp(`</${name}\\s*>`, 'gi');
    closer.lastIndex = tagEnd + 1;
    const close = closer.exec(html);
    if (!close) {
      unclosed.add(name);
      continue;
    }
    out += html.slice(from, open.index);
    from = close.index + close[0].length;
  }
  return out + html.slice(from);
}

/** Image references stay literal through the later tag strip and entity decode. */
function replaceImages(html: string): string {
  let out = '';
  let from = 0;
  let resume = 0;
  for (const open of html.matchAll(/<([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])/g)) {
    if (open.index < resume) continue;
    let at = open.index + open[0].length;
    let src: string | undefined;
    let alt: string | undefined;
    while (at < html.length && html[at] !== '>') {
      if (/\s/.test(html[at] ?? '') || html[at] === '/') {
        at += 1;
        continue;
      }
      const start = at;
      while (at < html.length && !/[\s=/>]/.test(html[at] ?? '')) at += 1;
      const name = html.slice(start, at).toLowerCase();
      while (at < html.length && /\s/.test(html[at] ?? '')) at += 1;
      let value = '';
      if (html[at] === '=') {
        at += 1;
        while (at < html.length && /\s/.test(html[at] ?? '')) at += 1;
        const quote = html[at] === '"' || html[at] === "'" ? html[at] : '';
        if (quote) {
          const end = html.indexOf(quote, at + 1);
          if (end < 0) return out + html.slice(from);
          value = html.slice(at + 1, end);
          at = end + 1;
        } else {
          const valueStart = at;
          while (at < html.length && !/[\s>]/.test(html[at] ?? '')) at += 1;
          value = html.slice(valueStart, at);
        }
      }
      if (name === 'src' && src === undefined) src = value;
      if (name === 'alt' && alt === undefined) alt = value;
    }
    if (at === html.length) break;
    resume = at + 1;
    if (open[1]?.toLowerCase() !== 'img') continue;
    const label = decodeEntities(alt ?? '').replace(/[\\[\]\r\n\u0085\u2028\u2029]/g, (char) => {
      switch (char) {
        case '\r':
          return '\\r';
        case '\n':
          return '\\n';
        case '\u0085':
          return '\\u0085';
        case '\u2028':
          return '\\u2028';
        case '\u2029':
          return '\\u2029';
        default:
          return `\\${char}`;
      }
    });
    const url = printUrl(decodeEntities(src ?? ''));
    const reference = url ? `![${label}](${url})` : label;
    const protectedReference = reference
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    out += html.slice(from, open.index) + protectedReference;
    from = at + 1;
  }
  return out + html.slice(from);
}

/**
 * An anchor as `label <url>`, entity-encoded (`&lt;url&gt;`, `&` as `&amp;`)
 * so the tag strip after it cannot remove the autolink; the final decode
 * restores it.
 */
function renderAnchor(value: string, inner: string): string {
  const href = printUrl(decodeEntities(value));
  const label = stripTags(inner).trim();
  if (!href) return label;
  const link = `&lt;${href.replace(/&/g, '&amp;')}&gt;`;
  return label && decodeEntities(label) !== href ? `${label} ${link}` : link;
}

/**
 * Replace each `<a … href=…>` and its label with {@link renderAnchor}, reading
 * what
 * `/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)(?:<\/a\s*>|(?=<\/?t[dhr]\b|<\/table\b))/gi`
 * matches in one pass. The label runs to the first {@link ANCHOR_END} after
 * the tag: a `</a>` is replaced with the anchor, and a table tag stays to end
 * the cell. The first `href` in the tag wins: a quoted value when its closing
 * quote has a `>` after it and before the last anchor end, otherwise the bare
 * run of characters up to a space or `>`. An anchor needs an end after its
 * tag, so none can match once the tag's first `>` is at or past the last one.
 */
function replaceAnchors(text: string): string {
  let lastEnd = -1;
  for (const end of text.matchAll(ANCHOR_END)) lastEnd = end.index;
  const lastGt = text.lastIndexOf('>', lastEnd - 1);
  const ender = new RegExp(ANCHOR_END);
  let out = '';
  let from = 0;
  let resume = 0;
  for (const open of text.matchAll(/<a\b/gi)) {
    if (open.index < resume) continue;
    const tagStart = open.index + 2;
    const firstGt = text.indexOf('>', tagStart);
    if (firstGt < 0 || firstGt >= lastEnd) break;
    const href = /\bhref\s*=\s*/i.exec(text.slice(tagStart, firstGt));
    const valueStart = href ? tagStart + href.index + href[0].length : firstGt;
    if (valueStart === firstGt) {
      resume = firstGt;
      continue;
    }
    const quote = text[valueStart] === '"' || text[valueStart] === "'" ? text[valueStart] : '';
    const quoteEnd = quote ? text.indexOf(quote, valueStart + 1) : -1;
    let value: string;
    let tagEnd: number;
    if (quoteEnd >= 0 && quoteEnd < lastGt) {
      value = text.slice(valueStart + 1, quoteEnd);
      tagEnd = text.indexOf('>', quoteEnd + 1);
    } else {
      const space = text.slice(valueStart, firstGt).search(/\s/);
      value = text.slice(valueStart, space < 0 ? firstGt : valueStart + space);
      tagEnd = firstGt;
    }
    ender.lastIndex = tagEnd + 1;
    const end = ender.exec(text);
    if (!end) break;
    out += text.slice(from, open.index) + renderAnchor(value, text.slice(tagEnd + 1, end.index));
    from = resume = /^<\/a/i.test(end[0]) ? end.index + end[0].length : end.index;
  }
  return out + text.slice(from);
}

/**
 * `line` with its table cells joined by ` | `: each `<td>` or `<th>` tag,
 * dropped to its `>`, starts a cell, and the text before a line's first cell
 * tag is kept as a cell only when more than tags or whitespace. A line with no
 * cell tag comes back unchanged.
 */
function joinCells(line: string): string {
  const cells = splitTags(line, CELL_TAG);
  if (cells.length === 1) return line;
  if (stripTags(cells[0] ?? '').trim() === '') cells.shift();
  return cells.join(' | ');
}

/**
 * Convert portal HTML to plain text: tags dropped; `<p>`, `<br>`, `<li>`,
 * headings, `<blockquote>` and table rows become line breaks; a row's cells
 * are joined by ` | `; `<a href>` becomes `text <url>`; images become literal
 * `![alt](url)` references (alt alone without a source); entities decoded;
 * blank-line runs collapsed. A bare `<` is encoded as `&lt;` before the first
 * pass: removing a comment, a script or style element, an anchor's tags, or a
 * tag inside an anchor label after a bare `<` can leave it before a letter,
 * where the tag strip would open a tag. Each step is a single pass, so the
 * time is linear in the length of the HTML.
 */
export function htmlToText(html: string): string {
  const encoded = html.replace(BARE_LT, '&lt;');
  const anchored = replaceAnchors(
    replaceImages(dropScripts(dropComments(encoded))).replace(/\s+/g, ' '),
  );
  const lines = splitTags(anchored.replace(/<br\s*\/?>/gi, '\n'), BLOCK_TAG).join('\n');
  const text = stripTags(lines.split('\n').map(joinCells).join('\n'));
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fence free text in a code block whose backtick run is longer than any run
 * inside the text, so the text's own fences cannot close it.
 */
export function fence(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const marker = '`'.repeat(Math.max(3, longestRun + 1));
  return `${marker}\n${text}\n${marker}`;
}

/** HTML from the portal as a fenced plain-text block. */
export function fenceHtml(html: string): string {
  return fence(htmlToText(html));
}

function isLineBreak(codePoint: number): boolean {
  return (
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    codePoint === 0x85 ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

const INLINE_ESCAPES = new Map([
  ['\\', '\\\\'],
  ['[', '\\['],
  [']', '\\]'],
  ['|', '\\|'],
  ['<', '&lt;'],
  ['>', '&gt;'],
]);

/** {@link inline} before its trim. */
function neutralize(text: string): string {
  let out = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isLineBreak(codePoint) || codePoint === 0x09) out += ' ';
    else if (isControl(codePoint) || isBidiControl(codePoint)) continue;
    else out += INLINE_ESCAPES.get(char) ?? char;
  }
  return out;
}

/**
 * Neutralize text for an inline markdown slot (heading, bold label, list item,
 * table cell): line breaks and tabs flatten to a space; C0/C1 controls and bidi
 * controls are stripped; `\` is escaped before `[ ] |`, and `< >` become
 * entities.
 */
export function inline(text: string): string {
  return neutralize(text).trim();
}

/**
 * {@link inline} for a value whose exact spelling a filter must repeat, such as
 * a facet value: one with leading or trailing whitespace renders inside double
 * quotes with that whitespace kept, so ` Heavy-Ion Physics` stays distinct from
 * `Heavy-Ion Physics`, and one holding a comma renders quoted, so
 * `"13TeV, 13.6TeV"` reads as one value in a comma-joined list.
 */
export function inlineSpelling(text: string): string {
  const neutral = neutralize(text);
  const trimmed = neutral.trim();
  return trimmed === neutral && !neutral.includes(',') ? trimmed : `"${neutral}"`;
}

/**
 * Collapse every line break, and the whitespace around it, to one space, so a
 * value echoed in a notice or error message stays on one line. Nothing else is
 * escaped: the result is plain text, not a markdown slot.
 */
export function oneLine(text: string): string {
  return text.replace(/[\s\u{85}]+/gu, (run) =>
    /[\r\n\u{85}\u{2028}\u{2029}]/u.test(run) ? ' ' : run,
  );
}

/** `n` and its noun in agreement: `1 file`, `0 files`, `2 matches` with `plural` given. */
export function countOf(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** Inline-neutralized value, or {@link NOT_AVAILABLE} when absent. */
export function inlineOrNA(value: string | number | undefined): string {
  if (value === undefined) return NOT_AVAILABLE;
  return typeof value === 'number' ? String(value) : inline(value);
}

/** Inline-neutralized values joined by `, `, or {@link NOT_AVAILABLE} when there are none. */
export function inlineList(values: readonly string[] | undefined): string {
  return values?.length ? values.map(inline).join(', ') : NOT_AVAILABLE;
}

const NOTICE_VALUE_MAX_CHARS = 200;

/**
 * A portal-derived value for a notice or an error message: cut at 200
 * characters (`…` marks the cut), then neutralized like an inline slot. A
 * notice renders as one `>` line, and an error message as plain markdown, so
 * markdown and HTML in the value would otherwise be live.
 */
export function noticeValue(value: string): string {
  const capped = capText(value, NOTICE_VALUE_MAX_CHARS);
  const text = inline(capped.text);
  return capped.truncated ? `${text}…` : text;
}

/** {@link noticeValue} of each value joined by `, `, or {@link NOT_AVAILABLE} when there are none. */
export function noticeList(values: readonly string[] | undefined): string {
  return values?.length ? values.map(noticeValue).join(', ') : NOT_AVAILABLE;
}

/** A string cut to at most `maxChars` UTF-16 units, never splitting a surrogate pair. */
export interface CappedText {
  /** Original length in characters. */
  length: number;
  text: string;
  truncated: boolean;
}

/** Cut `text` at `maxChars` characters, flagging the cut and keeping the original length. */
export function capText(text: string, maxChars: number): CappedText {
  const slice = sliceText(text, 0, maxChars);
  return { text: slice.text, length: text.length, truncated: slice.end < text.length };
}

/** A run of at most `maxUnits` UTF-16 units of a string, with the offsets it spans. */
export interface TextSlice {
  /** Offset after the slice's last unit: where the next slice starts. */
  end: number;
  /** Offset of the slice's first unit. */
  start: number;
  text: string;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * At most `maxUnits` UTF-16 units of `text` from `offset`, never splitting a
 * surrogate pair: an offset on a pair's second half starts at its first half,
 * and a slice that would end between the halves ends before the pair.
 * Following `end` until it reaches `text.length` rebuilds `text` exactly.
 */
export function sliceText(text: string, offset: number, maxUnits: number): TextSlice {
  const start =
    offset > 0 &&
    isLowSurrogate(text.charCodeAt(offset)) &&
    isHighSurrogate(text.charCodeAt(offset - 1))
      ? offset - 1
      : offset;
  let end = Math.min(start + maxUnits, text.length);
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return { text: text.slice(start, end), start, end };
}
