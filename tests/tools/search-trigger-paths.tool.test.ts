/**
 * @fileoverview Tests for cern_opendata_search_trigger_paths: path
 * normalization (HLT_ prefix, case, wildcard, version suffix), the query for
 * paths outside the HLT_ family (anchored on the record title, checked against
 * the released query), the advertised input schemas (no lookaround),
 * blank-as-unset year, limit and page, the request sent on the wire, parsed
 * records for the three HLT_IsoMu24 abstracts and titles naming several
 * datasets, required enrichment on the zero-result,
 * under-cap, truncated and past-the-end pages, the notices the design
 * specifies, every declared error on the wire, upstream failure classes, and
 * the text twin of structuredContent. Upstream I/O is a strict fetch fake.
 * @module tests/tools/search-trigger-paths.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { searchTriggerPaths } from '@/mcp-server/tools/definitions/search-trigger-paths.tool.js';
import {
  type ContractResult,
  dataOf,
  disposeInstalledService,
  errorOf,
  installService,
  settle,
  textOf,
} from '../fixtures/cern-opendata-harness.js';
import {
  emptySearchBody,
  HTML_ERROR_PAGE,
  hit,
  ISOMU24_2011_ABSTRACT,
  isoMu24Hit2011,
  isoMu24Hit2012,
  isoMu24Hit2016,
  jsonResponse,
  portalRoute,
  RANGE_ERROR_BODY,
  SYNTAX_ERROR_BODY,
  searchBody,
  triggerHit,
  WINDOW_ERROR_BODY,
} from '../fixtures/cern-opendata-upstream.js';

type Output = Awaited<ReturnType<typeof searchTriggerPaths.handler>>;
type Result = Output & {
  cap: number;
  effectiveQuery: string;
  notice?: string;
  shown: number;
  totalCount: number;
  truncated: boolean;
};

const searchRoute = (respond: Parameters<typeof portalRoute>[1]) =>
  portalRoute('/api/records/', respond);

function serve(body: unknown, init: ResponseInit = {}) {
  return installService([searchRoute(() => jsonResponse(body, init))]);
}

const run = (input: Parameters<typeof runToolContract<typeof searchTriggerPaths>>[1]) =>
  runToolContract(searchTriggerPaths, input);

const success = (result: ContractResult) => dataOf<Result>(result);

const paramsOf = (http: ReturnType<typeof installService>['http'], call = 0) =>
  new URL(http.calls[call]?.request.url ?? '').searchParams;

const hintOf = (error: ReturnType<typeof errorOf>): string =>
  String((error.data?.recovery as { hint?: string } | undefined)?.hint);

/** The record-title prefix as a `title` keyword term, its spaces escaped. */
const TITLE = 'High-Level\\ Trigger\\ path\\ information\\ ';

/**
 * The query sent for a path outside the HLT_ family: its record titles (the
 * title alone or with a dataset suffix; a prefix for a trailing `*`), or the
 * path with HLT_ prepended.
 */
const anchored = (path: string) =>
  path.endsWith('*')
    ? `title:${TITLE}${path} OR HLT_${path}`
    : `title:"High-Level Trigger path information ${path}" OR title:${TITLE}${path}\\ \\(* OR HLT_${path}`;

/** `count` trigger path hits, recids from 7000. */
const triggerHits = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    triggerHit(String(7000 + i), `HLT_Mu${i}`, ISOMU24_2011_ABSTRACT, { year: '2012' }),
  );

afterEach(() => {
  disposeInstalledService();
});

describe('cern_opendata_search_trigger_paths registration', () => {
  it('is registered, read-only, idempotent and open-world', () => {
    expect(allToolDefinitions).toContain(searchTriggerPaths);
    expect(searchTriggerPaths.name).toBe('cern_opendata_search_trigger_paths');
    expect(searchTriggerPaths.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('declares the three error reasons with the right codes and the service-thrown ones marked', () => {
    const byReason = Object.fromEntries(
      (searchTriggerPaths.errors ?? []).map((entry) => [entry.reason, entry]),
    );
    expect(Object.keys(byReason).sort()).toEqual([
      'page_window_exceeded',
      'rate_limited',
      'upstream_unreadable',
    ]);
    expect(byReason.page_window_exceeded).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
    });
    expect(byReason.rate_limited).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
    });
    expect(byReason.upstream_unreadable).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
    });
  });

  it('names its own tool in every recovery', () => {
    for (const entry of searchTriggerPaths.errors ?? []) {
      expect(entry.recovery, entry.reason).toContain('cern_opendata_search_trigger_paths');
    }
  });

  it('states trigger coverage as 2011-2016, the years that hold path records', () => {
    const input = z.toJSONSchema(searchTriggerPaths.input, { io: 'input', unrepresentable: 'any' });
    const year = input.properties?.year;
    expect(searchTriggerPaths.description).toContain('Covers CMS open data from 2011-2016.');
    expect(typeof year === 'object' ? year.description : undefined).toBe(
      'Data-taking year, such as 2012. Trigger records cover 2011-2016.',
    );
    expect(JSON.stringify({ input, description: searchTriggerPaths.description })).not.toMatch(
      /2010/,
    );
  });

  it('describes each datasets item and the effectiveQuery echo as built', () => {
    const output = z.toJSONSchema(searchTriggerPaths.output, { unrepresentable: 'any' });
    const triggers = output.properties?.triggers;
    const trigger = typeof triggers === 'object' ? triggers.items : undefined;
    const datasets =
      trigger && typeof trigger === 'object' && !Array.isArray(trigger)
        ? trigger.properties?.datasets
        : undefined;
    const item = typeof datasets === 'object' ? datasets.items : undefined;
    expect(item && typeof item === 'object' && !Array.isArray(item) ? item.description : '').toBe(
      'One primary dataset name.',
    );
    expect(searchTriggerPaths.enrichment?.effectiveQuery?.description).toBe(
      'The query sent, after normalization (version suffix dropped): an HLT_ path as given; any other path as title clauses matching it as a record path name, OR HLT_ plus the path.',
    );
  });

  it('declares the required list enrichment and the required effectiveQuery echo', () => {
    expect(Object.keys(searchTriggerPaths.enrichment ?? {}).sort()).toEqual([
      'cap',
      'effectiveQuery',
      'notice',
      'shown',
      'totalCount',
      'truncated',
    ]);
  });
});

