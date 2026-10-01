/**
 * @fileoverview Best-effort parse of a CMS `Supplementaries::Trigger` record:
 * the path name and primary dataset from its title, and from its abstract HTML
 * the first and last run seen online (with HLT menu links), the per-version run
 * ranges with their L1 seeds, and the full trigger-list record. Fields the
 * abstract does not state are omitted; `parsed` is false when the `first seen`
 * line or every version line fails to parse.
 * @module services/cern-opendata/trigger-parse
 */

import { str } from './normalize.js';
import { decodeEntities, splitTags, stripTags } from './text.js';
import type { RawMetadata } from './types.js';

/** A run where the path was seen online, with the HLT menu named beside it. */
export interface TriggerRunSeen {
  /** HLT menu name as the abstract states it (`/cdaq/physics/Run2011/5e32/v4.2/HLT/V2`). */
  menu?: string;
  /** Recid of the menu's `Supplementaries::Configuration HLT` record, when linked. */
  menu_recid?: string;
  run: number;
}

/** One `V<n>: (runs a - b) seeded by: …` line. */
export interface TriggerVersion {
  l1_seed?: string;
  run_first: number;
  run_last: number;
  /** `n` of `V<n>`, the path's `_v<n>` suffix in CMSSW. */
  version: number;
}

/** The parsed fields of one trigger path record. */
export interface ParsedTrigger {
  /** Primary-dataset name from the title's ` ({Primary} dataset)` suffix. */
  dataset?: string;
  first_seen?: TriggerRunSeen;
  last_seen?: TriggerRunSeen;
  /** False when the `first seen` line or every version line failed to parse. */
  parsed: boolean;
  /** Path name from the title, such as `HLT_IsoMu24`. */
  path?: string;
  /** Recid of the year's full trigger-list record (the `See also` link). */
  trigger_list_recid?: string;
  versions: TriggerVersion[];
}

