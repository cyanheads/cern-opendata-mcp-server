/**
 * @fileoverview Tests for cern_opendata_search_records: registration and
 * contract, blank-as-unset and canonicalizing inputs, the request sent on the
 * wire, applied_filters and unrecognized values, required enrichment on the
 * zero-result, under-cap, truncated and past-the-end pages, the page-window
 * rejection split from an invalid query, every declared error on the wire, and
 * the text twin of structuredContent. Upstream I/O is a strict fetch fake.
 * @module tests/tools/search-records.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { searchRecords } from '@/mcp-server/tools/definitions/search-records.tool.js';
import { inline, inlineSpelling } from '@/services/cern-opendata/text.js';
import {
  type ContractResult,
  dataOf,
  disposeInstalledService,
  errorOf,
  installService,
  textOf,
} from '../fixtures/cern-opendata-harness.js';
import {
  aggregationsBody,
  collisionDatasetHit,
  docHit,
  emptySearchBody,
  hit,
  jsonResponse,
  licensedDatasetHit,
  newsHit,
  portalRoute,
  RANGE_ERROR_BODY,
  SYNTAX_ERROR_BODY,
  searchBody,
  softwareHit,
  sparseHit,
  syntheticHits,
  WINDOW_ERROR_BODY,
} from '../fixtures/cern-opendata-upstream.js';
import { expectLinearTime } from '../fixtures/cpu-time.js';

type Output = Awaited<ReturnType<typeof searchRecords.handler>>;
type Enrichment = {
  applied_filters: {
    expanded?: { param: string; sent: string[]; value: string }[];
    query?: string;
    sort: string;
    sort_defaulted: boolean;
    type: string[];
    type_defaulted: boolean;
    unrecognized_values?: { param: string; value: string }[];
  } & Record<string, unknown>;
  cap: number;
  notice?: string;
  shown: number;
  totalCount: number;
  truncated: boolean;
};
type Result = Output & Enrichment;

const searchRoute = (respond: Parameters<typeof portalRoute>[1]) =>
  portalRoute('/api/records/', respond);

/** Serve one search body for every request. */
function serve(body: unknown, init: ResponseInit = {}) {
  return installService([searchRoute(() => jsonResponse(body, init))]);
}

const run = (input: Parameters<typeof runToolContract<typeof searchRecords>>[1]) =>
  runToolContract(searchRecords, input);

const paramsOf = (http: ReturnType<typeof installService>['http'], call = 0) =>
  new URL(http.calls[call]?.request.url ?? '').searchParams;

const success = (result: ContractResult) => dataOf<Result>(result);

/** The recovery hint a wire error carries. */
const hintOf = (error: ReturnType<typeof errorOf>): string =>
  String((error.data?.recovery as { hint?: string } | undefined)?.hint);

afterEach(() => {
  disposeInstalledService();
});

describe('cern_opendata_search_records registration', () => {
  it('is registered, read-only, idempotent and open-world', () => {
    expect(allToolDefinitions).toContain(searchRecords);
    expect(searchRecords.name).toBe('cern_opendata_search_records');
    expect(searchRecords.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('declares the six error reasons with the right codes and the service-thrown ones marked', () => {
    const byReason = Object.fromEntries(
      (searchRecords.errors ?? []).map((entry) => [entry.reason, entry]),
    );
    expect(Object.keys(byReason).sort()).toEqual([
      'invalid_query',
      'invalid_range',
      'page_window_exceeded',
      'query_server_error',
      'rate_limited',
      'upstream_unreadable',
    ]);
    expect(byReason.query_server_error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(byReason.query_server_error).not.toHaveProperty('retryable');
    expect(byReason.query_server_error).not.toHaveProperty('severity');
    expect(byReason.invalid_query?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(byReason.page_window_exceeded?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(byReason.invalid_range?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(byReason.rate_limited).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
    });
    expect(byReason.upstream_unreadable).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
    });
    for (const reason of ['invalid_query', 'page_window_exceeded', 'invalid_range']) {
      expect((byReason[reason] as { severity?: string } | undefined)?.severity, reason).toBe(
        'notice',
      );
    }
  });

  it('names its own tool in every recovery', () => {
    for (const entry of searchRecords.errors ?? []) {
      expect(entry.recovery, entry.reason).toContain('cern_opendata_search_records');
    }
  });
});

describe('cern_opendata_search_records input', () => {
  const FORM_BLANKS = {
    query: '',
    type: '  ',
    experiment: '',
    collision_energy: ' , ',
    collision_type: '\t',
    file_type: [],
    availability: '',
    collection: ' ',
    category: '',
    keywords: ' ',
    magnet_polarity: [],
    stripping_stream: '\t',
    stripping_version: ' , ',
    year_from: '',
    year_to: ' ',
    min_events: '',
    max_events: '',
    sort: '',
    limit: '',
    page: '',
  } as const;

  it('reads blank strings and empty lists on every optional input as unset', () => {
    expect(searchRecords.input.parse(FORM_BLANKS)).toEqual({ limit: 10, page: 1 });
  });

  it('sends the same request for a form client full of blanks as for an empty call', async () => {
    const { http } = serve(emptySearchBody);
    await run({});
    await run(FORM_BLANKS as never);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1]?.request.url).toBe(http.calls[0]?.request.url);
  });

  it('echoes blank inputs as unset in applied_filters', async () => {
    serve(emptySearchBody);
    const { applied_filters } = success(await run(FORM_BLANKS as never));
    expect(applied_filters).toMatchObject({
      type_defaulted: true,
      sort: 'mostrecent',
      sort_defaulted: true,
      include_ondemand: true,
    });
    for (const key of [
      'query',
      'experiment',
      'collision_energy',
      'collision_type',
      'file_type',
      'year',
      'number_events',
      'availability',
      'collection',
      'category',
      'keywords',
      'magnet_polarity',
      'stripping_stream',
      'stripping_version',
      'expanded',
      'unrecognized_values',
    ]) {
      expect(applied_filters, key).not.toHaveProperty(key);
    }
  });

  it.each([
    ['experiment', 'cms, atlas', ['CMS', 'ATLAS']],
    ['experiment', ['lhcb', 'LHCB', ' Alice '], ['LHCb', 'ALICE']],
    ['type', 'dataset/collision', ['Dataset::Collision']],
    ['type', 'DATASET : Simulated', ['Dataset::Simulated']],
    ['type', 'software', ['Software']],
    ['collision_energy', '13 tev', ['13TeV']],
    ['collision_energy', '13TeV, 13.6TeV', ['13TeV, 13.6TeV']],
    ['collision_energy', '8tev, 13tev', ['8TeV', '13TeV']],
    ['collision_energy', ['13TeV, 13.6TeV', '8TeV'], ['13TeV, 13.6TeV', '8TeV']],
    ['collision_type', 'Pb-Pb', ['PbPb']],
    ['collision_type', 'PBPB, e+e-', ['PbPb', 'e+e-']],
    ['availability', 'on demand', ['ondemand']],
    ['availability', 'On-Demand,ONLINE', ['ondemand', 'online']],
    ['file_type', 'NANOAOD, daod_physlite, ROOT', ['nanoaod', 'DAOD_PHYSLITE', 'root']],
    ['category', 'higgs physics/standard model', ['Higgs Physics::Standard Model']],
    ['category', ' heavy-ion physics ', ['Heavy-Ion Physics']],
    [
      'category',
      'Exotica::Heavy Fermions, Heavy Righ-Handed Neutrinos',
      ['Exotica::Heavy Fermions, Heavy Righ-Handed Neutrinos'],
    ],
    ['category', 'Exotica::Dark Matter, Supersymmetry', ['Exotica::Dark Matter', 'Supersymmetry']],
    ['category', 'susy, SUPERSYMMETRY', ['Susy', 'Supersymmetry']],
    ['magnet_polarity', 'magdown', ['MagDown']],
    ['magnet_polarity', 'MAGUP, magdown', ['MagUp', 'MagDown']],
    ['stripping_stream', 'dimuon', ['DIMUON']],
    ['stripping_stream', ['charm.mdst', 'Semileptonic'], ['CHARM.MDST', 'SEMILEPTONIC']],
    ['stripping_version', 'Stripping21r1', ['stripping21r1']],
  ] as const)('canonicalizes %s %j to %j', (param, value, expected) => {
    const parsed = searchRecords.input.parse({ [param]: value }) as Record<string, unknown>;
    expect(parsed[param]).toEqual(expected);
  });

  it('keeps unknown values as given, trimmed, and collection values as given', () => {
    const parsed = searchRecords.input.parse({
      experiment: ' Atlas2 ',
      file_type: 'weird-format',
      collection: [' CMS-Validated-Runs ', 'cms-validated-runs'],
    });
    expect(parsed).toMatchObject({
      experiment: ['Atlas2'],
      file_type: ['weird-format'],
      collection: ['CMS-Validated-Runs', 'cms-validated-runs'],
    });
  });

  it('accepts a comma-separated string and an array for collection', () => {
    expect(searchRecords.input.parse({ collection: 'A, B' }).collection).toEqual(['A', 'B']);
    expect(searchRecords.input.parse({ collection: ['A', 'B'] }).collection).toEqual(['A', 'B']);
  });

  it('keeps keywords as given, trimmed, case variants apart', () => {
    expect(searchRecords.input.parse({ keywords: ' education , Education' }).keywords).toEqual([
      'education',
      'Education',
    ]);
    expect(
      searchRecords.input.parse({ keywords: ['Jet substructure, OmniFold'] }).keywords,
    ).toEqual(['Jet substructure, OmniFold']);
  });

  it.each([
    ['Glossary', { type: 'Glossary' }],
    ['glossary in any case', { type: ['Dataset', 'GLOSSARY'] }],
    ['a Glossary secondary', { type: 'glossary::term' }],
    ['a type list over 7', { type: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }],
    ['an experiment list over 9', { experiment: 'a,b,c,d,e,f,g,h,i,j' }],
    ['a collision_type list over 6', { collision_type: 'a,b,c,d,e,f,g' }],
    ['an availability list over 4', { availability: 'a,b,c,d,e' }],
    ['a collection list over 10', { collection: Array.from({ length: 11 }, (_, i) => `c${i}`) }],
    ['a filter value over 100 characters', { experiment: 'x'.repeat(101) }],
    ['a collection name over 100 characters', { collection: 'x'.repeat(101) }],
    ['a category list over 20', { category: Array.from({ length: 21 }, (_, i) => `c${i}`) }],
    ['a keywords list over 10', { keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) }],
    ['a keyword over 100 characters', { keywords: 'x'.repeat(101) }],
    ['a magnet_polarity list over 2', { magnet_polarity: 'MagUp, MagDown, MagSide' }],
    [
      'a stripping_stream list over 11',
      { stripping_stream: Array.from({ length: 12 }, (_, i) => `s${i}`) },
    ],
    [
      'a stripping_version list over 12',
      { stripping_version: Array.from({ length: 13 }, (_, i) => `v${i}`) },
    ],
    ['a query over 500 characters', { query: 'x'.repeat(501) }],
    ['year_from below 1900', { year_from: 1899 }],
    ['year_to above 2100', { year_to: 2101 }],
    ['a fractional year', { year_from: 2012.5 }],
    ['negative min_events', { min_events: -1 }],
    ['negative max_events', { max_events: -1 }],
    ['an unknown sort', { sort: 'bogus' }],
    ['limit 0', { limit: 0 }],
    ['limit 51', { limit: 51 }],
    ['page 0', { page: 0 }],
    ['a fractional page', { page: 1.5 }],
    ['a numeric string for limit', { limit: '10' }],
  ] as const)('rejects %s as invalid arguments before any request', async (_name, input) => {
    const { http } = serve(emptySearchBody);
    const result = await run(input as never);
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(http.calls).toHaveLength(0);
  });

  it.each<[string, (n: number) => unknown]>([
    ['a string', (n) => `a${' '.repeat(n)}b`],
    ['an array item', (n) => [`a${' '.repeat(n)}b`]],
  ])(
    'rejects a type value holding a million spaces as too long, as %s, in linear time',
    (_form, make) => {
      const parse = (type: unknown) => searchRecords.input.safeParse({ type });
      expect(parse(make(1_000_000)).error?.issues[0]).toMatchObject({
        code: 'too_big',
        path: ['type', 0],
      });
      expectLinearTime(make, parse, { sizes: [62_500, 250_000, 1_000_000], maxMs: 250 });
    },
  );

  it('says Glossary is not served in the rejection', async () => {
    serve(emptySearchBody);
    expect(errorOf(await run({ type: 'Glossary' })).message).toContain(
      'Glossary entries are not served by this server.',
    );
  });

  it('applies the defaults limit 10 and page 1', () => {
    expect(searchRecords.input.parse({})).toEqual({ limit: 10, page: 1 });
  });
});

