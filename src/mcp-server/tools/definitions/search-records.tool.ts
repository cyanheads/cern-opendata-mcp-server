/**
 * @fileoverview cern_opendata_search_records — faceted search across the CERN
 * Open Data Portal (datasets, software, environments, documentation,
 * supplementaries, news) with exact-vocabulary filters, an optional full-text
 * query, and live facet counts.
 * @module mcp-server/tools/definitions/search-records.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { RecordTypeSchema, renderRecordType } from '@/mcp-server/record-schema.js';
import {
  getCernOpenDataService,
  isPageWindowRejection,
  PAGE_WINDOW,
} from '@/services/cern-opendata/cern-opendata-service.js';
import {
  definedOnly,
  FACET_KEYS,
  glossaryFacetCount,
  toFacets,
  toSearchHit,
} from '@/services/cern-opendata/normalize.js';
import {
  type DelimiterProblem,
  findUnbalancedDelimiter,
} from '@/services/cern-opendata/query-syntax.js';
import {
  countOf,
  fence,
  inline,
  inlineSpelling,
  noticeValue,
  printUrl,
} from '@/services/cern-opendata/text.js';
import type { SearchParams, SortKey } from '@/services/cern-opendata/types.js';
import {
  PARAM_TOPIC,
  SEARCHABLE_TYPE_PRIMARIES,
  SPELLING_EXPANSIONS,
  VOCABULARY_PARAMS,
  type VocabularyParam,
} from '@/services/cern-opendata/vocabulary.js';
import {
  composeNotice,
  finishListEnrichment,
  lastPageNotice,
  listEnrichment,
  startListEnrichment,
} from '../enrichment.js';
import { blankAsUnset, listInput, unrecognizedValues, vocabularyListInput } from '../inputs.js';

const SORTS = ['bestmatch', 'mostrecent', 'title', 'title_desc'] as const;

/** The upstream spelling of each sort: the portal takes direction only from a `-` prefix. */
const UPSTREAM_SORT: Record<(typeof SORTS)[number], SortKey> = {
  bestmatch: 'bestmatch',
  mostrecent: '-mostrecent',
  title: 'title',
  title_desc: '-title',
};

const stringList = (item: string, list: string) =>
  z.array(z.string().describe(item)).optional().describe(list);

const SearchHitSchema = z
  .object({
    id: z
      .string()
      .describe('Portal id: the recid for records, the slug for documentation and news.'),
    recid: z
      .string()
      .optional()
      .describe('Record id; pass it to cern_opendata_get_records or cern_opendata_list_files.'),
    slug: z
      .string()
      .optional()
      .describe('Documentation or news slug; pass it to cern_opendata_get_records.'),
    title: z.string().optional().describe('Title as the portal states it.'),
    title_additional: z.string().optional().describe('Descriptive secondary title.'),
    type: RecordTypeSchema,
    experiment: stringList('One experiment name.', 'Experiments, such as CMS or ATLAS.'),
    run_period: stringList('One run period.', 'Run periods, such as Run2012B.'),
    date_created: stringList('One year or date.', 'Data-taking or creation years.'),
    collections: stringList('One collection name.', 'Portal collections the record belongs to.'),
    formats: stringList(
      'One file format or data tier.',
      'File formats and data tiers, such as aod or nanoaod.',
    ),
    doi: z.string().optional().describe('DOI to cite.'),
    date_published: z.string().optional().describe('Publication date on the portal.'),
    availability: z
      .string()
      .optional()
      .describe('Record-level availability: online, partial, ondemand or requested.'),
    collision_energy: z.string().optional().describe('Collision energy, such as 8TeV.'),
    collision_type: z.string().optional().describe('Collision type, such as pp or PbPb.'),
    number_events: z.number().optional().describe('Number of events.'),
    number_files: z.number().optional().describe('Number of files.'),
    size_in_bytes: z.number().optional().describe('Total size in bytes.'),
    short_description: z
      .string()
      .optional()
      .describe('Docs and news: the short description, as received.'),
    portal_url: z.string().describe('The record or documentation page on opendata.cern.ch.'),
  })
  .describe('One matching record, compact; cern_opendata_get_records returns the full metadata.');

