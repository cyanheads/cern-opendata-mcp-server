/**
 * @fileoverview Tests for cern_opendata_get_records: id parsing and mixed
 * identifier forms, the combined lookup query, matches in input order,
 * `missing` with guidance (unrecognized ids included), the uppercase-DOI retry,
 * license and citation in every record, doc-body caps and their notice, sparse
 * payloads, the text twin of structuredContent, and errors on the wire.
 * @module tests/tools/get-records.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecords } from '@/mcp-server/tools/definitions/get-records.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { CITATION_REQUEST } from '@/services/cern-opendata/normalize.js';
import { inline } from '@/services/cern-opendata/text.js';
import type { RawHit } from '@/services/cern-opendata/types.js';
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
  collisionDatasetHit,
  docHit,
  docHitWithBody,
  emptySearchBody,
  environmentSystemHit,
  HTML_ERROR_PAGE,
  hit,
  jsonResponse,
  licensedDatasetHit,
  newsHit,
  portalRoute,
  richDatasetHit,
  SYNTAX_ERROR_BODY,
  searchBody,
  softwareHit,
  sparseHit,
} from '../fixtures/cern-opendata-upstream.js';

type Output = Awaited<ReturnType<typeof getRecords.handler>>;
type Record_ = Output['records'][number];
type Result = Output & { notice?: string };

const DOI = '10.7483/OPENDATA.CMS.YLIC.86ZZ';
const PATH = '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD';

const searchRoute = (respond: Parameters<typeof portalRoute>[1]) =>
  portalRoute('/api/records/', respond);

/** Every lookup search answers with the whole `pool`; the service keeps the hits that match. */
function servePool(pool: readonly RawHit[]) {
  return installService([searchRoute(() => jsonResponse(searchBody(pool)))]);
}

const run = (ids: Parameters<typeof runToolContract<typeof getRecords>>[1]['ids'] | string) =>
  runToolContract(getRecords, { ids } as never);

const success = (result: ContractResult) => dataOf<Result>(result);

const queriesOf = (http: ReturnType<typeof installService>['http']) =>
  http.calls.map((call) => new URL(call.request.url).searchParams);

afterEach(() => {
  vi.useRealTimers();
  disposeInstalledService();
});

describe('cern_opendata_get_records registration', () => {
  it('is registered, read-only, idempotent and open-world', () => {
    expect(allToolDefinitions).toContain(getRecords);
    expect(getRecords.name).toBe('cern_opendata_get_records');
    expect(getRecords.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('declares only the two shared service errors, naming the tool in each recovery', () => {
    expect(getRecords.errors?.map((entry) => entry.reason)).toEqual([
      'rate_limited',
      'upstream_unreadable',
    ]);
    expect(getRecords.errors?.[0]).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
    });
    expect(getRecords.errors?.[1]).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
    });
    for (const entry of getRecords.errors ?? []) {
      expect(entry.recovery).toContain('cern_opendata_get_records');
    }
  });
});

describe('cern_opendata_get_records input', () => {
  it('accepts an array, one comma-separated string, and a mix of identifier forms', () => {
    expect(getRecords.input.parse({ ids: ['6004', DOI, PATH, 'cms-guide-docker'] }).ids).toEqual([
      '6004',
      DOI,
      PATH,
      'cms-guide-docker',
    ]);
    expect(getRecords.input.parse({ ids: `6004, ${DOI} ,cms-guide-docker` }).ids).toEqual([
      '6004',
      DOI,
      'cms-guide-docker',
    ]);
  });

  it('drops blank elements and exact duplicates, keeping order', () => {
    expect(getRecords.input.parse({ ids: ['6004', '', '  ', '101', '6004'] }).ids).toEqual([
      '6004',
      '101',
    ]);
    expect(getRecords.input.parse({ ids: ' , 7 ,, 8 ' }).ids).toEqual(['7', '8']);
  });

  it('rejects a non-string id at the schema', () => {
    expect(getRecords.input.safeParse({ ids: [6004] }).success).toBe(false);
  });

  it('keeps different spellings of one record as separate inputs', () => {
    expect(getRecords.input.parse({ ids: ['6004', 'recid:6004'] }).ids).toEqual([
      '6004',
      'recid:6004',
    ]);
  });

  it.each([
    ['no ids key', {}],
    ['an empty array', { ids: [] }],
    ['an empty string', { ids: '' }],
    ['only blanks', { ids: [' ', ''] }],
    ['only separators', { ids: ' , , ' }],
    ['more than 20 ids', { ids: Array.from({ length: 21 }, (_, i) => String(i + 1)) }],
    ['an id over 500 characters', { ids: ['1'.repeat(501)] }],
  ])('rejects %s as invalid arguments before any request', async (_name, input) => {
    const { http } = servePool([]);
    const result = await runToolContract(getRecords, input as never);
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    ['an empty array', { ids: [] }],
    ['an empty string', { ids: '' }],
    ['only blanks', { ids: [' ', ''] }],
    ['only separators', { ids: ' , , ' }],
  ])('names the missing identifier and the way to find one for %s', async (_name, input) => {
    const { http } = servePool([]);
    const result = await runToolContract(getRecords, input as never);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).message).toContain(
      'ids: At least one identifier is required (a recid, DOI, CMS dataset path or documentation slug); cern_opendata_search_records finds them.',
    );
    expect(textOf(result)).toContain('cern_opendata_search_records finds them');
    expect(http.calls).toHaveLength(0);
  });

  it('accepts exactly 20 ids and sends them in one request', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(1000 + i));
    const { http } = servePool([]);
    const result = await run(ids);
    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    expect(queriesOf(http)[0]?.get('q')).toBe(`recid:(${ids.join(' OR ')})`);
    expect(success(result).missing).toHaveLength(20);
  });
});

