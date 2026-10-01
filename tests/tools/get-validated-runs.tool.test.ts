/**
 * @fileoverview Tests for cern_opendata_get_validated_runs: selector and
 * variant input handling (blank-as-unset), the twin rule by file-key stem
 * (14208 full and 14209 muons-only), selection by list recid, dataset recid and
 * run period, `matched_lists` for an ambiguous period, run filtering and the
 * limit cut, every declared error on the wire, required enrichment on the
 * zero-result and under-cap pages, upstream failure classes on each of the
 * three legs, the collection cache, and the text twin of structuredContent.
 * Upstream I/O is a strict fetch fake.
 * @module tests/tools/get-validated-runs.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getValidatedRuns } from '@/mcp-server/tools/definitions/get-validated-runs.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import type { RawHit } from '@/services/cern-opendata/types.js';
import {
  type ContractResult,
  dataOf,
  disposeInstalledService,
  errorOf,
  fakeClock,
  installService,
  requestedUrls,
  settle,
  textOf,
} from '../fixtures/cern-opendata-harness.js';
import {
  ALL_LIST_SPECS,
  collisionDatasetHit,
  datasetLinkingLists,
  HTML_ERROR_PAGE,
  hit,
  jsonResponse,
  LIST_SPECS,
  type ListSpec,
  NOT_FOUND_BODY,
  portalRoute,
  RUN_LIST_BODY,
  searchBody,
  validatedListHit,
  validatedRunsSearchBody,
} from '../fixtures/cern-opendata-upstream.js';

type Output = Awaited<ReturnType<typeof getValidatedRuns.handler>>;
type Result = Output & {
  cap: number;
  notice?: string;
  shown: number;
  totalCount: number;
  truncated: boolean;
};

const KEY_1002 = 'Cert_190456-208686_8TeV_22Jan2013ReReco_Collisions12_JSON.txt';
const KEY_1005 = 'Cert_190456-208686_8TeV_22Jan2013ReReco_Collisions12_JSON_MuonPhys.txt';
const KEY_14208 = 'Cert_177718-178078_2.76TeV_PromptReco_Collisions11_JSON_v2.txt';
const KEY_14209 = 'Cert_177718-178078_2.76TeV_PromptReco_Collisions11_JSON_MuonPhys.txt';

interface Upstream {
  /** Replace the collection body (default: the lists of `specs`). */
  collection?: unknown;
  /** Good-run list file bodies by list recid; any recid left out serves {@link RUN_LIST_BODY}. */
  files?: Record<string, unknown>;
  /** Dataset hits answered to `q=recid:N`, by recid. */
  records?: Record<string, RawHit>;
  specs?: readonly ListSpec[];
}

/** The three routes the tool reads: the collection, a record lookup and a list file. */
function routes({ specs = LIST_SPECS, collection, records = {}, files = {} }: Upstream = {}) {
  return [
    portalRoute('/api/records/', () => jsonResponse(collection ?? validatedRunsSearchBody(specs)), {
      query: (params) => params.get('collections') === 'CMS-Validated-Runs',
    }),
    portalRoute(
      '/api/records/',
      (request) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        const found = records[/^recid:(\d+)$/.exec(q)?.[1] ?? ''];
        return jsonResponse(searchBody(found ? [found] : []));
      },
      { query: (params) => params.get('q')?.startsWith('recid:') === true },
    ),
    portalRoute(/^\/record\/\d+\/files\/.+$/, (request) => {
      const recid = /^\/record\/(\d+)\//.exec(new URL(request.url).pathname)?.[1] ?? '';
      return jsonResponse(recid in files ? files[recid] : RUN_LIST_BODY);
    }),
  ];
}

const serve = (upstream: Upstream = {}, options?: Parameters<typeof installService>[1]) =>
  installService(routes(upstream), options);

const run = (input: Parameters<typeof runToolContract<typeof getValidatedRuns>>[1]) =>
  runToolContract(getValidatedRuns, input);

const success = (result: ContractResult) => dataOf<Result>(result);

const hintOf = (error: ReturnType<typeof errorOf>): string =>
  String((error.data?.recovery as { hint?: string } | undefined)?.hint);

/** `pathname?search` of every request the fake saw. */
const requestsOf = (http: ReturnType<typeof installService>['http']) =>
  http.calls.map((call) => {
    const url = new URL(call.request.url);
    return `${url.pathname}${url.search}`;
  });

/** Runs `1000 … 1000 + count - 1`, each with one lumi range. */
const syntheticRuns = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      String(1000 + i),
      [[1, 10 + i]] as [number, number][],
    ]),
  );

afterEach(() => {
  disposeInstalledService();
});

