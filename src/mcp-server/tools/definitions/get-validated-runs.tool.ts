/**
 * @fileoverview cern_opendata_get_validated_runs — return a CMS validated-run
 * (good-run) list: run → luminosity-section ranges, selected by a list recid,
 * a collision dataset recid or a run period, in the full or muons-only
 * variant. Lists come from the cached `CMS-Validated-Runs` collection and are
 * selected locally (Decision 17); only a single match reads the list file.
 * @module mcp-server/tools/definitions/get-validated-runs.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCernOpenDataService } from '@/services/cern-opendata/cern-opendata-service.js';
import {
  definedOnly,
  recordUrl,
  str,
  strList,
  twinOf,
} from '@/services/cern-opendata/normalize.js';
import {
  inline,
  inlineOrNA,
  NOT_AVAILABLE,
  oneLine,
  printUrl,
} from '@/services/cern-opendata/text.js';
import type { RunList, RunListVariant, ValidatedRunList } from '@/services/cern-opendata/types.js';
import {
  composeNotice,
  finishListEnrichment,
  listEnrichment,
  startListEnrichment,
} from '../enrichment.js';
import { blankAsUnset, recidInput } from '../inputs.js';

const OTHER_VARIANT: Record<RunListVariant, RunListVariant> = {
  full: 'muons_only',
  muons_only: 'full',
};

/** Whether a list covers `period`: case-insensitive, and a bare `2012B` matches `Run2012B`. */
function coversPeriod(list: ValidatedRunList, period: string): boolean {
  const key = period.toLowerCase();
  return list.run_periods.some((p) => {
    const lower = p.toLowerCase();
    return lower === key || lower === `run${key}`;
  });
}

/** Which selector the call uses; exactly one of `recid` and `run_period` is required. */
function selectionOf(
  recid: string | undefined,
  runPeriod: string | undefined,
):
  | { kind: 'recid'; recid: string }
  | { kind: 'run_period'; runPeriod: string }
  | 'missing'
  | 'conflicting' {
  if (recid !== undefined && runPeriod !== undefined) return 'conflicting';
  if (recid !== undefined) return { kind: 'recid', recid };
  if (runPeriod !== undefined) return { kind: 'run_period', runPeriod };
  return 'missing';
}

function uniqueByRecid(lists: readonly ValidatedRunList[]): ValidatedRunList[] {
  return lists.filter((list, i) => lists.findIndex((other) => other.recid === list.recid) === i);
}

/** Runs ascending, each with its lumi-section count and ranges. */
function toRuns(runList: RunList) {
  return Object.entries(runList)
    .map(([run, ranges]) => ({
      run: Number(run),
      lumi_sections: ranges.reduce((sum, [first, last]) => sum + (last - first + 1), 0),
      lumi_ranges: ranges.map(([first, last]) => ({ first, last })),
    }))
    .sort((a, b) => a.run - b.run);
}

const MatchedListSchema = z
  .object({
    recid: z.string().describe('Recid of the validated-run list record.'),
    title: z.string().describe('List title; names the reconstruction pass and certification file.'),
    variant: z
      .enum(['full', 'muons_only'])
      .describe('full: every detector certified; muons_only: certified for muon physics only.'),
    run_periods: z
      .array(z.string().describe('One run period.'))
      .describe('Run periods the list covers, such as Run2012B.'),
    collision_energy: z.string().optional().describe('Collision energy, when the list states it.'),
  })
  .describe('One validated-run list the selector matched.');

const SelectedListSchema = z
  .object({
    recid: z.string().describe('Recid of the selected list record.'),
    title: z.string().describe('List title.'),
    file_key: z.string().describe('File key of the good-run list JSON.'),
    variant: z.enum(['full', 'muons_only']).describe('full or muons_only.'),
    run_periods: z
      .array(z.string().describe('One run period.'))
      .describe('Run periods the list covers.'),
    collision_energy: z.string().optional().describe('Collision energy, when the list states it.'),
    https_url: z.string().describe('HTTPS download URL of the whole list file (JSON).'),
    xrootd_uri: z.string().optional().describe('XRootD URI of the list file, when listed.'),
    portal_url: z.string().describe('The list record page on the portal.'),
  })
  .describe('The list whose runs are returned.');