describe('cern_opendata_get_records lookup on the wire', () => {
  it('resolves every identifier form in one search with the documented parameters', async () => {
    const { http } = servePool([collisionDatasetHit]);
    await run(['6004', DOI, PATH, 'cms-guide-docker']);
    expect(http.calls).toHaveLength(1);
    const params = queriesOf(http)[0];
    expect(params?.get('q')).toBe(
      `recid:(6004) OR doi:("${DOI}") OR title:("${PATH}") OR slug:("cms-guide-docker")`,
    );
    expect([...(params ?? [])].filter(([name]) => name !== 'q')).toEqual([
      ['sort', 'bestmatch'],
      ['size', '100'],
      ['skip_files', '1'],
      ['ondemand', 'true'],
    ]);
  });

  it('joins several ids of one form inside one clause', async () => {
    const { http } = servePool([]);
    await run(['1', 'recid:2', 'https://opendata.cern.ch/record/3']);
    expect(queriesOf(http)[0]?.get('q')).toBe('recid:(1 OR 2 OR 3)');
  });

  it.each([
    ['doi:10.7483/OPENDATA.CMS.YLIC.86ZZ', DOI],
    ['DOI: 10.7483/OPENDATA.CMS.YLIC.86ZZ', DOI],
    ['https://doi.org/10.7483/OPENDATA.CMS.YLIC.86ZZ', DOI],
    ['http://dx.doi.org/10.7483/OPENDATA.CMS.YLIC.86ZZ', DOI],
  ])('reduces the DOI spelling %s to the bare DOI in the query', async (input, bare) => {
    const { http } = servePool([]);
    await run(input);
    expect(queriesOf(http)[0]?.get('q')).toBe(`doi:("${bare}")`);
  });

  it('reduces a portal docs URL to its lowercased slug', async () => {
    const { http } = servePool([]);
    await run('https://opendata.cern.ch/docs/CMS-Guide-Docker#intro');
    expect(queriesOf(http)[0]?.get('q')).toBe('slug:("cms-guide-docker")');
  });

  it('strips leading zeros from a recid in the query and still reports the input as given', async () => {
    const { http } = servePool([collisionDatasetHit]);
    const { records, missing } = success(await run(['06004', 'recid:0006004', '0010']));
    const q = queriesOf(http)[0]?.get('q') ?? '';
    expect(q).toMatch(/^recid:\(6004 OR 6004 OR 10\)$/);
    expect(q).not.toContain('06004');
    expect(missing.map((entry) => entry.input)).toEqual(['0010']);
    expect(records).toHaveLength(1);
    expect(records[0]?.matched_inputs).toEqual(['06004', 'recid:0006004']);
  });

  it('makes no request when no id is recognized, and reports each as unrecognized', async () => {
    const { http } = servePool([collisionDatasetHit]);
    const result = await run(['not valid!', 'a b c', '??']);
    const data = success(result);
    expect(http.calls).toHaveLength(0);
    expect(data.records).toEqual([]);
    expect(data.missing.map((entry) => [entry.input, entry.interpreted_as])).toEqual([
      ['not valid!', 'unrecognized'],
      ['a b c', 'unrecognized'],
      ['??', 'unrecognized'],
    ]);
  });

  it('keeps an unrecognized id out of the query while the recognized ones are sent', async () => {
    const { http } = servePool([collisionDatasetHit]);
    await run(['6004', 'not valid!']);
    expect(queriesOf(http)[0]?.get('q')).toBe('recid:(6004)');
  });
});