describe('cern_opendata_search_trigger_paths path input', () => {
  it.each([
    ['HLT_IsoMu24', 'HLT_IsoMu24'],
    ['  HLT_IsoMu24  ', 'HLT_IsoMu24'],
    ['hlt_IsoMu24', 'HLT_IsoMu24'],
    ['Hlt_IsoMu24', 'HLT_IsoMu24'],
    ['IsoMu24', 'IsoMu24'],
    ['  IsoMu24', 'IsoMu24'],
    ['HLT_IsoMu*', 'HLT_IsoMu*'],
    ['IsoMu*', 'IsoMu*'],
    ['hlt_isomu*', 'HLT_isomu*'],
    ['HLT_IsoMu24_v3', 'HLT_IsoMu24_v3'],
    ['HLT_IsoMu24_v*', 'HLT_IsoMu24_v*'],
    ['HLT_HLT_IsoMu24', 'HLT_HLT_IsoMu24'],
    ['HLT_Mu_7_8', 'HLT_Mu_7_8'],
    ['HLT_9', 'HLT_9'],
    ['AlCa_EcalPi0', 'AlCa_EcalPi0'],
    ['HLTriggerFinalPath', 'HLTriggerFinalPath'],
    ['hlt', 'hlt'],
    ['300Tower0p5', '300Tower0p5'],
    [' 60Jet10 ', '60Jet10'],
    ['70Jet*', '70Jet*'],
    ['3*', '3*'],
    ['9', '9'],
  ])('reads the path %j as %j', (raw, expected) => {
    expect(searchTriggerPaths.input.parse({ path: raw }).path).toBe(expected);
  });

  it('keeps the case of everything past the prefix: names are not lowercased or uppercased', () => {
    expect(searchTriggerPaths.input.parse({ path: 'hlt_ISOMU24' }).path).toBe('HLT_ISOMU24');
    expect(searchTriggerPaths.input.parse({ path: 'isomu24' }).path).toBe('isomu24');
  });

  it.each([
    ['an empty path', ''],
    ['a blank path', '   '],
    ['the prefix alone', 'HLT_'],
    ['a lone wildcard', '*'],
    ['a prefix and a wildcard only', 'HLT_*'],
    ['a wildcard in the middle', 'HLT_Iso*Mu'],
    ['two trailing wildcards', 'HLT_IsoMu**'],
    ['a space inside', 'HLT_Iso Mu24'],
    ['a hyphen', 'HLT_Iso-Mu24'],
    ['a boolean operator', 'HLT_IsoMu24 OR HLT_Mu*'],
    ['a field prefix', 'title:HLT_IsoMu24'],
    ['a quote', 'HLT_Iso"Mu24'],
    ['a newline', 'HLT_IsoMu24\nHLT_Mu9'],
    ['a slash', 'HLT_IsoMu/24'],
    ['a question-mark wildcard', 'HLT_IsoMu?'],
    ['more than 200 characters', `HLT_${'a'.repeat(200)}`],
  ])('rejects %s as invalid arguments before any request', async (_name, path) => {
    const { http } = serve(emptySearchBody);
    const result = await run({ path });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(http.calls).toHaveLength(0);
  });

  it('rejects a missing path and a list of paths', async () => {
    const { http } = serve(emptySearchBody);
    expect(errorOf(await run({} as never)).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(await run({ path: ['HLT_Mu'] } as never)).code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    expect(http.calls).toHaveLength(0);
  });

  it('accepts a 200-character path', () => {
    const path = `HLT_${'a'.repeat(196)}`;
    expect(searchTriggerPaths.input.parse({ path }).path).toBe(path);
  });

  it('reads blank year, limit and page as unset, applying the defaults', () => {
    expect(
      searchTriggerPaths.input.parse({ path: 'HLT_Mu9', year: '', limit: ' ', page: '' }),
    ).toEqual({ path: 'HLT_Mu9', limit: 10, page: 1 });
  });

  it('sends the same request for a form client full of blanks as for the bare path', async () => {
    const { http } = serve(emptySearchBody);
    await run({ path: 'HLT_Mu9' });
    await run({ path: 'HLT_Mu9', year: '', limit: '', page: '' } as never);
    expect(http.calls[1]?.request.url).toBe(http.calls[0]?.request.url);
  });

  it.each([
    ['year 1999', { year: 1999 }],
    ['year 2101', { year: 2101 }],
    ['a fractional year', { year: 2012.5 }],
    ['limit 0', { limit: 0 }],
    ['limit 51', { limit: 51 }],
    ['a fractional limit', { limit: 2.5 }],
    ['page 0', { page: 0 }],
    ['a negative page', { page: -1 }],
  ])('rejects %s as invalid arguments before any request', async (_name, extra) => {
    const { http } = serve(emptySearchBody);
    const result = await run({ path: 'HLT_Mu9', ...extra });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
  });

  it('accepts the year, limit and page edges', () => {
    expect(searchTriggerPaths.input.parse({ path: 'HLT_Mu9', year: 2000 }).year).toBe(2000);
    expect(searchTriggerPaths.input.parse({ path: 'HLT_Mu9', year: 2100 }).year).toBe(2100);
    expect(searchTriggerPaths.input.parse({ path: 'HLT_Mu9', limit: 1 }).limit).toBe(1);
    expect(searchTriggerPaths.input.parse({ path: 'HLT_Mu9', limit: 50 }).limit).toBe(50);
  });
});

describe('cern_opendata_search_trigger_paths on the wire', () => {
  it('sends the fixed filters, the default size and page, and the path as the query', async () => {
    const { http } = serve(emptySearchBody);
    await run({ path: 'HLT_IsoMu24' });
    expect(http.calls).toHaveLength(1);
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.pathname).toBe('/api/records/');
    const params = url.searchParams;
    expect(params.get('q')).toBe('HLT_IsoMu24');
    expect(params.getAll('type')).toEqual(['Supplementaries::Trigger']);
    expect(params.getAll('experiment')).toEqual(['CMS']);
    expect(params.get('sort')).toBe('bestmatch');
    expect(params.get('size')).toBe('10');
    expect(params.get('page')).toBe('1');
    expect(params.get('skip_files')).toBe('1');
    expect(params.get('ondemand')).toBe('true');
    expect(params.has('year')).toBe(false);
    expect([...params.keys()].sort()).toEqual(
      ['experiment', 'ondemand', 'page', 'q', 'size', 'skip_files', 'sort', 'type'].sort(),
    );
  });

  it('sends a normalized prefix path, a year range, the limit and the page', async () => {
    const { http } = serve(emptySearchBody);
    await run({ path: ' isomu*', year: 2012, limit: 25, page: 3 });
    const params = paramsOf(http);
    expect(params.get('q')).toBe(anchored('isomu*'));
    expect(params.get('year')).toBe('2012--2012');
    expect(params.get('size')).toBe('25');
    expect(params.get('page')).toBe('3');
  });

  it.each([
    ['HLT_IsoMu24_v3', 'HLT_IsoMu24'],
    ['HLT_IsoMu24_V3', 'HLT_IsoMu24'],
    ['HLT_IsoMu24_v12', 'HLT_IsoMu24'],
    ['HLT_IsoMu24_v*', 'HLT_IsoMu24'],
    ['isomu24_v1', anchored('isomu24')],
  ])('strips the version suffix of %j and searches %j', async (path, searched) => {
    const { http } = serve(emptySearchBody);
    const result = success(await run({ path }));
    expect(paramsOf(http).get('q')).toBe(searched);
    expect(result.effectiveQuery).toBe(searched);
  });

  it.each([
    ['HLT_IsoMu24_v', 'HLT_IsoMu24_v'],
    ['HLT_IsoMu24_va', 'HLT_IsoMu24_va'],
    ['HLT_v3', 'HLT_v3'],
    ['HLT_IsoMu24_v3_v4', 'HLT_IsoMu24_v3'],
    ['HLT_IsoMu24v3', 'HLT_IsoMu24v3'],
  ])('leaves %j alone or strips only one suffix: searches %j', async (path, searched) => {
    const { http } = serve(emptySearchBody);
    await run({ path });
    expect(paramsOf(http).get('q')).toBe(searched);
  });

  it('echoes the normalized query as effectiveQuery', async () => {
    serve(emptySearchBody);
    expect(success(await run({ path: ' isomu24 ' })).effectiveQuery).toBe(anchored('isomu24'));
    expect(success(await run({ path: 'HLT_IsoMu*' })).effectiveQuery).toBe('HLT_IsoMu*');
  });

  it('echoes the path in the text trailer', async () => {
    serve(emptySearchBody);
    expect(textOf(await run({ path: 'IsoMu24' }), 1)).toContain('HLT_IsoMu24');
  });
});

