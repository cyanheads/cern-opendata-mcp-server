/**
 * @fileoverview cern_opendata_search_trigger_paths — find CMS High-Level
 * Trigger path records (`Supplementaries::Trigger`) by exact name or prefix
 * pattern, each parsed into its first and last run seen online, per-version run
 * ranges, L1 seeds and HLT menu links. One search per call.
 * @module mcp-server/tools/definitions/search-trigger-paths.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getCernOpenDataService,
  isPageWindowRejection,
  PAGE_WINDOW,
} from '@/services/cern-opendata/cern-opendata-service.js';
import { definedOnly, portalUrlOf, str, strList } from '@/services/cern-opendata/normalize.js';
import {
  countOf,
  fenceHtml,
  inline,
  inlineList,
  inlineOrNA,
  NOT_AVAILABLE,
  noticeValue,
  printUrl,
} from '@/services/cern-opendata/text.js';
import { parseTrigger } from '@/services/cern-opendata/trigger-parse.js';
import type { RawHit, SearchParams } from '@/services/cern-opendata/types.js';
import {
  composeNotice,
  finishListEnrichment,
  lastPageNotice,
  listEnrichment,
  startListEnrichment,
} from '../enrichment.js';
import { blankAsUnset } from '../inputs.js';

/**
 * A path after {@link normalizePathInput}: `HLT_` and at least one name
 * character, or a letter- or digit-led name without that prefix
 * (`AlCa_EcalPi0`, `HLTriggerFinalPath`, `300Tower0p5`, searched as
 * `HLT_300Tower0p5` too), then at most one trailing `*`. An `_`-led name is
 * refused: no path starts `HLT__`. Spelled without a lookahead, which strict
 * tool schemas do not accept in `pattern`: the branches after the first are
 * the names that do not start `HLT_`, by how far they share it (`H`, `HL`,
 * `HLT`).
 */
const PATH_PATTERN =
  /^(?:HLT_[A-Za-z0-9_]+|[0-9A-GI-Za-z][A-Za-z0-9_]*|H(?:[A-KM-Za-z0-9_][A-Za-z0-9_]*)?|HL(?:[A-SU-Za-z0-9_][A-Za-z0-9_]*)?|HLT(?:[A-Za-z0-9][A-Za-z0-9_]*)?)\*?$/;
/** A trailing CMSSW version suffix: `_v<digits>` or `_v*`. */
const VERSION_SUFFIX = /_v(\d+|\*)$/i;
/** Words the portal's query parser reads as operators; a form spelled as one is quoted in {@link formsQuery}. */
const OPERATOR_WORD = /^(?:AND|OR|NOT|TO)$/i;

/** Trim, then canonicalize the case of an `HLT_` prefix (Decision 20). */
function normalizePathInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return /^hlt_/i.test(trimmed) ? `HLT_${trimmed.slice(4)}` : trimmed;
}

/**
 * The names a path is searched as, named in the zero-hit notice: an `HLT_`
 * path alone, any other path as given and with `HLT_` prepended, since the
 * collection holds `AlCa_`, `DST_` and `DQM_` paths and output modules beside
 * the `HLT_` paths (Decision 20).
 */
const searchForms = (path: string): string[] =>
  path.startsWith('HLT_') ? [path] : [path, `HLT_${path}`];

/**
 * The forms OR-joined, an operator word quoted so it reads as a term
 * (Decision 33): the query the zero-hit notice suggests to
 * `cern_opendata_search_records`.
 */
const formsQuery = (forms: string[]): string =>
  forms.map((form) => (OPERATOR_WORD.test(form) ? `"${form}"` : form)).join(' OR ');

/**
 * Every path record's title: this prefix, the path, then optionally
 * ` ({A} dataset)` or ` ({A}, {B} datasets)`. The portal maps `title` as one
 * keyword term, so a wildcard on it anchors at the path's first character.
 */
const PATH_TITLE_PREFIX = 'High-Level Trigger path information ';

