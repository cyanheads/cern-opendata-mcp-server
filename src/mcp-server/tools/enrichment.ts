/**
 * @fileoverview Shared success-path enrichment for the list-shaped
 * cern_opendata tools (search_records, list_files, get_validated_runs,
 * search_trigger_paths): the required `truncated` / `shown` / `cap` /
 * `totalCount` fields, written at handler entry and updated once results
 * arrive, plus one composed `notice` per call.
 * @module mcp-server/tools/enrichment
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
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