describe('cern_opendata_get_validated_runs registration', () => {
  it('is registered, read-only, idempotent and open-world', () => {
    expect(allToolDefinitions).toContain(getValidatedRuns);
    expect(getValidatedRuns.name).toBe('cern_opendata_get_validated_runs');
    expect(getValidatedRuns.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('declares the seven error reasons with the right codes and the service-thrown ones marked', () => {
    const byReason = Object.fromEntries(
      (getValidatedRuns.errors ?? []).map((entry) => [entry.reason, entry]),
    );
    expect(Object.keys(byReason).sort()).toEqual([
      'conflicting_selectors',
      'invalid_range',
      'missing_selector',
      'no_validated_runs',
      'rate_limited',
      'record_not_found',
      'upstream_unreadable',
    ]);
    for (const reason of ['missing_selector', 'conflicting_selectors', 'invalid_range']) {
      expect(byReason[reason]?.code, reason).toBe(JsonRpcErrorCode.ValidationError);
    }
    for (const reason of ['record_not_found', 'no_validated_runs']) {
      expect(byReason[reason]?.code, reason).toBe(JsonRpcErrorCode.NotFound);
    }
    for (const reason of [
      'missing_selector',
      'conflicting_selectors',
      'invalid_range',
      'record_not_found',
      'no_validated_runs',
    ]) {
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
    for (const entry of getValidatedRuns.errors ?? []) {
      expect(entry.recovery, entry.reason).toContain('cern_opendata_get_validated_runs');
    }
  });

  it('declares the required list enrichment fields', () => {
    expect(Object.keys(getValidatedRuns.enrichment ?? {}).sort()).toEqual([
      'cap',
      'notice',
      'shown',
      'totalCount',
      'truncated',
    ]);
  });
});

describe('cern_opendata_get_validated_runs input', () => {
  it.each([
    ['1002'],
    [' 1002 '],
    ['recid:1002'],
    ['RECID: 1002'],
    ['https://opendata.cern.ch/record/1002'],
    ['http://opendata.cern.ch/api/records/1002?ln=en'],
    ['01002'],
  ])('reads the recid spelling %j as list 1002', async (recid) => {
    serve();
    const result = success(await run({ recid }));
    expect(result.list?.recid).toBe('1002');
  });

  it.each([['abc'], ['60o4'], ['-1'], ['12.5'], ['0'], ['https://evil.example/record/1002']])(
    'rejects the recid %j as invalid arguments before any request',
    async (recid) => {
      const { http } = serve();
      const result = await run({ recid });
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(errorOf(result).data).toMatchObject({ reason: 'invalid_arguments' });
      expect(http.calls).toHaveLength(0);
    },
  );

  it('reads blank strings on every optional input as unset', () => {
    expect(
      getValidatedRuns.input.parse({
        recid: '',
        run_period: '  ',
        variant: '',
        run_min: '',
        run_max: ' ',
        limit: '',
      }),
    ).toEqual({ limit: 200 });
  });

  it('keeps a form-client payload of blanks plus one selector equal to the lone selector', async () => {
    serve();
    const plain = success(await run({ run_period: 'Run2012B' }));
    const blanks = success(
      await run({
        recid: '',
        run_period: 'Run2012B',
        variant: '',
        run_min: '',
        run_max: '',
        limit: '',
      } as never),
    );
    expect(blanks).toEqual(plain);
  });

  it('reads a blank run_period beside a recid as the recid selector, not a conflict', async () => {
    serve();
    const result = success(await run({ recid: '1002', run_period: '   ' } as never));
    expect(result.list?.recid).toBe('1002');
  });

  it('trims run_period', () => {
    expect(getValidatedRuns.input.parse({ run_period: '  Run2012B  ' }).run_period).toBe(
      'Run2012B',
    );
  });

  it.each([
    ['run_period over 40 characters', { run_period: 'R'.repeat(41) }],
    ['an unknown variant', { run_period: 'Run2012B', variant: 'both' }],
    ['run_min 0', { run_period: 'Run2012B', run_min: 0 }],
    ['a fractional run_max', { run_period: 'Run2012B', run_max: 1.5 }],
    ['a negative run_max', { run_period: 'Run2012B', run_max: -3 }],
    ['limit 0', { run_period: 'Run2012B', limit: 0 }],
    ['limit 2001', { run_period: 'Run2012B', limit: 2001 }],
  ])('rejects %s as invalid arguments before any request', async (_name, input) => {
    const { http } = serve();
    const result = await run(input as never);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
  });

  it('accepts a 40-character run_period, limit 1 and limit 2000, and defaults the limit to 200', async () => {
    serve();
    expect(getValidatedRuns.input.parse({ run_period: 'R'.repeat(40) }).limit).toBe(200);
    expect(success(await run({ run_period: 'Run2012B', limit: 1 })).cap).toBe(1);
    expect(success(await run({ run_period: 'Run2012B', limit: 2000 })).cap).toBe(2000);
    expect(success(await run({ run_period: 'Run2012B' })).cap).toBe(200);
  });
});

describe('cern_opendata_get_validated_runs list recid and the twin rule', () => {
  it('uses a full list as named and reads its file: collection search, then the file', async () => {
    const { http } = serve();
    const result = success(await run({ recid: '1002' }));
    expect(result.list).toEqual({
      recid: '1002',
      title: `CMS list of validated runs ${KEY_1002}`,
      file_key: KEY_1002,
      variant: 'full',
      run_periods: ['Run2012A', 'Run2012B', 'Run2012C', 'Run2012D'],
      collision_energy: '8TeV',
      https_url: `https://opendata.cern.ch/record/1002/files/${KEY_1002}`,
      xrootd_uri: `root://eospublic.cern.ch//eos/opendata/cms/validation/${KEY_1002}`,
      portal_url: 'https://opendata.cern.ch/record/1002',
    });
    expect(result.matched_lists).toEqual([
      {
        recid: '1002',
        title: `CMS list of validated runs ${KEY_1002}`,
        variant: 'full',
        run_periods: ['Run2012A', 'Run2012B', 'Run2012C', 'Run2012D'],
        collision_energy: '8TeV',
      },
    ]);
    expect(result).not.toHaveProperty('dataset');
    expect(result).not.toHaveProperty('notice');
    const paths = requestsOf(http);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/^\/api\/records\/\?/);
    expect(paths[1]).toBe(`/record/1002/files/${KEY_1002}`);
  });

  it('sends the collection search with files included, size 100 and on-demand records', async () => {
    const { http } = serve();
    await run({ recid: '1002' });
    const params = requestedUrls(http)[0]?.searchParams;
    expect(params?.get('collections')).toBe('CMS-Validated-Runs');
    expect(params?.get('size')).toBe('100');
    expect(params?.get('ondemand')).toBe('true');
    expect(params?.has('skip_files')).toBe(false);
  });

  it('uses a muons-only list as named when variant is omitted (Decision 22), with no notice', async () => {
    const { http } = serve();
    const result = success(await run({ recid: '1005' }));
    expect(result.list).toMatchObject({ recid: '1005', variant: 'muons_only', file_key: KEY_1005 });
    expect(result).not.toHaveProperty('notice');
    expect(requestsOf(http)[1]).toBe(`/record/1005/files/${KEY_1005}`);
  });

  it.each([
    ['1002', 'full'],
    ['1005', 'muons_only'],
  ])('keeps list %s when variant names the list own variant %s', async (recid, variant) => {
    const { http } = serve();
    const result = success(await run({ recid, variant } as never));
    expect(result.list?.recid).toBe(recid);
    expect(result).not.toHaveProperty('notice');
    expect(http.calls).toHaveLength(2);
  });

  it.each([
    ['1002', 'muons_only', '1005', 'full', KEY_1005],
    ['1005', 'full', '1002', 'muons_only', KEY_1002],
    ['14208', 'muons_only', '14209', 'full', KEY_14209],
    ['14209', 'full', '14208', 'muons_only', KEY_14208],
    [
      '14202',
      'muons_only',
      '14203',
      'full',
      'Cert_136033-149442_7TeV_HI_Collisions10_JSON_MuonPhys_v2.txt',
    ],
    ['14203', 'full', '14202', 'muons_only', 'Cert_136033-149442_7TeV_HI_Collisions10_JSON_v2.txt'],
  ])(
    'swaps list %s for its twin when variant is %s: returns %s and says so',
    async (recid, variant, twin, namedVariant, twinKey) => {
      const { http } = serve();
      const result = success(await run({ recid, variant } as never));
      expect(result.list).toMatchObject({ recid: twin, file_key: twinKey, variant });
      expect(result.matched_lists.map((m) => m.recid)).toEqual([twin]);
      expect(result.notice).toBe(
        `List ${recid} is the ${namedVariant} variant; its ${variant} twin ${twin} is returned because variant was set. Call cern_opendata_get_validated_runs with recid ${recid} and no variant for the list as named.`,
      );
      expect(requestsOf(http)[1]).toBe(`/record/${twin}/files/${twinKey}`);
    },
  );

  it('pairs 14208 and 14209 by key stem although only one carries a version suffix', async () => {
    serve();
    const toMuons = success(await run({ recid: '14208', variant: 'muons_only' }));
    expect(toMuons.list?.recid).toBe('14209');
    const toFull = success(await run({ recid: '14209', variant: 'full' }));
    expect(toFull.list?.recid).toBe('14208');
  });

  it.each([
    ['1000', 'muons_only'],
    ['14200', 'muons_only'],
  ])('refuses list %s in variant %s: it has no twin', async (recid, variant) => {
    const specs = [
      ...LIST_SPECS,
      {
        recid: '14200',
        key: 'Commissioning10-May19ReReco_900GeV.json',
        periods: ['Commissioning2010'],
      },
    ];
    const { http } = serve({ specs });
    const result = await run({ recid, variant } as never);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'no_validated_runs', recid, variant });
    expect(error.message).toBe(`List ${recid} is the full variant and has no muons_only twin.`);
    expect(http.calls).toHaveLength(1);
  });

  it('serves a twinless full list when no variant is asked, or full', async () => {
    serve();
    expect(success(await run({ recid: '1000' })).list?.recid).toBe('1000');
    expect(success(await run({ recid: '1000', variant: 'full' })).list?.recid).toBe('1000');
  });

  it('matches a twin by stem only: lists that merely share a period are not twins', async () => {
    const specs: ListSpec[] = [
      { recid: '1', key: 'Cert_A_JSON.txt', periods: ['Run2012B'] },
      { recid: '2', key: 'Cert_B_JSON_MuonPhys.txt', periods: ['Run2012B'] },
    ];
    serve({ specs });
    const error = errorOf(await run({ recid: '1', variant: 'muons_only' }));
    expect(error.data).toMatchObject({ reason: 'no_validated_runs' });
  });

  it('reads a leading _v<n> or a mid-key _MuonPhys correctly: only the documented affixes are removed', async () => {
    const specs: ListSpec[] = [
      { recid: '10', key: 'Cert_X_JSON_v3.json', periods: ['Run2013A'] },
      { recid: '11', key: 'Cert_X_JSON_MuonPhys_v3.json', periods: ['Run2013A'] },
    ];
    serve({ specs });
    expect(success(await run({ recid: '10', variant: 'muons_only' })).list?.recid).toBe('11');
  });
});

describe('cern_opendata_get_validated_runs dataset recid', () => {
  const dataset = collisionDatasetHit;

  it('selects the list a dataset links, reading the dataset record, then the file', async () => {
    const { http } = serve({ records: { '6004': dataset } });
    const result = success(await run({ recid: '6004' }));
    expect(result.list?.recid).toBe('1002');
    expect(result.dataset).toEqual({
      recid: '6004',
      title: '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
      run_period: ['Run2012B'],
    });
    const paths = requestsOf(http);
    expect(paths).toHaveLength(3);
    const record = requestedUrls(http)[1]?.searchParams;
    expect(record?.get('q')).toBe('recid:6004');
    expect(record?.get('size')).toBe('1');
    expect(record?.get('skip_files')).toBe('1');
    expect(record?.get('ondemand')).toBe('true');
    expect(paths[2]).toBe(`/record/1002/files/${KEY_1002}`);
  });

  it('replaces the linked full list with its muons-only twin when variant is muons_only', async () => {
    serve({ records: { '6004': dataset } });
    const result = success(await run({ recid: '6004', variant: 'muons_only' }));
    expect(result.list).toMatchObject({ recid: '1005', variant: 'muons_only' });
    expect(result.matched_lists.map((m) => m.recid)).toEqual(['1005']);
    expect(result.dataset?.recid).toBe('6004');
    expect(result).not.toHaveProperty('notice');
  });

  it('collapses links to both twins into the one list of the requested variant', async () => {
    const both = datasetLinkingLists('6100', { abstract: ['1002', '1005'] });
    serve({ records: { '6100': both } });
    expect(success(await run({ recid: '6100' })).matched_lists.map((m) => m.recid)).toEqual([
      '1002',
    ]);
    expect(
      success(await run({ recid: '6100', variant: 'muons_only' })).matched_lists.map(
        (m) => m.recid,
      ),
    ).toEqual(['1005']);
  });

  it('reads links from note.links as well as abstract.links, and ignores a link with no recid', async () => {
    const viaNote = hit('6101', {
      recid: '6101',
      title: 'Via note',
      type: { primary: 'Dataset', secondary: ['Collision'] },
      abstract: { links: [{ description: 'No recid here' }, { url: '/docs/x' }] },
      note: { links: [{ recid: '14208' }] },
    });
    serve({ records: { '6101': viaNote } });
    const result = success(await run({ recid: '6101' }));
    expect(result.list?.recid).toBe('14208');
    expect(result.dataset).toEqual({ recid: '6101', title: 'Via note' });
  });

  it('pairs a linked 14208 with 14209 for muons_only', async () => {
    const d = datasetLinkingLists('6102', { abstract: ['14208'] });
    serve({ records: { '6102': d } });
    expect(success(await run({ recid: '6102', variant: 'muons_only' })).list?.recid).toBe('14209');
  });

  it('returns every candidate and reads no file when a dataset links lists that are not twins', async () => {
    const d = datasetLinkingLists('6103', { abstract: ['1000'], note: ['14202'] });
    const { http } = serve({ records: { '6103': d } });
    const result = success(await run({ recid: '6103' }));
    expect(result.matched_lists.map((m) => m.recid)).toEqual(['1000', '14202']);
    expect(result).not.toHaveProperty('list');
    expect(result).not.toHaveProperty('summary');
    expect(result.runs).toEqual([]);
    expect(result.dataset?.recid).toBe('6103');
    expect(result.notice).toContain(
      '2 validated-run lists match record 6103 (variant full): 1000 — ',
    );
    expect(http.calls).toHaveLength(2);
  });

  it('refuses a dataset that links no list of the collection, naming the record', async () => {
    const d = datasetLinkingLists('6104', { abstract: ['99999'] });
    serve({ records: { '6104': d } });
    const error = errorOf(await run({ recid: '6104' }));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'no_validated_runs', recid: '6104' });
    expect(error.message).toBe(
      'Record 6104 links no validated-run list; lists exist for CMS collision data only, so simulated, non-CMS and non-collision records have none.',
    );
  });

  it('refuses a dataset with no links at all (simulated or non-CMS)', async () => {
    serve({ records: { '30517': hit('30517', { recid: '30517', title: 'Simulated' }) } });
    expect(errorOf(await run({ recid: '30517' })).data).toMatchObject({
      reason: 'no_validated_runs',
      recid: '30517',
    });
  });

  it('refuses a dataset whose only linked list has no twin in the requested variant', async () => {
    const d = datasetLinkingLists('6105', { abstract: ['1000'] });
    serve({ records: { '6105': d } });
    const error = errorOf(await run({ recid: '6105', variant: 'muons_only' }));
    expect(error.data).toMatchObject({
      reason: 'no_validated_runs',
      recid: '6105',
      variant: 'muons_only',
    });
    expect(error.message).toBe(
      'Record 6105 links validated-run lists 1000 in the full variant, and none has a muons_only twin.',
    );
  });

  it('reports record_not_found when the record search finds nothing, naming the recid', async () => {
    const { http } = serve();
    const result = await run({ recid: '123456' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'record_not_found', recid: '123456' });
    expect(error.message).toBe('No record has recid 123456.');
    expect(hintOf(error)).toContain('experiment CMS and type Dataset::Collision');
    expect(http.calls).toHaveLength(2);
  });

  it('reports record_not_found when the search answers a different record', async () => {
    serve({ records: { '777': collisionDatasetHit } });
    // The route serves the hit for q=recid:777, but its recid is 6004.
    expect(errorOf(await run({ recid: '777' })).data).toMatchObject({ reason: 'record_not_found' });
  });
});