const BucketSchema = z
  .object({
    value: z.string().describe('As its filter takes it.'),
    count: z.number().describe('Records.'),
  })
  .describe('One facet value.');

/** Only the type facet's buckets carry subtypes, so only its schema declares them. */
const TypeBucketSchema = BucketSchema.extend({
  subtypes: z
    .array(
      z
        .object({
          value: z.string().describe('Secondary type.'),
          count: z.number().describe('Records with it.'),
        })
        .describe('One secondary type.'),
    )
    .optional()
    .describe('Secondary types of this primary type.'),
}).describe('One primary type.');

/** Only the category facet's buckets carry subcategories, so only its schema declares them. */
const CategoryBucketSchema = BucketSchema.extend({
  subcategories: z
    .array(
      z
        .object({
          value: z.string().describe('Secondary category.'),
          count: z.number().describe('Records with it.'),
        })
        .describe('One secondary category.'),
    )
    .optional()
    .describe('Secondary categories of this primary category.'),
}).describe('One primary category.');

const facetSchema = <B extends z.ZodType>(what: string, bucket: B) =>
  z
    .object({
      buckets: z.array(bucket).describe('Values with counts.'),
      other_count: z.number().describe('Records past the bucket cap.'),
    })
    .describe(what);

const AppliedFiltersSchema = z
  .object({
    query: z.string().optional().describe('The full-text query, as sent.'),
    type: z
      .array(z.string().describe('One type.'))
      .describe('Types sent (OR); the six served primaries when type_defaulted.'),
    type_defaulted: z
      .boolean()
      .describe('True when type was omitted and the six served primaries were sent.'),
    experiment: stringList('One experiment.', 'Experiments sent (OR).'),
    collision_energy: stringList('One energy.', 'Collision energies sent (OR).'),
    collision_type: stringList('One collision type.', 'Collision types requested (OR).'),
    file_type: stringList('One file type.', 'File types sent (OR).'),
    year: z
      .string()
      .optional()
      .describe('Data-taking year range sent: from--to, from-- or --to (inclusive).'),
    number_events: z
      .string()
      .optional()
      .describe('Event-count range sent: min--max, min-- or --max (inclusive).'),
    availability: stringList('One availability state.', 'Availability states sent (OR).'),
    collection: stringList('One collection.', 'Collections sent (OR).'),
    category: stringList('One category.', 'Categories requested (OR).'),
    keywords: stringList('One keyword.', 'Keywords sent (OR).'),
    magnet_polarity: stringList('One polarity.', 'Magnet polarities sent (OR).'),
    stripping_stream: stringList('One stream.', 'Stripping streams sent (OR).'),
    stripping_version: stringList('One version.', 'Stripping versions sent (OR).'),
    sort: z.enum(SORTS).describe('The sort that ran.'),
    sort_defaulted: z
      .boolean()
      .describe(
        'True when sort was omitted, so the server chose it: bestmatch with a query, mostrecent (newest first) without.',
      ),
    include_ondemand: z
      .literal(true)
      .describe('Tape-resident (ondemand) records are always included.'),
    expanded: z
      .array(
        z
          .object({
            param: z.string().describe('Filter parameter.'),
            value: z.string().describe('Requested value.'),
            sent: z
              .array(z.string().describe('One upstream spelling.'))
              .describe('Upstream spellings sent for it.'),
          })
          .describe('One expanded value.'),
      )
      .optional()
      .describe('Values sent as several upstream spellings.'),
    unrecognized_values: z
      .array(
        z
          .object({
            param: z.enum(VOCABULARY_PARAMS).describe('Filter parameter.'),
            value: z.string().describe('The value as sent.'),
          })
          .describe('One unrecognized value.'),
      )
      .optional()
      .describe(
        'Values not in the verified vocabulary, sent as given; cern_opendata_list_reference lists the accepted spellings.',
      ),
  })
  .describe('The filters as the server applied them.');