describe('cern_opendata_search_records on the wire', () => {
  it('sends the six served primaries, the default sort and size for a bare call', async () => {
    const { http } = serve(emptySearchBody);
    await run({});
    expect(http.calls).toHaveLength(1);
    expect([...paramsOf(http)]).toEqual([
      ['type', 'Dataset'],
      ['type', 'Documentation'],
      ['type', 'Environment'],
      ['type', 'Software'],
      ['type', 'Supplementaries'],
      ['type', 'News'],
      ['sort', '-mostrecent'],
      ['size', '10'],
      ['page', '1'],
      ['skip_files', '1'],
      ['ondemand', 'true'],
    ]);
  });

  it('sends the query verbatim and defaults the sort to bestmatch with it', async () => {
    const { http } = serve(emptySearchBody);
    await run({ query: 'title:"Double Muon" AND run_period:("Run2012B")' });
    const params = paramsOf(http);
    expect(params.get('q')).toBe('title:"Double Muon" AND run_period:("Run2012B")');
    expect(params.get('sort')).toBe('bestmatch');
  });

  it('sends every filter under its portal name, repeating list values', async () => {
    const { http } = serve(emptySearchBody);
    await run({
      query: 'muon',
      type: 'Dataset::Collision, Software',
      experiment: 'cms,atlas',
      collision_energy: '8TeV',
      collision_type: 'pp',
      file_type: 'aod, nanoaod',
      year_from: 2011,
      year_to: 2012,
      min_events: 1000,
      max_events: 5000,
      availability: 'online',
      collection: 'CMS-Primary-Datasets',
      sort: 'title_desc',
      limit: 25,
      page: 3,
    });
    const params = paramsOf(http);
    expect(params.getAll('type')).toEqual(['Dataset::Collision', 'Software']);
    expect(params.getAll('experiment')).toEqual(['CMS', 'ATLAS']);
    expect(params.getAll('collision_energy')).toEqual(['8TeV']);
    expect(params.getAll('collision_type')).toEqual(['pp']);
    expect(params.getAll('file_type')).toEqual(['aod', 'nanoaod']);
    expect(params.get('year')).toBe('2011--2012');
    expect(params.get('number_events')).toBe('1000--5000');
    expect(params.getAll('availability')).toEqual(['online']);
    expect(params.getAll('collections')).toEqual(['CMS-Primary-Datasets']);
    expect(params.get('sort')).toBe('-title');
    expect(params.get('size')).toBe('25');
    expect(params.get('page')).toBe('3');
    expect(params.get('skip_files')).toBe('1');
    expect(params.get('ondemand')).toBe('true');
  });

  it('sends only allowlisted parameter names', async () => {
    const { http } = serve(emptySearchBody);
    await run({
      query: 'x',
      type: 'Dataset',
      experiment: 'CMS',
      collision_energy: '8TeV',
      collision_type: 'pp',
      file_type: 'aod',
      year_from: 2012,
      min_events: 1,
      availability: 'online',
      collection: 'C',
      category: 'Exotica',
      keywords: 'education',
      magnet_polarity: 'MagUp',
      stripping_stream: 'DIMUON',
      stripping_version: 'stripping21',
      sort: 'title',
    });
    const allowed = new Set([
      'q',
      'type',
      'experiment',
      'collision_energy',
      'collision_type',
      'file_type',
      'availability',
      'collections',
      'category',
      'keywords',
      'magnet_polarity',
      'stripping_stream',
      'stripping_version',
      'year',
      'number_events',
      'sort',
      'size',
      'page',
      'skip_files',
      'ondemand',
    ]);
    for (const name of new Set([...paramsOf(http).keys()])) {
      expect(allowed.has(name), name).toBe(true);
    }
  });

  it.each([
    [{ year_from: 2012 }, '2012--'],
    [{ year_to: 2012 }, '--2012'],
    [{ year_from: 2012, year_to: 2012 }, '2012--2012'],
    [{ year_from: 2011, year_to: 2012 }, '2011--2012'],
  ])('composes the year range for %j as %s, never a bare year', async (input, expected) => {
    const { http } = serve(emptySearchBody);
    const result = success(await run(input));
    expect(paramsOf(http).get('year')).toBe(expected);
    expect(result.applied_filters.year).toBe(expected);
  });

  it.each([
    [{ min_events: 10_000_000 }, '10000000--'],
    [{ max_events: 500 }, '--500'],
    [{ min_events: 0, max_events: 0 }, '0--0'],
    [{ min_events: 100, max_events: 200 }, '100--200'],
  ])('composes the event range for %j as %s', async (input, expected) => {
    const { http } = serve(emptySearchBody);
    const result = success(await run(input));
    expect(paramsOf(http).get('number_events')).toBe(expected);
    expect(result.applied_filters.number_events).toBe(expected);
  });

  it('expands PbPb to both upstream spellings and echoes the expansion', async () => {
    const { http } = serve(emptySearchBody);
    const result = success(await run({ collision_type: ['PbPb', 'pp'] }));
    expect(paramsOf(http).getAll('collision_type')).toEqual(['PbPb', 'Pb-Pb', 'pp']);
    expect(result.applied_filters.collision_type).toEqual(['PbPb', 'pp']);
    expect(result.applied_filters.expanded).toEqual([
      { param: 'collision_type', value: 'PbPb', sent: ['PbPb', 'Pb-Pb'] },
    ]);
  });

  it('expands the Pb-Pb spelling too, since it canonicalizes to PbPb', async () => {
    const { http } = serve(emptySearchBody);
    await run({ collision_type: 'Pb-Pb' });
    expect(paramsOf(http).getAll('collision_type')).toEqual(['PbPb', 'Pb-Pb']);
  });

  it('does not expand other collision types', async () => {
    const { http } = serve(emptySearchBody);
    const result = success(await run({ collision_type: ['pp', 'pPb'] }));
    expect(paramsOf(http).getAll('collision_type')).toEqual(['pp', 'pPb']);
    expect(result.applied_filters).not.toHaveProperty('expanded');
  });

  it('keeps a whole 13TeV, 13.6TeV energy as one upstream value', async () => {
    const { http } = serve(emptySearchBody);
    await run({ collision_energy: '13TeV, 13.6TeV' });
    expect(paramsOf(http).getAll('collision_energy')).toEqual(['13TeV, 13.6TeV']);
  });

  it('sends the category, keyword and LHCb filters under their portal names', async () => {
    const { http } = serve(emptySearchBody);
    await run({
      category: 'higgs physics/standard model, susy',
      keywords: 'education, Education',
      magnet_polarity: 'magdown',
      stripping_stream: 'dimuon, ew',
      stripping_version: 'Stripping21r1',
      experiment: 'lhcb',
    });
    const params = paramsOf(http);
    expect(params.getAll('category')).toEqual(['Higgs Physics::Standard Model', 'Susy']);
    expect(params.getAll('keywords')).toEqual(['education', 'Education']);
    expect(params.getAll('magnet_polarity')).toEqual(['MagDown']);
    expect(params.getAll('stripping_stream')).toEqual(['DIMUON', 'EW']);
    expect(params.getAll('stripping_version')).toEqual(['stripping21r1']);
    expect(params.has('subcategory')).toBe(false);
  });

  it('expands Heavy-Ion Physics to both upstream spellings and echoes the expansion', async () => {
    const { http } = serve(emptySearchBody);
    const result = success(await run({ category: 'heavy-ion physics' }));
    expect(paramsOf(http).getAll('category')).toEqual(['Heavy-Ion Physics', ' Heavy-Ion Physics']);
    expect(result.applied_filters.category).toEqual(['Heavy-Ion Physics']);
    expect(result.applied_filters.expanded).toEqual([
      {
        param: 'category',
        value: 'Heavy-Ion Physics',
        sent: ['Heavy-Ion Physics', ' Heavy-Ion Physics'],
      },
    ]);
  });

  it('echoes every expansion of one call, PbPb and Heavy-Ion Physics together', async () => {
    const { http } = serve(emptySearchBody);
    const result = success(
      await run({ category: ['Exotica', 'Heavy-Ion Physics'], collision_type: 'pbpb' }),
    );
    expect(paramsOf(http).getAll('category')).toEqual([
      'Exotica',
      'Heavy-Ion Physics',
      ' Heavy-Ion Physics',
    ]);
    expect(paramsOf(http).getAll('collision_type')).toEqual(['PbPb', 'Pb-Pb']);
    expect(result.applied_filters.expanded).toEqual([
      { param: 'collision_type', value: 'PbPb', sent: ['PbPb', 'Pb-Pb'] },
      {
        param: 'category',
        value: 'Heavy-Ion Physics',
        sent: ['Heavy-Ion Physics', ' Heavy-Ion Physics'],
      },
    ]);
  });

  it('expands nothing for a value that names an object member', async () => {
    const { http } = serve(emptySearchBody);
    const result = success(await run({ category: 'constructor', collision_type: '__proto__' }));
    expect(paramsOf(http).getAll('category')).toEqual(['constructor']);
    expect(paramsOf(http).getAll('collision_type')).toEqual(['__proto__']);
    expect(result.applied_filters).not.toHaveProperty('expanded');
  });

  it('keeps a category that holds a comma as one upstream value', async () => {
    const { http } = serve(emptySearchBody);
    await run({ category: 'exotica/heavy fermions, heavy righ-handed neutrinos' });
    expect(paramsOf(http).getAll('category')).toEqual([
      'Exotica::Heavy Fermions, Heavy Righ-Handed Neutrinos',
    ]);
  });

  it('sends an explicit type without the defaulted flag', async () => {
    const { http } = serve(emptySearchBody);
    const result = success(await run({ type: 'documentation' }));
    expect(paramsOf(http).getAll('type')).toEqual(['Documentation']);
    expect(result.applied_filters).toMatchObject({
      type: ['Documentation'],
      type_defaulted: false,
    });
  });

  it.each([
    ['bestmatch', 'bestmatch'],
    ['mostrecent', '-mostrecent'],
    ['title', 'title'],
    ['title_desc', '-title'],
  ] as const)(
    'sends sort %s as %s, the direction a - prefix gives, and echoes the caller value',
    async (sort, sent) => {
      const { http } = serve(emptySearchBody);
      const result = success(await run({ sort }));
      expect(paramsOf(http).getAll('sort')).toEqual([sent]);
      expect(result.applied_filters).toMatchObject({ sort, sort_defaulted: false });
    },
  );

  it.each([
    ['without a query, newest first', {}, '-mostrecent', 'mostrecent'],
    ['with a query, by relevance', { query: 'muon' }, 'bestmatch', 'bestmatch'],
  ] as const)('defaults the sort %s', async (_when, input, sent, echoed) => {
    const { http } = serve(emptySearchBody);
    const result = success(await run(input));
    expect(paramsOf(http).getAll('sort')).toEqual([sent]);
    expect(result.applied_filters).toMatchObject({ sort: echoed, sort_defaulted: true });
  });

  it('echoes an explicit sort as not defaulted, and the default as defaulted', async () => {
    serve(emptySearchBody);
    expect(success(await run({ sort: 'bestmatch' })).applied_filters).toMatchObject({
      sort: 'bestmatch',
      sort_defaulted: false,
    });
    expect(success(await run({})).applied_filters).toMatchObject({
      sort: 'mostrecent',
      sort_defaulted: true,
    });
    expect(success(await run({ query: 'x' })).applied_filters).toMatchObject({
      sort: 'bestmatch',
      sort_defaulted: true,
    });
  });
});

