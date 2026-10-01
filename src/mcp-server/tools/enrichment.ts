/**
 * @fileoverview Shared success-path enrichment for the list-shaped
 * cern_opendata tools (search_records, list_files, get_validated_runs,
 * search_trigger_paths): the required `truncated` / `shown` / `cap` /
 * `totalCount` fields, written at handler entry and updated once results
 * arrive, plus one composed `notice` per call.
 * @module mcp-server/tools/enrichment
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { PAGE_WINDOW } from '@/services/cern-opendata/cern-opendata-service.js';
import { oneLine } from '@/services/cern-opendata/text.js';

/**
 * The enrichment fields every list-shaped tool declares. `totalDescription`
 * says what `totalCount` counts for that tool (matches, files in scope, …).
 */
export function listEnrichment(totalDescription: string) {
  return {
    truncated: z
      .boolean()
      .describe('True when more results remain past this page; notice says how to reach them.'),
    shown: z.number().describe('Number of items returned on this page.'),
    cap: z.number().describe('The page size (limit) applied to this call.'),
    totalCount: z.number().describe(totalDescription),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for the next call: how to page on, why nothing matched and what to change, or a caveat about the results.',
      ),
  };
}

/**
 * Write the required list fields before any branch or upstream call, so a
 * zero-result page or an under-cap page still satisfies the declared
 * enrichment.
 */
export function startListEnrichment(ctx: Context, cap: number): void {
  ctx.enrich({ truncated: false, shown: 0, cap, totalCount: 0 });
}

/**
 * Join notice fragments into one single-line notice string; `undefined` when
 * there are none. Line breaks in echoed values flatten to a space, since the
 * text trailer renders the notice as one `>` blockquote line.
 */
export function composeNotice(fragments: readonly (string | undefined)[]): string | undefined {
  const parts = fragments.filter((fragment): fragment is string => Boolean(fragment));
  return parts.length > 0 ? oneLine(parts.join(' ')) : undefined;
}

/** Limits in the tools' 1-50 range whose last page ends exactly at match 10,000, smallest first. */
const WINDOW_END_LIMITS = [10, 20, 25, 40, 50] as const;

/**
 * The notice for the last page a search pages to at this limit. When the limit
 * divides 10,000 the page ends at match 10,000 and only narrowing reaches
 * further. Otherwise it ends short of it, and the matches after it up to the
 * smaller of `total` and 10,000 are reachable at another limit: the notice
 * names the smallest limit whose last page starts at or before the first of
 * them, and which of that call's matches this page already showed. `narrow`
 * is the tool's own way to narrow a search, as a sentence opening
 * (`Add filters`).
 */
export function lastPageNotice(
  tool: string,
  narrow: string,
  page: { from: number; limit: number; to: number; total: number },
): string {
  const { from, limit, to, total } = page;
  const showing = `Showing ${from}–${to} of ${total}`;
  const end = Math.min(total, PAGE_WINDOW);
  if (to >= end) {
    return `${showing}; this is the last page within the first 10,000 matches, the deepest the portal pages to. ${narrow} to reach the rest.`;
  }
  const tail = WINDOW_END_LIMITS.find((size) => size >= PAGE_WINDOW - to) ?? 50;
  const tailFrom = Math.max(PAGE_WINDOW - tail + 1, from);
  const rest = to + 1 === end ? `match ${end}` : `matches ${to + 1}–${end}`;
  const shown =
    tailFrom > to
      ? ''
      : tailFrom === to
        ? `; its match ${to} is already on this page`
        : `; its matches ${tailFrom}–${to} are already on this page`;
  const beyond = total > PAGE_WINDOW ? ` ${narrow} to reach the matches past 10,000.` : '';
  return `${showing}; this is the last page at limit ${limit}, since the portal pages no deeper than match 10,000. For ${rest}, call ${tool} again with limit ${tail} and page ${PAGE_WINDOW / tail}${shown}.${beyond}`;
}

/**
 * Record the page once results arrive: `shown`, `totalCount`, and the one
 * composed notice — passed as `truncated()` guidance when more results
 * remain past this page (that call writes `notice`), else through `notice()`.
 */
export function finishListEnrichment(
  ctx: Context,
  page: {
    cap: number;
    notice: string | undefined;
    shown: number;
    total: number;
    truncated: boolean;
  },
): void {
  ctx.enrich({ shown: page.shown });
  ctx.enrich.total(page.total);
  if (page.truncated) {
    ctx.enrich.truncated({
      shown: page.shown,
      cap: page.cap,
      ...(page.notice ? { guidance: page.notice } : {}),
    });
  } else if (page.notice) {
    ctx.enrich.notice(page.notice);
  }
}