type AppliedFilters = z.infer<typeof AppliedFiltersSchema>;
type HitOut = z.infer<typeof SearchHitSchema>;

interface NestedOut {
  count: number;
  value: string;
}

/** Any facet's shape; only type buckets carry subtypes and only category buckets subcategories. */
interface FacetOut {
  buckets: {
    count: number;
    subcategories?: NestedOut[] | undefined;
    subtypes?: NestedOut[] | undefined;
    value: string;
  }[];
  other_count: number;
}

/** `a--b`, `a--` or `--b`; `undefined` when neither bound is set (Decision 19). */
function composeRange(from: number | undefined, to: number | undefined): string | undefined {
  if (from === undefined && to === undefined) return;
  return `${from ?? ''}--${to ?? ''}`;
}

/**
 * The upstream values sent for a filter: each value with several stored
 * spellings expands to all of them (Decision 8), deduped in order.
 */
function sentSpellings(param: VocabularyParam, values: string[] | undefined): string[] | undefined {
  const spellings = SPELLING_EXPANSIONS[param];
  if (values === undefined || spellings === undefined) return values;
  return [...new Set(values.flatMap((value) => spellings.get(value) ?? [value]))];
}

/** The `invalid_query` message for a query the delimiter scan refused. */
function delimiterProblem({ character, position, problem }: DelimiterProblem): string {
  switch (problem) {
    case 'unclosed':
      return `its ${character} at character ${position} is never closed`;
    case 'unopened':
      return `its ${character} at character ${position} closes nothing opened before it`;
    case 'dangling_escape':
      return `it ends with a ${character} that escapes nothing`;
  }
}

function joined(values: readonly string[]): string {
  return values.map(inline).join(', ');
}

function renderHit(hit: HitOut): string[] {
  const facts = [
    `**id:** ${inline(hit.id)}`,
    hit.recid !== undefined && hit.recid !== hit.id ? `**recid:** ${inline(hit.recid)}` : '',
    hit.slug !== undefined && hit.slug !== hit.id ? `**slug:** ${inline(hit.slug)}` : '',
    `**type:** ${renderRecordType(hit.type)}`,
    hit.experiment ? `**experiment:** ${joined(hit.experiment)}` : '',
    hit.collision_energy ? `**energy:** ${inline(hit.collision_energy)}` : '',
    hit.collision_type ? `**collision:** ${inline(hit.collision_type)}` : '',
    hit.run_period ? `**run period:** ${joined(hit.run_period)}` : '',
    hit.date_created ? `**year:** ${joined(hit.date_created)}` : '',
    hit.formats ? `**formats:** ${joined(hit.formats)}` : '',
    hit.number_events !== undefined ? `**events:** ${hit.number_events}` : '',
    hit.number_files !== undefined ? `**files:** ${hit.number_files}` : '',
    hit.size_in_bytes !== undefined ? `**size:** ${countOf(hit.size_in_bytes, 'byte')}` : '',
    hit.availability ? `**availability:** ${inline(hit.availability)}` : '',
    hit.doi ? `**DOI:** ${inline(hit.doi)}` : '',
    hit.date_published ? `**published:** ${inline(hit.date_published)}` : '',
    hit.collections ? `**collections:** ${joined(hit.collections)}` : '',
  ].filter(Boolean);
  const lines = [`### ${inline(hit.title ?? hit.id)}`];
  if (hit.title_additional) lines.push(`**Also titled:** ${inline(hit.title_additional)}`);
  lines.push(facts.join(' · '));
  if (hit.short_description) lines.push(fence(hit.short_description));
  lines.push(printUrl(hit.portal_url));
  return lines;
}

/** Facet values render through `inlineSpelling`, so ` Heavy-Ion Physics` stays apart from `Heavy-Ion Physics`. */
function renderFacet(name: string, facet: FacetOut): string {
  const buckets = facet.buckets.map((bucket) => {
    const nested = bucket.subtypes ?? bucket.subcategories;
    const level = nested?.length
      ? `: ${nested.map((sub) => `${inlineSpelling(sub.value)} ${sub.count}`).join(', ')}`
      : '';
    return `${inlineSpelling(bucket.value)} (${bucket.count}${level})`;
  });
  const other = facet.other_count > 0 ? ` · other values: ${facet.other_count}` : '';
  return `- **${name}:** ${buckets.length > 0 ? buckets.join(', ') : 'none'}${other}`;
}