describe('cern_opendata_search_records applied_filters', () => {
  it('echoes the parsed filters as sent', async () => {
    serve(emptySearchBody);
    const { applied_filters } = success(
      await run({
        query: 'muon',
        experiment: 'cms',
        collision_energy: '8 tev',
        file_type: 'AOD',
        availability: 'on demand',
        collection: 'CMS-Validated-Runs',
        year_from: 2012,
      }),
    );
    expect(applied_filters).toMatchObject({
      query: 'muon',
      experiment: ['CMS'],
      collision_energy: ['8TeV'],
      file_type: ['aod'],
      availability: ['ondemand'],
      collection: ['CMS-Validated-Runs'],
      year: '2012--',
    });
  });

  it('reports each unrecognized vocabulary value as sent, per parameter', async () => {
    const { http } = serve(emptySearchBody);
    const { applied_filters } = success(
      await run({
        experiment: ['CMS', 'NOPE'],
        collision_energy: '99TeV',
        collision_type: 'zz',
        file_type: ['aod', 'xyzzy'],
        availability: 'sometimes',
        type: ['Dataset', 'Dataset::Imaginary'],
      }),
    );
    expect(applied_filters.unrecognized_values).toEqual([
      { param: 'type', value: 'Dataset::Imaginary' },
      { param: 'experiment', value: 'NOPE' },
      { param: 'collision_energy', value: '99TeV' },
      { param: 'collision_type', value: 'zz' },
      { param: 'file_type', value: 'xyzzy' },
      { param: 'availability', value: 'sometimes' },
    ]);
    expect(paramsOf(http).getAll('experiment')).toEqual(['CMS', 'NOPE']);
    expect(paramsOf(http).getAll('file_type')).toEqual(['aod', 'xyzzy']);
  });

  it('does not report known values, canonicalized spellings or collection names', async () => {
    serve(emptySearchBody);
    const { applied_filters } = success(
      await run({
        experiment: 'lhcb',
        type: 'dataset/collision',
        collision_type: 'pb-pb',
        availability: 'on-demand',
        collision_energy: '13TeV, 13.6TeV',
        collection: 'not-a-known-collection',
      }),
    );
    expect(applied_filters).not.toHaveProperty('unrecognized_values');
  });

  it('echoes the category, keyword and LHCb filters as parsed', async () => {
    serve(emptySearchBody);
    const { applied_filters } = success(
      await run({
        category: 'exotica:dark matter',
        keywords: 'Education',
        magnet_polarity: 'magup',
        stripping_stream: 'charm.mdst',
        stripping_version: 'STRIPPING29R2P3',
      }),
    );
    expect(applied_filters).toMatchObject({
      category: ['Exotica::Dark Matter'],
      keywords: ['Education'],
      magnet_polarity: ['MagUp'],
      stripping_stream: ['CHARM.MDST'],
      stripping_version: ['stripping29r2p3'],
    });
  });

  it('reports unknown category and LHCb values as unrecognized, never a keyword', async () => {
    const { http } = serve(emptySearchBody);
    const { applied_filters } = success(
      await run({
        category: ['Exotica', 'Imaginary Physics'],
        keywords: 'no such keyword',
        magnet_polarity: 'MagSideways',
        stripping_stream: 'NOPE',
        stripping_version: 'stripping99',
      }),
    );
    expect(applied_filters.unrecognized_values).toEqual([
      { param: 'category', value: 'Imaginary Physics' },
      { param: 'magnet_polarity', value: 'MagSideways' },
      { param: 'stripping_stream', value: 'NOPE' },
      { param: 'stripping_version', value: 'stripping99' },
    ]);
    expect(paramsOf(http).getAll('category')).toEqual(['Exotica', 'Imaginary Physics']);
    expect(paramsOf(http).getAll('magnet_polarity')).toEqual(['MagSideways']);
  });

  it('shows the new filters and a whitespace-padded spelling in the text trailer', async () => {
    serve(emptySearchBody);
    const trailer = textOf(
      await run({
        category: 'Heavy-Ion Physics',
        keywords: 'Jet substructure',
        magnet_polarity: 'MagDown',
        stripping_stream: 'DIMUON',
        stripping_version: 'stripping21',
      }),
      1,
    );
    expect(trailer).toContain('- **category:** Heavy-Ion Physics');
    expect(trailer).toContain('- **keywords:** Jet substructure');
    expect(trailer).toContain('- **magnet_polarity:** MagDown');
    expect(trailer).toContain('- **stripping_stream:** DIMUON');
    expect(trailer).toContain('- **stripping_version:** stripping21');
    expect(trailer).toContain(
      '- **expanded:** category Heavy-Ion Physics → Heavy-Ion Physics, " Heavy-Ion Physics"',
    );
  });

  it('shows what is sent in the text trailer', async () => {
    serve(emptySearchBody);
    const result = await run({
      query: 'muon',
      experiment: ['CMS', 'NOPE'],
      collision_type: 'PbPb',
      year_from: 2012,
    });
    const trailer = textOf(result, 1);
    expect(trailer).toContain('**Applied filters:**');
    expect(trailer).toContain('- **query:** muon');
    expect(trailer).toContain(
      '- **type:** Dataset, Documentation, Environment, Software, Supplementaries, News (defaulted)',
    );
    expect(trailer).toContain('- **experiment:** CMS, NOPE');
    expect(trailer).toContain('- **year:** 2012--');
    expect(trailer).toContain('- **sort:** bestmatch (defaulted)');
    expect(trailer).toContain('- **include_ondemand:** true');
    expect(trailer).toContain('- **expanded:** collision_type PbPb → PbPb, Pb-Pb');
    expect(trailer).toContain('- **unrecognized_values:** experiment NOPE');
  });

  it('neutralizes CR/LF and markup in echoed query and values in the trailer', async () => {
    serve(emptySearchBody);
    const result = await run({
      query: 'a\r\n- **injected:** yes [x](http://e.example) <b>',
      experiment: 'X\nY',
    });
    const trailer = textOf(result, 1);
    const lines = trailer.split('\n').filter((line) => line.startsWith('- '));
    expect(lines.some((line) => line.startsWith('- **injected:**'))).toBe(false);
    expect(trailer).toContain(
      '- **query:** a  - **injected:** yes \\[x\\](http://e.example) &lt;b&gt;',
    );
    expect(trailer).toContain('- **experiment:** X Y');
  });
});