describe('cern_opendata_get_records results', () => {
  it('returns the full record with license and citation for a recid', async () => {
    servePool([collisionDatasetHit]);
    const { records, missing } = success(await run('6004'));
    expect(missing).toEqual([]);
    expect(records).toEqual([
      {
        id: '6004',
        kind: 'record',
        recid: '6004',
        matched_inputs: ['6004'],
        title: PATH,
        type: { primary: 'Dataset', secondary: ['Collision'] },
        experiment: ['CMS'],
        collections: ['CMS-Primary-Datasets'],
        date_created: ['2012'],
        run_period: ['Run2012B'],
        collaboration: { name: 'CMS Collaboration' },
        doi: DOI,
        date_published: '2014',
        availability: 'online',
        collision_energy: '8TeV',
        collision_type: 'pp',
        distribution: {
          formats: ['aod', 'root'],
          number_events: 29_308_627,
          number_files: 158,
          size_in_bytes: 4_950_000_000_000,
        },
        abstract_html: '<p>Dimuon events recorded in 2012.</p>',
        usage_html: '<p>See the <a href="/docs/cms-guide-docker">Docker guide</a>.</p>',
        links: [
          { source: 'abstract', recid: '1002' },
          { source: 'usage', url: '/docs/cms-guide-docker#intro', description: 'CMS Docker guide' },
        ],
        relations: [],
        license: {
          id: 'CC0-1.0',
          basis: 'cern_terms_default',
          statement:
            'CC0-1.0 under the CERN Open Data Terms of Use; the record states no license of its own.',
        },
        citation: {
          text: `CMS Collaboration (2014). ${PATH}. CERN Open Data Portal. DOI:${DOI}`,
          doi: DOI,
          request: CITATION_REQUEST,
        },
        portal_url: 'https://opendata.cern.ch/record/6004',
      },
    ]);
  });

  it('relays a license the record states, with the record basis', async () => {
    servePool([licensedDatasetHit, softwareHit]);
    const { records } = success(await run(['30517', '101']));
    expect(records.map((record) => record.license)).toEqual([
      {
        id: 'CC0-1.0',
        basis: 'record',
        statement: 'Licensed CC0-1.0, as stated on the record.',
      },
      {
        id: 'GPL-3.0-only',
        basis: 'record',
        statement: 'Licensed GPL-3.0-only, as stated on the record.',
      },
    ]);
  });

  it('builds the citation from what the record has, inventing nothing', async () => {
    servePool([licensedDatasetHit]);
    const [record] = success(await run('30517')).records;
    expect(record?.citation).toEqual({
      text: '/GluGluHToBB_M125_13TeV_powheg_pythia8/RunIIFall15MiniAODv2-PU25nsData2015v1-v1/MINIAODSIM. CERN Open Data Portal. DOI:10.7483/OPENDATA.CMS.TEST.0001',
      doi: '10.7483/OPENDATA.CMS.TEST.0001',
      request: CITATION_REQUEST,
    });
  });

  it('gives a record with no license of its own and no DOI the not-stated license and no citation', async () => {
    servePool([sparseHit]);
    const [record] = success(await run('1120')).records;
    expect(record?.license).toEqual({
      basis: 'not_stated',
      statement:
        "The record states no license. Software, environments, documentation and supplementary material are licensed separately from the CC0 data (software is commonly GPL); check the record's portal page.",
    });
    expect(record).not.toHaveProperty('citation');
    expect(record).not.toHaveProperty('doi');
  });

  it('keeps a sparse record sparse: absent fields omitted, lists empty, nothing defaulted', async () => {
    servePool([sparseHit]);
    const [record] = success(await run('1120')).records;
    expect(record).toEqual({
      id: '1120',
      kind: 'record',
      recid: '1120',
      matched_inputs: ['1120'],
      title: 'Sparse record',
      type: { primary: 'Software', secondary: [] },
      links: [],
      relations: [],
      license: expect.objectContaining({ basis: 'not_stated' }),
      portal_url: 'https://opendata.cern.ch/record/1120',
    });
  });

  it('returns a documentation page as a doc with its body, tags and short description', async () => {
    servePool([docHit]);
    const [record] = success(await run('cms-guide-docker')).records;
    expect(record).toMatchObject({
      id: 'cms-guide-docker',
      kind: 'doc',
      slug: 'cms-guide-docker',
      matched_inputs: ['cms-guide-docker'],
      tags: ['docker', 'cmssw'],
      short_description: 'How to run the CMS open data containers.',
      body: '## <a name="intro">Introduction</a>\n\nRun `docker pull`.\n',
      body_format: 'md',
      body_length: 56,
      body_truncated: false,
      portal_url: 'https://opendata.cern.ch/docs/cms-guide-docker',
    });
    expect(record).not.toHaveProperty('recid');
    expect(record?.license.basis).toBe('not_stated');
  });

  it('returns a news page with its author string as one author', async () => {
    servePool([newsHit]);
    const [record] = success(await run('cms-releases-2026')).records;
    expect(record).toMatchObject({
      kind: 'doc',
      authors: [{ name: 'CERN Open Data team' }],
      date_published: '2026-03-01',
    });
  });

  it('keeps structuredContent strings as received, HTML and entities included', async () => {
    servePool([
      hit('77', {
        recid: '77',
        title: 'A &amp; B <i>italic</i>',
        type: { primary: 'Software' },
        abstract: { description: '<p>x &lt; y &amp; z</p>' },
      }),
    ]);
    const [record] = success(await run('77')).records;
    expect(record?.title).toBe('A &amp; B <i>italic</i>');
    expect(record?.abstract_html).toBe('<p>x &lt; y &amp; z</p>');
  });

  it('ignores hits that match none of the requested ids', async () => {
    servePool([softwareHit, collisionDatasetHit, docHit]);
    const { records } = success(await run('6004'));
    expect(records.map((record) => record.id)).toEqual(['6004']);
  });
});

