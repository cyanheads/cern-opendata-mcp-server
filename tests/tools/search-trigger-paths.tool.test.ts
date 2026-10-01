/**
 * @fileoverview Tests for cern_opendata_search_trigger_paths: path
 * normalization (HLT_ prefix, case, wildcard, version suffix), blank-as-unset
 * year, limit and page, the request sent on the wire, parsed records for the
 * three HLT_IsoMu24 abstracts, required enrichment on the zero-result,
 * under-cap, truncated and past-the-end pages, the notices the design
 * specifies, every declared error on the wire, upstream failure classes, and
 * the text twin of structuredContent. Upstream I/O is a strict fetch fake.
 * @module tests/tools/search-trigger-paths.tool.test
 */

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

  it('declares the four error reasons with the right codes and the service-thrown ones marked', () => {
    const byReason = Object.fromEntries(
      (searchTriggerPaths.errors ?? []).map((entry) => [entry.reason, entry]),
    );
    expect(Object.keys(byReason).sort()).toEqual([
      'invalid_query',
      'page_window_exceeded',
      'rate_limited',
      'upstream_unreadable',
    ]);
    for (const reason of ['invalid_query', 'page_window_exceeded']) {
      expect(byReason[reason]?.code, reason).toBe(JsonRpcErrorCode.ValidationError);
      expect((byReason[reason] as { severity?: string } | undefined)?.severity, reason).toBe(
        'notice',
      );
    }
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
    ['IsoMu24', 'HLT_IsoMu24'],
    ['  IsoMu24', 'HLT_IsoMu24'],
    ['HLT_IsoMu*', 'HLT_IsoMu*'],
    ['IsoMu*', 'HLT_IsoMu*'],
    ['hlt_isomu*', 'HLT_isomu*'],
    ['HLT_IsoMu24_v3', 'HLT_IsoMu24_v3'],
    ['HLT_IsoMu24_v*', 'HLT_IsoMu24_v*'],
    ['HLT_HLT_IsoMu24', 'HLT_HLT_IsoMu24'],
    ['HLT_Mu_7_8', 'HLT_Mu_7_8'],
    ['HLT_9', 'HLT_9'],
  ])('reads the path %j as %j', (raw, expected) => {
    expect(searchTriggerPaths.input.parse({ path: raw }).path).toBe(expected);
  });

  it('keeps the case of everything past the prefix: names are not lowercased or uppercased', () => {
    expect(searchTriggerPaths.input.parse({ path: 'hlt_ISOMU24' }).path).toBe('HLT_ISOMU24');
    expect(searchTriggerPaths.input.parse({ path: 'isomu24' }).path).toBe('HLT_isomu24');
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
    expect(params.get('q')).toBe('HLT_isomu*');
    expect(params.get('year')).toBe('2012--2012');
    expect(params.get('size')).toBe('25');
    expect(params.get('page')).toBe('3');
  });

  it.each([
    ['HLT_IsoMu24_v3', 'HLT_IsoMu24'],
    ['HLT_IsoMu24_V3', 'HLT_IsoMu24'],
    ['HLT_IsoMu24_v12', 'HLT_IsoMu24'],
    ['HLT_IsoMu24_v*', 'HLT_IsoMu24'],
    ['isomu24_v1', 'HLT_isomu24'],
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

  it('echoes the normalized path as effectiveQuery', async () => {
    serve(emptySearchBody);
    expect(success(await run({ path: ' isomu24 ' })).effectiveQuery).toBe('HLT_isomu24');
    expect(success(await run({ path: 'HLT_IsoMu*' })).effectiveQuery).toBe('HLT_IsoMu*');
  });

  it('echoes the path in the text trailer', async () => {
    serve(emptySearchBody);
    expect(textOf(await run({ path: 'IsoMu24' }), 1)).toContain('HLT_IsoMu24');
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
    expect(trigger?.versions).toEqual([
      { version: 1, run_first: 273158, run_last: 274443 },
      { version: 2, run_first: 274445, run_last: 284044 },
    ]);
  });

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
      /^No CMS HLT path record matches "HLT_Nope"; path records cover CMS open data from 2010[-–]2016\. Try a prefix pattern such as HLT_IsoMu\*, drop year, or call cern_opendata_search_records with query HLT_Nope to search other record types\.$/,
    );
  });

  it('zero-result page names the year when one was given', async () => {
    serve(emptySearchBody);
    const result = success(await run({ path: 'HLT_Nope', year: 2013 }));
    expect(result.notice).toContain('matches "HLT_Nope" in 2013; path records cover');
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
    expect(result.notice).toContain('matches "HLT_nope"');
    expect(result.notice).toContain('query HLT_nope to search other record types');
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

  it('invalid_query: the portal syntax 400 carries the upstream message and the recovery', async () => {
    serve(SYNTAX_ERROR_BODY, { status: 400 });
    const result = await run({ path: 'HLT_Mu*' });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_query',
      upstreamMessage: 'The syntax of the search query is invalid.',
    });
    expect(error.data).not.toHaveProperty('upstreamErrors');
    expect(error.message).toBe(
      'The portal rejected the path: The syntax of the search query is invalid.',
    );
    expect(hintOf(error)).toContain('HLT_IsoMu24 or a prefix with one trailing wildcard');
    const text = textOf(result);
    expect(text).toContain('Recovery: Pass a path name such as HLT_IsoMu24');
    expect(text).toContain('reason invalid_query');
  });

  it('invalid_query: any other 400 is carried too, with its field errors', async () => {
    serve(RANGE_ERROR_BODY, { status: 400 });
    const error = await failure({ path: 'HLT_Mu9', year: 2012 });
    expect(error.data).toMatchObject({
      reason: 'invalid_query',
      upstreamMessage: 'Validation error.',
      upstreamErrors: [{ field: 'date_created', message: 'Invalid range format.' }],
    });
  });

  it('invalid_query: a message that only mentions the window is still a syntax rejection', async () => {
    serve(
      { status: 400, message: 'Syntax invalid. Maximum number of 10000 results' },
      { status: 400 },
    );
    expect((await failure({ path: 'HLT_Mu*' })).data).toMatchObject({ reason: 'invalid_query' });
  });

  it('page_window_exceeded: the upstream window 400 maps to it, not to invalid_query', async () => {
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
