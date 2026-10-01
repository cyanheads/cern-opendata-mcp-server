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
import { decodeEntities } from './text.js';
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

const TITLE = /^High-Level Trigger path information\s+(.+?)(?:\s+\(([^()]+?)\s+dataset\))?\s*$/i;
const LINE_BREAK = /<\/?(?:p|br|blockquote|div|li|ul|ol)\b[^>]*>/gi;
const RECORD_HREF =
  /<a\b[^>]*?\bhref\s*=\s*["']?(?:https?:\/\/opendata\.cern\.ch)?\/record\/(\d+)\b/i;
const SEEN = /^(first|last)\s+seen\s+online\s+on\s+run\s+(\d+)\b\s*(?:\((.*)\))?/i;
const VERSION =
  /^V(\d+)\s*:\s*\(\s*runs?\s+(\d+)(?:\s*-\s*(\d+))?\s*\)(?:\s*seeded\s+by\s*:\s*(.+))?$/i;
const SEE_ALSO = /^See also\b/i;

/** One abstract line: its text (tags dropped, entities decoded, spaces collapsed) and first record link. */
interface AbstractLine {
  recid?: string;
  text: string;
}

function abstractLines(html: string): AbstractLine[] {
  return html.split(LINE_BREAK).flatMap((segment) => {
    const text = decodeEntities(segment.replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return [];
    const recid = RECORD_HREF.exec(segment)?.[1];
    return [recid ? { text, recid } : { text }];
  });
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
  const title = TITLE.exec(str(meta.title)?.trim() ?? '');
  const out: ParsedTrigger = { parsed: false, versions: [] };
  if (title?.[1]) out.path = title[1];
  if (title?.[2]) out.dataset = title[2].trim();

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