describe('cern_opendata_get_records mixed identifiers', () => {
  it('collapses ids that resolve to one record, and lists every matching input in input order', async () => {
    servePool([collisionDatasetHit]);
    const { records, missing } = success(
      await run(['6004', `doi:${DOI.toLowerCase()}`, DOI, PATH, 'recid:6004']),
    );
    expect(missing).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]?.matched_inputs).toEqual([
      '6004',
      `doi:${DOI.toLowerCase()}`,
      DOI,
      PATH,
      'recid:6004',
    ]);
  });

  it('orders records by their first matching input, not by the order the portal returned them', async () => {
    servePool([softwareHit, collisionDatasetHit, docHit]);
    const { records } = success(
      await run(['cms-guide-docker', '6004', '101', `doi:${DOI}`, 'recid:101']),
    );
    expect(records.map((record) => record.id)).toEqual(['cms-guide-docker', '6004', '101']);
    expect(records[1]?.matched_inputs).toEqual(['6004', `doi:${DOI}`]);
    expect(records[2]?.matched_inputs).toEqual(['101', 'recid:101']);
  });

  it('keeps missing ids in input order, unrecognized ones included, each with its own guidance', async () => {
    const { http } = servePool([collisionDatasetHit]);
    const { records, missing } = success(
      await run([
        '999',
        'not valid!',
        '6004',
        '10.7483/OPENDATA.NOPE.0000',
        '/No/Such/Path',
        'no-such-slug',
        'recid:998',
      ]),
    );
    expect(records.map((record) => record.id)).toEqual(['6004']);
    expect(missing).toEqual([
      {
        input: '999',
        interpreted_as: 'recid',
        guidance:
          "No record has recid 999. Call cern_opendata_search_records with a title keyword to find the record's recid.",
      },
      {
        input: 'not valid!',
        interpreted_as: 'unrecognized',
        guidance:
          'Not a recid, DOI, CMS dataset path or documentation slug. Call cern_opendata_list_reference with topic identifiers for the accepted forms.',
      },
      {
        input: '10.7483/OPENDATA.NOPE.0000',
        interpreted_as: 'doi',
        guidance:
          'No record carries DOI 10.7483/OPENDATA.NOPE.0000 (tried as given and uppercased). Call cern_opendata_search_records with a title keyword to find the record; portal DOIs look like 10.7483/OPENDATA.CMS.XXXX.XXXX.',
      },
      {
        input: '/No/Such/Path',
        interpreted_as: 'cms_dataset_path',
        guidance:
          'No record title equals /No/Such/Path. Call cern_opendata_search_records with experiment CMS and query set to the primary-dataset name to find the exact path.',
      },
      {
        input: 'no-such-slug',
        interpreted_as: 'doc_slug',
        guidance:
          'No documentation or news page has slug no-such-slug. Call cern_opendata_search_records with type Documentation and a keyword to find the slug.',
      },
      {
        input: 'recid:998',
        interpreted_as: 'recid',
        guidance:
          "No record has recid 998. Call cern_opendata_search_records with a title keyword to find the record's recid.",
      },
    ]);
    expect(http.calls).toHaveLength(1);
  });

  it('echoes a missing input exactly as given and the guidance names the normalized value', async () => {
    servePool([]);
    const { missing } = success(await run('  https://opendata.cern.ch/record/555?ln=en '));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.input).toBe('https://opendata.cern.ch/record/555?ln=en');
    expect(missing[0]?.guidance).toContain('No record has recid 555.');
  });

  it('returns no records and every id missing when nothing resolves', async () => {
    servePool([]);
    const result = success(await run(['1', '2']));
    expect(result.records).toEqual([]);
    expect(result.missing.map((entry) => entry.input)).toEqual(['1', '2']);
    expect(result).not.toHaveProperty('notice');
  });
});