describe('cern_opendata_get_validated_runs run period', () => {
  it.each([['Run2012B'], ['run2012b'], ['RUN2012B'], ['2012B'], ['2012b'], ['  Run2012B  ']])(
    'selects list 1002 for the period %j',
    async (runPeriod) => {
      const { http } = serve();
      const result = success(await run({ run_period: runPeriod }));
      expect(result.list?.recid).toBe('1002');
      expect(result).not.toHaveProperty('dataset');
      expect(http.calls).toHaveLength(2);
    },
  );

  it('selects the muons-only list of a period when variant is muons_only', async () => {
    serve();
    const result = success(await run({ run_period: 'Run2012B', variant: 'muons_only' }));
    expect(result.list).toMatchObject({ recid: '1005', variant: 'muons_only' });
    expect(result).not.toHaveProperty('notice');
  });

  it('matches whole periods only: 2012 does not select Run2012B, and 2010 does not select HIRun2010', async () => {
    serve();
    for (const period of ['2012', 'Run2012', '2010', 'IRun2010']) {
      const error = errorOf(await run({ run_period: period }));
      expect(error.data, period).toMatchObject({ reason: 'no_validated_runs', run_period: period });
    }
  });

  it('selects an HI period by its full name', async () => {
    serve();
    expect(success(await run({ run_period: 'HIRun2010' })).list?.recid).toBe('14202');
    expect(success(await run({ run_period: 'hirun2010', variant: 'muons_only' })).list?.recid).toBe(
      '14203',
    );
  });

  it('refuses a period no list covers, naming it', async () => {
    const { http } = serve();
    const error = errorOf(await run({ run_period: 'Run2099X' }));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'no_validated_runs', run_period: 'Run2099X' });
    expect(error.message).toBe('No CMS validated-run list covers run period Run2099X.');
    expect(hintOf(error)).toContain('topic run_periods');
    expect(http.calls).toHaveLength(1);
  });

  it('refuses a period whose lists are only in the other variant, in both directions', async () => {
    serve();
    const noMuons = errorOf(await run({ run_period: 'Run2010B', variant: 'muons_only' }));
    expect(noMuons.data).toMatchObject({ reason: 'no_validated_runs', variant: 'muons_only' });
    expect(noMuons.message).toBe(
      'Run period Run2010B has validated-run lists only in the full variant, none in muons_only.',
    );
    disposeInstalledService();
    serve({
      specs: [{ recid: '50', key: 'Cert_only_MuonPhys.txt', periods: ['Run2099Z'] }],
    });
    const noFull = errorOf(await run({ run_period: 'Run2099Z' }));
    expect(noFull.message).toBe(
      'Run period Run2099Z has validated-run lists only in the muons_only variant, none in full.',
    );
  });

  it('with several lists for the period: returns the candidates and reads no list file', async () => {
    const { http } = serve({ specs: ALL_LIST_SPECS });
    const result = success(await run({ run_period: 'Run2011A' }));
    expect(result.matched_lists).toEqual([
      {
        recid: '1001',
        title:
          'CMS list of validated runs Cert_160404-180252_7TeV_ReRecoNov08_Collisions11_JSON.txt',
        variant: 'full',
        run_periods: ['Run2011A', 'Run2011B'],
        collision_energy: '7TeV',
      },
      {
        recid: '14206',
        title:
          'CMS list of validated runs Cert_160404-177515_7TeV_PromptReco_Collisions11_JSON.txt',
        variant: 'full',
        run_periods: ['Run2011A'],
        collision_energy: '7TeV',
      },
      {
        recid: '14208',
        title: `CMS list of validated runs ${KEY_14208}`,
        variant: 'full',
        run_periods: ['Run2011A'],
        collision_energy: '2.76TeV',
      },
    ]);
    expect(result).not.toHaveProperty('list');
    expect(result).not.toHaveProperty('summary');
    expect(result).not.toHaveProperty('dataset');
    expect(result.runs).toEqual([]);
    expect(result.notice).toBe(
      '3 validated-run lists match run period Run2011A (variant full): ' +
        '1001 — CMS list of validated runs Cert_160404-180252_7TeV_ReRecoNov08_Collisions11_JSON.txt, ' +
        '14206 — CMS list of validated runs Cert_160404-177515_7TeV_PromptReco_Collisions11_JSON.txt, ' +
        `14208 — CMS list of validated runs ${KEY_14208}. ` +
        'Call cern_opendata_get_validated_runs again with recid set to one of them; they differ by reconstruction pass and intended use, as their titles state.',
    );
    expect(http.calls).toHaveLength(1);
  });

  it('lists the muons-only candidates of an ambiguous period under variant muons_only', async () => {
    serve({ specs: ALL_LIST_SPECS });
    const result = success(await run({ run_period: 'Run2011A', variant: 'muons_only' }));
    expect(result.matched_lists.map((m) => [m.recid, m.variant])).toEqual([
      ['14207', 'muons_only'],
      ['14209', 'muons_only'],
    ]);
    expect(result.notice).toContain(
      '2 validated-run lists match run period Run2011A (variant muons_only)',
    );
  });

  it('lists candidates in recid order whatever order the portal answers in', async () => {
    serve({ specs: ALL_LIST_SPECS });
    const ids = success(await run({ run_period: 'Run2011B' })).matched_lists.map((m) => m.recid);
    expect(ids).toEqual(['1001']);
    const ambiguous = success(await run({ run_period: 'Run2011A' })).matched_lists.map((m) =>
      Number(m.recid),
    );
    expect([...ambiguous].sort((a, b) => a - b)).toEqual(ambiguous);
  });

  it('reads the single list of a period that the muons-only twins would have made ambiguous', async () => {
    const { http } = serve();
    const result = success(await run({ run_period: 'Run2011A' }));
    expect(result.list?.recid).toBe('14208');
    expect(result.matched_lists).toHaveLength(1);
    expect(http.calls).toHaveLength(2);
  });

  it('follows the ambiguity notice: the chosen recid reads its list', async () => {
    serve({ specs: ALL_LIST_SPECS });
    const result = success(await run({ recid: '14206' }));
    expect(result.list).toMatchObject({ recid: '14206', variant: 'full' });
    expect(result.runs).toHaveLength(2);
  });

  it('omits collision_energy from a candidate whose list states none', async () => {
    serve({ specs: ALL_LIST_SPECS });
    const result = success(await run({ run_period: 'Run2010B' }));
    expect(result.list).not.toHaveProperty('collision_energy');
    expect(result.matched_lists[0]).not.toHaveProperty('collision_energy');
  });
});

