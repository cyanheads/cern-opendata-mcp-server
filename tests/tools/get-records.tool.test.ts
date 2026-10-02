/**
 * @fileoverview Tests for cern_opendata_get_records: id parsing and mixed
 * identifier forms, the combined lookup query, matches in input order,
 * `missing` with guidance (unrecognized ids included), the uppercase-DOI retry,
 * license and citation in every record, doc-body slices read on with
 * `body_offset` and their notice, the variable dictionary, category, pile-up
 * and LHCb fields, the 64,000-byte response budget and its `deferred` list,
 * sparse payloads, the text twin of structuredContent, and errors on the wire.
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
  METHODOLOGY_5202_HTML,
  METHODOLOGY_5208_HTML,
  newsHit,
  portalRoute,
  prefixedDatasetHit,
  richDatasetHit,
  SYNTAX_ERROR_BODY,
  searchBody,
  selectionCutHits,
  softwareHit,
  sparseHit,
} from '../fixtures/cern-opendata-upstream.js';
import {
  anchorVariablesHit12102,
  categoryOnlyPrimaryHit88449,
  entityVariablesHit15009,
  largeVariablesHit12320,
  lhcbHit28004,
  pileupHit67817,
  pileupNoLinksHit30595,
  strippingDocHit,
  typelessVariablesHit4803,
  unitsHit84000,
  variablesHit12220,
} from '../fixtures/record-metadata-upstream.js';

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

  it('declares the two shared service errors and invalid_body_offset, naming the tool in each recovery', () => {
    expect(getRecords.errors?.map((entry) => entry.reason)).toEqual([
      'invalid_body_offset',
      'rate_limited',
      'upstream_unreadable',
    ]);
    expect(getRecords.errors?.[0]).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
    });
    expect(getRecords.errors?.[0]).not.toHaveProperty('thrownBy');
    expect(getRecords.errors?.[1]).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
    });
    expect(getRecords.errors?.[2]).toMatchObject({
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

  it('resolves a numeric and a prefixed recid from one search, prefixed spellings included', async () => {
    const { http } = servePool([collisionDatasetHit, prefixedDatasetHit]);
    const result = await run([
      '6004',
      'atlas-160006',
      'https://opendata.cern.ch/record/ATLAS-160006',
    ]);
    const { records, missing } = success(result);
    expect(http.calls).toHaveLength(1);
    expect(queriesOf(http)[0]?.get('q')).toBe('recid:(6004 OR atlas-160006 OR atlas-160006)');
    expect(missing).toEqual([]);
    expect(records.map((record) => [record.recid, record.matched_inputs])).toEqual([
      ['6004', ['6004']],
      ['atlas-160006', ['atlas-160006', 'https://opendata.cern.ch/record/ATLAS-160006']],
    ]);
    expect(records[1]).toMatchObject({
      id: 'atlas-160006',
      portal_url: 'https://opendata.cern.ch/record/atlas-160006',
      citation: { doi: '10.7483/OPENDATA.ATLAS.XEVX.LJJ2' },
    });
    expect(textOf(result)).toContain(
      '**id:** atlas-160006 · **kind:** record · **recid:** atlas-160006',
    );
  });

  it('reports a prefixed recid that no record has as a missing recid, not a doc slug', async () => {
    servePool([]);
    const { missing } = success(await run(['cms-99999']));
    expect(missing).toEqual([
      {
        input: 'cms-99999',
        interpreted_as: 'recid',
        guidance:
          "No record has recid cms-99999. Call cern_opendata_search_records with a title keyword to find the record's recid.",
      },
    ]);
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

  it("credits the authors of a record that names no collaboration, as the portal's Cite as does", async () => {
    const authored = hit(101, {
      recid: '101',
      title: 'Two-lepton/four-lepton analysis example of CMS 2010 open data',
      type: { primary: 'Software', secondary: ['Analysis'] },
      collaboration: null,
      authors: [{ name: 'Rodriguez Marrero, Ana', orcid: '0000-0002-7145-630X' }],
      date_published: '2014',
      doi: '10.7483/OPENDATA.CMS.QXY9.X47P',
      license: { attribution: 'GPL-3.0-only' },
    });
    servePool([authored]);
    const [record] = success(await run('101')).records;
    expect(record?.citation?.text).toBe(
      'Rodriguez Marrero, Ana; (2014). Two-lepton/four-lepton analysis example of CMS 2010 open data. CERN Open Data Portal. DOI:10.7483/OPENDATA.CMS.QXY9.X47P',
    );
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
          'No record carries DOI 10.7483/OPENDATA.NOPE.0000 (tried as given and uppercased). Call cern_opendata_search_records with a title keyword to find the record; portal DOIs look like 10.7483/OPENDATA.{EXPERIMENT}.XXXX.XXXX.',
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
  it('cuts a body over 30,000 characters, flags it, and names the call that continues it', async () => {
    servePool([docHitWithBody('long-page', 30_001)]);
    const result = success(await run('long-page'));
    const [record] = result.records;
    expect(record?.body).toHaveLength(30_000);
    expect(record).toMatchObject({
      body_truncated: true,
      body_length: 30_001,
      body_offset: 0,
      body_next_offset: 30_000,
    });
    expect(result.notice).toBe(
      'The body of long-page was cut at character 30000 of 30001; call cern_opendata_get_records with ids ["long-page"] and body_offset 30000 to continue it.',
    );
  });

  it('leaves a body of exactly 30,000 characters whole, with no notice', async () => {
    servePool([docHitWithBody('edge-page', 30_000)]);
    const result = success(await run('edge-page'));
    expect(result.records[0]?.body).toHaveLength(30_000);
    expect(result.records[0]).toMatchObject({
      body_truncated: false,
      body_length: 30_000,
      body_offset: 0,
    });
    expect(result.records[0]).not.toHaveProperty('body_next_offset');
    expect(result).not.toHaveProperty('notice');
  });

  it('joins one notice per cut body, and ignores the whole ones', async () => {
    servePool([
      docHitWithBody('long-a', 40_000),
      docHitWithBody('short-b', 10),
      docHitWithBody('long-c', 72_000),
    ]);
    const result = success(await run(['long-a', 'short-b', 'long-c']));
    expect(result.deferred).toEqual([]);
    expect(result.notice).toBe(
      'The body of long-a was cut at character 30000 of 40000; call cern_opendata_get_records with ids ["long-a"] and body_offset 30000 to continue it. ' +
        'The body of long-c was cut at character 30000 of 72000; call cern_opendata_get_records with ids ["long-c"] and body_offset 30000 to continue it.',
    );
  });

  it('escapes the slug and prints the portal URL in the cut notice', async () => {
    servePool([
      hit('777', {
        recid: '777',
        slug: 'x](https://evil.example) <img src=y>',
        title: 'Odd slug',
        type: { primary: 'Documentation' },
        body: { content: 'x'.repeat(30_001), format: 'md' },
      }),
    ]);
    const result = success(await run('777'));
    expect(result.records[0]?.slug).toBe('x](https://evil.example) <img src=y>');
    expect(result.notice).toBe(
      'The body of x\\](https://evil.example) &lt;img src=y&gt; was cut at character 30000 of 30001; call cern_opendata_get_records with ids ["x\\](https://evil.example) &lt;img src=y&gt;"] and body_offset 30000 to continue it.',
    );
    expect(result.notice).not.toMatch(/(?<!\\)\]\(/);
    expect(result.notice).not.toContain('<img');
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
    expect(text).toContain(
      '### Body (format md, 30100 characters, from body_offset 0, cut at character 30000; continue with body_offset 30000)',
    );
    expect(text.length).toBeLessThan(31_000);
  });

  it('renders a whole body as read to the end', async () => {
    servePool([docHit]);
    expect(textOf(await run('cms-guide-docker'))).toContain(
      '### Body (format md, 56 characters, from body_offset 0 to the end)',
    );
  });

  it('renders a one-character body in the singular', async () => {
    servePool([docHitWithBody('one-char', 1)]);
    expect(textOf(await run('one-char'))).toContain(
      '### Body (format md, 1 character, from body_offset 0 to the end)',
    );
  });
});

describe('cern_opendata_get_records format', () => {
  async function recordText(pool: readonly RawHit[], ids: string | string[]) {
    servePool(pool);
    const result = await run(ids);
    return { data: success(result), text: textOf(result) };
  }

  it('renders a one-byte size in the singular', async () => {
    const tiny = hit(9100, { recid: '9100', title: 'Tiny', distribution: { size: 1 } });
    const { text } = await recordText([tiny], '9100');
    expect(text).toContain('**Size:** 1 byte');
    expect(text).not.toContain('1 bytes');
  });

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

  it('renders selection cuts written with a bare < or > in full, and keeps the HTML as received', async () => {
    const { data, text } = await recordText(selectionCutHits, ['5202', '5208']);
    for (const cut of [
      'both with |eta| < 2.4, at least one muon was a global muon, the invariant mass of the two muons was > 0.3 GeV and < 300 GeV, and they have opposite-sign charge.',
      'with pT > 20 GeV and |eta| < 2.1 and the invariant mass of the two muons was > 60 GeV and < 120 GeV.',
    ]) {
      expect(text, cut).toContain(cut);
    }
    expect(data.records.map((record) => record.methodology_html)).toEqual([
      METHODOLOGY_5202_HTML,
      METHODOLOGY_5208_HTML,
    ]);
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

  it('renders the secondary types structuredContent carries when the record states no primary type', async () => {
    const { data, text } = await recordText(
      [hit('6004', { recid: '6004', title: 'T', type: { secondary: ['Collision', 'Derived'] } })],
      '6004',
    );
    const { type } = data.records[0] ?? {};
    expect(type).toEqual({ primary: '', secondary: ['Collision', 'Derived'] });
    expect(text).toContain(
      `**Type:** Not available (${type?.secondary.join(', ')}) · **Experiment:** Not available`,
    );
  });

  it('renders a type with no secondaries as the primary alone, and no type at all as Not available', async () => {
    const { text } = await recordText(
      [
        hit('6005', { recid: '6005', title: 'P', type: { primary: 'Dataset' } }),
        hit('6006', { recid: '6006', title: 'None' }),
      ],
      ['6005', '6006'],
    );
    expect(text).toContain('**Type:** Dataset · **Experiment:**');
    expect(text).toContain('**Type:** Not available · **Experiment:**');
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

describe('cern_opendata_get_records variables, category, pile-up and LHCb fields', () => {
  async function recordText(pool: readonly RawHit[], ids: string | string[]) {
    servePool(pool);
    const result = await run(ids);
    return { data: success(result), text: textOf(result) };
  }

  it('returns the variable dictionary and renders it as a table with the Type column', async () => {
    const { data, text } = await recordText([variablesHit12220], '12220');
    const [record] = data.records;
    expect(record?.variables).toHaveLength(87);
    expect(record?.variables?.[0]).toEqual({
      variable: 'hit_global_x',
      type: 'std::vector<float>',
      description_html: 'global x position of the RecHit',
    });
    expect(record?.keywords).toEqual(['datascience']);
    expect(text).toContain(
      '### Variables\n| Variable | Type | Description |\n|:--|:--|:--|\n| hit_global_x | std::vector&lt;float&gt; | global x position of the RecHit |',
    );
    expect(text).toContain('**Keywords:** datascience');
    for (const variable of record?.variables ?? [])
      expect(text).toContain(`| ${variable.variable} |`);
  });

  it('adds the Unit column only when an entry carries a unit', async () => {
    const { text } = await recordText([unitsHit84000], '84000');
    expect(text).toContain('| Variable | Type | Unit | Description |\n|:--|:--|:--|:--|');
    expect(text).toContain(
      '| track_rp_*_x | double | Milimeters | x coordinate of the hit in the Roman Pot number *, equals 0 if valid flag is flase |',
    );
  });

  it('renders an untyped dictionary with the Variable and Description columns only', async () => {
    const { text } = await recordText([typelessVariablesHit4803], '4803');
    expect(text).toContain('| Variable | Description |\n|:--|:--|');
    expect(text).toContain(
      '| amplL | PMT amplitude measured from the "left" side of a scintillator strip (in photo-electrons) |',
    );
  });

  it('fills a cell an entry lacks with Not available when its column is shown', async () => {
    const mixed = hit(9200, {
      recid: '9200',
      title: 'Mixed dictionary',
      dataset_semantics: [
        { variable: 'pt', type: 'float', unit: 'GeV', description: 'Transverse momentum' },
        { variable: 'n' },
      ],
    });
    const { text } = await recordText([mixed], '9200');
    expect(text).toContain('| pt | float | GeV | Transverse momentum |');
    expect(text).toContain('| n | Not available | Not available | Not available |');
  });

  it('renders a description link as text with its URL, neutralized in the cell, and keeps the HTML', async () => {
    const { data, text } = await recordText(
      [anchorVariablesHit12102, entityVariablesHit15009],
      ['12102', '15009'],
    );
    expect(
      data.records[0]?.variables?.find((variable) => variable.variable === 'fj_doubleb')
        ?.description_html,
    ).toContain('<a href="http://cms-results.web.cern.ch/');
    expect(text).toContain(
      '| fj_doubleb | Float_t | Double-b tagging discriminant based on a boosted decision tree calculated for the AK8 jet (see CMS-BTV-16-002 &lt;http://cms-results.web.cern.ch/cms-results/public-results/publications/BTV-16-002/&gt;) |',
    );
    expect(text).toContain('Pixel&lt;5e17&lt;SCT&lt;3e18&lt;LAr&lt;4.8e18&lt;Tile.');
  });

  it('keeps line breaks, pipes and markup in a variable entry inside its table cell', async () => {
    const hostile = hit(9201, {
      recid: '9201',
      title: 'Hostile dictionary',
      dataset_semantics: [
        {
          variable: 'a|b\n## injected',
          type: 'x]](javascript:y)',
          description: '<p>first</p><p>second | third</p>\n# heading',
        },
      ],
    });
    const { text } = await recordText([hostile], '9201');
    expect(text).toContain(
      '| a\\|b ## injected | x\\]\\](javascript:y) | first  second \\| third # heading |',
    );
    expect(text).not.toContain('\n## injected');
  });

  it('returns the physics category and pile-up, with pile-up links under Links', async () => {
    const { data, text } = await recordText([pileupHit67817], '67817');
    const [record] = data.records;
    expect(record?.category).toEqual({
      primary: 'Standard Model Physics',
      secondary: ['Top physics'],
      source: 'CMS Collaboration',
    });
    expect(record?.pileup_html).toContain('<a href="/docs/cms-guide-pileup-simulation">');
    expect(record?.links).toContainEqual({
      source: 'pileup',
      recid: '30595',
      description:
        '/Neutrino_E-10_gun/RunIISummer20ULPrePremix-UL16_106X_mcRun2_asymptotic_v13-v1/PREMIX',
    });
    expect(text).toContain(
      '**Category:** Standard Model Physics (Top physics) · **Category source:** CMS Collaboration',
    );
    expect(text).toContain(
      '### Pile-up\n```\nTo make these simulated data comparable with the collision data, pile-up events <https://opendata.cern.ch/docs/cms-guide-pileup-simulation> are added to the simulated event in the DIGI2RAW step.\n```',
    );
    expect(text).toContain(
      '- [pileup] /Neutrino_E-10_gun/RunIISummer20ULPrePremix-UL16_106X_mcRun2_asymptotic_v13-v1/PREMIX — recid 30595',
    );
  });

  it('renders a category with no secondary or source, and pile-up with no links', async () => {
    const { data, text } = await recordText(
      [pileupNoLinksHit30595, categoryOnlyPrimaryHit88449],
      ['30595', '88449'],
    );
    expect(data.records.map((record) => record.category)).toEqual([
      { primary: 'Pileup', secondary: [], source: 'CMS Collaboration' },
      { primary: 'Higgs', secondary: [] },
    ]);
    expect(text).toContain('**Category:** Pileup · **Category source:** CMS Collaboration');
    expect(text).toContain('**Category:** Higgs\n');
    expect(text).toContain('### Pile-up');
    expect(text).not.toContain('[pileup]');
  });

  it('quotes a category spelled with edge whitespace, as stored', async () => {
    const heavyIon = hit(9202, {
      recid: '9202',
      title: 'Heavy-ion dataset',
      categories: { primary: ' Heavy-Ion Physics', source: 'CMS Collaboration' },
    });
    const { data, text } = await recordText([heavyIon], '9202');
    expect(data.records[0]?.category?.primary).toBe(' Heavy-Ion Physics');
    expect(text).toContain('**Category:** " Heavy-Ion Physics"');
  });

  it('quotes a secondary category holding a comma, so it reads as one value', async () => {
    const exotica = hit(9203, {
      recid: '9203',
      title: 'Heavy-fermion simulation',
      categories: {
        primary: 'Exotica',
        secondary: ['Heavy Fermions, Heavy Righ-Handed Neutrinos', 'Dark Matter'],
      },
    });
    const { text } = await recordText([exotica], '9203');
    expect(text).toContain(
      '**Category:** Exotica ("Heavy Fermions, Heavy Righ-Handed Neutrinos", Dark Matter)',
    );
  });

  it('returns and renders the LHCb magnet polarity and stripping of a dataset and a stripping page', async () => {
    const { data, text } = await recordText(
      [lhcbHit28004, strippingDocHit],
      ['28004', 'stripping21-bhadron-b02dhhwsd2hhhhwsbeauty2charmline'],
    );
    expect(
      data.records.map(({ magnet_polarity, stripping }) => ({ magnet_polarity, stripping })),
    ).toEqual([
      { magnet_polarity: 'MagDown', stripping: { stream: 'DIMUON', version: 'stripping21r1' } },
      { magnet_polarity: undefined, stripping: { stream: 'BHADRON', version: 'stripping21' } },
    ]);
    expect(text).toContain(
      '**Magnet polarity:** MagDown · **Stripping:** stream DIMUON, version stripping21r1',
    );
    expect(text).toContain('**Stripping:** stream BHADRON, version stripping21');
    const partial = hit(9203, { recid: '9203', title: 'Partial', stripping: { version: 's20' } });
    expect((await recordText([partial], '9203')).text).toContain(
      '**Stripping:** stream Not available, version s20',
    );
  });

  it('renders a record that carries none of these keys without any of their labels', async () => {
    const { text } = await recordText(
      [richDatasetHit, sparseHit, collisionDatasetHit, docHit, newsHit, softwareHit],
      ['9001', '1120', '6004', 'cms-guide-docker', 'cms-releases-2026', '101'],
    );
    for (const label of [
      '### Variables',
      '### Pile-up',
      '[pileup]',
      '**Category',
      '**Keywords:**',
      '**Magnet polarity:**',
      '**Stripping:**',
    ]) {
      expect(text, label).not.toContain(label);
    }
  });
});

const BUDGET = 64_000;
const deferralNotice = (n: number) =>
  n === 1
    ? 'The response reached its 64,000-byte budget, so 1 record was deferred; call cern_opendata_get_records with ids set to the deferred list to fetch it.'
    : `The response reached its 64,000-byte budget, so ${n} records were deferred; call cern_opendata_get_records with ids set to the deferred list to fetch them.`;

/** UTF-8 bytes of each surface the caller receives: structuredContent JSON and every content[] text block. */
function surfaces(result: ContractResult) {
  return {
    json: Buffer.byteLength(JSON.stringify(result.structuredContent)),
    text: Buffer.byteLength(
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
    ),
  };
}

