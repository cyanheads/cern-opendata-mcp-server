/**
 * @fileoverview Rendering helpers for upstream-authored text in `format()`:
 * HTML to plain text, fenced free text, neutralized inline slots, printable
 * URLs, character caps, and counts that agree with their noun. Portal text is
 * data, never instructions, so it is fenced or neutralized before it reaches
 * markdown; `structuredContent` keeps every string as received.
 * @module services/cern-opendata/text
 */

/** The portal origin; relative portal paths are resolved against it. */
export const PORTAL_ORIGIN = 'https://opendata.cern.ch';

/** Rendered in place of an absent optional value — never `0`, `false` or `''`. */
export const NOT_AVAILABLE = 'Not available';

const NAMED_ENTITIES: Record<string, string> = {
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
};

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
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

/** Resolve a portal-relative path (`/record/3521`) to an absolute URL; other values pass through. */
export function absoluteUrl(url: string): string {
  return url.startsWith('/') && !url.startsWith('//') ? `${PORTAL_ORIGIN}${url}` : url;
}

const URL_UNSAFE: Record<string, string> = {
  '[': '%5B',
  ']': '%5D',
  ' ': '%20',
  '<': '%3C',
  '>': '%3E',
  '|': '%7C',
  '(': '%28',
  ')': '%29',
  '`': '%60',
  '"': '%22',
  '\\': '%5C',
};

/**
 * A URL ready to print in markdown: relative portal paths made absolute, and
 * brackets, spaces, angle brackets, pipes, parentheses, backticks, quotes,
 * backslashes, line breaks and control characters percent-encoded.
 */
export function printUrl(url: string): string {
  let out = '';
  for (const char of absoluteUrl(url.trim())) {
    const codePoint = char.codePointAt(0) ?? 0;
    const encoded = URL_UNSAFE[char];
    if (encoded) out += encoded;
    else if (isControl(codePoint) || isLineBreak(codePoint) || isBidiControl(codePoint)) {
      out += encodeURIComponent(char);
    } else out += char;
  }
  return out;
}

const BLOCK_TAG = /<\/?(?:p|div|li|ul|ol|h[1-6]|blockquote|tr|table|pre|dt|dd|dl|hr)\b[^>]*>/gi;
const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;

/**
 * Convert portal HTML to plain text: tags dropped; `<p>`, `<br>`, `<li>`,
 * headings and `<blockquote>` become line breaks; `<a href>` becomes
 * `text <url>`; entities decoded; blank-line runs collapsed.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s+/g, ' ')
    .replace(ANCHOR, (_whole, dq?: string, sq?: string, bare?: string, inner = '') => {
      /**
       * The result is entity-encoded (`&lt;url&gt;`, `&` as `&amp;`) so the
       * tag strip below cannot remove the autolink; the final decode restores it.
       */
      const href = printUrl(decodeEntities(dq ?? sq ?? bare ?? ''));
      const label = inner.replace(/<[^>]*>/g, '').trim();
      if (!href) return label;
      const link = `&lt;${href.replace(/&/g, '&amp;')}&gt;`;
      return label && decodeEntities(label) !== href ? `${label} ${link}` : link;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_TAG, '\n')
    .replace(/<[^>]*>/g, '');
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

const INLINE_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '[': '\\[',
  ']': '\\]',
  '|': '\\|',
  '<': '&lt;',
  '>': '&gt;',
};

/**
 * Neutralize text for an inline markdown slot (heading, bold label, list item,
 * table cell): line breaks and tabs flatten to a space; C0/C1 controls and bidi
 * controls are stripped; `\` is escaped before `[ ] |`, and `< >` become
 * entities.
 */
export function inline(text: string): string {
  let out = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isLineBreak(codePoint) || codePoint === 0x09) out += ' ';
    else if (isControl(codePoint) || isBidiControl(codePoint)) continue;
    else out += INLINE_ESCAPES[char] ?? char;
  }
  return out.trim();
}

/**
 * Collapse every line break, and the whitespace around it, to one space, so a
 * value echoed in a notice or error message stays on one line. Nothing else is
 * escaped: the result is plain text, not a markdown slot.
 */
export function oneLine(text: string): string {
  return text.replace(/[\s\u0085]*[\r\n\u0085\p{Zl}\p{Zp}][\s\u0085]*/gu, ' ');
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

/** A string cut to at most `maxChars` UTF-16 units, never splitting a surrogate pair. */
export interface CappedText {
  /** Original length in characters. */
  length: number;
  text: string;
  truncated: boolean;
}

/** Cut `text` at `maxChars` characters, flagging the cut and keeping the original length. */
export function capText(text: string, maxChars: number): CappedText {
  if (text.length <= maxChars) return { text, length: text.length, truncated: false };
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), length: text.length, truncated: true };
}