describe('cern_opendata_get_validated_runs runs', () => {
  it('returns each run with its lumi-section count and ranges, and the whole-list summary', async () => {
    serve();
    const result = success(await run({ recid: '1002' }));
    expect(result.runs).toEqual([
      {
        run: 190456,
        lumi_sections: 110,
        lumi_ranges: [
          { first: 1, last: 91 },
          { first: 93, last: 111 },
        ],
      },
      { run: 190459, lumi_sections: 1, lumi_ranges: [{ first: 1, last: 1 }] },
    ]);
    expect(result.summary).toEqual({
      run_count: 2,
      lumi_section_count: 111,
      first_run: 190456,
      last_run: 190459,
    });
  });

  it('returns runs in ascending order whatever order the list file states them in', async () => {
    serve({
      files: { '1002': { '300': [[1, 2]], '20': [[1, 1]], '100000': [[5, 5]], '4': [[2, 3]] } },
    });
    expect(success(await run({ recid: '1002' })).runs.map((r) => r.run)).toEqual([
      4, 20, 300, 100_000,
    ]);
  });

  describe('run_min and run_max', () => {
    const files = { '1002': syntheticRuns(10) };

    it.each([
      [{ run_min: 1003 }, [1003, 1004, 1005, 1006, 1007, 1008, 1009]],
      [{ run_max: 1002 }, [1000, 1001, 1002]],
      [{ run_min: 1003, run_max: 1005 }, [1003, 1004, 1005]],
      [{ run_min: 1004, run_max: 1004 }, [1004]],
      [
        { run_min: 1, run_max: 99_999 },
        [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009],
      ],
    ])('applies %j inclusively', async (bounds, expected) => {
      serve({ files });
      const result = success(await run({ recid: '1002', ...bounds }));
      expect(result.runs.map((r) => r.run)).toEqual(expected);
      expect(result.totalCount).toBe(expected.length);
      expect(result.summary?.run_count).toBe(10);
      expect(result).not.toHaveProperty('notice');
    });

    it('keeps the summary on the whole list, before the run filter', async () => {
      serve({ files });
      const { summary } = success(await run({ recid: '1002', run_min: 1005 }));
      expect(summary).toMatchObject({ run_count: 10, first_run: 1000, last_run: 1009 });
    });

    it.each([
      [
        { run_min: 5000 },
        'No run of list 1002 falls in 5000–1009; the list covers runs 1000–1009.',
      ],
      [{ run_max: 10 }, 'No run of list 1002 falls in 1000–10; the list covers runs 1000–1009.'],
      [
        { run_min: 2000, run_max: 3000 },
        'No run of list 1002 falls in 2000–3000; the list covers runs 1000–1009.',
      ],
    ])('says what the list covers when %j leaves no run', async (bounds, notice) => {
      serve({ files });
      const result = success(await run({ recid: '1002', ...bounds }));
      expect(result.runs).toEqual([]);
      expect(result.notice).toBe(notice);
      expect(result.list?.recid).toBe('1002');
      expect(result.summary?.run_count).toBe(10);
    });

    it('refuses run_min above run_max before any request, and accepts equal bounds', async () => {
      const { http } = serve({ files });
      const result = await run({ recid: '1002', run_min: 1005, run_max: 1004 });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'invalid_range', run_min: 1005, run_max: 1004 });
      expect(error.message).toBe('run_min 1005 is above run_max 1004.');
      expect(textOf(result)).toContain('Recovery: Set run_min at or below run_max');
      expect(http.calls).toHaveLength(0);
      expect(success(await run({ recid: '1002', run_min: 1005, run_max: 1005 })).runs).toHaveLength(
        1,
      );
    });
  });

  describe('limit', () => {
    const files = { '1002': syntheticRuns(5) };

    it('cuts the runs at the limit and says how to continue', async () => {
      serve({ files });
      const result = success(await run({ recid: '1002', limit: 2 }));
      expect(result.runs.map((r) => r.run)).toEqual([1000, 1001]);
      expect(result).toMatchObject({ truncated: true, shown: 2, cap: 2, totalCount: 5 });
      expect(result.notice).toBe(
        'Showing 2 of 5 runs; call cern_opendata_get_validated_runs again with run_min set to 1002, or download the whole list from list.https_url.',
      );
      expect(result.summary?.run_count).toBe(5);
    });

    it('walks every run once by following run_min from each notice', async () => {
      serve({ files });
      const seen: number[] = [];
      let runMin: number | undefined;
      for (let page = 0; page < 5; page++) {
        const result = success(
          await run({
            recid: '1002',
            limit: 2,
            ...(runMin === undefined ? {} : { run_min: runMin }),
          }),
        );
        seen.push(...result.runs.map((r) => r.run));
        if (!result.truncated) break;
        runMin = Number(/run_min set to (\d+)/.exec(result.notice ?? '')?.[1]);
      }
      expect(seen).toEqual([1000, 1001, 1002, 1003, 1004]);
    });

    it('counts the total after the run filter, and names the next run inside the filter', async () => {
      serve({ files });
      const result = success(await run({ recid: '1002', limit: 1, run_min: 1002, run_max: 1003 }));
      expect(result).toMatchObject({ truncated: true, shown: 1, totalCount: 2 });
      expect(result.notice).toContain('Showing 1 of 2 runs');
      expect(result.notice).toContain('run_min set to 1003');
    });

    it('is not truncated when the limit equals the runs in scope', async () => {
      serve({ files });
      const result = success(await run({ recid: '1002', limit: 5 }));
      expect(result).toMatchObject({ truncated: false, shown: 5, cap: 5, totalCount: 5 });
      expect(result).not.toHaveProperty('notice');
    });

    it('returns 2,000 runs on one page and truncates a 2,001-run list', async () => {
      serve({ files: { '1002': syntheticRuns(2_001) } });
      const result = success(await run({ recid: '1002', limit: 2000 }));
      expect(result.runs).toHaveLength(2000);
      expect(result).toMatchObject({ truncated: true, shown: 2000, totalCount: 2001 });
      expect(result.notice).toContain('run_min set to 3000');
    });
  });

  it('says so for a list that certifies no runs, with an empty summary', async () => {
    serve({ files: { '1002': {} } });
    const result = success(await run({ recid: '1002' }));
    expect(result.runs).toEqual([]);
    expect(result.summary).toEqual({ run_count: 0, lumi_section_count: 0 });
    expect(result.notice).toBe('List 1002 certifies no runs.');
    expect(result).toMatchObject({ truncated: false, shown: 0, totalCount: 0 });
  });

  it('keeps a run with an empty range list at zero lumi sections', async () => {
    serve({ files: { '1002': { '5': [] } } });
    const result = success(await run({ recid: '1002' }));
    expect(result.runs).toEqual([{ run: 5, lumi_sections: 0, lumi_ranges: [] }]);
    expect(result.summary).toMatchObject({ run_count: 1, lumi_section_count: 0 });
  });

  it('percent-encodes the file key in the download URL and the file request', async () => {
    const key = 'Cert a[1]#x.json';
    const { http } = serve({ specs: [{ recid: '77', key, periods: ['Run2099Z'] }] });
    const result = success(await run({ recid: '77' }));
    expect(result.list?.https_url).toBe(
      'https://opendata.cern.ch/record/77/files/Cert%20a%5B1%5D%23x.json',
    );
    expect(result.list?.file_key).toBe(key);
    expect(requestsOf(http)[1]).toBe('/record/77/files/Cert%20a%5B1%5D%23x.json');
  });

  it('omits xrootd_uri when the collection lists none', async () => {
    const lists = [validatedListHit({ recid: '88', key: 'a.json', periods: ['Run2099Z'] })];
    const meta = lists[0]?.metadata;
    const files = (meta?._files as { key: string; size: number; uri?: string }[]) ?? [];
    delete files[0]?.uri;
    serve({ collection: searchBody(lists) });
    expect(success(await run({ recid: '88' })).list).not.toHaveProperty('xrootd_uri');
  });
});