describe('cern_opendata_search_records enrichment', () => {
  const ZERO_BASE = { truncated: false, shown: 0, totalCount: 0 };

  it('zero-result page: required fields written before any branch, no notice for a bare empty call', async () => {
    serve(emptySearchBody);
    const result = success(await run({ limit: 7 }));
    expect(result).toMatchObject({ ...ZERO_BASE, cap: 7, hits: [], has_more: false });
    expect(result).not.toHaveProperty('notice');
  });

  it('zero-result page names an unrecognized value, then the facet hint', async () => {
    serve(emptySearchBody);
    const result = success(await run({ experiment: 'NOPE' }));
    expect(result).toMatchObject(ZERO_BASE);
    expect(result.notice).toBe(
      '"NOPE" is not a known experiment value, so it was sent as given; call cern_opendata_list_reference with topic experiments for the accepted spellings. ' +
        'The facet counts in this response show what each filter would match with the other filters applied; relax the filter whose facet lists the alternatives and call cern_opendata_search_records again.',
    );
  });

  it('zero-result page names at most three unrecognized values', async () => {
    serve(emptySearchBody);
    const result = success(
      await run({
        experiment: 'E1',
        collision_energy: '1TeV',
        file_type: 'f1, f2',
      }),
    );
    const named = (result.notice ?? '').match(/is not a known/g) ?? [];
    expect(named).toHaveLength(3);
    expect(result.notice).toContain('"E1" is not a known experiment value');
    expect(result.notice).toContain('"1TeV" is not a known collision_energy value');
    expect(result.notice).toContain('"f1" is not a known file_type value');
    expect(result.notice).not.toContain('"f2"');
    expect(result.notice).toContain('topic collision_energies');
    expect(result.notice).toContain('topic file_types');
  });

  it('keeps a filter value that holds a line break on one line in the notice', async () => {
    serve(emptySearchBody);
    const result = success(await run({ experiment: 'X\nY' }));
    expect(result.notice).not.toMatch(/[\r\n]/);
  });

  it('zero-result page routes a filtered miss to the facets, and collection to its spelling hint', async () => {
    serve(emptySearchBody);
    const result = success(await run({ collection: 'cms-validated-runs' }));
    expect(result.notice).toBe(
      'The facet counts in this response show what each filter would match with the other filters applied; relax the filter whose facet lists the alternatives and call cern_opendata_search_records again. ' +
        'Collection names are exact and case-sensitive; call cern_opendata_get_records on a related record and copy the spelling from its collections field.',
    );
  });

  it.each([
    ['category', 'categories', 'Imaginary Physics'],
    ['magnet_polarity', 'lhcb', 'MagSideways'],
    ['stripping_stream', 'lhcb', 'NOPE'],
    ['stripping_version', 'lhcb', 'stripping99'],
  ] as const)(
    'zero-result page routes an unknown %s value to topic %s',
    async (param, topic, value) => {
      serve(emptySearchBody);
      const result = success(await run({ [param]: value }));
      expect(result.notice).toBe(
        `"${value}" is not a known ${param} value, so it was sent as given; call cern_opendata_list_reference with topic ${topic} for the accepted spellings. ` +
          'The facet counts in this response show what each filter would match with the other filters applied; relax the filter whose facet lists the alternatives and call cern_opendata_search_records again.',
      );
    },
  );

  it('zero-result page with keywords says keywords are exact and case-sensitive', async () => {
    serve(emptySearchBody);
    const result = success(await run({ keywords: 'EDUCATION' }));
    expect(result.notice).toBe(
      'The facet counts in this response show what each filter would match with the other filters applied; relax the filter whose facet lists the alternatives and call cern_opendata_search_records again. ' +
        'Keywords are exact and case-sensitive (Education and education are different keywords); the keywords facet in this response lists the first ones the other filters match, alphabetically.',
    );
  });

  it.each([
    ['category', 'Exotica'],
    ['keywords', 'education'],
    ['magnet_polarity', 'MagDown'],
    ['stripping_stream', 'DIMUON'],
    ['stripping_version', 'stripping21'],
  ] as const)('zero-result page treats %s as a filter', async (param, value) => {
    serve(emptySearchBody);
    const result = success(await run({ query: 'muon', [param]: value }));
    expect(result.notice).toMatch(/^The facet counts in this response/);
    expect(result.notice).toContain('call cern_opendata_search_records with the query alone');
    expect(result.notice).not.toContain('No record matched the query');
  });

  it('zero-result page with a query and filters names the unfiltered query as the next call', async () => {
    serve(emptySearchBody);
    const result = success(await run({ query: 'muon', experiment: 'CMS' }));
    expect(result.notice).toBe(
      'The facet counts in this response show what each filter would match with the other filters applied; relax the filter whose facet lists the alternatives and call cern_opendata_search_records again. ' +
        'To see what the query matches without filters, call cern_opendata_search_records with the query alone, or with broader terms.',
    );
  });

  it('zero-result page treats an explicit type as a filter', async () => {
    serve(emptySearchBody);
    const result = success(await run({ type: 'Software' }));
    expect(result.notice).toMatch(/^The facet counts in this response/);
  });

  it('zero-result page with only a query points to broader terms and the query syntax', async () => {
    serve(emptySearchBody);
    const result = success(await run({ query: 'zzzzzz' }));
    expect(result.notice).toBe(
      'No record matched the query; try fewer or broader terms, or call cern_opendata_list_reference with topic query_syntax for field forms.',
    );
  });

  it('zero-result page with a defaulted type reports the Glossary matches the server does not serve', async () => {
    serve(searchBody([], { total: 0, aggregations: aggregationsBody }));
    const result = success(await run({ query: 'AOD' }));
    expect(result.notice).toBe(
      '5 glossary entries matched; glossary entries are not served by this server. ' +
        'No record matched the query; try fewer or broader terms, or call cern_opendata_list_reference with topic query_syntax for field forms.',
    );
  });

  it('zero-result page names one Glossary match in the singular', async () => {
    serve(
      searchBody([], {
        total: 0,
        aggregations: { type: { buckets: [{ key: 'Glossary', doc_count: 1 }] } },
      }),
    );
    expect(success(await run({ query: 'AOD' })).notice).toMatch(
      /^1 glossary entry matched; glossary entries are not served by this server\. /,
    );
  });

  it('zero-result page leaves the Glossary note out when type was set', async () => {
    serve(searchBody([], { total: 0, aggregations: aggregationsBody }));
    const result = success(await run({ type: 'Software' }));
    expect(result.notice).not.toContain('glossary');
  });

  it('composes the zero-result fragments in the documented order', async () => {
    serve(searchBody([], { total: 0, aggregations: aggregationsBody }));
    const result = success(await run({ experiment: 'NOPE', collection: 'c', keywords: 'k' }));
    const notice = result.notice ?? '';
    const order = [
      'is not a known experiment value',
      'The facet counts in this response',
      'Collection names are exact',
      'Keywords are exact',
      '5 glossary entries matched',
    ].map((fragment) => notice.indexOf(fragment));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('under-cap page: fewer hits than the cap, not truncated, no notice, totals match', async () => {
    serve(searchBody([collisionDatasetHit, softwareHit], { total: 2 }));
    const result = success(await run({ limit: 10, experiment: 'CMS' }));
    expect(result).toMatchObject({
      truncated: false,
      shown: 2,
      cap: 10,
      totalCount: 2,
      has_more: false,
      page: 1,
    });
    expect(result.hits).toHaveLength(2);
    expect(result).not.toHaveProperty('notice');
  });

  it('full page that is also the last: shown equals the cap and nothing is truncated', async () => {
    serve(searchBody(syntheticHits(5), { total: 5 }));
    const result = success(await run({ limit: 5 }));
    expect(result).toMatchObject({ truncated: false, shown: 5, cap: 5, totalCount: 5 });
    expect(result).not.toHaveProperty('notice');
  });

  it('truncated page: guidance carries the range and the next page, and sets the notice', async () => {
    serve(searchBody(syntheticHits(10), { total: 95, hasNext: true }));
    const result = success(await run({ limit: 10, page: 3 }));
    expect(result).toMatchObject({
      truncated: true,
      shown: 10,
      cap: 10,
      totalCount: 95,
      has_more: true,
      page: 3,
    });
    expect(result.notice).toBe(
      'Showing 21–30 of 95; call cern_opendata_search_records again with page 4, or narrow with filters.',
    );
  });

  it('adds the window caveat when more than 10,000 matches exist', async () => {
    serve(searchBody(syntheticHits(10), { total: 35_747, hasNext: true }));
    const result = success(await run({ limit: 10 }));
    expect(result.notice).toBe(
      'Showing 1–10 of 35747; call cern_opendata_search_records again with page 2, or narrow with filters. Only the first 10,000 matches can be paged; add filters to reach the rest.',
    );
  });

  it('on the last page inside the window, never points past it', async () => {
    serve(searchBody(syntheticHits(50), { total: 35_747 }));
    const result = success(await run({ limit: 50, page: 200 }));
    expect(result).toMatchObject({ truncated: true, has_more: false, shown: 50 });
    expect(result.notice).toBe(
      'Showing 9951–10000 of 35747; this is the last page within the first 10,000 matches, the deepest the portal pages to. Add filters to reach the rest.',
    );
    expect(result.notice).not.toContain('page 201');
  });

  it('flags the last reachable page at limit 10 although the portal sends no links.next there', async () => {
    serve(searchBody(syntheticHits(10), { total: 60_383 }));
    const result = success(await run({ limit: 10, page: 1000 }));
    expect(result).toMatchObject({
      truncated: true,
      has_more: false,
      shown: 10,
      totalCount: 60_383,
    });
    expect(result.notice).toBe(
      'Showing 9991–10000 of 60383; this is the last page within the first 10,000 matches, the deepest the portal pages to. Add filters to reach the rest.',
    );
  });

  describe('the last page at a limit that does not divide 10,000 names the call for the matches after it', () => {
    const lastPage = 'this is the last page at limit';
    const window = 'since the portal pages no deeper than match 10,000';
    it.each([
      [
        30,
        333,
        60_383,
        `Showing 9961–9990 of 60383; ${lastPage} 30, ${window}. For matches 9991–10000, call cern_opendata_search_records again with limit 10 and page 1000. Add filters to reach the matches past 10,000.`,
      ],
      [
        30,
        333,
        9_995,
        `Showing 9961–9990 of 9995; ${lastPage} 30, ${window}. For matches 9991–9995, call cern_opendata_search_records again with limit 10 and page 1000.`,
      ],
      [
        30,
        333,
        9_991,
        `Showing 9961–9990 of 9991; ${lastPage} 30, ${window}. For match 9991, call cern_opendata_search_records again with limit 10 and page 1000.`,
      ],
      [
        7,
        1_428,
        60_383,
        `Showing 9990–9996 of 60383; ${lastPage} 7, ${window}. For matches 9997–10000, call cern_opendata_search_records again with limit 10 and page 1000; its matches 9991–9996 are already on this page. Add filters to reach the matches past 10,000.`,
      ],
      [
        41,
        243,
        60_383,
        `Showing 9923–9963 of 60383; ${lastPage} 41, ${window}. For matches 9964–10000, call cern_opendata_search_records again with limit 40 and page 250; its matches 9961–9963 are already on this page. Add filters to reach the matches past 10,000.`,
      ],
      [
        29,
        344,
        9_990,
        `Showing 9948–9976 of 9990; ${lastPage} 29, ${window}. For matches 9977–9990, call cern_opendata_search_records again with limit 25 and page 400; its match 9976 is already on this page.`,
      ],
      [
        3,
        3_333,
        60_383,
        `Showing 9997–9999 of 60383; ${lastPage} 3, ${window}. For match 10000, call cern_opendata_search_records again with limit 10 and page 1000; its matches 9997–9999 are already on this page. Add filters to reach the matches past 10,000.`,
      ],
    ])('limit %i, page %i, total %i', async (limit, page, total, notice) => {
      serve(searchBody(syntheticHits(limit), { total }));
      const result = success(await run({ limit, page }));
      expect(result).toMatchObject({ truncated: true, has_more: false, shown: limit });
      expect(result.notice).toBe(notice);
    });
  });

  it('reports more pages from the total when the portal sends no links.next', async () => {
    serve(searchBody(syntheticHits(10), { total: 95 }));
    const result = success(await run({ limit: 10, page: 3 }));
    expect(result).toMatchObject({ truncated: true, has_more: true });
    expect(result.notice).toContain('again with page 4');
  });

  it('points the page before the window edge at the last reachable page normally', async () => {
    serve(searchBody(syntheticHits(50), { total: 35_747, hasNext: true }));
    const result = success(await run({ limit: 50, page: 199 }));
    expect(result.notice).toContain('call cern_opendata_search_records again with page 200');
    expect(result.notice).toContain('Only the first 10,000 matches can be paged');
  });

  it('past-the-end page: empty hits with a positive total name the last page', async () => {
    serve(searchBody([], { total: 123 }));
    const result = success(await run({ limit: 10, page: 40 }));
    expect(result).toMatchObject({
      hits: [],
      truncated: false,
      shown: 0,
      cap: 10,
      totalCount: 123,
      page: 40,
    });
    expect(result.notice).toBe(
      'Page 40 is past the last page (123 matches); call cern_opendata_search_records again with page 13.',
    );
  });

  it('past-the-end page: the last page is clamped to the 10,000-match window', async () => {
    serve(searchBody([], { total: 50_000 }));
    const result = success(await run({ limit: 50, page: 200 }));
    expect(result.notice).toContain('with page 200.');
  });

  it('past-the-end page: a single match is named in the singular', async () => {
    serve(searchBody([], { total: 1 }));
    expect(success(await run({ page: 2 })).notice).toBe(
      'Page 2 is past the last page (1 match); call cern_opendata_search_records again with page 1.',
    );
  });

  it('keeps the facet counts on a zero-result page, so the alternatives show', async () => {
    serve(searchBody([], { total: 0, aggregations: aggregationsBody }));
    const result = success(await run({ experiment: 'ATLAS' }));
    expect(result.facets.experiment.buckets).toEqual([
      { value: 'ATLAS', count: 12 },
      { value: 'CMS', count: 700 },
    ]);
    expect(result.facets.type.buckets.map((bucket) => bucket.value)).toEqual([
      'Dataset',
      'Software',
    ]);
  });

  it('writes the same fields into the text trailer', async () => {
    serve(searchBody(syntheticHits(10), { total: 95, hasNext: true }));
    const trailer = textOf(await run({ limit: 10 }), 1);
    expect(trailer).toContain('**truncated:** true');
    expect(trailer).toContain('**shown:** 10');
    expect(trailer).toContain('**cap:** 10');
    expect(trailer).toContain('95 total');
    expect(trailer).toContain('Showing 1–10 of 95');
  });
});

describe('cern_opendata_search_records result', () => {
  it('maps hits compactly, omitting absent fields and never defaulting them', async () => {
    serve(searchBody([collisionDatasetHit, sparseHit, docHit, newsHit], { total: 4 }));
    const { hits } = success(await run({}));
    expect(hits[0]).toEqual({
      id: '6004',
      recid: '6004',
      title: '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
      type: { primary: 'Dataset', secondary: ['Collision'] },
      experiment: ['CMS'],
      run_period: ['Run2012B'],
      date_created: ['2012'],
      collections: ['CMS-Primary-Datasets'],
      formats: ['aod', 'root'],
      doi: '10.7483/OPENDATA.CMS.YLIC.86ZZ',
      date_published: '2014',
      availability: 'online',
      collision_energy: '8TeV',
      collision_type: 'pp',
      number_events: 29_308_627,
      number_files: 158,
      size_in_bytes: 4_950_000_000_000,
      portal_url: 'https://opendata.cern.ch/record/6004',
    });
    expect(hits[1]).toEqual({
      id: '1120',
      recid: '1120',
      title: 'Sparse record',
      type: { primary: 'Software', secondary: [] },
      portal_url: 'https://opendata.cern.ch/record/1120',
    });
    expect(hits[2]).toMatchObject({
      id: 'cms-guide-docker',
      slug: 'cms-guide-docker',
      short_description: 'How to run the CMS open data containers.',
      portal_url: 'https://opendata.cern.ch/docs/cms-guide-docker',
    });
    expect(hits[2]).not.toHaveProperty('recid');
    expect(hits[3]).toMatchObject({
      id: 'cms-releases-2026',
      portal_url: 'https://opendata.cern.ch/docs/cms-releases-2026',
    });
  });

  it('carries the facets with subtypes and drops the Glossary bucket', async () => {
    serve(searchBody([collisionDatasetHit], { total: 1, aggregations: aggregationsBody }));
    const { facets } = success(await run({}));
    expect(facets.type.buckets).toEqual([
      {
        value: 'Dataset',
        count: 600,
        subtypes: [
          { value: 'Collision', count: 500 },
          { value: 'Simulated', count: 100 },
        ],
      },
      { value: 'Software', count: 90, subtypes: [{ value: 'Analysis', count: 90 }] },
    ]);
    expect(facets.experiment.other_count).toBe(3);
    expect(facets.year.buckets.map((bucket) => bucket.value)).toEqual(['2012', '2013']);
    expect(facets.number_events.other_count).toBe(0);
  });

  it('carries the category facet with subcategories and the leading-space spelling as received', async () => {
    serve(searchBody([collisionDatasetHit], { total: 1, aggregations: aggregationsBody }));
    const { facets } = success(await run({}));
    expect(facets.category.buckets.map((bucket) => bucket.value)).toEqual([
      ' Heavy-Ion Physics',
      'Exotica',
      'Heavy-Ion Physics',
      'Higgs Physics',
    ]);
    expect(facets.category.buckets[3]).toEqual({
      value: 'Higgs Physics',
      count: 11_232,
      subcategories: [
        { value: 'Beyond Standard Model', count: 6815 },
        { value: 'Standard Model', count: 4417 },
      ],
    });
    expect(facets.category.other_count).toBe(25_724);
    expect(facets.keywords.other_count).toBe(474);
    expect(facets.magnet_polarity.buckets).toEqual([
      { value: 'MagDown', count: 61 },
      { value: 'MagUp', count: 60 },
    ]);
    expect(facets.stripping_stream.buckets.map((bucket) => bucket.value)).toEqual([
      'BHADRON',
      'DIMUON',
    ]);
    expect(facets.stripping_version.other_count).toBe(4);
    expect(facets).not.toHaveProperty('signature');
  });

  it('returns every facet, empty, when the portal sends no aggregations', async () => {
    serve(searchBody([collisionDatasetHit], { total: 1 }));
    const { facets } = success(await run({}));
    expect(Object.keys(facets)).toEqual([
      'experiment',
      'type',
      'collision_energy',
      'collision_type',
      'file_type',
      'availability',
      'year',
      'number_events',
      'category',
      'keywords',
      'magnet_polarity',
      'stripping_stream',
      'stripping_version',
    ]);
    for (const facet of Object.values(facets)) {
      expect(facet).toEqual({ buckets: [], other_count: 0 });
    }
  });

  it('derives has_more from the total, never from links.next', async () => {
    serve(searchBody(syntheticHits(2), { total: 2, hasNext: true }));
    const result = success(await run({}));
    expect(result).toMatchObject({ has_more: false, truncated: false });
    expect(result).not.toHaveProperty('notice');
  });

  it('echoes the requested page', async () => {
    serve(searchBody([], { total: 0 }));
    expect(success(await run({ page: 7, limit: 5 })).page).toBe(7);
  });

  it('keeps licensed hits compact: no license or citation on a search hit', async () => {
    serve(searchBody([licensedDatasetHit], { total: 1 }));
    const { hits } = success(await run({}));
    expect(hits[0]).not.toHaveProperty('license');
    expect(hits[0]).not.toHaveProperty('citation');
  });
});

describe('cern_opendata_search_records errors', () => {
  const failure = async (input: Parameters<typeof run>[0]) => errorOf(await run(input));

  it('invalid_query: the portal syntax 400 carries the upstream message and the recovery', async () => {
    serve(SYNTAX_ERROR_BODY, { status: 400 });
    const result = await run({ query: 'title:' });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_query',
      upstreamMessage: 'The syntax of the search query is invalid.',
    });
    expect(error.data).not.toHaveProperty('upstreamErrors');
    expect(hintOf(error)).toContain('cern_opendata_list_reference with topic query_syntax');
    expect(error.message).toBe(
      'The portal rejected the search: The syntax of the search query is invalid.',
    );
    const text = textOf(result);
    expect(text).toContain('Error: The portal rejected the search');
    expect(text).toContain('Recovery: Quote phrases');
    expect(text).toContain('reason invalid_query');
  });

  it.each([
    ['(foo', 'its ( at character 1 is never closed'],
    ['title:(', 'its ( at character 7 is never closed'],
    ['foo)', 'its ) at character 4 closes nothing opened before it'],
    [')(', 'its ) at character 1 closes nothing opened before it'],
    ['"foo', 'its " at character 1 is never closed'],
    ['foo"bar', 'its " at character 4 is never closed'],
    ['"foo\\"', 'its " at character 1 is never closed'],
    ['date_created:[2010 TO 2012', 'its [ at character 14 is never closed'],
    ['date_created:[2010 TO 2012)', 'its [ at character 14 is never closed'],
    ['foo]', 'its ] at character 4 closes nothing opened before it'],
    ['foo {', 'its { at character 5 is never closed'],
    ['foo\\', 'it ends with a \\ that escapes nothing'],
  ])(
    'invalid_query: %s is refused before any request, naming the unbalanced character',
    async (query, problem) => {
      const { http } = serve(emptySearchBody);
      const result = await run({ query });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'invalid_query', query });
      expect(error.message).toBe(`The query was not sent: ${problem}.`);
      expect(hintOf(error)).toContain('balance parentheses');
      expect(textOf(result)).toContain('reason invalid_query');
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([
    'muon \\(',
    '"foo (bar"',
    'title:"Double (Muon"',
    'date_created:[2010 TO 2012]',
    'date_created:{2010 TO 2012}',
    'date_created:[2010 TO 2012}',
    '[2010 TO 2012]',
    'title:(Double Muon)',
    '(muon OR electron) 2012',
    'title:/DoubleMu.*/',
    'foo"bar"',
    '"foo \\"bar"',
    'foo\\"bar',
    'foo\\\\',
    "Higgs' boson",
    "O'Neil",
    '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
    'title:[A( TO B]',
    'title:["a TO b]',
    'title:[A" TO B] "muon"',
  ])('sends the balanced query %s to the portal as written', async (query) => {
    const { http } = serve(emptySearchBody);
    const result = await run({ query });
    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    expect(paramsOf(http).get('q')).toBe(query);
  });

  it('invalid_query: any other 400 is carried too, with its field errors', async () => {
    serve(RANGE_ERROR_BODY, { status: 400 });
    const error = await failure({ query: 'x' });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_query',
      upstreamMessage: 'Validation error.',
      upstreamErrors: [{ field: 'date_created', message: 'Invalid range format.' }],
    });
  });

  it('invalid_query: a 400 whose body is not JSON carries the raw text', async () => {
    installService([searchRoute(() => new Response('plain refusal', { status: 400 }))]);
    const error = await failure({});
    expect(error.data).toMatchObject({
      reason: 'invalid_query',
      upstreamMessage: 'plain refusal',
    });
  });

  it('invalid_query: escapes the portal text in the message and keeps it as received in data', async () => {
    const body = '<img src=x> [a](https://evil.example)';
    installService([
      searchRoute(
        () => new Response(body, { status: 400, headers: { 'content-type': 'text/plain' } }),
      ),
    ]);
    const result = await run({});
    const error = errorOf(result);
    expect(error.message).toBe(
      'The portal rejected the search: &lt;img src=x&gt; \\[a\\](https://evil.example)',
    );
    expect(error.data).toMatchObject({ reason: 'invalid_query', upstreamMessage: body });
    expect(textOf(result)).not.toContain('<img');
  });

  it('invalid_query: a message that only mentions the window is still a syntax rejection', async () => {
    serve(
      { status: 400, message: 'Syntax invalid. Maximum number of 10000 results' },
      { status: 400 },
    );
    expect((await failure({})).data).toMatchObject({ reason: 'invalid_query' });
  });

  it('page_window_exceeded: the upstream window 400 maps to it, not to invalid_query', async () => {
    const { http } = serve(WINDOW_ERROR_BODY, { status: 400 });
    const result = await run({ query: 'x', page: 5, limit: 50 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'page_window_exceeded',
      upstreamMessage: 'Maximum number of 10000 results have been reached.',
    });
    expect(error.data).not.toHaveProperty('upstreamErrors');
    expect(error.message).toBe(
      'The portal refused the page: Maximum number of 10000 results have been reached.',
    );
    expect(hintOf(error)).toContain('Narrow the search');
    expect(textOf(result)).toContain('reason page_window_exceeded');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    [201, 50],
    [1001, 10],
    [10_001, 1],
  ])(
    'page_window_exceeded: page %i × limit %i is refused before any request',
    async (page, limit) => {
      const { http } = serve(emptySearchBody);
      const error = await failure({ page, limit });
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'page_window_exceeded',
        page,
        limit,
        window: 10_000,
      });
      expect(error.message).toBe(
        `page ${page} × limit ${limit} reaches past match 10000, the deepest the portal pages to.`,
      );
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([
    [200, 50],
    [1000, 10],
    [10_000, 1],
    [1, 50],
  ])('allows page %i × limit %i, the edge of the window', async (page, limit) => {
    const { http } = serve(searchBody([], { total: 0 }));
    const result = await run({ page, limit });
    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    expect(paramsOf(http).get('page')).toBe(String(page));
  });

  it('invalid_range: year_from after year_to is refused before any request', async () => {
    const { http } = serve(emptySearchBody);
    const result = await run({ year_from: 2013, year_to: 2012 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'invalid_range', year_from: 2013, year_to: 2012 });
    expect(error.message).toBe('year_from 2013 is after year_to 2012.');
    expect(textOf(result)).toContain('Recovery: Correct the bounds');
    expect(http.calls).toHaveLength(0);
  });

  it('invalid_range: min_events above max_events is refused before any request', async () => {
    const { http } = serve(emptySearchBody);
    const error = await failure({ min_events: 10, max_events: 5 });
    expect(error.data).toMatchObject({ reason: 'invalid_range', min_events: 10, max_events: 5 });
    expect(error.message).toBe('min_events 10 is above max_events 5.');
    expect(http.calls).toHaveLength(0);
  });

  it('invalid_range: equal bounds and a lone bound are fine', async () => {
    const { http } = serve(emptySearchBody);
    for (const input of [
      { year_from: 2012, year_to: 2012 },
      { min_events: 5, max_events: 5 },
      { year_from: 2100 },
      { year_to: 1900 },
      { min_events: 99 },
    ]) {
      expect((await run(input)).isError, JSON.stringify(input)).toBeFalsy();
    }
    expect(http.calls).toHaveLength(5);
  });

  it('invalid_range wins over the page window when both apply', async () => {
    serve(emptySearchBody);
    const error = await failure({ year_from: 2013, year_to: 2012, page: 500, limit: 50 });
    expect(error.data).toMatchObject({ reason: 'invalid_range' });
  });

  it('input-class refusals write no enrichment that could pass for a result', async () => {
    serve(emptySearchBody);
    const result = await run({ year_from: 2013, year_to: 2012 });
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).not.toHaveProperty('hits');
  });
});