describe('cern_opendata_search_trigger_paths paths outside the HLT_ family', () => {
  it.each([
    ['AlCa_EcalPi0', anchored('AlCa_EcalPi0')],
    ['AlCa_*', anchored('AlCa_*')],
    ['DST_Physics', anchored('DST_Physics')],
    ['HLTriggerFinalPath', anchored('HLTriggerFinalPath')],
    ['ALCAP0Output', anchored('ALCAP0Output')],
    ['IsoMu24', anchored('IsoMu24')],
    ['  isomu*', anchored('isomu*')],
    ['A', anchored('A')],
    ['A*', anchored('A*')],
    ['HLT_IsoMu24', 'HLT_IsoMu24'],
    ['hlt_isomu24', 'HLT_isomu24'],
    ['HLT_IsoMu*', 'HLT_IsoMu*'],
  ])(
    'searches %j by its record titles and with HLT_ prepended, in one request: %j',
    async (path, query) => {
      const { http } = serve(emptySearchBody);
      const result = success(await run({ path }));
      expect(http.calls).toHaveLength(1);
      expect(paramsOf(http).get('q')).toBe(query);
      expect(result.effectiveQuery).toBe(query);
    },
  );

  it.each([
    ['AND', 'AND', '"AND" OR HLT_AND'],
    ['OR', 'OR', '"OR" OR HLT_OR'],
    ['NOT', 'NOT', '"NOT" OR HLT_NOT'],
    ['TO', 'TO', '"TO" OR HLT_TO'],
    ['and', 'and', '"and" OR HLT_and'],
    ['Or', 'Or', '"Or" OR HLT_Or'],
    ['not', 'not', '"not" OR HLT_not'],
    ['to', 'to', '"to" OR HLT_to'],
    ['OR_v2', 'OR', '"OR" OR HLT_OR'],
    ['OR*', 'OR*', 'OR* OR HLT_OR*'],
    ['ORANGE', 'ORANGE', 'ORANGE OR HLT_ORANGE'],
  ])(
    'sends a path spelled as a query operator, %j, only inside title terms, and quotes it in the search_records suggestion',
    async (path, stripped, suggestion) => {
      const { http } = serve(emptySearchBody);
      const result = success(await run({ path }));
      expect(result.effectiveQuery).toBe(anchored(stripped));
      expect(paramsOf(http).get('q')).toBe(anchored(stripped));
      expect(result.notice).toContain(
        `cern_opendata_search_records with query ${suggestion} to search other record types.`,
      );
    },
  );

  it('sends HLT_OR as given, and suggests it as given', async () => {
    const { http } = serve(emptySearchBody);
    const result = success(await run({ path: 'HLT_OR' }));
    expect(paramsOf(http).get('q')).toBe('HLT_OR');
    expect(result.notice).toContain('cern_opendata_search_records with query HLT_OR to search');
  });

  it.each([
    ['AlCa_EcalPi0_v3', 'AlCa_EcalPi0', '3'],
    ['DST_Physics_v*', 'DST_Physics', '*'],
    ['HLTriggerFinalPath_V2', 'HLTriggerFinalPath', '2'],
  ])(
    'strips the version suffix of %j and searches both forms of %j',
    async (path, stripped, version) => {
      const { http } = serve(emptySearchBody);
      const result = success(await run({ path }));
      expect(paramsOf(http).get('q')).toBe(anchored(stripped));
      expect(result.notice).toContain(
        version === '*'
          ? `${path} names every version of ${stripped}.`
          : `${path} is version ${version} of ${stripped}.`,
      );
    },
  );

  it('names both forms searched in the zero-hit notice', async () => {
    serve(emptySearchBody);
    const result = success(await run({ path: 'AlCa_Nope_v2', year: 2012 }));
    expect(result.notice).toBe(
      'Path versions are listed per record as V<n>; AlCa_Nope_v2 is version 2 of AlCa_Nope. No CMS HLT path record matches "AlCa_Nope" or "HLT_AlCa_Nope" in 2012; path records cover CMS open data from 2011-2016. Try a prefix pattern such as HLT_IsoMu*, drop year, or call cern_opendata_search_records with query AlCa_Nope OR HLT_AlCa_Nope to search other record types.',
    );
  });

  it('renders a record whose path has no HLT_ prefix', async () => {
    serve(
      searchBody([triggerHit('2007', 'AlCa_EcalPi0', ISOMU24_2011_ABSTRACT, { year: '2011' })], {
        total: 1,
      }),
    );
    const result = await run({ path: 'AlCa_EcalPi0' });
    expect(success(result).triggers[0]).toMatchObject({ recid: '2007', path: 'AlCa_EcalPi0' });
    expect(textOf(result)).toContain('### AlCa_EcalPi0, 2011');
  });

  it.each([
    ['an underscore first', '_IsoMu24'],
    ['a lone underscore', '_'],
    ['an underscore-led prefix', '_*'],
  ])('rejects a path with %s, which names no record family', async (_name, path) => {
    const { http } = serve(emptySearchBody);
    const result = await run({ path });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).message).toContain(
      'A path is a letter or digit followed by letters, digits and underscores',
    );
    expect(http.calls).toHaveLength(0);
  });

  /** 2011 path records named HLT_ and a digit: 2027–2030, 2031–2036, 2037–2039. */
  it.each(['300Tower0p5', '600Tower1p0', '60Jet10', '70Jet13', '70Jet*', '3*', '9'])(
    'searches the digit-led path %j by its record titles and as HLT_ plus the path, as 0.1.1 did',
    async (path) => {
      const { http } = serve(emptySearchBody);
      const result = success(await run({ path }));
      expect(http.calls).toHaveLength(1);
      expect(paramsOf(http).get('q')).toBe(anchored(path));
      expect(result.effectiveQuery).toBe(anchored(path));
      expect((paramsOf(http).get('q') ?? '').split(' OR ')).toContain(`HLT_${path}`);
    },
  );

  it('strips the version suffix of a digit-led path and searches both forms of the rest', async () => {
    const { http } = serve(emptySearchBody);
    const result = success(await run({ path: '60Jet10_v2' }));
    expect(paramsOf(http).get('q')).toBe(anchored('60Jet10'));
    expect(result.notice).toContain('60Jet10_v2 is version 2 of 60Jet10.');
  });
});

describe('cern_opendata_search_trigger_paths anchors names outside the HLT_ family on the record title', () => {
  it.each([
    ['AlCa_*', `title:${TITLE}AlCa_* OR HLT_AlCa_*`],
    ['Jet*', `title:${TITLE}Jet* OR HLT_Jet*`],
    [
      'AlCa_EcalPi0',
      `title:"High-Level Trigger path information AlCa_EcalPi0" OR title:${TITLE}AlCa_EcalPi0\\ \\(* OR HLT_AlCa_EcalPi0`,
    ],
    [
      'IsoMu24_v3',
      `title:"High-Level Trigger path information IsoMu24" OR title:${TITLE}IsoMu24\\ \\(* OR HLT_IsoMu24`,
    ],
    ['OR', `title:"High-Level Trigger path information OR" OR title:${TITLE}OR\\ \\(* OR HLT_OR`],
    ['HLT_IsoMu*', 'HLT_IsoMu*'],
    ['hlt_isomu24', 'HLT_isomu24'],
  ])('sends and echoes %j as %s', async (path, query) => {
    const { http } = serve(emptySearchBody);
    const result = success(await run({ path }));
    expect(paramsOf(http).get('q')).toBe(query);
    expect(result.effectiveQuery).toBe(query);
  });

  it('never sends a bare term: every clause is a title term or an HLT_ name', async () => {
    for (const path of [
      'Jet*',
      'OR',
      'AlCa_EcalPi0',
      'A',
      'and*',
      'HLTriggerFinalPath',
      '300Tower0p5',
      '3*',
    ]) {
      const { http } = serve(emptySearchBody);
      await run({ path });
      const clauses = (paramsOf(http).get('q') ?? '').split(' OR ');
      expect(clauses.filter((clause) => !/^(?:title:|HLT_)/.test(clause))).toEqual([]);
      disposeInstalledService();
    }
  });

  it('suggests the plain forms, not the anchored query, to cern_opendata_search_records', async () => {
    serve(emptySearchBody);
    const result = await run({ path: 'AlCa_Nope' });
    const suggestion =
      'or call cern_opendata_search_records with query AlCa_Nope OR HLT_AlCa_Nope to search other record types.';
    expect(success(result).notice).toBe(
      `No CMS HLT path record matches "AlCa_Nope" or "HLT_AlCa_Nope"; path records cover CMS open data from 2011-2016. Try a prefix pattern such as HLT_IsoMu*, ${suggestion}`,
    );
    expect(success(result).effectiveQuery).toBe(anchored('AlCa_Nope'));
    expect(textOf(result, 1)).toContain(suggestion);
  });
});