describe('cern_opendata_get_validated_runs collection cache', () => {
  it('reads the collection once across calls, and each list file once per call', async () => {
    const { http } = serve();
    await run({ recid: '1002' });
    await run({ run_period: 'Run2012B', variant: 'muons_only' });
    await run({ recid: '14208' });
    const paths = requestsOf(http);
    expect(paths.filter((p) => p.startsWith('/api/records/'))).toHaveLength(1);
    expect(paths.filter((p) => p.startsWith('/record/'))).toHaveLength(3);
  });

  it('reads the collection again after the cache expires', async () => {
    const clock = fakeClock();
    const { http } = serve({}, { now: clock.now, listCacheTtlMs: 60_000 });
    await run({ recid: '1002' });
    clock.advance(59_000);
    await run({ recid: '1002' });
    expect(requestsOf(http).filter((p) => p.startsWith('/api/records/'))).toHaveLength(1);
    clock.advance(2_000);
    await run({ recid: '1002' });
    expect(requestsOf(http).filter((p) => p.startsWith('/api/records/'))).toHaveLength(2);
  });

  it('does not cache a refused call: the lists were still read once for it', async () => {
    const { http } = serve();
    await run({ run_period: 'Run2099X' });
    await run({ recid: '1002' });
    expect(requestsOf(http).filter((p) => p.startsWith('/api/records/'))).toHaveLength(1);
  });
});

