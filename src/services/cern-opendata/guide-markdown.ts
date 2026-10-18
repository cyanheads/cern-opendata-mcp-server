/**
 * @fileoverview Line scans over guide markdown (`/api/docs/{slug}` bodies):
 * which lines sit in fenced code, the link reference definitions a body
 * declares (`[label]: destination`), and the labels its bracketed spans name.
 * Labels are compared as CommonMark normalizes them. Each scan reads its input
 * once, so time is linear in the body.
 * @module services/cern-opendata/guide-markdown
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** For each line of a markdown body: whether it opens, closes or sits inside a fenced code block. */
export function fencedLines(lines: readonly string[]): boolean[] {
  const fenced: boolean[] = [];
  let open: string | undefined;
  for (const line of lines) {
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (open) {
      if (marker && marker[0] === open[0] && marker.length >= open.length) open = undefined;
      fenced.push(true);
    } else {
      open = marker;
      fenced.push(marker !== undefined);
    }
  }
  return fenced;
}

/**
 * A link label as CommonMark compares it: case-folded, edges trimmed, inner
 * whitespace runs collapsed to one space (commonmark.js `normalizeReference`).
 */
function normalizeLabel(label: string): string {
  return label
    .trim()
    .replace(/[ \t\r\n]+/g, ' ')
    .toLowerCase()
    .toUpperCase();
}

/**
 * The normalized label of a line that opens with `[label]:` after at most
 * three spaces, or `undefined`: the label holds no unescaped bracket and more
 * than whitespace.
 */
function definitionLabel(line: string): string | undefined {
  let at = 0;
  while (at < 3 && line[at] === ' ') at++;
  if (line[at] !== '[') return;
  for (let i = at + 1; i < line.length; i++) {
    const char = line[i];
    if (char === '\\') i++;
    else if (char === '[') return;
    else if (char === ']') {
      if (line[i + 1] !== ':') return;
      return normalizeLabel(line.slice(at + 1, i)) || undefined;
    }
  }
  return;
}

/** A link reference definition: its line in the body and its normalized label. */
export interface ReferenceDefinition {
  label: string;
  line: number;
}

/**
 * The first definition of each label among `lines`, in body order. A line
 * `fenced` marks defines nothing.
 */
export function referenceDefinitions(
  lines: readonly string[],
  fenced: readonly boolean[],
): ReferenceDefinition[] {
  const seen = new Set<string>();
  const definitions: ReferenceDefinition[] = [];
  for (const [line, text] of lines.entries()) {
    if (fenced[line]) continue;
    const label = definitionLabel(text);
    if (label === undefined || seen.has(label)) continue;
    seen.add(label);
    definitions.push({ label, line });
  }
  return definitions;
}

/**
 * The normalized label of every bracketed span `[…]` in `text` that holds no
 * other unescaped bracket: `[x][INSTALLVB]` names `X` and `INSTALLVB`, and
 * `[[a]]` names `A`.
 */
export function bracketLabels(text: string): Set<string> {
  const labels = new Set<string>();
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') i++;
    else if (char === '[') open = i;
    else if (char === ']' && open >= 0) {
      labels.add(normalizeLabel(text.slice(open + 1, i)));
      open = -1;
    }
  }
  return labels;
}