describe('cern_opendata_get_records uppercase DOI retry', () => {
  const lower = DOI.toLowerCase();
  const docRoute = (answer: (q: string) => RawHit[]) =>
    searchRoute((request) =>
      jsonResponse(searchBody(answer(new URL(request.url).searchParams.get('q') ?? ''))),
    );

  it('retries a lowercase DOI that missed with its uppercase form, once, and keeps the input as given', async () => {
    const { http } = installService([
      docRoute((q) => (q.includes(`"${DOI}"`) ? [collisionDatasetHit] : [])),
    ]);
    const { records, missing } = success(await run(lower));
    expect(missing).toEqual([]);
    expect(records[0]).toMatchObject({ id: '6004', matched_inputs: [lower] });
    const queries = queriesOf(http).map((params) => params.get('q'));
    expect(queries).toEqual([`doi:("${lower}")`, `doi:("${DOI}")`]);
  });

  it('sends only the missed DOIs, uppercased, in the retry', async () => {
    const { http } = installService([
      docRoute((q) =>
        q.includes(`"${DOI}"`)
          ? [collisionDatasetHit]
          : q.includes('recid:(101)')
            ? [softwareHit]
            : [],
      ),
    ]);
    const { records } = success(await run(['101', lower, 'doi:10.7483/opendata.cms.nope.0000']));
    expect(records.map((record) => record.id)).toEqual(['101', '6004']);
    const queries = queriesOf(http).map((params) => params.get('q'));
    expect(queries).toHaveLength(2);
    expect(queries[1]).toBe(`doi:("${DOI}" OR "10.7483/OPENDATA.CMS.NOPE.0000")`);
    expect(queries[1]).not.toContain('recid');
  });

  it('reports a DOI missing after both searches missed, naming both tries', async () => {
    const { http } = servePool([]);
    const { missing } = success(await run(lower));
    expect(http.calls).toHaveLength(2);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ input: lower, interpreted_as: 'doi' });
    expect(missing[0]?.guidance).toContain('(tried as given and uppercased)');
  });

  it('does not retry a DOI that is already uppercase', async () => {
    const { http } = servePool([]);
    await run('10.7483/OPENDATA.CMS.NOPE.0000');
    expect(http.calls).toHaveLength(1);
  });

  it('does not retry a lowercase DOI the first search resolved (matching ignores case)', async () => {
    const { http } = servePool([collisionDatasetHit]);
    const { records } = success(await run(lower));
    expect(records).toHaveLength(1);
    expect(http.calls).toHaveLength(1);
  });

  it('fails the call, never reporting the DOI missing, when the retry fails', async () => {
    vi.useFakeTimers();
    const { http } = installService([
      searchRoute((request) =>
        new URL(request.url).searchParams.get('q')?.includes(`"${DOI}"`)
          ? new Response('down', { status: 503 })
          : jsonResponse(emptySearchBody),
      ),
    ]);
    const settled = await settle(() => run(lower));
    if (!settled.ok) throw settled.error;
    expect(settled.value.isError).toBe(true);
    expect(errorOf(settled.value).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(settled.value.structuredContent).not.toHaveProperty('missing');
    expect(http.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('fails with upstream_unreadable when the retry answers an unreadable body', async () => {
    vi.useFakeTimers();
    installService([
      searchRoute((request) =>
        new URL(request.url).searchParams.get('q')?.includes(`"${DOI}"`)
          ? new Response(HTML_ERROR_PAGE, { status: 200 })
          : jsonResponse(emptySearchBody),
      ),
    ]);
    const settled = await settle(() => run(lower));
    if (!settled.ok) throw settled.error;
    expect(errorOf(settled.value).data).toMatchObject({ reason: 'upstream_unreadable' });
  });
});

describe('cern_opendata_get_records documentation bodies', () => {
  it('cuts a body over 30,000 characters, flags it, and says so in the notice', async () => {
    servePool([docHitWithBody('long-page', 30_001)]);
    const result = success(await run('long-page'));
    const [record] = result.records;
    expect(record?.body).toHaveLength(30_000);
    expect(record).toMatchObject({ body_truncated: true, body_length: 30_001 });
    expect(result.notice).toBe(
      'The body of long-page was cut at 30,000 of 30001 characters; read the full page at https://opendata.cern.ch/docs/long-page.',
    );
  });

  it('leaves a body of exactly 30,000 characters whole, with no notice', async () => {
    servePool([docHitWithBody('edge-page', 30_000)]);
    const result = success(await run('edge-page'));
    expect(result.records[0]?.body).toHaveLength(30_000);
    expect(result.records[0]).toMatchObject({ body_truncated: false, body_length: 30_000 });
    expect(result).not.toHaveProperty('notice');
  });

  it('joins one notice per cut body, and ignores the whole ones', async () => {
    servePool([
      docHitWithBody('long-a', 40_000),
      docHitWithBody('short-b', 10),
      docHitWithBody('long-c', 72_000),
    ]);
    const result = success(await run(['long-a', 'short-b', 'long-c']));
    expect(result.notice).toBe(
      'The body of long-a was cut at 30,000 of 40000 characters; read the full page at https://opendata.cern.ch/docs/long-a. ' +
        'The body of long-c was cut at 30,000 of 72000 characters; read the full page at https://opendata.cern.ch/docs/long-c.',
    );
  });

  it('never splits a surrogate pair at the cut', async () => {
    const body = `${'a'.repeat(29_999)}\u{1F600}tail`;
    servePool([
      hit('emoji-page', {
        slug: 'emoji-page',
        title: 'Emoji',
        type: { primary: 'Documentation' },
        body: { content: body, format: 'md' },
      }),
    ]);
    const [record] = success(await run('emoji-page')).records;
    expect(record?.body).toHaveLength(29_999);
    expect(record?.body_truncated).toBe(true);
  });

  it('renders the cut in the text and the text carries at most the capped body', async () => {
    servePool([docHitWithBody('long-page', 30_100)]);
    const text = textOf(await run('long-page'));
    expect(text).toContain('### Body (format md, 30100 characters, truncated at 30000 characters)');
    expect(text.length).toBeLessThan(31_000);
  });

  it('renders a whole body as not truncated', async () => {
    servePool([docHit]);
    expect(textOf(await run('cms-guide-docker'))).toContain(
      '### Body (format md, 56 characters, not truncated)',
    );
  });
});

describe('cern_opendata_get_records format', () => {
  async function recordText(pool: readonly RawHit[], ids: string | string[]) {
    servePool(pool);
    const result = await run(ids);
    return { data: success(result), text: textOf(result) };
  }

  it('renders every populated field of a rich record', async () => {
    const { data, text } = await recordText([richDatasetHit], '9001');
    const [record] = data.records as Record_[];
    for (const line of [
      '## Rich dataset /A/B/C',
      '**Also titled:** A descriptive secondary title',
      '**id:** 9001 · **kind:** record · **recid:** 9001',
      '**Matched inputs:** 9001',
      '**Type:** Dataset (Collision, Derived) · **Experiment:** CMS, ATLAS',
      '**Collaboration:** CMS Collaboration (recid 7000)',
      '**Authors:** Ada Lovelace (ORCID 0000-0002-1825-0097); Alan Turing',
      '**DOI:** 10.7483/OPENDATA.CMS.RICH.0001 · **Published:** 2024 · **Reprocessed:** 2025',
      '**Year:** 2011, 2012 · **Run period:** Run2011A, Run2012B · **Run numbers:** 160404, 160405',
      '**Collision energy:** 13TeV · **Collision type:** pp',
      '**Formats:** nanoaod, root · **Events:** 12345 · **Files:** 7 · **Size:** 999 bytes',
      '**Availability:** partial (online files: 5, on-demand files: 2)',
      '**Collections:** CMS-Primary-Datasets, Another-Collection',
      '**Software environment:** release CMSSW_10_6_30 · global tag 106X_dataRun2_v37 · container images cmsopendata/cmssw_10_6_30 (dockerhub) · environment recid 9003',
      '**Source code:** https://github.com/example/rich-source',
      '**Dataset semantics:** https://opendata.cern.ch/eos/opendata/cms/semantics/rich.html (HTML) · https://opendata.cern.ch/eos/opendata/cms/semantics/rich.json (JSON)',
      '**License:** CC0-1.0 (basis: cern_terms_default) CC0-1.0 under the CERN Open Data Terms of Use; the record states no license of its own.',
      '**Citation** (DOI 10.7483/OPENDATA.CMS.RICH.0001):',
      CITATION_REQUEST,
      '**Portal:** https://opendata.cern.ch/record/9001',
    ]) {
      expect(text, line).toContain(line);
    }
    expect(text).toContain(record?.citation?.text);
    expect(text).toContain('Environment description:\n```\nEnvironment notes.\n```');
  });

  it('renders the HTML sections as fenced text with link URLs kept', async () => {
    const { text } = await recordText([richDatasetHit], '9001');
    expect(text).toContain(
      '### Abstract\n```\nAbstract text with a guide <https://opendata.cern.ch/docs/cms-guide-docker>.\n```',
    );
    for (const [heading, body] of [
      ['Methodology', 'Method text.'],
      ['Usage', 'Usage text.'],
      ['Validation', 'Validation text.'],
      ['Note', 'Note text.'],
      ['Use with', 'Use with text.'],
    ]) {
      expect(text, heading).toContain(`### ${heading}\n\`\`\`\n${body}\n\`\`\``);
    }
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('<b>');
  });

  it('renders every link and relation', async () => {
    const { text } = await recordText([richDatasetHit], '9001');
    expect(text).toContain('### Links');
    expect(text).toContain('- [abstract] Validated runs, full validation — recid 1002');
    expect(text).toContain('- [note] Not available — recid 9002');
    expect(text).toContain(
      '- [usage] CMS Docker guide — https://opendata.cern.ch/docs/cms-guide-docker#intro',
    );
    expect(text).toContain('- [use_with] Not available — recid 6004');
    expect(text).toContain('- [software] Source — https://github.com/example/rich');
    expect(text).toContain('### Relations');
    expect(text).toContain(
      '- isRelatedTo: Related record (recid 9002, DOI 10.7483/OPENDATA.CMS.REL.0002) — Companion',
    );
  });

  it('renders a sparse record with Not available, never invented values', async () => {
    const { text } = await recordText([sparseHit], '1120');
    expect(text).toContain('## Sparse record');
    expect(text).toContain('**DOI:** Not available · **Published:** Not available');
    expect(text).toContain('**Year:** Not available · **Run period:** Not available');
    expect(text).toContain('**Type:** Software · **Experiment:** Not available');
    expect(text).toContain('**Availability:** Not available');
    expect(text).not.toMatch(/undefined|null|NaN/);
    expect(text).not.toContain('**Citation**');
    expect(text).not.toContain('### Links');
    expect(text).not.toContain('### Relations');
    expect(text).not.toContain('**Formats:**');
  });

  it('renders a distribution that states only some numbers with Not available for the rest', async () => {
    const { text } = await recordText(
      [
        hit('88', {
          recid: '88',
          title: 'Partial distribution',
          type: { primary: 'Dataset' },
          distribution: { formats: [] },
        }),
      ],
      '88',
    );
    expect(text).toContain(
      '**Formats:** Not available · **Events:** Not available · **Files:** Not available · **Size:** Not available',
    );
  });

  it('renders an environment image without a name dropped and one without a registry bare', async () => {
    const { text, data } = await recordText([environmentSystemHit], '12100');
    expect(data.records[0]?.system_details?.container_images).toEqual([
      { name: 'cmsopendata/cmssw_5_3_32', registry: 'dockerhub' },
      { name: 'cmsopendata/other' },
    ]);
    expect(text).toContain(
      'container images cmsopendata/cmssw_5_3_32 (dockerhub), cmsopendata/other · environment recid 12101',
    );
    expect(text).toContain('Environment description:\n```\nVM image\n```');
  });

  it('renders a doc with its fenced short description and body', async () => {
    const { text } = await recordText([docHit], 'cms-guide-docker');
    expect(text).toContain('**id:** cms-guide-docker · **kind:** doc · **slug:** cms-guide-docker');
    expect(text).toContain('**Tags:** docker, cmssw');
    expect(text).toContain(
      '### Short description\n```\nHow to run the CMS open data containers.\n```',
    );
    expect(text).toContain('```\n## <a name="intro">Introduction</a>\n\nRun `docker pull`.\n\n```');
    expect(text).toContain('**Portal:** https://opendata.cern.ch/docs/cms-guide-docker');
  });

  it('renders every matched input and every record, in order, separated by blank lines', async () => {
    const { text } = await recordText(
      [collisionDatasetHit, softwareHit],
      ['101', '6004', DOI, 'zzz!'],
    );
    expect(text.indexOf('## CMS analysis example')).toBeLessThan(text.indexOf(`## ${PATH}`));
    expect(text).toContain(`**Matched inputs:** 6004, ${DOI}`);
    expect(text).toContain('**Matched inputs:** 101');
    expect(text).toContain('## Missing');
    expect(text).toContain(
      '- zzz! (interpreted as unrecognized): Not a recid, DOI, CMS dataset path or documentation slug.',
    );
  });

  it('renders the all-missing result as an explicit statement plus the Missing list', async () => {
    const { text } = await recordText([], ['404']);
    expect(text.startsWith('No identifier resolved to a record.')).toBe(true);
    expect(text).toContain('- 404 (interpreted as recid): No record has recid 404.');
  });

  it('renders the Missing section only when something is missing', async () => {
    const { text } = await recordText([collisionDatasetHit], '6004');
    expect(text).not.toContain('## Missing');
    expect(text).not.toContain('No identifier resolved');
  });

  it('keeps CR/LF, markup and bidi controls in upstream text out of the inline slots', async () => {
    const RLO = String.fromCharCode(0x202e);
    const hostile = hit('666', {
      recid: '666',
      title: 'Evil\r\n# Injected\n- [x](http://evil.example) <img>',
      title_additional: 'Sub\ntitle | cell',
      type: { primary: 'Software', secondary: ['Sec\nondary'] },
      experiment: ['CMS\r\n## y'],
      collaboration: { name: 'Collab\noration', recid: '1\n2' },
      authors: [{ name: 'Mal\nlory', orcid: '0000-\n0001' }],
      doi: '10.7483/OPENDATA.EVIL\n.0001',
      date_published: '20\n24',
      run_period: [`Run${RLO}X`],
      collections: ['Coll\nection[1]'],
      links: [{ description: 'Link\n- injected', url: 'https://e.example/a b\n?q=[1]' }],
      relations: [
        { type: 'isRelatedTo\nx', recid: '5\n5', title: 'Rel\nated', description: 'Des\nc | x' },
      ],
      system_details: {
        release: 'CMSSW\n_1',
        global_tag: 'GT\n2',
        container_images: [{ name: 'img\nname', registry: 'reg\nistry' }],
        recid: '9\n9',
      },
      source_code_repository: { url: 'https://e.example/repo\nx' },
    });
    const { text } = await recordText([hostile], '666');
    const lines = text.split('\n');
    expect(lines[0]).toBe('## Evil  # Injected - \\[x\\](http://evil.example) &lt;img&gt;');
    const stray = lines.filter(
      (line) =>
        line.startsWith('# ') ||
        line.startsWith('- injected') ||
        line.startsWith('- [x]') ||
        (line.startsWith('## ') && !line.startsWith('## Evil')),
    );
    expect(stray).toEqual([]);
    expect(text).toContain('**Also titled:** Sub title \\| cell');
    expect(text).toContain('Collab oration (recid 1 2)');
    expect(text).toContain('Mal lory (ORCID 0000- 0001)');
    expect(text).toContain('**DOI:** 10.7483/OPENDATA.EVIL .0001 · **Published:** 20 24');
    expect(text).toContain('**Run period:** RunX');
    expect(text).toContain('**Collections:** Coll ection\\[1\\]');
    expect(text).toContain('- [software] Link - injected — https://e.example/a%20b%0A?q=%5B1%5D');
    expect(text).toContain('- isRelatedTo x: Rel ated (recid 5 5) — Des c \\| x');
    expect(text).toContain(
      'release CMSSW _1 · global tag GT 2 · container images img name (reg istry) · environment recid 9 9',
    );
    expect(text).toContain('**Source code:** https://e.example/repo%0Ax');
    expect(text).not.toMatch(new RegExp(`[\\r${RLO}]`));
  });

  it('keeps a hostile missing input on one line in the Missing list', async () => {
    const { text } = await recordText([], ['bad\n## Heading\n- [x](http://e.example)']);
    const missing = text.slice(text.indexOf('## Missing'));
    const lines = missing.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('bad ## Heading - \\[x\\](http://e.example) (interpreted as');
  });

  it('fences HTML and free text whose own backticks would close a short fence', async () => {
    const { text } = await recordText(
      [
        hit('55', {
          recid: '55',
          title: 'Fences',
          type: { primary: 'Software' },
          abstract: { description: '<p>```\n# not a heading\n```</p>' },
          short_description: { content: '````\nx\n````' },
        }),
      ],
      '55',
    );
    expect(text).toContain('### Abstract\n````\n``` # not a heading ```\n````');
    expect(text).toContain('### Short description\n`````\n````\nx\n````\n`````');
  });

  it('renders the same ids and DOIs that structuredContent carries', async () => {
    const { data, text } = await recordText(
      [collisionDatasetHit, softwareHit, docHit],
      ['6004', '101', 'cms-guide-docker'],
    );
    for (const record of data.records) {
      expect(text).toContain(`**id:** ${inline(record.id)}`);
      expect(text).toContain(`**Portal:** ${record.portal_url}`);
      if (record.doi) expect(text).toContain(inline(record.doi));
      if (record.citation) expect(text).toContain(record.citation.text);
      expect(text).toContain(`(basis: ${record.license.basis})`);
    }
  });
});

describe('cern_opendata_get_records errors on the wire', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('treats a 400 on the query the server built as an internal error, not a caller error', async () => {
    installService([searchRoute(() => jsonResponse(SYNTAX_ERROR_BODY, { status: 400 }))]);
    const settled = await settle(() => run('6004'));
    if (!settled.ok) throw settled.error;
    const error = errorOf(settled.value);
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toContain('rejected a query this server built');
    expect(error.data).toMatchObject({
      upstreamMessage: 'The syntax of the search query is invalid.',
    });
  });

  it('puts rate_limited and its retryAfter on the wire with the declared recovery', async () => {
    installService([
      searchRoute(() => new Response('', { status: 429, headers: { 'retry-after': '60' } })),
    ]);
    const settled = await settle(() => run('6004'));
    if (!settled.ok) throw settled.error;
    const error = errorOf(settled.value);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    expect(textOf(settled.value)).toContain('Recovery: Wait the retryAfter seconds');
    expect(textOf(settled.value)).toContain('call cern_opendata_get_records again');
  });
});