describe('cern_opendata_get_validated_runs input errors on the wire', () => {
  it('missing_selector: neither recid nor run_period, before any request', async () => {
    const { http } = serve();
    const result = await run({});
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'missing_selector' });
    expect(error.message).toBe('Give recid or run_period to select a validated-run list.');
    expect(hintOf(error)).toContain('cern_opendata_list_reference with topic run_periods');
    const text = textOf(result);
    expect(text).toContain('Recovery: Call cern_opendata_get_validated_runs again with recid');
    expect(text).toContain('reason missing_selector');
    expect(http.calls).toHaveLength(0);
  });

  it('missing_selector: blanks and options alone are no selector', async () => {
    const { http } = serve();
    const result = await run({
      recid: '',
      run_period: '  ',
      variant: 'muons_only',
      run_min: 5,
      limit: 10,
    } as never);
    expect(errorOf(result).data).toMatchObject({ reason: 'missing_selector' });
    expect(http.calls).toHaveLength(0);
  });

  it('conflicting_selectors: both recid and run_period, before any request', async () => {
    const { http } = serve();
    const result = await run({ recid: '1002', run_period: 'Run2012B' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'conflicting_selectors',
      recid: '1002',
      run_period: 'Run2012B',
    });
    expect(error.message).toBe(
      'Both recid 1002 and run_period Run2012B were given; they select lists differently.',
    );
    expect(hintOf(error)).toBe(
      'Call cern_opendata_get_validated_runs again with only recid or only run_period, not both.',
    );
    expect(textOf(result)).toContain('reason conflicting_selectors');
    expect(http.calls).toHaveLength(0);
  });

  it('conflicting_selectors wins over an invalid range', async () => {
    serve();
    const error = errorOf(
      await run({ recid: '1002', run_period: 'Run2012B', run_min: 9, run_max: 1 }),
    );
    expect(error.data).toMatchObject({ reason: 'conflicting_selectors' });
  });

  it('writes no enrichment that could pass for a result on input-class refusals', async () => {
    serve();
    for (const input of [
      {},
      { recid: '1', run_period: 'x' },
      { recid: '1002', run_min: 9, run_max: 1 },
    ]) {
      const result = await run(input);
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(result.structuredContent).not.toHaveProperty('runs');
    }
  });
});

describe('cern_opendata_get_validated_runs enrichment', () => {
  it('zero-result page (a run filter leaves nothing): required fields at zero beside the notice', async () => {
    serve();
    const result = success(await run({ recid: '1002', run_min: 999_999, limit: 25 }));
    expect(result).toMatchObject({
      truncated: false,
      shown: 0,
      cap: 25,
      totalCount: 0,
      runs: [],
    });
    expect(result.notice).toBe(
      'No run of list 1002 falls in 999999–190459; the list covers runs 190456–190459.',
    );
  });

  it('zero-result page (several lists matched, none read): required fields at zero beside the notice', async () => {
    serve({ specs: ALL_LIST_SPECS });
    const result = success(await run({ run_period: 'Run2011A', limit: 7 }));
    expect(result).toMatchObject({ truncated: false, shown: 0, cap: 7, totalCount: 0, runs: [] });
    expect(result.notice).toMatch(/^3 validated-run lists match run period Run2011A/);
  });

  it('zero-result page (a list that certifies nothing): required fields at zero beside the notice', async () => {
    serve({ files: { '1002': {} } });
    expect(success(await run({ recid: '1002' }))).toMatchObject({
      truncated: false,
      shown: 0,
      cap: 200,
      totalCount: 0,
      notice: 'List 1002 certifies no runs.',
    });
  });

  it('under-cap page: fewer runs than the cap, not truncated, no notice, totals match', async () => {
    serve();
    const result = success(await run({ recid: '1002', limit: 10 }));
    expect(result).toMatchObject({ truncated: false, shown: 2, cap: 10, totalCount: 2 });
    expect(result).not.toHaveProperty('notice');
  });

  it('under-cap page with a swap notice: still not truncated, the notice rides on notice', async () => {
    serve();
    const result = success(await run({ recid: '1002', variant: 'muons_only', limit: 10 }));
    expect(result).toMatchObject({ truncated: false, shown: 2, cap: 10, totalCount: 2 });
    expect(result.notice).toMatch(/^List 1002 is the full variant; its muons_only twin 1005/);
  });

  it('truncated page carrying a swap notice composes both fragments in order', async () => {
    serve({ files: { '1005': syntheticRuns(4) } });
    const result = success(await run({ recid: '1002', variant: 'muons_only', limit: 3 }));
    expect(result).toMatchObject({ truncated: true, shown: 3, totalCount: 4 });
    const notice = result.notice ?? '';
    expect(notice.indexOf('List 1002 is the full variant')).toBe(0);
    expect(notice.indexOf('Showing 3 of 4 runs')).toBeGreaterThan(
      notice.indexOf('no variant for the list as named.'),
    );
  });

  it('writes the same fields into the text trailer', async () => {
    serve({ files: { '1002': syntheticRuns(5) } });
    const trailer = textOf(await run({ recid: '1002', limit: 2 }), 1);
    expect(trailer).toContain('**truncated:** true');
    expect(trailer).toContain('**shown:** 2');
    expect(trailer).toContain('**cap:** 2');
    expect(trailer).toContain('5 total');
    expect(trailer).toContain('Showing 2 of 5 runs');
  });
});