function renderAppliedFilters(filters: AppliedFilters): string {
  const list = (values: readonly string[] | undefined) =>
    values?.length ? values.map(inline).join(', ') : undefined;
  const rows: [string, string | undefined][] = [
    ['query', filters.query === undefined ? undefined : inline(filters.query)],
    ['type', `${list(filters.type) ?? 'none'}${filters.type_defaulted ? ' (defaulted)' : ''}`],
    ['experiment', list(filters.experiment)],
    ['collision_energy', list(filters.collision_energy)],
    ['collision_type', list(filters.collision_type)],
    ['file_type', list(filters.file_type)],
    ['year', filters.year],
    ['number_events', filters.number_events],
    ['availability', list(filters.availability)],
    ['collection', list(filters.collection)],
    ['category', list(filters.category)],
    ['keywords', list(filters.keywords)],
    ['magnet_polarity', list(filters.magnet_polarity)],
    ['stripping_stream', list(filters.stripping_stream)],
    ['stripping_version', list(filters.stripping_version)],
    ['sort', `${filters.sort}${filters.sort_defaulted ? ' (defaulted)' : ''}`],
    ['include_ondemand', String(filters.include_ondemand)],
    [
      'expanded',
      filters.expanded
        ?.map((e) => `${e.param} ${inline(e.value)} → ${e.sent.map(inlineSpelling).join(', ')}`)
        .join('; '),
    ],
    [
      'unrecognized_values',
      filters.unrecognized_values?.map((u) => `${u.param} ${inline(u.value)}`).join('; '),
    ],
  ];
  const lines = rows.flatMap(([label, value]) =>
    value === undefined ? [] : [`- **${label}:** ${value}`],
  );
  return ['**Applied filters:**', ...lines].join('\n');
}