describe('cern_opendata_search_records format', () => {
  async function rendered(hits: Parameters<typeof searchBody>[0], aggregations = {}) {
    serve(searchBody(hits, { total: hits.length, aggregations }));
    const result = await run({});
    return { result, data: success(result), text: textOf(result) };
  }

  it('renders the page line, every hit field and the portal URL', async () => {
    const { data, text } = await rendered([collisionDatasetHit]);
    const [h] = data.hits;
    expect(text.split('\n')[0]).toBe('**Page:** 1 · **More pages:** no · **Hits on this page:** 1');
    expect(text).toContain(`### ${h?.title}`);
    expect(text).toContain('**id:** 6004');
    expect(text).toContain('**type:** Dataset (Collision)');
    expect(text).toContain('**experiment:** CMS');
    expect(text).toContain('**energy:** 8TeV');
    expect(text).toContain('**collision:** pp');
    expect(text).toContain('**run period:** Run2012B');
    expect(text).toContain('**year:** 2012');
    expect(text).toContain('**formats:** aod, root');
    expect(text).toContain('**events:** 29308627');
    expect(text).toContain('**files:** 158');
    expect(text).toContain('**size:** 4950000000000 bytes');
    expect(text).toContain('**availability:** online');
    expect(text).toContain(`**DOI:** ${h?.doi}`);
    expect(text).toContain('**published:** 2014');
    expect(text).toContain('**collections:** CMS-Primary-Datasets');
    expect(text).toContain('https://opendata.cern.ch/record/6004');
  });

  it('renders every hit of the page, in order', async () => {
    const { data, text } = await rendered([collisionDatasetHit, softwareHit, docHit]);
    const positions = data.hits.map((h) => text.indexOf(`### ${inline(h.title ?? h.id)}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('renders a doc hit with its slug, fenced short description and docs URL', async () => {
    const { text } = await rendered([docHit]);
    expect(text).toContain('### Docker containers for CMS open data');
    expect(text).toContain('**id:** cms-guide-docker');
    expect(text).not.toContain('**slug:**');
    expect(text).toContain('```\nHow to run the CMS open data containers.\n```');
    expect(text).toContain('https://opendata.cern.ch/docs/cms-guide-docker');
  });

  it('renders a sparse hit without inventing values', async () => {
    const { text } = await rendered([sparseHit]);
    expect(text).toContain('### Sparse record');
    expect(text).toContain('**type:** Software');
    expect(text).not.toMatch(/undefined|null|NaN|\*\*events:\*\* 0|\*\*files:\*\* 0/);
    const hitSection = text.slice(0, text.indexOf('## Facets'));
    expect(hitSection).not.toContain('**experiment:**');
    expect(hitSection).not.toContain('**DOI:**');
  });

  it('renders a hit with no type as Not available and one with secondary types in parentheses', async () => {
    const { text } = await rendered([
      hit('1', { recid: '1', title: 'Typeless' }),
      hit('2', {
        recid: '2',
        title: 'Two',
        type: { primary: 'Dataset', secondary: ['Collision', 'Derived'] },
      }),
    ]);
    expect(text).toContain('**type:** Not available');
    expect(text).toContain('**type:** Dataset (Collision, Derived)');
  });

  it('renders the secondary types of a hit that states no primary type', async () => {
    const { data, text } = await rendered([
      hit('3', { recid: '3', title: 'Secondary only', type: { secondary: ['Collision'] } }),
    ]);
    expect(data.hits[0]?.type).toEqual({ primary: '', secondary: ['Collision'] });
    expect(text).toContain('**type:** Not available (Collision)');
  });

  it('shows the recid and slug when they differ from the id', () => {
    const blocks = searchRecords.format?.({
      hits: [
        {
          id: 'abc',
          recid: '77',
          slug: 'a-slug',
          type: { primary: 'Dataset', secondary: [] },
          portal_url: 'https://opendata.cern.ch/record/77',
        },
      ],
      page: 1,
      has_more: false,
      facets: emptyFacets(),
    });
    const text = blocks?.[0]?.type === 'text' ? blocks[0].text : '';
    expect(text).toContain('**id:** abc · **recid:** 77 · **slug:** a-slug');
  });

  it('declares bucket subtypes on the type facet and subcategories on the category facet only', () => {
    const shapes = Object.entries(searchRecords.output.shape.facets.shape);
    expect(shapes).toHaveLength(13);
    for (const [name, facet] of shapes) {
      const bucket = facet.shape.buckets.element.shape;
      expect('subtypes' in bucket, name).toBe(name === 'type');
      expect('subcategories' in bucket, name).toBe(name === 'category');
    }
  });

  it('renders a one-byte size in the singular', () => {
    const blocks = searchRecords.format?.({
      hits: [
        {
          id: '78',
          size_in_bytes: 1,
          type: { primary: 'Dataset', secondary: [] },
          portal_url: 'https://opendata.cern.ch/record/78',
        },
      ],
      page: 1,
      has_more: false,
      facets: emptyFacets(),
    });
    const text = blocks?.[0]?.type === 'text' ? blocks[0].text : '';
    expect(text).toMatch(/\*\*size:\*\* 1 byte$/m);
  });

  it('renders every facet bucket, count, subtype and other-values count', async () => {
    const { data, text } = await rendered([collisionDatasetHit], aggregationsBody);
    expect(text).toContain('## Facets');
    for (const [name, facet] of Object.entries(data.facets)) {
      expect(text, name).toContain(`- **${name}:**`);
      for (const bucket of facet.buckets) {
        expect(text, `${name} ${bucket.value}`).toContain(
          `${inlineSpelling(bucket.value)} (${bucket.count}`,
        );
        const nested = [
          ...(('subtypes' in bucket ? bucket.subtypes : undefined) ?? []),
          ...(('subcategories' in bucket ? bucket.subcategories : undefined) ?? []),
        ];
        for (const sub of nested) {
          expect(text).toContain(`${inlineSpelling(sub.value)} ${sub.count}`);
        }
      }
      if (facet.other_count > 0) expect(text).toContain(`other values: ${facet.other_count}`);
    }
    expect(text).toContain(
      '- **type:** Dataset (600: Collision 500, Simulated 100), Software (90: Analysis 90)',
    );
    expect(text).not.toContain('Glossary');
    expect(text).toContain('- **experiment:** ATLAS (12), CMS (700) · other values: 3');
    expect(text).toContain(
      '- **category:** " Heavy-Ion Physics" (219), Exotica (14584: Dark Matter 2138, "Heavy Fermions, Heavy Righ-Handed Neutrinos" 2301), Heavy-Ion Physics (3), Higgs Physics (11232: Beyond Standard Model 6815, Standard Model 4417) · other values: 25724',
    );
    expect(text).toContain('- **keywords:** Education (1), Roman Pot (2) · other values: 474');
    expect(text).toContain('- **magnet_polarity:** MagDown (61), MagUp (60)');
    expect(text).toContain(
      '- **stripping_stream:** BHADRON (3160), DIMUON (154) · other values: 390',
    );
    expect(text).toContain(
      '- **stripping_version:** stripping21 (2186), stripping21r1 (2178) · other values: 4',
    );
    expect(text).not.toContain('signature');
  });

  it('quotes a facet value with edge whitespace in every facet, so it stays apart from its trimmed twin', async () => {
    const { text } = await rendered([], {
      keywords: {
        buckets: [
          { key: 'Higgs ', doc_count: 1 },
          { key: 'Higgs', doc_count: 2 },
        ],
      },
      category: {
        buckets: [
          { key: 'X', doc_count: 1, subcategory: { buckets: [{ key: ' Y', doc_count: 1 }] } },
        ],
      },
    });
    expect(text).toContain('- **keywords:** "Higgs " (1), Higgs (2)');
    expect(text).toContain('- **category:** X (1: " Y" 1)');
  });

  it('quotes a facet value holding a comma, so it reads as one value', async () => {
    const { text } = await rendered([], {
      collision_energy: {
        buckets: [
          { key: '13TeV', doc_count: 5 },
          { key: '13TeV, 13.6TeV', doc_count: 1 },
        ],
      },
      category: {
        buckets: [
          {
            key: 'Exotica',
            doc_count: 3,
            subcategory: {
              buckets: [
                { key: 'Dark Matter', doc_count: 1 },
                { key: 'Heavy Fermions, Heavy Righ-Handed Neutrinos', doc_count: 2 },
              ],
            },
          },
        ],
      },
    });
    expect(text).toContain('- **collision_energy:** 13TeV (5), "13TeV, 13.6TeV" (1)');
    expect(text).toContain(
      '- **category:** Exotica (3: Dark Matter 1, "Heavy Fermions, Heavy Righ-Handed Neutrinos" 2)',
    );
  });

  it('renders an empty facet as none', async () => {
    const { text } = await rendered([]);
    expect(text).toContain('**Hits on this page:** 0');
    expect(text).toContain('- **experiment:** none');
    expect(text).toContain('- **number_events:** none');
  });

  it('keeps CR/LF, markup and bidi controls in upstream text out of the inline slots', async () => {
    const hostile = hit('555', {
      recid: '555',
      title: 'Evil\r\n# Injected heading\n- [link](http://evil.example) <script>',
      title_additional: 'Also\nTitled | cell',
      type: { primary: 'Dataset', secondary: ['Col\nlision'] },
      experiment: ['CMS\r\n## x', 'ATLAS|y'],
      run_period: ['Run\u202e2012'],
      date_created: ['20\n12'],
      collections: ['Coll\nection[1]'],
      doi: '10.7483/OPENDATA.X\n.Y',
      availability: 'on\nline',
      collision_information: { energy: '8\nTeV', type: 'p\np' },
      distribution: { formats: ['ao\nd', 'ro|ot'] },
    });
    const { text } = await rendered([hostile], {
      experiment: { buckets: [{ key: 'Bad\nKey [x]', doc_count: 1 }], sum_other_doc_count: 0 },
    });
    expect(text).toContain(
      '### Evil  # Injected heading - \\[link\\](http://evil.example) &lt;script&gt;',
    );
    const lines = text.split('\n');
    expect(lines.some((line) => line.startsWith('# '))).toBe(false);
    expect(lines.some((line) => line.startsWith('## ') && line !== '## Facets')).toBe(false);
    expect(lines.some((line) => line.startsWith('- [link]'))).toBe(false);
    expect(text).toContain('**Also titled:** Also Titled \\| cell');
    expect(text).toContain('**type:** Dataset (Col lision)');
    expect(text).toContain('**experiment:** CMS  ## x, ATLAS\\|y');
    expect(text).toContain('**run period:** Run2012');
    expect(text).toContain('**collections:** Coll ection\\[1\\]');
    expect(text).toContain('**DOI:** 10.7483/OPENDATA.X .Y');
    expect(text).toContain('**availability:** on line');
    expect(text).toContain('**energy:** 8 TeV');
    expect(text).toContain('**formats:** ao d, ro\\|ot');
    expect(text).toContain('Bad Key \\[x\\] (1)');
    expect(text).not.toMatch(/[\r\u202e]/);
  });

  it('fences a short description whose own backticks would close a plain fence', async () => {
    const { text } = await rendered([
      hit('news-1', {
        slug: 'news-1',
        title: 'News',
        type: { primary: 'News' },
        short_description: { content: 'before\n```\n# not a heading\n```\nafter' },
      }),
    ]);
    expect(text).toContain('````\nbefore\n```\n# not a heading\n```\nafter\n````');
  });

  it('returns a single text block for the page and one for the trailer', async () => {
    const { result } = await rendered([collisionDatasetHit]);
    expect(result.content).toHaveLength(2);
    expect(result.content.every((block) => block.type === 'text')).toBe(true);
  });
});

function emptyFacets() {
  const empty = { buckets: [], other_count: 0 };
  return {
    experiment: empty,
    type: empty,
    collision_energy: empty,
    collision_type: empty,
    file_type: empty,
    availability: empty,
    year: empty,
    number_events: empty,
    category: empty,
    keywords: empty,
    magnet_polarity: empty,
    stripping_stream: empty,
    stripping_version: empty,
  };
}