const RunSchema = z
  .object({
    run: z.number().describe('Run number.'),
    lumi_sections: z.number().describe('Luminosity sections certified good in this run.'),
    lumi_ranges: z
      .array(
        z
          .object({
            first: z.number().describe('First luminosity section, inclusive.'),
            last: z.number().describe('Last luminosity section, inclusive.'),
          })
          .describe('One certified luminosity-section range.'),
      )
      .describe('Certified luminosity-section ranges, as listed.'),
  })
  .describe('One certified run.');

const GetValidatedRunsOutput = z.object({
  matched_lists: z
    .array(MatchedListSchema)
    .describe(
      'Every list the selector matched in the requested variant. Several means none was read: call again with recid set to one of them.',
    ),
  list: SelectedListSchema.optional().describe('The selected list, when exactly one matched.'),
  dataset: z
    .object({
      recid: z.string().describe('Recid of the dataset.'),
      title: z.string().optional().describe('Dataset title.'),
      run_period: z
        .array(z.string().describe('One run period.'))
        .optional()
        .describe('Run periods the dataset covers.'),
    })
    .optional()
    .describe('The dataset, when recid named a dataset rather than a list.'),
  summary: z
    .object({
      run_count: z.number().describe('Runs in the whole list.'),
      lumi_section_count: z.number().describe('Luminosity sections in the whole list.'),
      first_run: z.number().optional().describe('Lowest run in the list.'),
      last_run: z.number().optional().describe('Highest run in the list.'),
    })
    .optional()
    .describe('The whole selected list, before run_min/run_max.'),
  runs: z
    .array(RunSchema)
    .describe(
      'Certified runs, ascending, after run_min/run_max and cut at limit; empty when no single list was selected.',
    ),
});

type GetValidatedRunsOut = z.infer<typeof GetValidatedRunsOutput>;
type DatasetOut = NonNullable<GetValidatedRunsOut['dataset']>;

function toMatched(list: ValidatedRunList): z.infer<typeof MatchedListSchema> {
  return definedOnly<z.infer<typeof MatchedListSchema>>({
    recid: list.recid,
    title: list.title,
    variant: list.variant,
    run_periods: list.run_periods,
    collision_energy: list.collision_energy,
  });
}

function toSelected(list: ValidatedRunList): z.infer<typeof SelectedListSchema> {
  return definedOnly<z.infer<typeof SelectedListSchema>>({
    recid: list.recid,
    title: list.title,
    file_key: list.file_key,
    variant: list.variant,
    run_periods: list.run_periods,
    collision_energy: list.collision_energy,
    https_url: `${recordUrl(list.recid)}/files/${encodeURIComponent(list.file_key)}`,
    xrootd_uri: list.xrootd_uri,
    portal_url: recordUrl(list.recid),
  });
}

function joinOrNA(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.map(inline).join(', ') : NOT_AVAILABLE;
}