/** A `title` keyword term, its spaces and parentheses escaped for the portal's query parser. */
const titleTerm = (text: string): string => `title:${text.replace(/[ ()]/g, '\\$&')}`;

/**
 * Titles whose path is `path`, or starts with it for a trailing `*`, in the
 * case given: the title alone or followed by its dataset suffix.
 */
const titleQuery = (path: string): string =>
  path.endsWith('*')
    ? `${titleTerm(PATH_TITLE_PREFIX + path.slice(0, -1))}*`
    : `title:"${PATH_TITLE_PREFIX}${path}" OR ${titleTerm(`${PATH_TITLE_PREFIX}${path} (`)}*`;

/**
 * The query sent: an `HLT_` path as given; any other path anchored on the
 * record title, or with `HLT_` prepended (Decision 20). A bare term would match
 * every indexed word, dataset names and abstract text included.
 */
const pathQuery = (path: string): string =>
  path.startsWith('HLT_') ? path : `${titleQuery(path)} OR HLT_${path}`;

/**
 * Split a trailing `_v<n>` / `_v*` off the path (the records list versions as
 * `V<n>`). Runs in the handler because the stripped version is echoed in the
 * notice; the input pattern accepts the path with or without it. The strip
 * keeps a path in its family, so `HLT_v3` is not cut to `HLT`.
 */
function splitVersion(path: string): { path: string; version?: string } {
  const match = VERSION_SUFFIX.exec(path);
  if (!match?.[1]) return { path };
  const stripped = path.slice(0, match.index);
  const sameFamily = stripped.startsWith('HLT_') === path.startsWith('HLT_');
  return sameFamily && PATH_PATTERN.test(stripped)
    ? { path: stripped, version: match[1] }
    : { path };
}

const RunSeenSchema = z
  .object({
    run: z.number().describe('Run number.'),
    menu: z
      .string()
      .optional()
      .describe(
        'HLT menu name as the record states it, such as /cdaq/physics/Run2011/5e32/v4.2/HLT/V2.',
      ),
    menu_recid: z
      .string()
      .optional()
      .describe(
        'Recid of the HLT menu record (Supplementaries::Configuration HLT), when linked; cern_opendata_get_records reads it.',
      ),
  })
  .describe('A run where the path was seen online, with the HLT menu in use.');

const VersionSchema = z
  .object({
    version: z
      .number()
      .describe('n of V<n>, the path version (the _v<n> suffix of the CMSSW path name).'),
    run_first: z.number().describe('First run of this version, inclusive.'),
    run_last: z.number().describe('Last run of this version, inclusive.'),
    l1_seed: z
      .string()
      .optional()
      .describe('Level-1 seed as the record states it, such as L1_SingleMu12.'),
  })
  .describe('One path version and its run range.');

const TriggerSchema = z
  .object({
    recid: z.string().describe('Recid of the trigger path record.'),
    portal_url: z.string().describe('The record page on the portal.'),
    path: z.string().optional().describe('Path name from the record title, such as HLT_IsoMu24.'),
    dataset: z
      .string()
      .optional()
      .describe(
        'Primary dataset named in the title, such as SingleMu, when the title names exactly one; absent when it names several (see datasets).',
      ),
    datasets: z
      .array(z.string().describe('One primary dataset name.'))
      .optional()
      .describe(
        'Every primary dataset the title names, in order, such as ["DoubleMu", "DoubleMuParked"]; absent when it names none.',
      ),
    year: z.string().optional().describe('Data-taking year the record covers.'),
    first_seen: RunSeenSchema.optional().describe('First run the path was seen online.'),
    last_seen: RunSeenSchema.optional().describe('Last run the path was seen online.'),
    versions: z
      .array(VersionSchema)
      .describe('Per-version run ranges, as parsed from the record; empty when none parsed.'),
    trigger_list_recid: z
      .string()
      .optional()
      .describe(
        "Recid of the year's full CMS trigger-list record, when linked; cern_opendata_get_records reads it.",
      ),
    parsed: z
      .boolean()
      .describe(
        'False when the first-seen line or every version line could not be parsed; read abstract_html then.',
      ),
    abstract_html: z
      .string()
      .optional()
      .describe(
        'The record abstract as the portal sent it (HTML), the source of every parsed field.',
      ),
  })
  .describe('One trigger path record (one path in one data-taking year).');

const SearchTriggerPathsOutput = z.object({
  page: z.number().describe('The page returned.'),
  has_more: z
    .boolean()
    .describe(
      'True when the next page holds matches and lies within the first 10,000. False on the last reachable page even when more matches exist; truncated and notice say so.',
    ),
  triggers: z.array(TriggerSchema).describe('Matching trigger path records on this page.'),
});

type TriggerOut = z.infer<typeof TriggerSchema>;
type RunSeenOut = z.infer<typeof RunSeenSchema>;

function toTrigger(hit: RawHit): TriggerOut {
  const meta = hit.metadata;
  const parsed = parseTrigger(meta);
  return definedOnly<TriggerOut>({
    recid: str(meta.recid) ?? String(hit.id),
    portal_url: portalUrlOf(hit),
    path: parsed.path,
    dataset: parsed.dataset,
    datasets: parsed.datasets,
    year: strList(meta.date_created)?.[0],
    first_seen: parsed.first_seen,
    last_seen: parsed.last_seen,
    versions: parsed.versions,
    trigger_list_recid: parsed.trigger_list_recid,
    parsed: parsed.parsed,
    abstract_html: str(meta.abstract?.description),
  });
}

function renderSeen(label: string, seen: RunSeenOut | undefined): string {
  if (!seen) return `**${label}:** ${NOT_AVAILABLE}`;
  const menu = seen.menu ? `, menu ${inline(seen.menu)}` : '';
  const record = seen.menu_recid ? ` (record ${inline(seen.menu_recid)})` : '';
  return `**${label}:** run ${seen.run}${menu}${record}`;
}

function renderTrigger(trigger: TriggerOut): string[] {
  const several = (trigger.datasets?.length ?? 0) > 1;
  const datasets = trigger.datasets?.length
    ? ` (${inlineList(trigger.datasets)} ${several ? 'datasets' : 'dataset'})`
    : '';
  const lines = [
    `### ${inlineOrNA(trigger.path)}${datasets}, ${inlineOrNA(trigger.year)}`,
    `**Recid:** ${inline(trigger.recid)} · **Year:** ${inlineOrNA(trigger.year)} · ${several ? '**Datasets:**' : '**Dataset:**'} ${inlineList(trigger.datasets)} · **Portal:** ${printUrl(trigger.portal_url)}`,
    renderSeen('First seen', trigger.first_seen),
    renderSeen('Last seen', trigger.last_seen),
    `**Trigger list record:** ${inlineOrNA(trigger.trigger_list_recid)} · **Parsed:** ${trigger.parsed ? 'yes' : 'no'}`,
  ];
  if (trigger.versions.length > 0) {
    lines.push(
      '',
      '| Version | First run | Last run | L1 seed |',
      '|:--------|----------:|---------:|:--------|',
      ...trigger.versions.map(
        (version) =>
          `| V${version.version} | ${version.run_first} | ${version.run_last} | ${inlineOrNA(version.l1_seed)} |`,
      ),
    );
  } else {
    lines.push('**Versions:** none parsed');
  }
  lines.push(
    '',
    trigger.abstract_html
      ? `**Abstract (as text, the source of the fields above):**\n${fenceHtml(trigger.abstract_html)}`
      : `**Abstract:** ${NOT_AVAILABLE}`,
  );
  return lines;
}

export const searchTriggerPaths = tool('cern_opendata_search_trigger_paths', {
  title: 'Search CMS Trigger Paths',
  description:
    'Look up CMS High-Level Trigger paths by exact name (HLT_IsoMu24) or prefix pattern (HLT_IsoMu*), optionally for one data-taking year. Paths outside the HLT_ family, such as AlCa_EcalPi0, DST_ and DQM_ paths, output modules and HLTriggerFinalPath, are found by their own names, in the case given. Each match is a per-year path record parsed into the primary datasets its title names, the first and last run the path was seen online, per-version run ranges, the L1 seed, and links to the HLT menu records. Covers CMS open data from 2011-2016. Prescale tables are not published.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    path: z
      .preprocess(
        normalizePathInput,
        z
          .string()
          .max(200)
          .regex(
            PATH_PATTERN,
            'A path is a letter or digit followed by letters, digits and underscores, with at most one trailing * (HLT_IsoMu24, AlCa_EcalPi0 or HLT_IsoMu*); HLT_ alone is not a path.',
          ),
      )
      .describe(
        'Trigger path name (HLT_IsoMu24, AlCa_EcalPi0) or prefix with one trailing wildcard (HLT_IsoMu*): a letter or digit, then letters, digits and underscores. Trimmed. A path starting HLT_ in any case is searched as given, with the prefix case fixed, and matches path names in any case. Any other path is matched against record path names in the case given, the whole name or, with a trailing *, its start (AlCa_EcalPi0, AlCa_*), and is also searched with HLT_ prepended (IsoMu24 finds HLT_IsoMu24, 60Jet10 finds HLT_60Jet10). A trailing version suffix (_v3 or _v*) is dropped, since records list versions as V<n>.',
      ),
    year: blankAsUnset(z.number().int().min(2000).max(2100).optional()).describe(
      'Data-taking year, such as 2012. Trigger records cover 2011-2016.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(50).default(10)).describe(
      'Records per page, 1-50.',
    ),
    page: blankAsUnset(z.number().int().min(1).default(1)).describe(
      'Page number, from 1. page × limit may not exceed 10,000.',
    ),
  }),
  output: SearchTriggerPathsOutput,
  enrichment: {
    ...listEnrichment('Trigger path records matching the path (and year).'),
    effectiveQuery: z
      .string()
      .describe(
        'The query sent, after normalization (version suffix dropped): an HLT_ path as given; any other path as title clauses matching it as a record path name, OR HLT_ plus the path.',
      ),
  },
  errors: [
    {
      reason: 'page_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page × limit exceeds 10,000, the deepest match the portal pages to.',
      recovery:
        'Add year or a longer path prefix to narrow the match, then call cern_opendata_search_trigger_paths again from page 1.',
      severity: 'notice',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The portal's 60-a-minute budget is spent: it answered 429, or the request could not start within the call's deadline. data.retryAfter is set.",
      recovery:
        'Wait the retryAfter seconds given in this error (the portal allows 60 requests a minute per IP), then call cern_opendata_search_trigger_paths again with the same arguments.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The portal answered with a body the server could not read: not JSON, missing the expected envelope, or over the byte ceiling (then data.retryable is false). Also raised when a search answers 404.',
      recovery:
        'Call cern_opendata_search_trigger_paths again in a minute; if it repeats, the portal is serving an error page or an oversized response, so read the same data on https://opendata.cern.ch instead.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { path, version } = splitVersion(input.path);
    const forms = searchForms(path);
    const query = pathQuery(path);
    startListEnrichment(ctx, input.limit);
    ctx.enrich.echo(query);

    /** With year already set, the only narrowing left to suggest is a longer prefix. */
    const yearSet = input.year !== undefined;
    const windowRecovery = yearSet
      ? {
          recovery: {
            hint: 'Use a longer path prefix to narrow the match, then call cern_opendata_search_trigger_paths again from page 1.',
          },
        }
      : {};

    if (input.page * input.limit > PAGE_WINDOW) {
      throw ctx.fail(
        'page_window_exceeded',
        `page ${input.page} × limit ${input.limit} reaches past match ${PAGE_WINDOW}, the deepest the portal pages to.`,
        { page: input.page, limit: input.limit, window: PAGE_WINDOW, ...windowRecovery },
      );
    }

    const service = getCernOpenDataService();
    const params: SearchParams = {
      q: query,
      type: ['Supplementaries::Trigger'],
      experiment: ['CMS'],
      ...(input.year === undefined ? {} : { year: `${input.year}--${input.year}` }),
      sort: 'bestmatch',
      size: input.limit,
      page: input.page,
      skipFiles: true,
    };
    const outcome = await service.search(params, service.startBudget(), ctx);

    if (outcome.kind === 'server_error') throw outcome.error;
    if (outcome.kind === 'rejected') {
      const { rejection } = outcome;
      if (isPageWindowRejection(rejection)) {
        throw ctx.fail(
          'page_window_exceeded',
          `The portal refused the page: ${noticeValue(rejection.message)}`,
          { upstreamMessage: rejection.message, ...windowRecovery },
        );
      }
      throw internalError(
        `CERN Open Data rejected a query this server built: ${noticeValue(rejection.message)}`,
        {
          upstreamMessage: rejection.message,
          ...(rejection.errors ? { upstreamErrors: rejection.errors } : {}),
        },
      );
    }

    const { page } = outcome;
    const triggers = page.hits.map(toTrigger);
    const truncated = page.total > input.page * input.limit;
    const hasMore = truncated && (input.page + 1) * input.limit <= PAGE_WINDOW;

    const fragments: string[] = [];
    if (version !== undefined) {
      fragments.push(
        version === '*'
          ? `Path versions are listed per record as V<n>; ${input.path} names every version of ${path}.`
          : `Path versions are listed per record as V<n>; ${input.path} is version ${version} of ${path}.`,
      );
    }
    if (page.total === 0) {
      const inYear = yearSet ? ` in ${input.year}` : '';
      const dropYear = yearSet ? ' drop year,' : '';
      const named = forms.map((form) => `"${form}"`).join(' or ');
      fragments.push(
        `No CMS HLT path record matches ${named}${inYear}; path records cover CMS open data from 2011-2016. Try a prefix pattern such as HLT_IsoMu*,${dropYear} or call cern_opendata_search_records with query ${formsQuery(forms)} to search other record types.`,
      );
    } else if (triggers.length === 0) {
      const last = Math.max(1, Math.ceil(Math.min(page.total, PAGE_WINDOW) / input.limit));
      fragments.push(
        `Page ${input.page} is past the last page (${countOf(page.total, 'match', 'matches')}); call cern_opendata_search_trigger_paths again with page ${last}.`,
      );
    }
    if (truncated) {
      const from = (input.page - 1) * input.limit + 1;
      const to = from + triggers.length - 1;
      fragments.push(
        hasMore
          ? `Showing ${from}–${to} of ${page.total}; call cern_opendata_search_trigger_paths again with page ${input.page + 1}${yearSet ? '' : ', or add year'}.`
          : lastPageNotice(
              'cern_opendata_search_trigger_paths',
              yearSet ? 'Use a longer path prefix' : 'Add year or a longer path prefix',
              {
                from,
                to,
                total: page.total,
                limit: input.limit,
              },
            ),
      );
    }

    finishListEnrichment(ctx, {
      shown: triggers.length,
      total: page.total,
      cap: input.limit,
      truncated,
      notice: composeNotice(fragments),
    });

    return { page: input.page, has_more: hasMore, triggers };
  },

  format: (result) => {
    const lines = [
      `**Page:** ${result.page} · **More pages:** ${result.has_more ? 'yes' : 'no'} · **Records on this page:** ${result.triggers.length}`,
    ];
    if (result.triggers.length === 0) lines.push('', 'No trigger path records on this page.');
    for (const trigger of result.triggers) lines.push('', ...renderTrigger(trigger));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