const TITLE_PREFIX = /^High-Level Trigger path information(?=\s)/i;
const DATASET_SUFFIX = /^dataset\)$/i;
const LINE_TERMINATOR = /[\n\r\u{2028}\u{2029}]/u;
/** Opens a line-breaking element; {@link splitTags} runs the tag to its `>`. */
const LINE_BREAK = /<\/?(?:p|br|blockquote|div|li|ul|ol)\b/gi;
/** A record link's href, read from inside one `<a>` tag. */
const RECORD_HREF = /\bhref\s*=\s*["']?(?:https?:\/\/opendata\.cern\.ch)?\/record\/(\d+)\b/i;
const SEEN = /^(first|last)\s+seen\s+online\s+on\s+run\s+(\d+)\b\s*(?:\((.*)\))?/i;
const VERSION =
  /^V(\d+)\s*:\s*\(\s*runs?\s+(\d+)(?:\s*-\s*(\d+))?\s*\)(?:\s*seeded\s+by\s*:\s*(.+))?$/i;
const SEE_ALSO = /^See also\b/i;

/** One abstract line: its text (tags dropped, entities decoded, spaces collapsed) and first record link. */
interface AbstractLine {
  recid?: string;
  text: string;
}

/**
 * The recid of the first `<a>` tag in `segment` whose href is a portal record
 * link. Tag by tag, so a tag with no `>` is read to the end of the segment once.
 */
function recordLinkRecid(segment: string): string | undefined {
  let resume = 0;
  for (const open of segment.matchAll(/<a\b/gi)) {
    if (open.index < resume) continue;
    const tagEnd = segment.indexOf('>', open.index + 2);
    const tag = segment.slice(open.index + 2, tagEnd < 0 ? undefined : tagEnd);
    const recid = RECORD_HREF.exec(tag)?.[1];
    if (recid || tagEnd < 0) return recid;
    resume = tagEnd;
  }
  return;
}

function abstractLines(html: string): AbstractLine[] {
  return splitTags(html, LINE_BREAK).flatMap((segment) => {
    const text = decodeEntities(stripTags(segment)).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const recid = recordLinkRecid(segment);
    return [recid ? { text, recid } : { text }];
  });
}

/**
 * The path and the raw dataset text of a trimmed trigger title: what
 * `/^High-Level Trigger path information\s+(.+?)(?:\s+\(([^()]+?)\s+dataset\))?\s*$/i`
 * captures, read with string scans instead of backtracking. The path is the
 * text after the prefix, or, when it ends `({Primary} dataset)` with space
 * before the `(` and before `dataset`, the text up to that space. A path that
 * holds a line break reads as no path.
 */
function titleParts(title: string): { dataset?: string; path?: string } {
  const prefix = TITLE_PREFIX.exec(title);
  if (!prefix) return {};
  const rest = title.slice(prefix[0].length);
  const body = rest.trimStart();
  let open = -1;
  let dataset: string | undefined;
  if (DATASET_SUFFIX.test(body.slice(-8))) {
    const inner = body.slice(0, -8);
    open = inner.lastIndexOf('(');
    const datasetEnd = Math.max(inner.trimEnd().length, open + 2);
    if (open >= 0 && inner.indexOf(')', open) < 0 && datasetEnd < inner.length) {
      dataset = body.slice(open + 1, datasetEnd);
    }
  }
  if (dataset !== undefined && open > 0) {
    const pathEnd = body.slice(0, open).trimEnd().length;
    if (pathEnd < open) {
      const path = body.slice(0, pathEnd);
      return LINE_TERMINATOR.test(path) ? {} : { path, dataset };
    }
  }
  if (!LINE_TERMINATOR.test(body)) return { path: body };
  if (dataset === undefined || open > 0) return {};
  /**
   * The body is `(… dataset)` and holds a line break, so the regex backs into
   * the space after the prefix: the path becomes one space character, the last
   * that is not a line break and still leaves space before the `(`.
   */
  const gap = rest.slice(0, rest.length - body.length);
  for (let i = gap.length - 2; i >= 1; i--) {
    const char = gap.charAt(i);
    if (!LINE_TERMINATOR.test(char)) return { path: char, dataset };
  }
  return {};
}

function seenRun(run: string, menu: string | undefined, recid: string | undefined): TriggerRunSeen {
  const name = menu?.trim();
  return {
    run: Number(run),
    ...(name ? { menu: name } : {}),
    ...(recid ? { menu_recid: recid } : {}),
  };
}

/**
 * Parse a trigger path record. The title gives `path` and `dataset`; the
 * abstract (`abstract.description`, HTML) gives the rest. Never throws.
 */
export function parseTrigger(meta: RawMetadata): ParsedTrigger {
  const title = titleParts(str(meta.title)?.trim() ?? '');
  const out: ParsedTrigger = { parsed: false, versions: [] };
  if (title.path) out.path = title.path;
  if (title.dataset) out.dataset = title.dataset.trim();

  for (const line of abstractLines(str(meta.abstract?.description) ?? '')) {
    const seen = SEEN.exec(line.text);
    if (seen?.[1] && seen[2]) {
      const key = seen[1].toLowerCase() === 'first' ? 'first_seen' : 'last_seen';
      out[key] ??= seenRun(seen[2], seen[3], line.recid);
      continue;
    }
    const version = VERSION.exec(line.text);
    if (version?.[1] && version[2]) {
      const seed = version[4]?.trim();
      out.versions.push({
        version: Number(version[1]),
        run_first: Number(version[2]),
        run_last: Number(version[3] ?? version[2]),
        ...(seed ? { l1_seed: seed } : {}),
      });
      continue;
    }
    if (SEE_ALSO.test(line.text) && line.recid) out.trigger_list_recid ??= line.recid;
  }

  out.parsed = out.first_seen !== undefined && out.versions.length > 0;
  return out;
}