export const getValidatedRuns = tool('cern_opendata_get_validated_runs', {
  title: 'Get CMS Validated Runs',
  description:
    'Get a CMS validated-run (good-run) list, which certifies the luminosity sections that are good for physics in each run. Select it by a CMS collision dataset recid, a validated-run list recid, or a run period such as Run2012B (give exactly one of recid and run_period). Choose the full validation or the muons-only variant, and narrow to a run range. Returns the runs with their luminosity-section ranges and the list file download URL. CMS only.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    recid: blankAsUnset(recidInput().optional()).describe(
      'A CMS collision dataset recid (its linked list is used) or a validated-run list recid (used as named): digits, recid:N or a portal record URL. Give this or run_period.',
    ),
    run_period: blankAsUnset(
      z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string().max(40).optional(),
      ),
    ).describe(
      'A CMS run period such as Run2012B, matched case-insensitively; 2012B also matches Run2012B. Give this or recid. cern_opendata_list_reference with topic run_periods lists them.',
    ),
    variant: blankAsUnset(z.enum(['full', 'muons_only']).optional()).describe(
      'full (every detector certified) or muons_only (certified for muon physics). Omitted: a list recid is used as named; a dataset recid or run_period selects full.',
    ),
    run_min: blankAsUnset(z.number().int().min(1).optional()).describe(
      'Lowest run to return, inclusive.',
    ),
    run_max: blankAsUnset(z.number().int().min(1).optional()).describe(
      'Highest run to return, inclusive.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(2000).default(200)).describe(
      'Runs to return, 1-2000.',
    ),
  }),
  output: GetValidatedRunsOutput,
  enrichment: listEnrichment('Runs in the selected list after run_min/run_max.'),
  errors: [
    {
      reason: 'missing_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither recid nor run_period was given.',
      recovery:
        'Call cern_opendata_get_validated_runs again with recid (a CMS collision dataset or a validated-run list) or run_period (for example Run2012B); cern_opendata_list_reference with topic run_periods lists the periods.',
      severity: 'notice',
    },
    {
      reason: 'conflicting_selectors',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both recid and run_period were given.',
      recovery:
        'Call cern_opendata_get_validated_runs again with only recid or only run_period, not both.',
      severity: 'notice',
    },
    {
      reason: 'invalid_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'run_min is above run_max.',
      recovery:
        'Set run_min at or below run_max, then call cern_opendata_get_validated_runs again.',
      severity: 'notice',
    },
    {
      reason: 'record_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'recid is not a validated-run list and no record has it.',
      recovery:
        "Call cern_opendata_search_records with experiment CMS and type Dataset::Collision to find the dataset's recid, then call cern_opendata_get_validated_runs with it.",
      severity: 'notice',
    },
    {
      reason: 'no_validated_runs',
      code: JsonRpcErrorCode.NotFound,
      when: 'No list matches: the record links none (simulated, non-CMS or non-collision records), the run period has no list, or the variant has no list for it. The message names which case applied.',
      recovery:
        'Call cern_opendata_list_reference with topic run_periods for the periods that have lists, then call cern_opendata_get_validated_runs with run_period, or with variant full when no muons-only list exists.',
      severity: 'notice',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The portal's 60-a-minute budget is spent: it answered 429, or the request could not start within the call's deadline. data.retryAfter is set.",
      recovery:
        'Wait the retryAfter seconds given in this error (the portal allows 60 requests a minute per IP), then call cern_opendata_get_validated_runs again with the same arguments.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The portal answered with a body the server could not read: not JSON, missing the expected envelope, or over the byte ceiling (then data.retryable is false). Also raised when a list file the collection names answers 404.',
      recovery:
        'Call cern_opendata_get_validated_runs again in a minute; if it repeats, the portal is serving an error page or an oversized response, so read the same data on https://opendata.cern.ch instead.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    startListEnrichment(ctx, input.limit);
    const { recid, run_period: runPeriod, run_min: runMin, run_max: runMax } = input;
    const selection = selectionOf(recid, runPeriod);
    if (selection === 'missing') {
      throw ctx.fail(
        'missing_selector',
        'Give recid or run_period to select a validated-run list.',
      );
    }
    if (selection === 'conflicting') {
      throw ctx.fail(
        'conflicting_selectors',
        `Both recid ${recid} and run_period ${oneLine(String(runPeriod))} were given; they select lists differently.`,
        { recid, run_period: runPeriod },
      );
    }
    if (runMin !== undefined && runMax !== undefined && runMin > runMax) {
      throw ctx.fail('invalid_range', `run_min ${runMin} is above run_max ${runMax}.`, {
        run_min: runMin,
        run_max: runMax,
      });
    }

    const service = getCernOpenDataService();
    const budget = service.startBudget();
    const lists = await service.getValidatedRunLists(budget, ctx);
    const variant = input.variant ?? 'full';
    const fragments: string[] = [];
    let candidates: ValidatedRunList[];
    let selector: string;
    let dataset: DatasetOut | undefined;

    if (selection.kind === 'run_period') {
      const { runPeriod } = selection;
      selector = `run period ${oneLine(runPeriod)}`;
      const covering = lists.filter((list) => coversPeriod(list, runPeriod));
      if (covering.length === 0) {
        throw ctx.fail(
          'no_validated_runs',
          `No CMS validated-run list covers run period ${oneLine(runPeriod)}.`,
          { run_period: runPeriod },
        );
      }
      candidates = covering.filter((list) => list.variant === variant);
      if (candidates.length === 0) {
        throw ctx.fail(
          'no_validated_runs',
          `Run period ${oneLine(runPeriod)} has validated-run lists only in the ${OTHER_VARIANT[variant]} variant, none in ${variant}.`,
          { run_period: runPeriod, variant },
        );
      }
    } else {
      const { recid: selectedRecid } = selection;
      const named = lists.find((list) => list.recid === selectedRecid);
      if (named) {
        selector = `list ${named.recid}`;
        if (input.variant === undefined || input.variant === named.variant) {
          candidates = [named];
        } else {
          const twin = twinOf(named, lists);
          if (!twin) {
            throw ctx.fail(
              'no_validated_runs',
              `List ${named.recid} is the ${named.variant} variant and has no ${input.variant} twin.`,
              { recid: named.recid, variant: input.variant },
            );
          }
          candidates = [twin];
          fragments.push(
            `List ${named.recid} is the ${named.variant} variant; its ${twin.variant} twin ${twin.recid} is returned because variant was set. Call cern_opendata_get_validated_runs with recid ${named.recid} and no variant for the list as named.`,
          );
        }
      } else {
        const datasetRecid = selectedRecid;
        selector = `record ${datasetRecid}`;
        const hit = await service.findRecord(datasetRecid, budget, ctx);
        if (!hit) {
          throw ctx.fail('record_not_found', `No record has recid ${datasetRecid}.`, {
            recid: datasetRecid,
          });
        }
        const meta = hit.metadata;
        dataset = definedOnly<DatasetOut>({
          recid: datasetRecid,
          title: str(meta.title),
          run_period: strList(meta.run_period),
        });
        const linkedRecids = new Set(
          [...(meta.abstract?.links ?? []), ...(meta.note?.links ?? [])].flatMap(
            (link) => str(link?.recid) ?? [],
          ),
        );
        const linked = lists.filter((list) => linkedRecids.has(list.recid));
        if (linked.length === 0) {
          throw ctx.fail(
            'no_validated_runs',
            `Record ${datasetRecid} links no validated-run list; lists exist for CMS collision data only, so simulated, non-CMS and non-collision records have none.`,
            { recid: datasetRecid },
          );
        }
        candidates = uniqueByRecid(
          linked.flatMap((list) =>
            list.variant === variant ? [list] : (twinOf(list, lists) ?? []),
          ),
        );
        if (candidates.length === 0) {
          throw ctx.fail(
            'no_validated_runs',
            `Record ${datasetRecid} links validated-run lists ${linked.map((list) => list.recid).join(', ')} in the ${OTHER_VARIANT[variant]} variant, and none has a ${variant} twin.`,
            { recid: datasetRecid, variant },
          );
        }
      }
    }

    const matchedLists = candidates.map(toMatched);
    const [selected] = candidates;
    if (candidates.length > 1 || !selected) {
      fragments.push(
        `${candidates.length} validated-run lists match ${selector} (variant ${variant}): ${candidates.map((list) => `${list.recid} — ${inline(list.title)}`).join(', ')}. Call cern_opendata_get_validated_runs again with recid set to one of them; they differ by reconstruction pass and intended use, as their titles state.`,
      );
      finishListEnrichment(ctx, {
        shown: 0,
        total: 0,
        cap: input.limit,
        hasMore: false,
        notice: composeNotice(fragments),
      });
      return definedOnly<GetValidatedRunsOut>({
        matched_lists: matchedLists,
        list: undefined,
        dataset,
        summary: undefined,
        runs: [],
      });
    }

    const allRuns = toRuns(
      await service.getRunList(selected.recid, selected.file_key, budget, ctx),
    );
    const firstRun = allRuns[0]?.run;
    const lastRun = allRuns.at(-1)?.run;
    const inRange = allRuns.filter(
      (run) =>
        (runMin === undefined || run.run >= runMin) && (runMax === undefined || run.run <= runMax),
    );
    const runs = inRange.slice(0, input.limit);
    const next = inRange[input.limit];

    if (allRuns.length === 0) {
      fragments.push(`List ${selected.recid} certifies no runs.`);
    } else if (inRange.length === 0) {
      fragments.push(
        `No run of list ${selected.recid} falls in ${runMin ?? firstRun}–${runMax ?? lastRun}; the list covers runs ${firstRun}–${lastRun}.`,
      );
    }
    if (next) {
      fragments.push(
        `Showing ${runs.length} of ${inRange.length} runs; call cern_opendata_get_validated_runs again with run_min set to ${next.run}, or download the whole list from list.https_url.`,
      );
    }

    finishListEnrichment(ctx, {
      shown: runs.length,
      total: inRange.length,
      cap: input.limit,
      hasMore: next !== undefined,
      notice: composeNotice(fragments),
    });

    return definedOnly<GetValidatedRunsOut>({
      matched_lists: matchedLists,
      list: toSelected(selected),
      dataset,
      summary: definedOnly<NonNullable<GetValidatedRunsOut['summary']>>({
        run_count: allRuns.length,
        lumi_section_count: allRuns.reduce((sum, run) => sum + run.lumi_sections, 0),
        first_run: firstRun,
        last_run: lastRun,
      }),
      runs,
    });
  },

  format: (result) => {
    const lines: string[] = [];
    const { list, dataset, summary } = result;
    lines.push(
      list
        ? `## Validated runs: list ${inline(list.recid)} (${list.variant})`
        : `## Validated-run lists (${result.matched_lists.length} matched)`,
    );
    if (dataset) {
      lines.push(
        `**Dataset:** ${inline(dataset.recid)}: ${inlineOrNA(dataset.title)} · **Run periods:** ${joinOrNA(dataset.run_period)}`,
      );
    }

    lines.push(
      '',
      `### Matched lists (${result.matched_lists.length})`,
      '| Recid | Variant | Run periods | Collision energy | Title |',
      '|:------|:--------|:------------|:-----------------|:------|',
      ...result.matched_lists.map(
        (matched) =>
          `| ${inline(matched.recid)} | ${matched.variant} | ${joinOrNA(matched.run_periods)} | ${inlineOrNA(matched.collision_energy)} | ${inline(matched.title)} |`,
      ),
    );

    if (list) {
      lines.push(
        '',
        '### Selected list',
        `**Title:** ${inline(list.title)}`,
        `**Recid:** ${inline(list.recid)} · **Variant:** ${list.variant} · **Run periods:** ${joinOrNA(list.run_periods)} · **Collision energy:** ${inlineOrNA(list.collision_energy)}`,
        `**File key:** ${inline(list.file_key)}`,
        `**HTTPS:** ${printUrl(list.https_url)}`,
        `**XRootD:** ${list.xrootd_uri ? printUrl(list.xrootd_uri) : NOT_AVAILABLE}`,
        `**Portal:** ${printUrl(list.portal_url)}`,
      );
    }
    if (summary) {
      lines.push(
        '',
        `**Whole list:** ${summary.run_count} runs, ${summary.lumi_section_count} luminosity sections, runs ${inlineOrNA(summary.first_run)}–${inlineOrNA(summary.last_run)}`,
      );
    }

    lines.push('', `### Runs (${result.runs.length})`);
    if (result.runs.length === 0) {
      lines.push(
        list ? 'No runs in range.' : 'No list read; pick one recid from the matched lists.',
      );
    } else {
      lines.push(
        '| Run | Lumi sections | Lumi-section ranges |',
        '|----:|--------------:|:--------------------|',
        ...result.runs.map(
          (run) =>
            `| ${run.run} | ${run.lumi_sections} | ${run.lumi_ranges.map((range) => `${range.first}–${range.last}`).join(', ')} |`,
        ),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