export const searchRecords = tool('cern_opendata_search_records', {
  title: 'Search CERN Open Data Records',
  description:
    "Search the CERN Open Data Portal's datasets, software, environments, documentation and supplementary records with exact-vocabulary filters and an optional full-text query. The filters are experiment, record type, physics category, keyword, collision energy and type, file format, data-taking year, event count, availability, collection, and LHCb magnet polarity, stripping stream and stripping version. Returns compact hits with recids plus live facet counts. Each facet ignores its own filter, so its counts show the alternatives under the other filters. Filter values are exact upstream; common spellings are normalized, and cern_opendata_list_reference lists the vocabulary. Paging reaches the first 10,000 matches.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: blankAsUnset(z.string().max(500).optional()).describe(
      'Full-text query, sent verbatim as an OpenSearch query_string (AND between terms; title matches weigh double). Field forms such as title:"…", recid:(1 OR 2) or run_period:("Run2012B") work; cern_opendata_list_reference with topic query_syntax lists them. Omit to browse by filters alone.',
    ),
    type: vocabularyListInput('type', 7).describe(
      'Record types (OR): a primary (Dataset, Documentation, Environment, Software, Supplementaries, News) or Primary::Secondary such as Dataset::Collision or Dataset::Simulated. Array or comma-separated string, up to 7. Omit for every served type; Glossary is not served.',
    ),
    experiment: vocabularyListInput('experiment', 9).describe(
      'Experiments (OR): ALICE, ATLAS, CMS, DELPHI, JADE, LHCb, OPERA, PHENIX, TOTEM. Array or comma-separated string, up to 9; case is normalized.',
    ),
    collision_energy: vocabularyListInput('collision_energy', 15).describe(
      'Collision energies (OR), such as 7TeV, 8TeV, 13TeV or 5.02TeV. Array or comma-separated string, up to 15; "13TeV, 13.6TeV" is one upstream value and is kept whole.',
    ),
    collision_type: vocabularyListInput('collision_type', 6).describe(
      'Collision types (OR): pp, PbPb, pPb, e+e-, Interfill. PbPb also matches the Pb-Pb spelling. Array or comma-separated string, up to 6.',
    ),
    file_type: vocabularyListInput('file_type', 20).describe(
      'File formats and data tiers (OR), such as nanoaod, miniaod, aod, root, DAOD_PHYSLITE or csv. Array or comma-separated string, up to 20; case is normalized for known values.',
    ),
    year_from: blankAsUnset(z.number().int().min(1900).max(2100).optional()).describe(
      'Earliest data-taking year, inclusive. Alone, it means this year onward; for one year, set year_from and year_to to it.',
    ),
    year_to: blankAsUnset(z.number().int().min(1900).max(2100).optional()).describe(
      'Latest data-taking year, inclusive. Alone, it means up to this year.',
    ),
    min_events: blankAsUnset(z.number().int().min(0).optional()).describe(
      'Minimum number of events, inclusive.',
    ),
    max_events: blankAsUnset(z.number().int().min(0).optional()).describe(
      'Maximum number of events, inclusive.',
    ),
    availability: vocabularyListInput('availability', 4).describe(
      'Record availability (OR): online, partial, ondemand (on tape, requested before download) or requested. Array or comma-separated string, up to 4.',
    ),
    collection: listInput(
      10,
      z.string().max(100).describe('One collection name, exact and case-sensitive.'),
    ).describe(
      "Portal collections (OR), exact and case-sensitive, such as CMS-Validated-Runs; copy spellings from a record's collections field. Array or comma-separated string, up to 10.",
    ),
    category: vocabularyListInput('category', 20).describe(
      'Physics categories of simulated datasets (OR): a primary such as Exotica, Higgs Physics, Standard Model Physics or Supersymmetry, or Primary::Secondary such as Higgs Physics::Standard Model. Array or comma-separated string, up to 20; case and the separator are normalized, and a known value holding a comma is kept whole. Heavy-Ion Physics also matches its leading-space spelling. cern_opendata_list_reference topic categories lists every value.',
    ),
    keywords: listInput(
      10,
      z.string().max(100).describe('One keyword, exact and case-sensitive.'),
    ).describe(
      'Record keywords (OR), exact and case-sensitive (Education and education differ), sent as given. Array or comma-separated string, up to 10; pass a keyword holding a comma in an array.',
    ),
    magnet_polarity: vocabularyListInput('magnet_polarity', 2).describe(
      'LHCb magnet polarities (OR): MagDown or MagUp, set on LHCb collision datasets. Array or comma-separated string, up to 2; case is normalized.',
    ),
    stripping_stream: vocabularyListInput('stripping_stream', 11).describe(
      'LHCb stripping streams (OR), such as BHADRON, CHARM, DIMUON, EW or LEPTONIC; they also match LHCb stripping documentation. Array or comma-separated string, up to 11; case is normalized. cern_opendata_list_reference topic lhcb lists them.',
    ),
    stripping_version: vocabularyListInput('stripping_version', 12).describe(
      'LHCb stripping versions (OR), such as stripping21 or stripping21r1p2. Array or comma-separated string, up to 12; case is normalized.',
    ),
    sort: blankAsUnset(z.enum(SORTS).optional()).describe(
      'bestmatch (relevance), mostrecent (by date_published, newest first), title (A-Z) or title_desc (Z-A). Omitted: bestmatch with a query, mostrecent (newest first) without.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(50).default(10)).describe(
      'Hits per page, 1-50.',
    ),
    page: blankAsUnset(z.number().int().min(1).default(1)).describe(
      'Page number, from 1. page × limit may not exceed 10,000.',
    ),
  }),
  output: z.object({
    hits: z.array(SearchHitSchema).describe('Matching records on this page.'),
    page: z.number().describe('The page returned.'),
    has_more: z
      .boolean()
      .describe(
        'True when the next page holds matches and lies within the first 10,000. False on the last reachable page even when more matches exist; truncated and notice say so.',
      ),
    facets: z
      .object({
        experiment: facetSchema('Matches by experiment.', BucketSchema),
        type: facetSchema(
          'Matches by primary type, each with its secondary types.',
          TypeBucketSchema,
        ),
        collision_energy: facetSchema('Matches by collision energy.', BucketSchema),
        collision_type: facetSchema('Matches by collision type.', BucketSchema),
        file_type: facetSchema('Matches by file format or data tier.', BucketSchema),
        availability: facetSchema('Matches by record availability.', BucketSchema),
        year: facetSchema('Matches by data-taking year.', BucketSchema),
        number_events: facetSchema('Matches by event-count range.', BucketSchema),
        category: facetSchema(
          'Matches by physics category, each with its secondary categories.',
          CategoryBucketSchema,
        ),
        keywords: facetSchema('Matches by keyword.', BucketSchema),
        magnet_polarity: facetSchema('Matches by LHCb magnet polarity.', BucketSchema),
        stripping_stream: facetSchema('Matches by LHCb stripping stream.', BucketSchema),
        stripping_version: facetSchema('Matches by LHCb stripping version.', BucketSchema),
      })
      .describe(
        'Live facet counts. Each facet ignores its own filter, so its counts show the alternatives under the other filters. Terms facets list the first 10 values alphabetically (file_type up to 100). other_count is 0 for year and number_events.',
      ),
  }),
  enrichment: {
    ...listEnrichment('Total matches for the query and filters.'),
    applied_filters: AppliedFiltersSchema,
  },
  enrichmentTrailer: {
    applied_filters: { render: renderAppliedFilters },
  },
  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'query leaves a parenthesis, range bracket or double quote unbalanced, or ends in an escaping backslash (refused before any request); or the portal rejected the query string (invalid query syntax), or answered another 400 the server did not anticipate, whose upstream message is carried.',
      recovery:
        'Quote phrases, balance parentheses, brackets and double quotes, or escape or drop special characters, then call cern_opendata_search_records again; cern_opendata_list_reference with topic query_syntax lists the field forms.',
      severity: 'notice',
    },
    {
      reason: 'query_server_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every attempt of a search with query set answered HTTP 500, as the portal does for some malformed queries in place of its 400 syntax rejection.',
      recovery:
        'Check query for an operator or field name with nothing after it (AND, OR, NOT, title:), a stray colon or an unescaped special character, and fix it; only if the query is well formed, call cern_opendata_search_records again in a minute.',
    },
    {
      reason: 'page_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page × limit exceeds 10,000, the deepest match the portal pages to.',
      recovery:
        'Narrow the search with filters such as experiment, type, file_type or year_from (the facets show how matches split), then call cern_opendata_search_records again from page 1.',
      severity: 'notice',
    },
    {
      reason: 'invalid_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'year_from is after year_to, or min_events is above max_events.',
      recovery:
        'Correct the bounds so the lower one is not above the upper one, then call cern_opendata_search_records again.',
      severity: 'notice',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The portal's 60-a-minute budget is spent: it answered 429, or the request could not start within the call's deadline. data.retryAfter is set.",
      recovery:
        'Wait the retryAfter seconds given in this error (the portal allows 60 requests a minute per IP), then call cern_opendata_search_records again with the same arguments.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The portal answered with a body the server could not read: not JSON, missing the expected envelope, or over the byte ceiling (then data.retryable is false). Also raised when a search answers 404.',
      recovery:
        'Call cern_opendata_search_records again in a minute; if it repeats, the portal is serving an error page or an oversized response, so read the same data on https://opendata.cern.ch instead.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const typeDefaulted = input.type === undefined;
    const sortDefaulted = input.sort === undefined;
    const sort = input.sort ?? (input.query === undefined ? 'mostrecent' : 'bestmatch');
    const year = composeRange(input.year_from, input.year_to);
    const numberEvents = composeRange(input.min_events, input.max_events);
    const sent = (param: VocabularyParam) => sentSpellings(param, input[param]);
    const expanded = VOCABULARY_PARAMS.flatMap((param) =>
      (input[param] ?? []).flatMap((value) => {
        const spellings = SPELLING_EXPANSIONS[param]?.get(value);
        return spellings ? [{ param, value, sent: [...spellings] }] : [];
      }),
    );
    const sentType = sent('type') ?? [...SEARCHABLE_TYPE_PRIMARIES];
    const unrecognized = VOCABULARY_PARAMS.flatMap((param) =>
      unrecognizedValues(param, input[param]),
    );

    startListEnrichment(ctx, input.limit);
    ctx.enrich({
      applied_filters: definedOnly<AppliedFilters>({
        query: input.query,
        type: sentType,
        type_defaulted: typeDefaulted,
        experiment: input.experiment,
        collision_energy: input.collision_energy,
        collision_type: input.collision_type,
        file_type: input.file_type,
        year,
        number_events: numberEvents,
        availability: input.availability,
        collection: input.collection,
        category: input.category,
        keywords: input.keywords,
        magnet_polarity: input.magnet_polarity,
        stripping_stream: input.stripping_stream,
        stripping_version: input.stripping_version,
        sort,
        sort_defaulted: sortDefaulted,
        include_ondemand: true,
        expanded: expanded.length > 0 ? expanded : undefined,
        unrecognized_values: unrecognized.length > 0 ? unrecognized : undefined,
      }),
    });

    if (
      input.year_from !== undefined &&
      input.year_to !== undefined &&
      input.year_from > input.year_to
    ) {
      throw ctx.fail(
        'invalid_range',
        `year_from ${input.year_from} is after year_to ${input.year_to}.`,
        { year_from: input.year_from, year_to: input.year_to },
      );
    }
    if (
      input.min_events !== undefined &&
      input.max_events !== undefined &&
      input.min_events > input.max_events
    ) {
      throw ctx.fail(
        'invalid_range',
        `min_events ${input.min_events} is above max_events ${input.max_events}.`,
        { min_events: input.min_events, max_events: input.max_events },
      );
    }
    if (input.page * input.limit > PAGE_WINDOW) {
      throw ctx.fail(
        'page_window_exceeded',
        `page ${input.page} × limit ${input.limit} reaches past match ${PAGE_WINDOW}, the deepest the portal pages to.`,
        { page: input.page, limit: input.limit, window: PAGE_WINDOW },
      );
    }
    const delimiter = input.query === undefined ? undefined : findUnbalancedDelimiter(input.query);
    if (delimiter) {
      throw ctx.fail('invalid_query', `The query was not sent: ${delimiterProblem(delimiter)}.`, {
        query: input.query,
        ...delimiter,
      });
    }

    const service = getCernOpenDataService();
    const outcome = await service.search(
      definedOnly<SearchParams>({
        q: input.query,
        type: sentType,
        experiment: sent('experiment'),
        collision_energy: sent('collision_energy'),
        collision_type: sent('collision_type'),
        file_type: sent('file_type'),
        availability: sent('availability'),
        collections: input.collection,
        category: sent('category'),
        keywords: input.keywords,
        magnet_polarity: sent('magnet_polarity'),
        stripping_stream: sent('stripping_stream'),
        stripping_version: sent('stripping_version'),
        year,
        number_events: numberEvents,
        sort: UPSTREAM_SORT[sort],
        size: input.limit,
        page: input.page,
        skipFiles: true,
      }),
      service.startBudget(),
      ctx,
    );

    if (outcome.kind === 'server_error') {
      const { error } = outcome;
      if (input.query === undefined) throw error;
      throw ctx.fail(
        'query_server_error',
        `CERN Open Data answered HTTP 500 to all ${error.data?.retryAttempts} attempts at this search, as it does for some malformed queries.`,
        { ...error.data },
        { cause: error },
      );
    }
    if (outcome.kind === 'rejected') {
      const { rejection } = outcome;
      if (isPageWindowRejection(rejection)) {
        throw ctx.fail(
          'page_window_exceeded',
          `The portal refused the page: ${noticeValue(rejection.message)}`,
          {
            upstreamMessage: rejection.message,
          },
        );
      }
      throw ctx.fail(
        'invalid_query',
        `The portal rejected the search: ${noticeValue(rejection.message)}`,
        {
          upstreamMessage: rejection.message,
          ...(rejection.errors ? { upstreamErrors: rejection.errors } : {}),
        },
      );
    }

    const { page } = outcome;
    const hits = page.hits.map(toSearchHit);
    const facets = toFacets(page.aggregations);
    const truncated = page.total > input.page * input.limit;
    const hasMore = truncated && (input.page + 1) * input.limit <= PAGE_WINDOW;
    const anyFilter =
      !typeDefaulted ||
      [
        input.experiment,
        input.collision_energy,
        input.collision_type,
        input.file_type,
        year,
        numberEvents,
        input.availability,
        input.collection,
        input.category,
        input.keywords,
        input.magnet_polarity,
        input.stripping_stream,
        input.stripping_version,
      ].some((value) => value !== undefined);

    const fragments: string[] = [];
    if (page.total === 0) {
      for (const { param, value } of unrecognized.slice(0, 3)) {
        fragments.push(
          `"${value}" is not a known ${param} value, so it was sent as given; call cern_opendata_list_reference with topic ${PARAM_TOPIC[param]} for the accepted spellings.`,
        );
      }
      if (anyFilter) {
        fragments.push(
          'The facet counts in this response show what each filter would match with the other filters applied; relax the filter whose facet lists the alternatives and call cern_opendata_search_records again.',
        );
        if (input.query !== undefined) {
          fragments.push(
            'To see what the query matches without filters, call cern_opendata_search_records with the query alone, or with broader terms.',
          );
        }
      }
      if (input.collection) {
        fragments.push(
          'Collection names are exact and case-sensitive; call cern_opendata_get_records on a related record and copy the spelling from its collections field.',
        );
      }
      if (input.keywords) {
        fragments.push(
          'Keywords are exact and case-sensitive (Education and education are different keywords); the keywords facet in this response lists the first ones the other filters match, alphabetically.',
        );
      }
      const glossary = typeDefaulted ? glossaryFacetCount(page.aggregations) : 0;
      if (glossary > 0) {
        fragments.push(
          `${countOf(glossary, 'glossary entry', 'glossary entries')} matched; glossary entries are not served by this server.`,
        );
      }
      if (!anyFilter && input.query !== undefined) {
        fragments.push(
          'No record matched the query; try fewer or broader terms, or call cern_opendata_list_reference with topic query_syntax for field forms.',
        );
      }
    } else if (hits.length === 0) {
      const last = Math.max(1, Math.ceil(Math.min(page.total, PAGE_WINDOW) / input.limit));
      fragments.push(
        `Page ${input.page} is past the last page (${countOf(page.total, 'match', 'matches')}); call cern_opendata_search_records again with page ${last}.`,
      );
    }
    if (truncated) {
      const from = (input.page - 1) * input.limit + 1;
      const to = from + hits.length - 1;
      if (hasMore) {
        const windowNote =
          page.total > PAGE_WINDOW
            ? ' Only the first 10,000 matches can be paged; add filters to reach the rest.'
            : '';
        fragments.push(
          `Showing ${from}–${to} of ${page.total}; call cern_opendata_search_records again with page ${input.page + 1}, or narrow with filters.${windowNote}`,
        );
      } else {
        fragments.push(
          lastPageNotice('cern_opendata_search_records', 'Add filters', {
            from,
            to,
            total: page.total,
            limit: input.limit,
          }),
        );
      }
    }

    finishListEnrichment(ctx, {
      shown: hits.length,
      total: page.total,
      cap: input.limit,
      truncated,
      notice: composeNotice(fragments),
    });

    return { hits, page: input.page, has_more: hasMore, facets };
  },

  format: (result) => {
    const lines = [
      `**Page:** ${result.page} · **More pages:** ${result.has_more ? 'yes' : 'no'} · **Hits on this page:** ${result.hits.length}`,
    ];
    for (const hit of result.hits) lines.push('', ...renderHit(hit));
    lines.push('', '## Facets', ...FACET_KEYS.map((key) => renderFacet(key, result.facets[key])));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