const runArgs = (args: { body_offset?: unknown; ids: unknown }) =>
  runToolContract(getRecords, args as never);

describe('cern_opendata_get_records response budget', () => {
  const pool = [
    variablesHit12220,
    largeVariablesHit12320,
    unitsHit84000,
    pileupHit67817,
    lhcbHit28004,
    collisionDatasetHit,
    docHit,
  ];

  it('returns every record under the budget, with deferred [] and body_offset 0 on docs', async () => {
    servePool(pool);
    const result = success(await run(['6004', 'cms-guide-docker', '28004']));
    expect(result.records.map((record) => record.id)).toEqual([
      '6004',
      'cms-guide-docker',
      '28004',
    ]);
    expect(result.deferred).toEqual([]);
    expect(result.records[1]).toMatchObject({ body_offset: 0, body_truncated: false });
    expect(result.records[0]).not.toHaveProperty('body_offset');
    expect(result).not.toHaveProperty('notice');
  });

  it('stops at the first record that would cross the budget, deferring it and every record after it', async () => {
    servePool(pool);
    const both = await run(['12220', '84000']);
    expect(success(both).deferred).toEqual([]);
    expect(surfaces(both).json).toBeLessThan(BUDGET);

    const result = await run(['12220', '12320', '84000']);
    const data = success(result);
    expect(data.records.map((record) => record.id)).toEqual(['12220']);
    expect(data.deferred).toEqual(['12320', '84000']);
    expect(data.notice).toBe(deferralNotice(2));
    expect(surfaces(result).json).toBeLessThanOrEqual(BUDGET);
    expect(surfaces(result).text).toBeLessThanOrEqual(BUDGET);
  });

  it('returns the first record whole even alone over the budget, and nothing after it', async () => {
    servePool(pool);
    const result = await run(['12320', '84000']);
    const data = success(result);
    expect(data.records.map((record) => record.id)).toEqual(['12320']);
    expect(data.records[0]?.variables).toHaveLength(622);
    expect(data.deferred).toEqual(['84000']);
    expect(data.notice).toBe(deferralNotice(1));
    expect(surfaces(result).json).toBeGreaterThan(BUDGET);
    expect(textOf(result)).toContain('## Deferred\n- 84000');
  });

  it('lists every input of a deferred record in input order, and keeps misses under missing', async () => {
    servePool(pool);
    const data = success(
      await run(['12220', '12320', 'no-such-page', '84000', 'recid:12320', '012220']),
    );
    expect(data.records.map((record) => record.id)).toEqual(['12220']);
    expect(data.records[0]?.matched_inputs).toEqual(['12220', '012220']);
    expect(data.deferred).toEqual(['12320', '84000', 'recid:12320']);
    expect(data.missing.map((entry) => entry.input)).toEqual(['no-such-page']);
  });

  it('returns the deferred records when the deferred list is passed back as ids, budgeted again', async () => {
    servePool(pool);
    const first = success(await run(['12220', '12320', '84000']));
    expect(first.deferred).toEqual(['12320', '84000']);
    const second = success(await run(first.deferred));
    expect(second.records.map((record) => record.id)).toEqual(['12320']);
    expect(second.deferred).toEqual(['84000']);
    const third = success(await run(second.deferred));
    expect(third.records.map((record) => record.id)).toEqual(['84000']);
    expect(third.deferred).toEqual([]);
    expect(third).not.toHaveProperty('notice');
  });

  it('puts the body cut and the deferral in one notice, for admitted records only', async () => {
    servePool([...pool, docHitWithBody('cut-a', 40_000), docHitWithBody('cut-b', 40_000)]);
    const data = success(await run(['cut-a', '12320', 'cut-b']));
    expect(data.records.map((record) => record.id)).toEqual(['cut-a']);
    expect(data.deferred).toEqual(['12320', 'cut-b']);
    expect(data.notice).toBe(
      `The body of cut-a was cut at character 30000 of 40000; call cern_opendata_get_records with ids ["cut-a"] and body_offset 30000 to continue it. ${deferralNotice(2)}`,
    );
  });

  it('holds both assembled surfaces to 64,000 bytes, notice included, across a sweep over the edge', async () => {
    const outcomes = new Set<number>();
    for (let fill = 1_000; fill <= 4_000; fill += 37) {
      disposeInstalledService();
      servePool([
        docHitWithBody('cut-a', 40_000),
        docHitWithBody('cut-b', 40_000),
        docHitWithBody('fill', fill),
      ]);
      const result = await run(['cut-a', 'cut-b', 'no-such-page', 'fill']);
      const data = success(result);
      const { json, text } = surfaces(result);
      expect(json, `fill ${fill}`).toBeLessThanOrEqual(BUDGET);
      expect(text, `fill ${fill}`).toBeLessThanOrEqual(BUDGET);
      expect(data.records.slice(0, 2).map((record) => record.id)).toEqual(['cut-a', 'cut-b']);
      expect(data.deferred).toEqual(data.records.length === 3 ? [] : ['fill']);
      outcomes.add(data.records.length);
    }
    expect([...outcomes].sort()).toEqual([2, 3]);
  });

  it('holds a 20-id batch of long pages and #13 records to the budget, deferring a tail in input order', async () => {
    const pages = Array.from({ length: 14 }, (_, i) =>
      docHitWithBody(`stripping-line-${i}-page`, 47_000),
    );
    servePool([...pool, ...pages]);
    const ids = [
      ...pages.map((page) => String(page.id)),
      '12220',
      '84000',
      '67817',
      '28004',
      '6004',
      'cms-guide-docker',
    ];
    const result = await run(ids);
    const data = success(result);
    expect(surfaces(result).json).toBeLessThanOrEqual(BUDGET);
    expect(surfaces(result).text).toBeLessThanOrEqual(BUDGET);
    const returned = data.records.map((record) => record.id);
    expect(returned).toEqual(ids.slice(0, returned.length));
    expect(data.deferred).toEqual(ids.slice(returned.length));
    expect(data.notice).toContain(deferralNotice(ids.length - returned.length));
  });
});