describe('cern_opendata_get_validated_runs upstream failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settled = async (input: Parameters<typeof run>[0], signal?: AbortSignal) => {
    const outcome = await settle(() =>
      signal ? runToolContract(getValidatedRuns, input, { context: { signal } }) : run(input),
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };

  /** A service whose collection, record and file legs each answer as given (healthy by default). */
  const legs = (answers: {
    collection?: () => Response;
    file?: () => Response;
    record?: () => Response;
  }) =>
    installService([
      portalRoute(
        '/api/records/',
        answers.collection ?? (() => jsonResponse(validatedRunsSearchBody())),
        {
          query: (p) => p.get('collections') === 'CMS-Validated-Runs',
        },
      ),
      portalRoute(
        '/api/records/',
        answers.record ?? (() => jsonResponse(searchBody([collisionDatasetHit]))),
        {
          query: (p) => p.get('q')?.startsWith('recid:') === true,
        },
      ),
      portalRoute(
        /^\/record\/\d+\/files\/.+$/,
        answers.file ?? (() => jsonResponse(RUN_LIST_BODY)),
      ),
    ]);

  const rateLimited = () => new Response('', { status: 429, headers: { 'retry-after': '60' } });

  it.each([
    ['the collection', 'collection'],
    ['the dataset record lookup', 'record'],
    ['the list file', 'file'],
  ] as const)(
    'maps a 429 on %s to rate_limited with retryAfter and the declared recovery, without retrying',
    async (_name, leg) => {
      const { http } = legs({ [leg]: rateLimited });
      const result = await settled({ recid: '6004' });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
      const text = textOf(result);
      expect(text).toContain('Recovery: Wait the retryAfter seconds');
      expect(text).toContain('call cern_opendata_get_validated_runs again');
      expect(http.calls.length).toBeLessThanOrEqual(3);
      expect(requestsOf(http).filter((p) => p === requestsOf(http).at(-1))).toHaveLength(1);
    },
  );

  it('sheds the 51st request inside a minute as rate_limited before any request', async () => {
    const { http } = legs({});
    // The first call reads the collection (cached) and one list file; each later call reads one file.
    for (let n = 0; n < 49; n++) {
      expect((await run({ recid: '1002' })).isError, `call ${n}`).toBeFalsy();
    }
    expect(http.calls).toHaveLength(50);
    const outcome = await settle(() => run({ recid: '1002' }), 100);
    if (!outcome.ok) throw outcome.error;
    expect(errorOf(outcome.value).code).toBe(JsonRpcErrorCode.RateLimited);
    expect(errorOf(outcome.value).data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    expect(http.calls).toHaveLength(50);
  });

  it('fails a persistent 503 on the collection as ServiceUnavailable after three attempts', async () => {
    const { http } = legs({ collection: () => new Response('down', { status: 503 }) });
    const result = await settled({ run_period: 'Run2012B' });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(http.calls).toHaveLength(3);
  });

  it('recovers when a 502 on the list file is followed by a healthy answer', async () => {
    let calls = 0;
    const { http } = legs({
      file: () =>
        ++calls === 1 ? new Response('bad gateway', { status: 502 }) : jsonResponse(RUN_LIST_BODY),
    });
    const result = await settled({ recid: '1002' });
    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(3);
  });

  it('maps an HTML body on the collection to upstream_unreadable, retried, with the declared recovery', async () => {
    const { http } = legs({ collection: () => new Response(HTML_ERROR_PAGE, { status: 200 }) });
    const result = await settled({ recid: '1002' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.data).not.toMatchObject({ retryable: false });
    expect(textOf(result)).toContain(
      'Recovery: Call cern_opendata_get_validated_runs again in a minute',
    );
    expect(http.calls).toHaveLength(3);
  });

  it.each([
    ['an HTML page', () => new Response(HTML_ERROR_PAGE, { status: 200 })],
    ['an array instead of a run object', () => jsonResponse([[1, 2]])],
    ['a non-numeric run key', () => jsonResponse({ abc: [[1, 2]] })],
    ['a fractional lumi section', () => jsonResponse({ '5': [[1.5, 2]] })],
    ['a range with three numbers', () => jsonResponse({ '5': [[1, 2, 3]] })],
    ['ranges of strings', () => jsonResponse({ '5': [['1', '2']] })],
    ['an empty body', () => new Response('', { status: 200 })],
  ])('maps %s as the list file to upstream_unreadable', async (_name, file) => {
    legs({ file });
    const result = await settled({ recid: '1002' });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(errorOf(result).data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('maps a list file the collection names but the portal 404s to upstream_unreadable, and re-reads the collection next time', async () => {
    let missing = true;
    const { http } = legs({
      file: () =>
        missing ? jsonResponse(NOT_FOUND_BODY, { status: 404 }) : jsonResponse(RUN_LIST_BODY),
    });
    const result = await settled({ recid: '1002' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_unreadable',
      recid: '1002',
      key: KEY_1002,
    });
    const collectionReads = () =>
      requestsOf(http).filter((p) => p.startsWith('/api/records/')).length;
    expect(collectionReads()).toBe(1);
    missing = false;
    expect((await settled({ recid: '1002' })).isError).toBeFalsy();
    expect(collectionReads()).toBe(2);
  });

  it('maps a list file over the 2 MiB ceiling to non-retryable upstream_unreadable after one request', async () => {
    const { http } = legs({
      file: () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
        }),
    });
    const result = await settled({ recid: '1002' });
    expect(errorOf(result).data).toMatchObject({
      reason: 'upstream_unreadable',
      retryable: false,
      limitBytes: 2 * 1024 * 1024,
    });
    expect(requestsOf(http).filter((p) => p.startsWith('/record/'))).toHaveLength(1);
  });

  it('fails a refused connection as ServiceUnavailable, naming the portal, after three attempts', async () => {
    const fetchFake = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    installService([], { fetch: fetchFake as unknown as typeof fetch });
    const result = await settled({ recid: '1002' });
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
    const result = await settled({ recid: '1002' });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.Timeout);
  });

  it('reports a cancelled call as RequestCancelled without a request', async () => {
    const { http } = legs({});
    const controller = new AbortController();
    controller.abort(new Error('client left'));
    const result = await settled({ recid: '1002' }, controller.signal);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(http.calls).toHaveLength(0);
  });
});

describe('cern_opendata_get_validated_runs format', () => {
  it('renders the header, matched list, selected list, summary and every run row', async () => {
    serve();
    const result = await run({ recid: '1002' });
    const text = textOf(result);
    expect(text).toContain('## Validated runs: list 1002 (full)');
    expect(text).toContain('### Matched lists (1)');
    expect(text).toContain(
      `| 1002 | full | Run2012A, Run2012B, Run2012C, Run2012D | 8TeV | CMS list of validated runs ${KEY_1002} |`,
    );
    expect(text).toContain('### Selected list');
    expect(text).toContain(`**Title:** CMS list of validated runs ${KEY_1002}`);
    expect(text).toContain(
      '**Recid:** 1002 · **Variant:** full · **Run periods:** Run2012A, Run2012B, Run2012C, Run2012D · **Collision energy:** 8TeV',
    );
    expect(text).toContain(`**File key:** ${KEY_1002}`);
    expect(text).toContain(`**HTTPS:** https://opendata.cern.ch/record/1002/files/${KEY_1002}`);
    expect(text).toContain(
      `**XRootD:** root://eospublic.cern.ch//eos/opendata/cms/validation/${KEY_1002}`,
    );
    expect(text).toContain('**Portal:** https://opendata.cern.ch/record/1002');
    expect(text).toContain('**Whole list:** 2 runs, 111 luminosity sections, runs 190456–190459');
    expect(text).toContain('### Runs (2)');
    expect(text).toContain('| 190456 | 110 | 1–91, 93–111 |');
    expect(text).toContain('| 190459 | 1 | 1–1 |');
  });

  it('renders the same runs, ranges and list fields that structuredContent carries', async () => {
    serve({ files: { '1002': syntheticRuns(12) } });
    const result = await run({ recid: '1002', limit: 12 });
    const text = textOf(result);
    const data = success(result);
    for (const r of data.runs) {
      for (const range of r.lumi_ranges) {
        expect(text).toContain(`| ${r.run} | ${r.lumi_sections} | ${range.first}–${range.last} |`);
      }
    }
    for (const matched of data.matched_lists) {
      expect(text).toContain(matched.recid);
      expect(text).toContain(matched.title);
    }
    expect(text).toContain(data.list?.https_url);
    expect(text).toContain(data.list?.portal_url);
    expect(
      text.split('\n').filter((line) => /^\| 1\d{3} \| \d+ \| \d+–\d+ \|$/.test(line)),
    ).toHaveLength(12);
  });

  it('renders a dataset line with its title and run periods', async () => {
    serve({ records: { '6004': collisionDatasetHit } });
    const text = textOf(await run({ recid: '6004' }));
    expect(text).toContain(
      '**Dataset:** 6004: /DoubleMuParked/Run2012B-22Jan2013-v1/AOD · **Run periods:** Run2012B',
    );
  });

  it('renders a dataset with no title or run periods as Not available', async () => {
    const bare = hit('6200', {
      recid: '6200',
      type: { primary: 'Dataset', secondary: ['Collision'] },
      abstract: { links: [{ recid: '1002' }] },
    });
    serve({ records: { '6200': bare } });
    const text = textOf(await run({ recid: '6200' }));
    expect(text).toContain('**Dataset:** 6200: Not available · **Run periods:** Not available');
  });

  it('renders Not available for a list without collision energy or XRootD URI, never an empty value', async () => {
    serve({ specs: ALL_LIST_SPECS });
    const text = textOf(await run({ recid: '1000' }));
    expect(text).toContain('**Collision energy:** Not available');
    expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it('renders an ambiguous period as a candidate table with no selected list and no runs', async () => {
    serve({ specs: ALL_LIST_SPECS });
    const result = await run({ run_period: 'Run2011A' });
    const text = textOf(result);
    expect(text.split('\n')[0]).toBe('## Validated-run lists (3 matched)');
    expect(text).toContain('### Matched lists (3)');
    for (const recid of ['1001', '14206', '14208']) expect(text).toContain(`| ${recid} | full |`);
    expect(text).not.toContain('### Selected list');
    expect(text).not.toContain('**Whole list:**');
    expect(text).toContain('### Runs (0)\nNo list read; pick one recid from the matched lists.');
    expect(textOf(result, 1)).toContain('3 validated-run lists match run period Run2011A');
  });

  it('renders "No runs in range." when a list was read and the filter left nothing', async () => {
    serve();
    const text = textOf(await run({ recid: '1002', run_min: 999_999 }));
    expect(text).toContain('### Runs (0)\nNo runs in range.');
    expect(text).toContain('**Whole list:** 2 runs');
  });

  it('renders a list that certifies no runs with absent first and last runs as Not available', async () => {
    serve({ files: { '1002': {} } });
    const text = textOf(await run({ recid: '1002' }));
    expect(text).toContain(
      '**Whole list:** 0 runs, 0 luminosity sections, runs Not available–Not available',
    );
  });

  it('keeps CR/LF, markup and bidi controls in upstream list text out of the inline slots and the notice', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const hostile = (recid: string, key: string, period: string) => {
      const base = validatedListHit({ recid, key, periods: [period], energy: '8\nTeV' });
      return {
        ...base,
        metadata: {
          ...base.metadata,
          title: `Evil ${recid}\r\n# Injected heading\n- [link](http://evil.example) <script>`,
          // The clean period is what the call selects by; the hostile ones only render.
          run_period: [period, `Run2099Y${rlo}|z`, 'Run\n2099X'],
        },
      };
    };
    serve({
      collection: searchBody([
        hostile('301', 'Cert_a\nb.json', 'Run2099Z'),
        hostile('302', 'Cert_c[d].json', 'Run2099Z'),
      ]),
    });
    const result = await run({ run_period: 'Run2099Z' });
    const text = textOf(result);
    const lines = text.split('\n');
    expect(lines.some((line) => line.startsWith('# '))).toBe(false);
    expect(lines.filter((line) => line.startsWith('## '))).toEqual([
      '## Validated-run lists (2 matched)',
    ]);
    expect(lines.some((line) => line.startsWith('- [link]'))).toBe(false);
    expect(text).toContain(
      'Evil 301  # Injected heading - \\[link\\](http://evil.example) &lt;script&gt;',
    );
    expect(text).toContain('Run2099Z, Run2099Y\\|z, Run 2099X');
    expect(text).toContain('| 8 TeV |');
    expect(text).not.toMatch(new RegExp(`[\\r${rlo}]`));
    const notice = success(result).notice ?? '';
    expect(notice).not.toMatch(new RegExp(`[\\r\\n${rlo}]`));
    expect(notice).toContain(
      '301 — Evil 301  # Injected heading - \\[link\\](http://evil.example) &lt;script&gt;',
    );
    // structuredContent keeps the strings as received.
    expect(success(result).matched_lists[0]?.title).toContain('\r\n# Injected heading');
  });

  it('keeps CR/LF and markup in the file key and URI inside their slots for a selected list', async () => {
    const key = 'Cert\n# x|y [z].json';
    const base = validatedListHit({ recid: '303', key, periods: ['Run2099Z'] });
    serve({
      collection: searchBody([
        {
          ...base,
          metadata: {
            ...base.metadata,
            _files: [{ key, size: 1, uri: 'root://x/a b\n[1]' }],
          },
        },
      ]),
    });
    const text = textOf(await run({ recid: '303' }));
    const lines = text.split('\n');
    expect(text).toContain('**File key:** Cert # x\\|y \\[z\\].json');
    expect(text).toContain(
      '**HTTPS:** https://opendata.cern.ch/record/303/files/Cert%0A%23%20x%7Cy%20%5Bz%5D.json',
    );
    expect(text).toContain('**XRootD:** root://x/a%20b%0A%5B1%5D');
    expect(lines.some((line) => line.startsWith('# x'))).toBe(false);
  });

  it('returns one text block for the page and one for the trailer', async () => {
    serve();
    const result = await run({ recid: '1002' });
    expect(result.content.every((block) => block.type === 'text')).toBe(true);
    expect(result.content.length).toBeGreaterThanOrEqual(1);
  });
});