describe('cern_opendata_search_trigger_paths advertised input schemas', () => {
  /** The path pattern spelled with a lookahead: what the lookahead-free one must equal. */
  const LOOKAHEAD_PATTERN = /^(?:HLT_[A-Za-z0-9_]+|(?!HLT_)[A-Za-z0-9][A-Za-z0-9_]*)\*?$/;
  /** The released (0.1.1) path handling, frozen: HLT_ prepended when missing, its case fixed. */
  const RELEASED_PATTERN = /^HLT_[A-Za-z0-9_]+\*?$/;
  const releasedAccepts = (text: string) =>
    RELEASED_PATTERN.test(/^hlt_/i.test(text) ? `HLT_${text.slice(4)}` : `HLT_${text}`);
  /** The current preprocess (the HLT_ prefix case fixed), then the advertised pattern. */
  const accepts = (pattern: RegExp, text: string) =>
    pattern.test(/^hlt_/i.test(text) ? `HLT_${text.slice(4)}` : text);
  /** Every string of 1 to 5 characters over the boundary characters, digit-led ones included. */
  const boundaryStrings = () => {
    const alphabet = ['G', 'H', 'I', 'K', 'L', 'M', 'S', 'T', 'U', 'l', 't', '_', '0', '*'];
    let all: string[] = [];
    let strings = [''];
    for (let length = 1; length <= 5; length++) {
      strings = strings.flatMap((prefix) => alphabet.map((char) => prefix + char));
      all = all.concat(strings);
    }
    expect(strings).toHaveLength(alphabet.length ** 5);
    return all;
  };
  const inputSchemaOf = (tool: (typeof allToolDefinitions)[number]) =>
    z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' });
  const advertisedPathPattern = () => {
    const path = inputSchemaOf(searchTriggerPaths).properties?.path;
    const pattern = typeof path === 'object' ? path.pattern : undefined;
    expect(pattern).toBeDefined();
    return new RegExp(String(pattern));
  };

  it('advertises a path pattern', () => {
    expect(advertisedPathPattern().source).toMatch(/^\^\(\?:HLT_/);
  });

  it.each(allToolDefinitions.map((tool) => [tool.name, tool] as const))(
    '%s advertises no lookahead or lookbehind in its input schema',
    (_name, tool) => {
      expect(JSON.stringify(inputSchemaOf(tool))).not.toMatch(/\(\?<?[=!]/);
    },
  );

  it('advertises a path pattern that agrees with the lookahead one on every string up to 5 characters over the boundary characters', () => {
    const pattern = advertisedPathPattern();
    const disagreements = boundaryStrings().filter(
      (text) => pattern.test(text) !== LOOKAHEAD_PATTERN.test(text),
    );
    expect(disagreements).toEqual([]);
  });

  it('accepts a digit-led path exactly when 0.1.1 did, and refuses only underscore-led paths 0.1.1 took', () => {
    const pattern = advertisedPathPattern();
    const strings = boundaryStrings();
    const digitLed = strings.filter((text) => /^\d/.test(text));
    expect(digitLed.filter((text) => accepts(pattern, text)).length).toBeGreaterThan(0);
    expect(digitLed.filter((text) => accepts(pattern, text) !== releasedAccepts(text))).toEqual([]);
    const lost = strings.filter((text) => releasedAccepts(text) && !accepts(pattern, text));
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.filter((text) => !text.startsWith('_'))).toEqual([]);
  });
});

describe('cern_opendata_search_trigger_paths keeps every match the released path handling found', () => {
  /**
   * The released path handling, frozen: trim, prepend HLT_ when missing or fix
   * its case, check the pattern, strip one version suffix. Returns the `q` it
   * sent, or undefined for a path it refused.
   */
  function releasedQuery(raw: string): string | undefined {
    const pattern = /^HLT_[A-Za-z0-9_]+\*?$/;
    const trimmed = raw.trim();
    const path = /^hlt_/i.test(trimmed) ? `HLT_${trimmed.slice(4)}` : `HLT_${trimmed}`;
    if (path.length > 200 || !pattern.test(path)) return;
    const match = /_v(\d+|\*)$/i.exec(path);
    if (!match?.[1]) return path;
    const stripped = path.slice(0, match.index);
    return pattern.test(stripped) ? stripped : path;
  }

  it.each([
    'IsoMu24',
    'HLT_IsoMu24',
    'hlt_isomu24',
    'HLT_IsoMu*',
    'HLT_IsoMu24_v2',
    '  HLT_IsoMu24  ',
    'Hlt_IsoMu24',
    'IsoMu*',
    'hlt_isomu*',
    'isomu24_v1',
    'HLT_IsoMu24_v*',
    'HLT_IsoMu24_v3_v4',
    'HLT_HLT_IsoMu24',
    'HLT_Mu_7_8',
    'HLT_9',
    'HLT_v3',
    'AlCa_EcalPi0',
    'OR',
    '300Tower0p5',
    '60Jet10',
    '70Jet*',
    '3*',
    `HLT_${'a'.repeat(196)}`,
  ])('%j is still accepted, and its query still holds the released one', async (path) => {
    const released = releasedQuery(path);
    expect(released).toBeDefined();
    const { http } = serve(emptySearchBody);
    expect((await run({ path })).isError).toBeFalsy();
    const query = paramsOf(http).get('q') ?? '';
    const forms = query.split(' OR ');
    expect(forms).toContain(released);
  });
});

describe('cern_opendata_search_trigger_paths result: the three HLT_IsoMu24 records', () => {
  const body = () => searchBody([isoMu24Hit2011, isoMu24Hit2012, isoMu24Hit2016], { total: 3 });

  it('maps record 2561 (2011) into its parsed fields and keeps the abstract as received', async () => {
    serve(body());
    const [trigger] = success(await run({ path: 'HLT_IsoMu24' })).triggers;
    expect(trigger).toEqual({
      recid: '2561',
      portal_url: 'https://opendata.cern.ch/record/2561',
      path: 'HLT_IsoMu24',
      dataset: 'SingleMu',
      datasets: ['SingleMu'],
      year: '2011',
      first_seen: {
        run: 160404,
        menu: '/cdaq/physics/Run2011/5e32/v4.2/HLT/V2',
        menu_recid: '3521',
      },
      last_seen: {
        run: 178380,
        menu: '/cdaq/physics/Run2011/5e32/v6.1/HLT/V2',
        menu_recid: '3530',
      },
      versions: [
        { version: 1, run_first: 160404, run_last: 163261, l1_seed: 'L1_SingleMu12' },
        { version: 2, run_first: 163269, run_last: 165970, l1_seed: 'L1_SingleMu12' },
        { version: 6, run_first: 166346, run_last: 166346, l1_seed: 'L1_SingleMu12' },
      ],
      trigger_list_recid: '3000',
      parsed: true,
      abstract_html: ISOMU24_2011_ABSTRACT,
    });
  });

  it('maps record 6537 (2012): a plain-text last-seen menu has no menu_recid', async () => {
    serve(body());
    const trigger = success(await run({ path: 'HLT_IsoMu24' })).triggers[1];
    expect(trigger).toMatchObject({
      recid: '6537',
      year: '2012',
      dataset: 'SingleMu',
      last_seen: { run: 209151, menu: '/cdaq/special/25ns/v1.1/HLT/V2' },
      trigger_list_recid: '6000',
      parsed: true,
    });
    expect(trigger?.last_seen).not.toHaveProperty('menu_recid');
  });

  it('maps record 29551 (2016): no dataset, versions without an L1 seed', async () => {
    serve(body());
    const trigger = success(await run({ path: 'HLT_IsoMu24' })).triggers[2];
    expect(trigger).toMatchObject({ recid: '29551', year: '2016', parsed: true });
    expect(trigger).not.toHaveProperty('dataset');
    expect(trigger).not.toHaveProperty('datasets');
    expect(trigger?.versions).toEqual([
      { version: 1, run_first: 273158, run_last: 274443 },
      { version: 2, run_first: 274445, run_last: 284044 },
    ]);
  });

  it('lists the one dataset of a singular title in datasets as well as dataset', async () => {
    serve(body());
    const [trigger] = success(await run({ path: 'HLT_IsoMu24' })).triggers;
    expect(trigger).toMatchObject({ dataset: 'SingleMu', datasets: ['SingleMu'] });
  });

  it.each([[['DoubleMu', 'DoubleMuParked']], [['HT', 'HTMHT', 'HTMHTParked']]])(
    'maps a title naming the datasets %j: the path alone, every name in order, no dataset',
    async (datasets) => {
      serve(
        searchBody(
          [triggerHit('6666', 'HLT_Mu17_Mu8', ISOMU24_2011_ABSTRACT, { datasets, year: '2012' })],
          { total: 1 },
        ),
      );
      const [trigger] = success(await run({ path: 'HLT_Mu17_Mu8' })).triggers;
      expect(trigger).toMatchObject({
        recid: '6666',
        path: 'HLT_Mu17_Mu8',
        datasets,
        year: '2012',
      });
      expect(trigger).not.toHaveProperty('dataset');
    },
  );

  it('returns the page, has_more and the records in the portal order', async () => {
    serve(body());
    const result = success(await run({ path: 'HLT_IsoMu24' }));
    expect(result.page).toBe(1);
    expect(result.has_more).toBe(false);
    expect(result.triggers.map((t) => t.recid)).toEqual(['2561', '6537', '29551']);
  });

  it('echoes the requested page and derives has_more from the total', async () => {
    serve(searchBody(triggerHits(2), { total: 12 }));
    const result = success(await run({ path: 'HLT_Mu*', page: 2, limit: 2 }));
    expect(result).toMatchObject({ page: 2, has_more: true });
  });

  it('never reads has_more from links.next', async () => {
    serve(searchBody(triggerHits(2), { total: 2, hasNext: true }));
    const result = success(await run({ path: 'HLT_Mu*', limit: 2 }));
    expect(result).toMatchObject({ has_more: false, truncated: false });
    expect(result).not.toHaveProperty('notice');
  });

  it('flags an unparsable abstract as parsed false and keeps the abstract and the path from the title', async () => {
    const odd = triggerHit('8000', 'HLT_Odd', '<p>Free text the portal wrote by hand.</p>', {
      year: '2013',
    });
    serve(searchBody([odd]));
    const [trigger] = success(await run({ path: 'HLT_Odd' })).triggers;
    expect(trigger).toMatchObject({
      recid: '8000',
      path: 'HLT_Odd',
      year: '2013',
      parsed: false,
      versions: [],
      abstract_html: '<p>Free text the portal wrote by hand.</p>',
    });
    expect(trigger).not.toHaveProperty('first_seen');
    expect(trigger).not.toHaveProperty('last_seen');
    expect(trigger).not.toHaveProperty('trigger_list_recid');
  });

  it('maps a sparse record without inventing values: no abstract, no title, no year', async () => {
    serve(
      searchBody([
        hit('8001', { recid: '8001', type: { primary: 'Supplementaries' }, run_period: null }),
      ]),
    );
    const [trigger] = success(await run({ path: 'HLT_Odd' })).triggers;
    expect(trigger).toEqual({
      recid: '8001',
      portal_url: 'https://opendata.cern.ch/record/8001',
      versions: [],
      parsed: false,
    });
  });

  it('falls back to the hit id when the metadata carries no recid', async () => {
    serve(searchBody([hit(8002, { title: 'High-Level Trigger path information HLT_X' })]));
    const [trigger] = success(await run({ path: 'HLT_X' })).triggers;
    expect(trigger?.recid).toBe('8002');
    expect(trigger?.portal_url).toBe('https://opendata.cern.ch/record/8002');
    expect(trigger?.path).toBe('HLT_X');
  });

  it('takes the year from the first date_created entry', async () => {
    const multi = hit('8003', {
      recid: '8003',
      title: 'High-Level Trigger path information HLT_X',
      date_created: ['2015', '2016'],
    });
    serve(searchBody([multi]));
    expect(success(await run({ path: 'HLT_X' })).triggers[0]?.year).toBe('2015');
  });
});

describe('cern_opendata_search_trigger_paths enrichment and notices', () => {
  it('zero-result page: required fields at zero, the zero-match notice and the echo', async () => {
    serve(emptySearchBody);
    const result = success(await run({ path: 'HLT_Nope', limit: 7 }));
    expect(result).toMatchObject({
      truncated: false,
      shown: 0,
      cap: 7,
      totalCount: 0,
      effectiveQuery: 'HLT_Nope',
      triggers: [],
      has_more: false,
    });
    expect(result.notice).toMatch(
      /^No CMS HLT path record matches "HLT_Nope"; path records cover CMS open data from 2011-2016\. Try a prefix pattern such as HLT_IsoMu\*, or call cern_opendata_search_records with query HLT_Nope to search other record types\.$/,
    );
  });

  it('zero-result page names the year when one was given, and offers dropping it', async () => {
    serve(emptySearchBody);
    const result = success(await run({ path: 'HLT_Nope', year: 2013 }));
    expect(result.notice).toContain('matches "HLT_Nope" in 2013; path records cover');
    expect(result.notice).toContain('Try a prefix pattern such as HLT_IsoMu*, drop year, or call');
  });

  it('zero-result page without a year never offers dropping one', async () => {
    serve(emptySearchBody);
    expect(success(await run({ path: 'HLT_Nope' })).notice).not.toContain('year');
  });

  it('zero-result page puts the version note before the no-match note', async () => {
    serve(emptySearchBody);
    const result = success(await run({ path: 'HLT_Nope_v4' }));
    expect(result.notice).toMatch(
      /^Path versions are listed per record as V<n>; HLT_Nope_v4 is version 4 of HLT_Nope\. No CMS HLT path record matches "HLT_Nope";/,
    );
  });

  it('zero-result page names the stripped path, not the typed one', async () => {
    serve(emptySearchBody);
    const result = success(await run({ path: 'nope_v2' }));
    expect(result.notice).toContain('matches "nope" or "HLT_nope";');
    expect(result.notice).toContain('query nope OR HLT_nope to search other record types');
  });

  it('under-cap page: fewer records than the cap, not truncated, no notice, totals match', async () => {
    serve(searchBody([isoMu24Hit2011, isoMu24Hit2012, isoMu24Hit2016], { total: 3 }));
    const result = success(await run({ path: 'HLT_IsoMu24', limit: 10 }));
    expect(result).toMatchObject({
      truncated: false,
      shown: 3,
      cap: 10,
      totalCount: 3,
      effectiveQuery: 'HLT_IsoMu24',
      has_more: false,
    });
    expect(result).not.toHaveProperty('notice');
  });

  it('full page that is also the last: shown equals the cap and nothing is truncated', async () => {
    serve(searchBody(triggerHits(5), { total: 5 }));
    const result = success(await run({ path: 'HLT_Mu*', limit: 5 }));
    expect(result).toMatchObject({ truncated: false, shown: 5, cap: 5, totalCount: 5 });
    expect(result).not.toHaveProperty('notice');
  });

  it('truncated page: guidance carries the range and the next page, and sets the notice', async () => {
    serve(searchBody(triggerHits(10), { total: 95, hasNext: true }));
    const result = success(await run({ path: 'HLT_Mu*', limit: 10, page: 3 }));
    expect(result).toMatchObject({
      truncated: true,
      shown: 10,
      cap: 10,
      totalCount: 95,
      has_more: true,
    });
    expect(result.notice).toBe(
      'Showing 21–30 of 95; call cern_opendata_search_trigger_paths again with page 4, or add year.',
    );
  });

  it('truncated page with year set: guidance names the next page and stops there', async () => {
    serve(searchBody(triggerHits(1), { total: 84, hasNext: true }));
    const result = success(await run({ path: 'HLT_Mu*', year: 2012, limit: 1 }));
    expect(result).toMatchObject({ truncated: true, has_more: true });
    expect(result.notice).toBe(
      'Showing 1–1 of 84; call cern_opendata_search_trigger_paths again with page 2.',
    );
  });

  it('on the last page with year set, routes to a longer path prefix only', async () => {
    serve(searchBody(triggerHits(50), { total: 35_747 }));
    const result = success(await run({ path: 'HLT_Mu*', year: 2012, limit: 50, page: 200 }));
    expect(result.notice).toBe(
      'Showing 9951–10000 of 35747; this is the last page within the first 10,000 matches, the deepest the portal pages to. Use a longer path prefix to reach the rest.',
    );
  });

  it('on the last page at a limit that does not divide 10,000, with year set, never says add year', async () => {
    serve(searchBody(triggerHits(30), { total: 35_747 }));
    const result = success(await run({ path: 'HLT_Mu*', year: 2012, limit: 30, page: 333 }));
    expect(result.notice).toContain(
      'call cern_opendata_search_trigger_paths again with limit 10 and page 1000. Use a longer path prefix to reach the matches past 10,000.',
    );
    expect(result.notice).not.toContain('Add year');
  });

  it('truncated page: the version note comes first, then the paging guidance', async () => {
    serve(searchBody(triggerHits(2), { total: 5, hasNext: true }));
    const result = success(await run({ path: 'HLT_Mu_v*', limit: 2 }));
    expect(result.notice).toBe(
      'Path versions are listed per record as V<n>; HLT_Mu_v* names every version of HLT_Mu. Showing 1–2 of 5; call cern_opendata_search_trigger_paths again with page 2, or add year.',
    );
  });

  it('a single version names it: version n of the path', async () => {
    serve(searchBody([isoMu24Hit2011], { total: 1 }));
    const result = success(await run({ path: 'hlt_isomu24_v2' }));
    expect(result.notice).toBe(
      'Path versions are listed per record as V<n>; HLT_isomu24_v2 is version 2 of HLT_isomu24.',
    );
    expect(result).toMatchObject({ truncated: false, shown: 1 });
  });

  it('on the last page inside the 10,000-match window, never points past it', async () => {
    serve(searchBody(triggerHits(50), { total: 35_747 }));
    const result = success(await run({ path: 'HLT_Mu*', limit: 50, page: 200 }));
    expect(result).toMatchObject({ truncated: true, has_more: false });
    expect(result.notice).toBe(
      'Showing 9951–10000 of 35747; this is the last page within the first 10,000 matches, the deepest the portal pages to. Add year or a longer path prefix to reach the rest.',
    );
    expect(result.notice).not.toContain('page 201');
  });

  it.each([
    [
      30,
      333,
      35_747,
      'Showing 9961–9990 of 35747; this is the last page at limit 30, since the portal pages no deeper than match 10,000. For matches 9991–10000, call cern_opendata_search_trigger_paths again with limit 10 and page 1000. Add year or a longer path prefix to reach the matches past 10,000.',
    ],
    [
      41,
      243,
      9_970,
      'Showing 9923–9963 of 9970; this is the last page at limit 41, since the portal pages no deeper than match 10,000. For matches 9964–9970, call cern_opendata_search_trigger_paths again with limit 40 and page 250; its matches 9961–9963 are already on this page.',
    ],
  ])(
    'on the last page at limit %i (page %i, total %i), names the call for the matches after it',
    async (limit, page, total, notice) => {
      serve(searchBody(triggerHits(limit), { total }));
      const result = success(await run({ path: 'HLT_Mu*', limit, page }));
      expect(result).toMatchObject({ truncated: true, has_more: false, shown: limit });
      expect(result.notice).toBe(notice);
    },
  );

  it('points the page before the window edge at the next page normally', async () => {
    serve(searchBody(triggerHits(50), { total: 35_747, hasNext: true }));
    const result = success(await run({ path: 'HLT_Mu*', limit: 50, page: 199 }));
    expect(result.notice).toContain('again with page 200');
  });

  it('past-the-end page: empty records with a positive total name the last page', async () => {
    serve(searchBody([], { total: 25 }));
    const result = success(await run({ path: 'HLT_Mu*', limit: 10, page: 5 }));
    expect(result).toMatchObject({
      truncated: false,
      shown: 0,
      cap: 10,
      totalCount: 25,
      triggers: [],
    });
    expect(result.notice).toBe(
      'Page 5 is past the last page (25 matches); call cern_opendata_search_trigger_paths again with page 3.',
    );
  });

  it('past-the-end page: the last page is clamped to the 10,000-match window', async () => {
    serve(searchBody([], { total: 50_000 }));
    const result = success(await run({ path: 'HLT_Mu*', limit: 50, page: 150 }));
    expect(result.notice).toContain('page 200.');
  });

  it('past-the-end page: a single match is named in the singular', async () => {
    serve(searchBody([], { total: 1 }));
    expect(success(await run({ path: 'HLT_IsoMu24', page: 2 })).notice).toBe(
      'Page 2 is past the last page (1 match); call cern_opendata_search_trigger_paths again with page 1.',
    );
  });

  it('writes the same fields into the text trailer', async () => {
    serve(searchBody(triggerHits(10), { total: 95, hasNext: true }));
    const trailer = textOf(await run({ path: 'HLT_Mu*', limit: 10 }), 1);
    expect(trailer).toContain('**truncated:** true');
    expect(trailer).toContain('**shown:** 10');
    expect(trailer).toContain('**cap:** 10');
    expect(trailer).toContain('95 total');
    expect(trailer).toContain('Showing 1–10 of 95');
  });

  it('keeps a notice built from the caller path on one line', async () => {
    serve(emptySearchBody);
    const result = success(await run({ path: 'HLT_IsoMu24_v3' }));
    expect(result.notice).not.toMatch(/[\r\n]/);
  });
});

describe('cern_opendata_search_trigger_paths errors on the wire', () => {
  const failure = async (input: Parameters<typeof run>[0]) => errorOf(await run(input));

  it('a syntax 400 is a server fault: InternalError carrying the upstream message, no caller recovery', async () => {
    serve(SYNTAX_ERROR_BODY, { status: 400 });
    const result = await run({ path: 'HLT_Mu*' });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.data).toMatchObject({
      upstreamMessage: 'The syntax of the search query is invalid.',
    });
    expect(error.data).not.toHaveProperty('reason');
    expect(error.data).not.toHaveProperty('recovery');
    expect(error.message).toBe(
      'CERN Open Data rejected a query this server built: The syntax of the search query is invalid.',
    );
  });

  it('any other non-window 400 is the same server fault, with its field errors', async () => {
    serve(RANGE_ERROR_BODY, { status: 400 });
    const error = await failure({ path: 'HLT_Mu9', year: 2012 });
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.data).toMatchObject({
      upstreamMessage: 'Validation error.',
      upstreamErrors: [{ field: 'date_created', message: 'Invalid range format.' }],
    });
  });

  it('escapes the portal text of a non-JSON 400 in the message and keeps it as received in data', async () => {
    const body = '<img src=x> [a](https://evil.example)';
    installService([
      searchRoute(
        () => new Response(body, { status: 400, headers: { 'content-type': 'text/plain' } }),
      ),
    ]);
    const result = await run({ path: 'HLT_Mu*' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toBe(
      'CERN Open Data rejected a query this server built: &lt;img src=x&gt; \\[a\\](https://evil.example)',
    );
    expect(error.data).toMatchObject({ upstreamMessage: body });
    expect(textOf(result)).not.toContain('<img');
  });

  it('a message that only mentions the window is not read as the window rejection', async () => {
    serve(
      { status: 400, message: 'Syntax invalid. Maximum number of 10000 results' },
      { status: 400 },
    );
    expect((await failure({ path: 'HLT_Mu*' })).code).toBe(JsonRpcErrorCode.InternalError);
  });

  it('page_window_exceeded: the upstream window 400 maps to it, not to a server fault', async () => {
    const { http } = serve(WINDOW_ERROR_BODY, { status: 400 });
    const result = await run({ path: 'HLT_Mu*', page: 5, limit: 50 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'page_window_exceeded',
      upstreamMessage: 'Maximum number of 10000 results have been reached.',
    });
    expect(error.message).toBe(
      'The portal refused the page: Maximum number of 10000 results have been reached.',
    );
    expect(hintOf(error)).toContain('Add year or a longer path prefix');
    expect(textOf(result)).toContain('reason page_window_exceeded');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    ['refused before any request', { page: 201, limit: 50 }, emptySearchBody, 200],
    ['refused by the portal', { page: 5, limit: 50 }, WINDOW_ERROR_BODY, 400],
  ])(
    'page_window_exceeded with year set: the recovery asks for a longer prefix only (%s)',
    async (_how, paging, body, status) => {
      serve(body, { status });
      const result = await run({ path: 'HLT_Mu*', year: 2012, ...paging });
      const error = errorOf(result);
      expect(error.data).toMatchObject({ reason: 'page_window_exceeded' });
      expect(hintOf(error)).toBe(
        'Use a longer path prefix to narrow the match, then call cern_opendata_search_trigger_paths again from page 1.',
      );
      expect(textOf(result)).not.toContain('Add year');
    },
  );

  it.each([
    [201, 50],
    [1001, 10],
    [10_001, 1],
  ])(
    'page_window_exceeded: page %i × limit %i is refused before any request',
    async (page, limit) => {
      const { http } = serve(emptySearchBody);
      const error = await failure({ path: 'HLT_Mu*', page, limit });
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
  ])('allows page %i × limit %i, the edge of the window', async (page, limit) => {
    const { http } = serve(searchBody([], { total: 0 }));
    const result = await run({ path: 'HLT_Mu*', page, limit });
    expect(result.isError).toBeFalsy();
    expect(paramsOf(http).get('page')).toBe(String(page));
  });

  it('writes no enrichment that could pass for a result on a refused window', async () => {
    serve(emptySearchBody);
    const result = await run({ path: 'HLT_Mu*', page: 500, limit: 50 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).not.toHaveProperty('triggers');
  });
});

describe('cern_opendata_search_trigger_paths upstream failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settled = async (n = 0, signal?: AbortSignal) => {
    const outcome = await settle(() =>
      runToolContract(
        searchTriggerPaths,
        { path: `HLT_Mu${n}` },
        signal ? { context: { signal } } : undefined,
      ),
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };

  it('maps a 429 to rate_limited with retryAfter and the declared recovery, without retrying', async () => {
    const { http } = installService([
      searchRoute(() => new Response('', { status: 429, headers: { 'retry-after': '60' } })),
    ]);
    const result = await settled();
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    const text = textOf(result);
    expect(text).toContain('Recovery: Wait the retryAfter seconds');
    expect(text).toContain('call cern_opendata_search_trigger_paths again');
    expect(http.calls).toHaveLength(1);
  });

  it('sheds the 51st request inside a minute as rate_limited before any request', async () => {
    const { http } = installService([searchRoute(() => jsonResponse(emptySearchBody))]);
    for (let n = 0; n < 50; n++) {
      const result = await runToolContract(searchTriggerPaths, { path: `HLT_Mu${n}` });
      expect(result.isError, `call ${n}`).toBeFalsy();
    }
    expect(http.calls).toHaveLength(50);
    const outcome = await settle(
      () => runToolContract(searchTriggerPaths, { path: 'HLT_Mu50' }),
      100,
    );
    if (!outcome.ok) throw outcome.error;
    expect(errorOf(outcome.value).code).toBe(JsonRpcErrorCode.RateLimited);
    expect(errorOf(outcome.value).data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    expect(http.calls).toHaveLength(50);
  });

  it('fails a persistent 503 as ServiceUnavailable after three attempts', async () => {
    const { http } = installService([searchRoute(() => new Response('down', { status: 503 }))]);
    expect(errorOf(await settled()).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(http.calls).toHaveLength(3);
  });

  it('recovers when a 502 is followed by a healthy answer', async () => {
    let calls = 0;
    const { http } = installService([
      searchRoute(() =>
        ++calls === 1
          ? new Response('bad gateway', { status: 502 })
          : jsonResponse(emptySearchBody),
      ),
    ]);
    expect((await settled()).isError).toBeFalsy();
    expect(http.calls).toHaveLength(2);
  });

  it('maps an HTML body on a 200 to upstream_unreadable, retried, with the declared recovery', async () => {
    const { http } = installService([
      searchRoute(() => new Response(HTML_ERROR_PAGE, { status: 200 })),
    ]);
    const result = await settled();
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.data).not.toMatchObject({ retryable: false });
    expect(textOf(result)).toContain(
      'Recovery: Call cern_opendata_search_trigger_paths again in a minute',
    );
    expect(http.calls).toHaveLength(3);
  });

  it('maps JSON without the expected envelope and an empty 200 body to upstream_unreadable', async () => {
    installService([searchRoute(() => jsonResponse({ unexpected: true }))]);
    expect(errorOf(await settled()).data).toMatchObject({ reason: 'upstream_unreadable' });
    disposeInstalledService();
    installService([searchRoute(() => new Response('', { status: 200 }))]);
    expect(errorOf(await settled()).data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('maps a declared content-length over the 8 MiB ceiling to non-retryable upstream_unreadable', async () => {
    const limitBytes = 8 * 1024 * 1024;
    const { http } = installService([
      searchRoute(
        () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-length': String(limitBytes + 1) },
          }),
      ),
    ]);
    const result = await settled();
    expect(errorOf(result).data).toMatchObject({
      reason: 'upstream_unreadable',
      retryable: false,
      limitBytes,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('fails a refused connection as ServiceUnavailable, naming the portal, after three attempts', async () => {
    const fetchFake = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    installService([], { fetch: fetchFake as unknown as typeof fetch });
    const result = await settled();
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(errorOf(result).message).toContain('Could not reach CERN Open Data');
    expect(fetchFake).toHaveBeenCalledTimes(3);
  });

  it('stops a stalled portal at the call deadline as a Timeout', async () => {
    const hanging = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    installService([], { fetch: hanging as unknown as typeof fetch });
    expect(errorOf(await settled()).code).toBe(JsonRpcErrorCode.Timeout);
  });

  it('reports a cancelled call as RequestCancelled without a request', async () => {
    const { http } = installService([searchRoute(() => jsonResponse(emptySearchBody))]);
    const controller = new AbortController();
    controller.abort(new Error('client left'));
    expect(errorOf(await settled(0, controller.signal)).code).toBe(
      JsonRpcErrorCode.RequestCancelled,
    );
    expect(http.calls).toHaveLength(0);
  });
});

describe('cern_opendata_search_trigger_paths format', () => {
  async function rendered(hits: Parameters<typeof searchBody>[0], options = {}) {
    serve(searchBody(hits, { total: hits.length, ...options }));
    const result = await run({ path: 'HLT_IsoMu24' });
    return { result, data: success(result), text: textOf(result) };
  }

  it('renders the page line and every parsed field of a record', async () => {
    const { text } = await rendered([isoMu24Hit2011]);
    expect(text.split('\n')[0]).toBe(
      '**Page:** 1 · **More pages:** no · **Records on this page:** 1',
    );
    expect(text).toContain('### HLT_IsoMu24 (SingleMu dataset), 2011');
    expect(text).toContain(
      '**Recid:** 2561 · **Year:** 2011 · **Dataset:** SingleMu · **Portal:** https://opendata.cern.ch/record/2561',
    );
    expect(text).toContain(
      '**First seen:** run 160404, menu /cdaq/physics/Run2011/5e32/v4.2/HLT/V2 (record 3521)',
    );
    expect(text).toContain(
      '**Last seen:** run 178380, menu /cdaq/physics/Run2011/5e32/v6.1/HLT/V2 (record 3530)',
    );
    expect(text).toContain('**Trigger list record:** 3000 · **Parsed:** yes');
    expect(text).toContain('| Version | First run | Last run | L1 seed |');
    expect(text).toContain('| V1 | 160404 | 163261 | L1_SingleMu12 |');
    expect(text).toContain('| V2 | 163269 | 165970 | L1_SingleMu12 |');
    expect(text).toContain('| V6 | 166346 | 166346 | L1_SingleMu12 |');
  });

  it('renders every dataset a title names in the heading and the fact line', async () => {
    const { text } = await rendered([
      triggerHit('6666', 'HLT_Mu17_Mu8', ISOMU24_2011_ABSTRACT, {
        datasets: ['DoubleMu', 'DoubleMuParked'],
        year: '2012',
      }),
      triggerHit('6700', 'HLT_HT250_AlphaT0p55', ISOMU24_2011_ABSTRACT, {
        datasets: ['HT', 'HTMHT', 'HTMHTParked'],
        year: '2012',
      }),
    ]);
    expect(text).toContain('### HLT_Mu17_Mu8 (DoubleMu, DoubleMuParked datasets), 2012');
    expect(text).toContain(
      '**Recid:** 6666 · **Year:** 2012 · **Datasets:** DoubleMu, DoubleMuParked · **Portal:**',
    );
    expect(text).toContain('### HLT_HT250_AlphaT0p55 (HT, HTMHT, HTMHTParked datasets), 2012');
    expect(text).toContain('**Datasets:** HT, HTMHT, HTMHTParked · **Portal:**');
  });

  it('keeps empty dataset names out of both surfaces', async () => {
    const { data, text } = await rendered([
      triggerHit('6800', 'HLT_X', ISOMU24_2011_ABSTRACT, {
        datasets: ['A', '', 'B'],
        year: '2012',
      }),
      triggerHit('6801', 'HLT_Y', ISOMU24_2011_ABSTRACT, { datasets: ['', ''], year: '2012' }),
    ]);
    expect(data.triggers[0]).toMatchObject({ path: 'HLT_X', datasets: ['A', 'B'] });
    expect(data.triggers[0]).not.toHaveProperty('dataset');
    expect(data.triggers[1]?.path).toBe('HLT_Y');
    expect(data.triggers[1]).not.toHaveProperty('dataset');
    expect(data.triggers[1]).not.toHaveProperty('datasets');
    expect(text).toContain('### HLT_X (A, B datasets), 2012');
    expect(text).toContain('**Recid:** 6800 · **Year:** 2012 · **Datasets:** A, B · **Portal:**');
    expect(text).toContain('### HLT_Y, 2012');
    expect(text).toContain(
      '**Recid:** 6801 · **Year:** 2012 · **Dataset:** Not available · **Portal:**',
    );
  });

  it('renders the abstract as fenced text beside the parsed fields, on every record', async () => {
    const { text } = await rendered([isoMu24Hit2011, isoMu24Hit2016]);
    expect(
      text.match(/\*\*Abstract \(as text, the source of the fields above\):\*\*/g),
    ).toHaveLength(2);
    expect(text).toContain(
      'first seen online on run 160404 (/cdaq/physics/Run2011/5e32/v4.2/HLT/V2 <https://opendata.cern.ch/record/3521>)',
    );
    expect(text).toContain('V1: (runs 273158 - 274443)');
    expect(text).not.toContain('<blockquote>');
    expect(text).not.toContain('<p>');
  });

  it('renders an unseeded version as Not available and a missing menu as no menu text', async () => {
    const { text } = await rendered([isoMu24Hit2016, isoMu24Hit2012]);
    expect(text).toContain('| V1 | 273158 | 274443 | Not available |');
    expect(text).toContain('**Last seen:** run 209151, menu /cdaq/special/25ns/v1.1/HLT/V2\n');
    expect(text).toContain('### HLT_IsoMu24, 2016');
  });

  it('renders a sparse record without inventing values', async () => {
    const { text } = await rendered([
      hit('8001', { recid: '8001', type: { primary: 'Supplementaries' } }),
    ]);
    expect(text).toContain('### Not available, Not available');
    expect(text).toContain('**First seen:** Not available');
    expect(text).toContain('**Last seen:** Not available');
    expect(text).toContain('**Versions:** none parsed');
    expect(text).toContain('**Parsed:** no');
    expect(text).toContain('**Abstract:** Not available');
    expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it('renders an unparsed record, with its abstract as the only source of the numbers', async () => {
    const { text } = await rendered([
      triggerHit('8000', 'HLT_Odd', '<p>Seen in runs 1 to 9, <b>seeded</b> by L1_X.</p>', {
        year: '2013',
      }),
    ]);
    expect(text).toContain('**Parsed:** no');
    expect(text).toContain('**Versions:** none parsed');
    expect(text).toContain('Seen in runs 1 to 9, seeded by L1_X.');
  });

  it('renders every record of the page, in order, and the empty page', async () => {
    const { data, text } = await rendered([isoMu24Hit2011, isoMu24Hit2012, isoMu24Hit2016]);
    const positions = data.triggers.map((t) => text.indexOf(`**Recid:** ${t.recid} `));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    const empty = await rendered([]);
    expect(empty.text).toContain('**Records on this page:** 0');
    expect(empty.text).toContain('No trigger path records on this page.');
  });

  it('shows More pages: yes when another page holds matches', async () => {
    const { text } = await rendered(triggerHits(2), { total: 12 });
    expect(text.split('\n')[0]).toContain('**More pages:** yes');
  });

  it('keeps CR/LF, markup and bidi controls in upstream trigger text out of the inline slots', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const hostile = hit('8100', {
      recid: '8100',
      title: `High-Level Trigger path information HLT_Evil [x](http://e.example) | <b>${rlo} (Da|ta dataset)`,
      date_created: ['20\n12'],
      abstract: {
        description:
          `<p>first seen online on run 5 (/cdaq/a\r\n# H${rlo}/V1 |x [y])</p>` +
          '<p>V1: (runs 1 - 2) seeded by: L1_A\n- [l](http://e.example) &lt;b&gt;</p>' +
          '<p>V2: (runs 3 - 4) seeded by: L1_B | L1_C</p>',
      },
    });
    const { text, data } = await rendered([hostile]);
    const lines = text.split('\n');
    const outsideFence = text
      .split('```')
      .filter((_, i) => i % 2 === 0)
      .join('');
    expect(lines.some((line) => line.startsWith('# '))).toBe(false);
    expect(lines.filter((line) => line.startsWith('### '))).toEqual([
      '### HLT_Evil \\[x\\](http://e.example) \\| &lt;b&gt; (Da\\|ta dataset), 20 12',
    ]);
    expect(outsideFence).not.toMatch(new RegExp(`[\\r${rlo}]`));
    expect(outsideFence).toContain('**First seen:** run 5, menu /cdaq/a # H/V1 \\|x \\[y\\]');
    const table = lines.filter((line) => /^\| V\d/.test(line));
    expect(table).toEqual([
      '| V1 | 1 | 2 | L1_A - \\[l\\](http://e.example) &lt;b&gt; |',
      '| V2 | 3 | 4 | L1_B \\| L1_C |',
    ]);
    // structuredContent keeps the strings as received.
    expect(data.triggers[0]?.abstract_html).toContain('\r\n# H');
    expect(data.triggers[0]?.path).toBe(`HLT_Evil [x](http://e.example) | <b>${rlo}`);
  });

  it('fences an abstract whose own backticks would close a plain fence', async () => {
    const { text } = await rendered([
      triggerHit('8101', 'HLT_Tick', '<p>before ``` after</p><p># not a heading</p>', {
        year: '2013',
      }),
    ]);
    expect(text).toContain('````\nbefore ``` after\n\n# not a heading\n````');
  });

  it('renders the same recids, runs and seeds that structuredContent carries', async () => {
    const { data, text } = await rendered([isoMu24Hit2011, isoMu24Hit2012, isoMu24Hit2016]);
    for (const trigger of data.triggers) {
      expect(text).toContain(`**Recid:** ${trigger.recid} `);
      expect(text).toContain(trigger.portal_url);
      if (trigger.first_seen) expect(text).toContain(`run ${trigger.first_seen.run}`);
      if (trigger.last_seen) expect(text).toContain(`run ${trigger.last_seen.run}`);
      for (const version of trigger.versions) {
        expect(text).toContain(
          `| V${version.version} | ${version.run_first} | ${version.run_last} | ${version.l1_seed ?? 'Not available'} |`,
        );
      }
      if (trigger.trigger_list_recid)
        expect(text).toContain(`**Trigger list record:** ${trigger.trigger_list_recid}`);
    }
  });

  it('returns a text block for the page and one for the trailer', async () => {
    const { result } = await rendered([isoMu24Hit2011]);
    expect(result.content).toHaveLength(2);
    expect(result.content.every((block) => block.type === 'text')).toBe(true);
  });
});