describe('cern_opendata_get_records body_offset', () => {
  it('continues a body from body_offset with one id, echoing the offset', async () => {
    servePool([docHitWithBody('long', 70_000)]);
    const data = success(await runArgs({ ids: ['long'], body_offset: 30_000 }));
    expect(data.records[0]).toMatchObject({
      body_offset: 30_000,
      body_next_offset: 60_000,
      body_length: 70_000,
      body_truncated: true,
    });
    expect(data.records[0]?.body).toHaveLength(30_000);
    expect(data.notice).toBe(
      'The body of long was cut at character 60000 of 70000; call cern_opendata_get_records with ids ["long"] and body_offset 60000 to continue it.',
    );
  });

  it('rebuilds the portal body exactly by following body_next_offset, surrogate pairs on the boundaries', async () => {
    const pair = '\u{1F600}';
    const body = `${'a'.repeat(29_999)}${pair}${'b'.repeat(29_998)}${pair}${pair}${'c'.repeat(5_000)}`;
    servePool([
      hit('emoji-guide', {
        slug: 'emoji-guide',
        title: 'Emoji guide',
        type: { primary: 'Documentation' },
        body: { content: body, format: 'md' },
      }),
    ]);
    const slices: string[] = [];
    let offset: number | undefined = 0;
    let calls = 0;
    while (offset !== undefined) {
      const data = success(await runArgs({ ids: ['emoji-guide'], body_offset: offset }));
      calls += 1;
      const [record] = data.records;
      expect(record?.body_offset).toBe(offset);
      slices.push(record?.body ?? '');
      offset = record?.body_next_offset;
      if (offset !== undefined)
        expect(data.notice).toContain(`and body_offset ${offset} to continue it.`);
      else expect(data).not.toHaveProperty('notice');
    }
    expect(calls).toBe(3);
    expect(slices.join('')).toBe(body);
  });

  it('echoes an offset on the second half of a surrogate pair as one less', async () => {
    servePool([
      hit('pair-page', {
        slug: 'pair-page',
        type: { primary: 'Documentation' },
        body: { content: `ab\u{1F600}cd`, format: 'md' },
      }),
    ]);
    const data = success(await runArgs({ ids: ['pair-page'], body_offset: 3 }));
    expect(data.records[0]).toMatchObject({ body: '\u{1F600}cd', body_offset: 2 });
  });

  it('fails invalid_body_offset before any request when a positive offset rides beside two ids', async () => {
    const { http } = servePool([docHit, collisionDatasetHit]);
    const error = errorOf(await runArgs({ ids: ['cms-guide-docker', '6004'], body_offset: 5 }));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'invalid_body_offset' });
    expect(error.message).toBe(
      'body_offset 5 continues one body, so it takes exactly one id; 2 ids were given.',
    );
    expect(http.calls).toHaveLength(0);
  });

  it('accepts body_offset 0 with any number of ids', async () => {
    servePool([docHit, collisionDatasetHit]);
    const data = success(await runArgs({ ids: ['cms-guide-docker', '6004'], body_offset: 0 }));
    expect(data.records.map((record) => record.id)).toEqual(['cms-guide-docker', '6004']);
  });

  it('fails invalid_body_offset after the lookup for an offset at or past the body length', async () => {
    const { http } = servePool([docHitWithBody('short-page', 100)]);
    const error = errorOf(await runArgs({ ids: ['short-page'], body_offset: 100 }));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'invalid_body_offset' });
    expect(error.message).toBe(
      'body_offset 100 is at or past the end of the body of short-page, which is 100 characters long.',
    );
    expect(http.calls).toHaveLength(1);
    const last = success(await runArgs({ ids: ['short-page'], body_offset: 99 }));
    expect(last.records[0]).toMatchObject({ body: 'x', body_offset: 99, body_truncated: false });
  });

  it('fails invalid_body_offset for a record with no body, stating its absence', async () => {
    servePool([collisionDatasetHit]);
    const error = errorOf(await runArgs({ ids: ['6004'], body_offset: 10 }));
    expect(error.data).toMatchObject({ reason: 'invalid_body_offset' });
    expect(error.message).toBe(
      'body_offset 10 needs a documentation or news body, and 6004 has none.',
    );
  });

  it('reports an unresolved id under missing, not as an error, whatever the offset', async () => {
    servePool([docHit]);
    const data = success(await runArgs({ ids: ['no-such-page'], body_offset: 10 }));
    expect(data.records).toEqual([]);
    expect(data.missing.map((entry) => entry.input)).toEqual(['no-such-page']);
  });

  it('rejects a negative or fractional offset at the schema and treats a blank one as 0', async () => {
    servePool([docHit]);
    for (const body_offset of [-1, 1.5, '3']) {
      expect(errorOf(await runArgs({ ids: ['cms-guide-docker'], body_offset })).code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
    }
    const blank = success(await runArgs({ ids: ['cms-guide-docker'], body_offset: '' }));
    expect(blank.records[0]?.body_offset).toBe(0);
  });

  it('renders the slice position and the continuation offset in the body heading', async () => {
    servePool([docHitWithBody('long', 70_000)]);
    const middle = textOf(await runArgs({ ids: ['long'], body_offset: 30_000 }));
    expect(middle).toContain(
      '### Body (format md, 70000 characters, from body_offset 30000, cut at character 60000; continue with body_offset 60000)',
    );
    const last = textOf(await runArgs({ ids: ['long'], body_offset: 60_000 }));
    expect(last).toContain(
      '### Body (format md, 70000 characters, from body_offset 60000 to the end)',
    );
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
