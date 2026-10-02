/**
 * @fileoverview Tests for cern_opendata_list_files: recid and index input
 * handling (the `.txt` to `.json` key rewrite), record and index scope, index
 * reads beside the record search and their cache, keyless index members,
 * paging with opaque cursors, umbrella-only `children`, every declared error on
 * the wire, required enrichment on zero-result, under-cap and truncated pages,
 * the manifest cache, and the text twin of structuredContent.
 * @module tests/tools/list-files.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listFiles } from '@/mcp-server/tools/definitions/list-files.tool.js';
import {
  type ContractResult,
  dataOf,
  disposeInstalledService,
  errorOf,
  fakeClock,
  installService,
  textOf,
} from '../fixtures/cern-opendata-harness.js';
import {
  fileIndex,
  fileIndexRoute,
  filesRecordBody,
  indexedRecordBody,
  indexFile,
  jetSet2RecordBody,
  jsonResponse,
  NOT_FOUND_BODY,
  nanoaodRecordBody,
  portalRoute,
  prefixedRecordBody,
  type RecordBody,
  recordBody,
  recordSearchRoute,
  regularFiles,
  umbrellaRecordBody,
} from '../fixtures/cern-opendata-upstream.js';

type Output = Awaited<ReturnType<typeof listFiles.handler>>;
type Result = Output & {
  cap: number;
  notice?: string;
  shown: number;
  totalCount: number;
  truncated: boolean;
};

/** `/api/records/{recid}` answers from `bodies`, 404 for any other recid. */
function recordRoute(bodies: Readonly<Record<string, RecordBody>>) {
  return portalRoute(/^\/api\/records\/[^/]+$/, (request) => {
    const recid = new URL(request.url).pathname.split('/').pop() ?? '';
    const body = bodies[recid];
    return body === undefined ? jsonResponse(NOT_FOUND_BODY, { status: 404 }) : jsonResponse(body);
  });
}

const BODIES: Readonly<Record<string, RecordBody>> = {
  '6004': filesRecordBody,
  '24464': indexedRecordBody,
  '80020': umbrellaRecordBody,
  '30518': nanoaodRecordBody,
  'atlas-160006': prefixedRecordBody,
};

/**
 * The portal serving `bodies` on every read the tool makes: the record GET
 * (record scope), and the per-index route with the record's `q=recid:` search
 * (index scope without a cached manifest).
 */
const serve = (
  bodies: Readonly<Record<string, RecordBody>> = BODIES,
  options?: Parameters<typeof installService>[1],
) =>
  installService([recordRoute(bodies), fileIndexRoute(bodies), recordSearchRoute(bodies)], options);

/** Each request as path plus query, sorted (the index read and the search run in parallel). */
const requestPaths = (http: ReturnType<typeof serve>['http']) =>
  http.calls
    .map((call) => {
      const url = new URL(call.request.url);
      return `${url.pathname}${url.search}`;
    })
    .sort();

const run = (input: Parameters<typeof runToolContract<typeof listFiles>>[1]) =>
  runToolContract(listFiles, input);

const success = (result: ContractResult) => dataOf<Result>(result);

const cursorOf = (value: unknown) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString(
    'base64url',
  );

afterEach(() => {
  disposeInstalledService();
});

describe('cern_opendata_list_files registration', () => {
  it('is registered, read-only, idempotent and open-world', () => {
    expect(allToolDefinitions).toContain(listFiles);
    expect(listFiles.name).toBe('cern_opendata_list_files');
    expect(listFiles.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('declares the five error reasons with the right codes', () => {
    const byReason = Object.fromEntries(
      (listFiles.errors ?? []).map((entry) => [entry.reason, entry]),
    );
    expect(Object.keys(byReason).sort()).toEqual([
      'index_not_found',
      'invalid_cursor',
      'rate_limited',
      'record_not_found',
      'upstream_unreadable',
    ]);
    expect(byReason.record_not_found?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(byReason.index_not_found?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(byReason.invalid_cursor?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(byReason.rate_limited).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
    });
    expect(byReason.upstream_unreadable).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
    });
    for (const reason of ['record_not_found', 'index_not_found', 'invalid_cursor']) {
      expect((byReason[reason] as { severity?: string } | undefined)?.severity, reason).toBe(
        'notice',
      );
    }
  });

  it('describes every case in which a file has no https_url, the empty segment included', () => {
    const files = z.toJSONSchema(listFiles.output, { unrepresentable: 'any' }).properties?.files;
    const file = typeof files === 'object' ? files.items : undefined;
    const httpsUrl =
      file && typeof file === 'object' && !Array.isArray(file)
        ? file.properties?.https_url
        : undefined;
    expect(typeof httpsUrl === 'object' ? httpsUrl.description : undefined).toBe(
      "HTTPS download URL on the portal: the record's files route for a keyed file, the /eos/opendata/ route for a keyless one. Absent when a keyless file's XRootD URI is not a file path under eospublic.cern.ch/eos/opendata/, or when the key or path holds a lone surrogate or an empty, . or .. segment.",
    );
  });
});

describe('cern_opendata_list_files input', () => {
  it.each([
    ['6004'],
    [' 6004 '],
    ['recid:6004'],
    ['RECID: 6004'],
    ['https://opendata.cern.ch/record/6004'],
    ['http://opendata.cern.ch/api/records/6004?ln=en'],
    ['https://opendata.cern.ch/record/6004/files/file_a.root'],
    ['06004'],
    ['recid:0006004'],
    ['https://opendata.cern.ch/record/06004'],
  ])('reads the recid spelling %j as 6004', async (recid) => {
    const { http } = serve();
    const result = success(await run({ recid }));
    expect(result.recid).toBe('6004');
    expect(new URL(http.calls[0]?.request.url ?? '').pathname).toBe('/api/records/6004');
  });

  it.each([
    ['atlas-160006'],
    ['ATLAS-160006'],
    ['recid:atlas-160006'],
    ['https://opendata.cern.ch/record/atlas-160006'],
    ['http://opendata.cern.ch/api/records/atlas-0160006/files'],
  ])('reads the prefixed spelling %j as atlas-160006 and lists its indexes', async (recid) => {
    const { http } = serve();
    const result = await run({ recid });
    const data = success(result);
    expect(new URL(http.calls[0]?.request.url ?? '').pathname).toBe('/api/records/atlas-160006');
    expect(data.recid).toBe('atlas-160006');
    expect(data.indexes.map((index) => [index.key, index.uri_list_url])).toEqual([
      [
        'training_files.json',
        'https://opendata.cern.ch/record/atlas-160006/file_index/training_files.txt',
      ],
      [
        'test_VHbb_files.json',
        'https://opendata.cern.ch/record/atlas-160006/file_index/test_VHbb_files.txt',
      ],
    ]);
    expect(textOf(result)).toContain('atlas-160006');
  });

  it('pages a prefixed record index with a cursor bound to that recid', async () => {
    serve();
    const first = success(
      await run({ recid: 'atlas-160006', index: 'training_files.json', limit: 1 }),
    );
    expect(first.files.map((file) => file.https_url)).toEqual([
      'https://opendata.cern.ch/record/atlas-160006/files/training_files.json_0',
    ]);
    const second = success(
      await run({
        recid: 'atlas-160006',
        index: 'training_files.json',
        limit: 1,
        cursor: first.next_cursor,
      }),
    );
    expect(second.files.map((file) => file.key)).toEqual(['training_files.json_1']);
  });

  it.each([
    [''],
    ['   '],
    ['abc'],
    ['60o4'],
    ['-1'],
    ['12.5'],
    ['https://evil.example/record/6004'],
    ['https://opendata.cern.ch/record/6004evil'],
    ['recid:'],
    ['0'],
    ['000'],
    ['atlas-'],
    ['atlas-0'],
    ['atlas_160006'],
    ['atlas-160006x'],
    ['abcdefghijklmnopq-160006'],
  ])('rejects the recid %j as invalid arguments before any request', async (recid) => {
    const { http } = serve();
    const result = await run({ recid });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(http.calls).toHaveLength(0);
  });

  it.each([['1234567890123'], ['7'.repeat(1_000_000)]])(
    'rejects a recid of 13 digits or more before any request, without echoing it (%#)',
    async (recid) => {
      const { http } = serve();
      const result = await run({ recid });
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(result)).not.toContain(recid.slice(0, 13));
      expect(http.calls).toHaveLength(0);
    },
  );

  it('requires a recid even for a form client that sends only blanks', async () => {
    serve();
    const result = await run({ recid: '', index: '', cursor: '', limit: '' } as never);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('reads blank index, cursor and limit as unset', () => {
    expect(listFiles.input.parse({ recid: '6004', index: '  ', cursor: '', limit: '' })).toEqual({
      recid: '6004',
      limit: 50,
    });
  });

  it('gives the same result for blank optionals as for none', async () => {
    serve();
    const plain = success(await run({ recid: '6004' }));
    const blanks = success(
      await run({ recid: '6004', index: ' ', cursor: '', limit: '' } as never),
    );
    expect(blanks).toEqual(plain);
  });

  it.each([
    ['ds_a_file_index.txt', 'ds_a_file_index.json'],
    ['  ds_a_file_index.txt  ', 'ds_a_file_index.json'],
    ['ds_a_file_index.TXT', 'ds_a_file_index.json'],
    ['ds_a_file_index.json', 'ds_a_file_index.json'],
    ['a.txt.json', 'a.txt.json'],
    ['a.txt_file_index.json', 'a.txt_file_index.json'],
  ])('reads the index key %j as %j', (raw, expected) => {
    expect(listFiles.input.parse({ recid: '1', index: raw }).index).toBe(expected);
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['limit 501', { limit: 501 }],
    ['a fractional limit', { limit: 1.5 }],
    ['an index over 300 characters', { index: 'x'.repeat(301) }],
    ['a cursor over 500 characters', { cursor: 'x'.repeat(501) }],
  ])('rejects %s as invalid arguments', async (_name, extra) => {
    const { http } = serve();
    const result = await run({ recid: '6004', ...extra });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
  });

  it('accepts limit 1 and limit 500', async () => {
    serve();
    expect(success(await run({ recid: '6004', limit: 1 })).files).toHaveLength(1);
    expect(success(await run({ recid: '6004', limit: 500 })).cap).toBe(500);
  });

  it('applies the default limit of 50', async () => {
    serve();
    expect(success(await run({ recid: '6004' })).cap).toBe(50);
  });
});

describe('cern_opendata_list_files record scope', () => {
  it('lists a record with regular files only, dropping the portal bookkeeping', async () => {
    serve();
    const result = success(await run({ recid: '6004' }));
    expect(result).toMatchObject({
      recid: '6004',
      title: '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
      availability: 'online',
      availability_details: { online: 2 },
      scope: 'record',
      indexes: [],
      children: [],
      has_more: false,
      portal_url: 'https://opendata.cern.ch/record/6004',
    });
    expect(result.files).toEqual([
      {
        key: 'file_a.root',
        size_in_bytes: 1024,
        checksum: 'adler32:0a1b2c3d',
        xrootd_uri: 'root://eospublic.cern.ch//eos/opendata/cms/file_a.root',
        https_url: 'https://opendata.cern.ch/record/6004/files/file_a.root',
        availability: 'online',
      },
      {
        key: 'file_b.root',
        size_in_bytes: 2048,
        xrootd_uri: 'root://eospublic.cern.ch//eos/opendata/cms/file_b.root',
        https_url: 'https://opendata.cern.ch/record/6004/files/file_b.root',
      },
    ]);
    expect(result).not.toHaveProperty('next_cursor');
    for (const file of result.files) {
      for (const dropped of ['bucket', 'file_id', 'version_id', 'tags', 'filename']) {
        expect(file).not.toHaveProperty(dropped);
      }
    }
  });

  it('sends exactly one request, to the record GET', async () => {
    const { http } = serve();
    await run({ recid: '6004' });
    expect(http.calls).toHaveLength(1);
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.pathname).toBe('/api/records/6004');
    expect(url.search).toBe('');
  });

  it('lists the indexes of an indexed record with their URI-list and JSON URLs, and no regular files', async () => {
    serve();
    const result = success(await run({ recid: '24464' }));
    expect(result).toMatchObject({
      recid: '24464',
      title: 'ATLAS DAOD_PHYSLITE sample',
      availability: 'partial',
      availability_details: { online: 2, on_demand: 2 },
      scope: 'record',
      files: [],
      children: [],
      has_more: false,
    });
    expect(result.indexes).toEqual([
      {
        key: 'ds_a_file_index.json',
        description: 'First index',
        number_files: 2,
        size_in_bytes: 300,
        availability: { online: 1, on_demand: 1 },
        uri_list_url: 'https://opendata.cern.ch/record/24464/file_index/ds_a_file_index.txt',
        json_url: 'https://opendata.cern.ch/record/24464/file_index/ds_a_file_index.json',
      },
      {
        key: 'ds_b_file_index.json',
        number_files: 2,
        size_in_bytes: 500,
        availability: { online: 2 },
        uri_list_url: 'https://opendata.cern.ch/record/24464/file_index/ds_b_file_index.txt',
        json_url: 'https://opendata.cern.ch/record/24464/file_index/ds_b_file_index.json',
      },
    ]);
  });

  it('derives index counts and size from the members when the portal states none, availability {}', async () => {
    serve({
      '700': recordBody({
        recid: '700',
        _file_indices: [
          {
            key: 'bare_file_index.json',
            availability: {},
            files: [
              { key: 'bare_file_index.json_0', size: 10, uri: 'root://x/0' },
              { key: 'bare_file_index.json_1', size: 32, uri: 'root://x/1' },
            ],
          },
        ],
      }),
    });
    const result = await run({ recid: '700' });
    expect(success(result).indexes).toEqual([
      {
        key: 'bare_file_index.json',
        number_files: 2,
        size_in_bytes: 42,
        availability: {},
        uri_list_url: 'https://opendata.cern.ch/record/700/file_index/bare_file_index.txt',
        json_url: 'https://opendata.cern.ch/record/700/file_index/bare_file_index.json',
      },
    ]);
    expect(textOf(result)).toContain(
      '- **bare_file_index.json**: 2 files, 42 bytes, online Not available, on demand Not available',
    );
    expect(success(result).notice).toContain('Files are grouped into 1 file index (2 files)');
  });

  it('keeps regular files and indexes together when a record holds both', async () => {
    serve({
      '701': recordBody({
        recid: '701',
        title: 'Both',
        _files: regularFiles(2),
        _file_indices: [fileIndex('both_file_index.json', 3)],
      }),
    });
    const result = success(await run({ recid: '701' }));
    expect(result.files.map((file) => file.key)).toEqual(['file_0.root', 'file_1.root']);
    expect(result.indexes.map((index) => index.key)).toEqual(['both_file_index.json']);
    expect(result.totalCount).toBe(2);
    expect(result.notice).toBeUndefined();
  });

  it('builds the URI-list URL from an index key the portal spells with .txt', async () => {
    serve({
      '702': recordBody({ recid: '702', _file_indices: [fileIndex('t_file_index.txt', 1)] }),
    });
    const [index] = success(await run({ recid: '702' })).indexes;
    expect(index?.uri_list_url).toBe(
      'https://opendata.cern.ch/record/702/file_index/t_file_index.txt',
    );
    expect(index?.json_url).toBe(
      'https://opendata.cern.ch/record/702/file_index/t_file_index.json',
    );
  });

  it('encodes an index key as one path segment, so a dot segment cannot retarget its URLs', async () => {
    serve({
      '703': recordBody({
        recid: '703',
        _file_indices: [fileIndex('../../api/records/1_file_index.json', 1)],
      }),
    });
    const [index] = success(await run({ recid: '703' })).indexes;
    expect(index?.uri_list_url).toBe(
      'https://opendata.cern.ch/record/703/file_index/..%2F..%2Fapi%2Frecords%2F1_file_index.txt',
    );
    expect(new URL(index?.json_url ?? '').pathname).toBe(
      '/record/703/file_index/..%2F..%2Fapi%2Frecords%2F1_file_index.json',
    );
  });

  it('percent-encodes each segment of a file key in the HTTPS URL', async () => {
    serve({
      '703': recordBody({
        recid: '703',
        _files: [
          { key: 'dir/file name#1.root', size: 1, uri: 'root://x/a' },
          { key: 'a|b.root', size: 1, uri: 'root://x/b' },
        ],
      }),
    });
    const { files } = success(await run({ recid: '703' }));
    expect(files.map((file) => file.https_url)).toEqual([
      'https://opendata.cern.ch/record/703/files/dir/file%20name%231.root',
      'https://opendata.cern.ch/record/703/files/a%7Cb.root',
    ]);
  });
});

describe('cern_opendata_list_files index scope', () => {
  it('pages one index, with only that index listed and members keyed <index>_<n>', async () => {
    serve();
    const result = success(await run({ recid: '24464', index: 'ds_a_file_index.json' }));
    expect(result).toMatchObject({ scope: 'index', has_more: false, children: [] });
    expect(result.indexes.map((index) => index.key)).toEqual(['ds_a_file_index.json']);
    expect(result.files).toEqual([
      {
        key: 'ds_file_index.json_0',
        filename: 'part_0.root',
        size_in_bytes: 100,
        checksum: 'adler32:00000000',
        xrootd_uri: 'root://eospublic.cern.ch//eos/opendata/atlas/part_0.root',
        https_url: 'https://opendata.cern.ch/record/24464/files/ds_file_index.json_0',
        availability: 'online',
      },
      {
        key: 'ds_file_index.json_1',
        filename: 'part_1.root',
        size_in_bytes: 200,
        checksum: 'adler32:00000001',
        xrootd_uri: 'root://eospublic.cern.ch//eos/opendata/atlas/part_1.root',
        https_url: 'https://opendata.cern.ch/record/24464/files/ds_file_index.json_1',
        availability: 'on demand',
      },
    ]);
  });

  it('reads a .txt index key as the .json key it names', async () => {
    serve();
    const viaTxt = success(await run({ recid: '24464', index: 'ds_b_file_index.txt' }));
    const viaJson = success(await run({ recid: '24464', index: 'ds_b_file_index.json' }));
    expect(viaTxt.scope).toBe('index');
    expect(viaTxt.indexes[0]?.key).toBe('ds_b_file_index.json');
    expect(viaTxt).toEqual(viaJson);
  });

  it('matches the index key exactly, case included', async () => {
    serve();
    const result = await run({ recid: '24464', index: 'DS_A_FILE_INDEX.json' });
    expect(errorOf(result).data).toMatchObject({ reason: 'index_not_found' });
  });

  it('counts the tape files of the selected index only, not the other indexes', async () => {
    serve();
    const a = success(await run({ recid: '24464', index: 'ds_a_file_index.json' }));
    const b = success(await run({ recid: '24464', index: 'ds_b_file_index.json' }));
    expect(a.notice).toBe(
      "1 file is on tape (availability on demand); request it on the record's portal page (https://opendata.cern.ch/record/24464) before downloading.",
    );
    expect(b.notice).toBe(a.notice);
  });

  it('lists an empty index as a zero-result page without a notice', async () => {
    serve({
      '704': recordBody({
        recid: '704',
        _file_indices: [{ key: 'empty_file_index.json', files: [] }],
      }),
    });
    const result = success(await run({ recid: '704', index: 'empty_file_index.json' }));
    expect(result).toMatchObject({ files: [], shown: 0, totalCount: 0, truncated: false });
    expect(result.indexes[0]).toMatchObject({
      number_files: 0,
      size_in_bytes: 0,
      availability: {},
    });
    expect(result.notice).toBeUndefined();
  });
});

describe('cern_opendata_list_files index reads', () => {
  it('reads only that index and the record search when the manifest is not cached', async () => {
    const { http } = serve();
    success(await run({ recid: '24464', index: 'ds_a_file_index.json' }));
    expect(requestPaths(http)).toEqual([
      '/api/records/?q=recid%3A24464&size=1&skip_files=1&ondemand=true',
      '/record/24464/file_index/ds_a_file_index.json',
    ]);
  });

  it('makes no request for an index of a cached manifest, hit or miss', async () => {
    const { http } = serve();
    await run({ recid: '24464' });
    success(await run({ recid: '24464', index: 'ds_b_file_index.json' }));
    errorOf(await run({ recid: '24464', index: 'nope_file_index.json' }));
    expect(requestPaths(http)).toEqual(['/api/records/24464']);
  });

  describe.each([
    ['a keyed index with tape files', '24464', 'ds_a_file_index.json', BODIES],
    [
      'a JetSet2 index of keyless members',
      'atlas-160006',
      'training_files.json',
      { 'atlas-160006': jetSet2RecordBody },
    ],
  ] as const)('%s', (_name, recid, index, bodies) => {
    it('gives the whole output alike whichever path served it, page by page', async () => {
      const walk = async () => {
        const pages: ContractResult[] = [];
        let cursor: string | undefined;
        do {
          const page = await run({ recid, index, limit: 1, ...(cursor ? { cursor } : {}) });
          pages.push(page);
          cursor = success(page).next_cursor;
        } while (cursor);
        return pages;
      };

      const viaIndexRoute = serve(bodies);
      const routed = await walk();
      expect(requestPaths(viaIndexRoute.http)).not.toContain(`/api/records/${recid}`);
      disposeInstalledService();

      const viaManifest = serve(bodies);
      await run({ recid });
      const fromManifest = await walk();
      expect(requestPaths(viaManifest.http)).toEqual([`/api/records/${recid}`]);

      expect(routed.length).toBeGreaterThan(1);
      expect(fromManifest).toEqual(routed);
    });
  });

  it('index_not_found: a key the uncached record lacks names the record and the key', async () => {
    const { http } = serve();
    const result = await run({ recid: '24464', index: 'nope_file_index.json' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'index_not_found',
      recid: '24464',
      index: 'nope_file_index.json',
    });
    expect(error.data).not.toHaveProperty('indexCount');
    expect(error.message).toBe('Record 24464 has no file index with key "nope_file_index.json".');
    expect(textOf(result)).toContain(
      'Recovery: Call cern_opendata_list_files with this recid and no index',
    );
    expect(http.calls).toHaveLength(2);
  });

  it('record_not_found: an index of an unknown record, once its search finds nothing', async () => {
    serve();
    const result = await run({ recid: '999999', index: 'x_file_index.json' });
    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'record_not_found', recid: '999999' });
    expect(error.message).toBe('No record has recid 999999.');
    expect(textOf(result)).toContain('Recovery: Call cern_opendata_search_records');
  });

  it.each([['.'], ['..'], ['a\ud800.json']])(
    'index_not_found: the dot segment or ill-formed key %j, without a request',
    async (index) => {
      const { http } = serve();
      const error = errorOf(await run({ recid: '24464', index }));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({ reason: 'index_not_found', recid: '24464', index });
      expect(http.calls).toHaveLength(0);
    },
  );

  it('reads a prefixed recid with its index key from the index route', async () => {
    const { http } = serve({ 'atlas-160006': jetSet2RecordBody });
    const result = success(await run({ recid: 'ATLAS-0160006', index: 'test_VHbb_files.json' }));
    expect(result).toMatchObject({ recid: 'atlas-160006', scope: 'index', totalCount: 1 });
    expect(requestPaths(http)).toEqual([
      '/api/records/?q=recid%3Aatlas-160006&size=1&skip_files=1&ondemand=true',
      '/record/atlas-160006/file_index/test_VHbb_files.json',
    ]);
  });

  describe('cache', () => {
    it('pages an uncached index from one read: later pages make no request', async () => {
      const { http } = serve({
        '6001': recordBody({
          recid: '6001',
          _file_indices: [fileIndex('big_file_index.json', 130)],
        }),
      });
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = success(
          await run({
            recid: '6001',
            index: 'big_file_index.json',
            limit: 50,
            ...(cursor ? { cursor } : {}),
          }),
        );
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(http.calls).toHaveLength(2);
    });

    it('reads another index of the same record with one request', async () => {
      const { http } = serve();
      await run({ recid: '24464', index: 'ds_a_file_index.json' });
      const other = success(await run({ recid: '24464', index: 'ds_b_file_index.json' }));
      expect(other.title).toBe('ATLAS DAOD_PHYSLITE sample');
      expect(requestPaths(http)).toEqual([
        '/api/records/?q=recid%3A24464&size=1&skip_files=1&ondemand=true',
        '/record/24464/file_index/ds_a_file_index.json',
        '/record/24464/file_index/ds_b_file_index.json',
      ]);
    });

    it('never serves an index read older than a manifest cached since, once that manifest is evicted', async () => {
      const at = (state: 'online' | 'on demand', keys: readonly string[]) =>
        recordBody({
          recid: '7001',
          title: state,
          availability: state === 'online' ? 'online' : 'ondemand',
          _file_indices: keys.map((key, n) =>
            fileIndex(key, 1, { files: [indexFile(n, { availability: state })] }),
          ),
        });
      const bodies: Record<string, RecordBody> = {
        '7001': at('on demand', ['a_file_index.json', 'b_file_index.json', 'c_file_index.json']),
      };
      for (let n = 1; n <= 8; n++) bodies[String(n)] = recordBody({ recid: String(n), _files: [] });
      serve(bodies);
      const view = async (index: string) => {
        const data = success(await run({ recid: '7001', index }));
        return `${data.title}/${data.files[0]?.availability}`;
      };
      expect(await view('a_file_index.json')).toBe('on demand/on demand');
      expect(await view('c_file_index.json')).toBe('on demand/on demand');

      // The record changes upstream, dropping index c, and record scope caches it.
      bodies['7001'] = at('online', ['a_file_index.json', 'b_file_index.json']);
      await run({ recid: '7001' });
      expect(await view('a_file_index.json')).toBe('online/online');

      // Eight other records evict that manifest from its LRU of 8.
      for (let n = 1; n <= 8; n++) await run({ recid: String(n) });
      expect(await view('a_file_index.json')).toBe('online/online');
      expect(await view('b_file_index.json')).toBe('online/online');
      expect(errorOf(await run({ recid: '7001', index: 'c_file_index.json' })).data).toMatchObject({
        reason: 'index_not_found',
        recid: '7001',
        index: 'c_file_index.json',
      });
    });

    it('does not cache an index read whose record search found nothing', async () => {
      const { http } = installService([fileIndexRoute(BODIES), recordSearchRoute({})]);
      const first = success(await run({ recid: '24464', index: 'ds_a_file_index.json' }));
      expect(first).not.toHaveProperty('title');
      expect(first.files.length).toBeGreaterThan(0);
      await run({ recid: '24464', index: 'ds_a_file_index.json' });
      expect(http.calls).toHaveLength(4);
    });

    it('reads the index and the record search again after 15 minutes', async () => {
      const clock = fakeClock();
      const { http } = serve(BODIES, { now: clock.now });
      await run({ recid: '24464', index: 'ds_a_file_index.json' });
      clock.advance(15 * 60_000 - 1);
      await run({ recid: '24464', index: 'ds_a_file_index.json', limit: 1 });
      expect(http.calls).toHaveLength(2);
      clock.advance(1);
      await run({ recid: '24464', index: 'ds_a_file_index.json' });
      expect(http.calls).toHaveLength(4);
    });
  });

  describe('a failure of either read fails the call with its declared reason', () => {
    it('rate_limited: the index route answered 429', async () => {
      installService([
        portalRoute(
          /\/file_index\//,
          new Response('', { status: 429, headers: { 'retry-after': '20' } }),
        ),
        recordSearchRoute(BODIES),
      ]);
      const result = await run({ recid: '24464', index: 'ds_a_file_index.json' });
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited', retryAfter: 20 },
      });
      expect(textOf(result)).toContain('Recovery: Wait the retryAfter seconds');
    });

    it('upstream_unreadable: the record search answered 404', async () => {
      installService([
        fileIndexRoute(BODIES),
        portalRoute('/api/records/', jsonResponse(NOT_FOUND_BODY, { status: 404 })),
      ]);
      const result = await run({ recid: '24464', index: 'ds_a_file_index.json' });
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unreadable' },
      });
      expect(textOf(result)).toContain('Recovery: Call cern_opendata_list_files again in a minute');
    });

    it('a cancellation while the search is in flight settles as cancelled, never as a listing', async () => {
      const controller = new AbortController();
      installService([
        fileIndexRoute(BODIES),
        portalRoute(
          '/api/records/',
          (request) =>
            new Promise<Response>((_resolve, reject) => {
              controller.abort(new Error('caller left'));
              request.signal.addEventListener('abort', () => reject(request.signal.reason), {
                once: true,
              });
              if (request.signal.aborted) reject(request.signal.reason);
            }),
        ),
      ]);
      const result = await runToolContract(
        listFiles,
        { recid: '24464', index: 'ds_a_file_index.json' },
        { context: { signal: controller.signal } },
      );
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    });
  });
});

describe('cern_opendata_list_files deadline', () => {
  it('names the portal, the record, its page and the 50 s budget when a record GET runs out of time', async () => {
    vi.useFakeTimers();
    try {
      installService([
        portalRoute(
          /^\/api\/records\/\d+$/,
          (request) =>
            new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener('abort', () => reject(request.signal.reason), {
                once: true,
              });
            }),
        ),
      ]);
      const pending = run({ recid: '24464' });
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
      expect(error.message).toBe(
        "CERN Open Data did not finish sending record 24464 within this call's 50 s budget; call again in a minute, or browse its files at https://opendata.cern.ch/record/24464.",
      );
      expect(textOf(result)).not.toMatch(/CernOpenData|\d\s?ms\b/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cern_opendata_list_files keyless members (JetSet2, atlas-160006)', () => {
  const JETSET2 = { 'atlas-160006': jetSet2RecordBody };
  const EOS = 'https://opendata.cern.ch/eos/opendata/atlas/datascience/ATL-SOFT-PUB-2026-002';

  it('lists the 8 indexes at record scope, counts derived from the members and availability {}', async () => {
    serve(JETSET2);
    const result = await run({ recid: 'atlas-160006' });
    const data = success(result);
    expect(data).toMatchObject({
      scope: 'record',
      files: [],
      children: [],
      availability: 'online',
    });
    expect(data).not.toHaveProperty('availability_details');
    expect(data.indexes).toHaveLength(8);
    expect(data.indexes[0]).toEqual({
      key: 'training_files.json',
      description: 'training_files.json',
      number_files: 3,
      size_in_bytes: 14_190_227_850_197,
      availability: {},
      uri_list_url: 'https://opendata.cern.ch/record/atlas-160006/file_index/training_files.txt',
      json_url: 'https://opendata.cern.ch/record/atlas-160006/file_index/training_files.json',
    });
    expect(data.indexes.map((index) => index.number_files)).toEqual([3, 1, 1, 1, 1, 1, 1, 1]);
    for (const index of data.indexes) expect(index.availability).toEqual({});
    expect(data.notice).toBe(
      "Files are grouped into 8 file indexes (10 files); call cern_opendata_list_files with index set to one of the index keys to page its files, or fetch an index's uri_list_url for every XRootD URI at once.",
    );
    expect(textOf(result)).toContain(
      '- **training_files.json**: 3 files, 14190227850197 bytes, online Not available, on demand Not available',
    );
  });

  it('pages training_files.json: filename, size, checksum, XRootD URI and the EOS HTTPS URL, no key', async () => {
    serve(JETSET2);
    const result = await run({ recid: 'atlas-160006', index: 'training_files.json' });
    const data = success(result);
    expect(data.totalCount).toBe(3);
    expect(data.files[0]).toEqual({
      filename: 'jetset2-release_v1.pp_output_train-full_0.h5',
      size_in_bytes: 72_161_839_049,
      checksum: 'adler32:47ef28c2',
      xrootd_uri:
        'root://eospublic.cern.ch:1094//eos/opendata/atlas/datascience/ATL-SOFT-PUB-2026-002/train/jetset2-release_v1.pp_output_train-full_0.h5',
      https_url: `${EOS}/train/jetset2-release_v1.pp_output_train-full_0.h5`,
      availability: 'online',
    });
    for (const file of data.files) expect(file).not.toHaveProperty('key');
    expect(textOf(result)).toContain(
      `| Not available | jetset2-release_v1.pp_output_train-full_0.h5 | 72161839049 | adler32:47ef28c2 | online | root://eospublic.cern.ch:1094//eos/opendata/atlas/datascience/ATL-SOFT-PUB-2026-002/train/jetset2-release_v1.pp_output_train-full_0.h5 | ${EOS}/train/jetset2-release_v1.pp_output_train-full_0.h5 |`,
    );
  });

  /** The JetSet2 record with every index's `size` dropped, so the size must come from the members. */
  const jetSet2Unsized: RecordBody = {
    ...jetSet2RecordBody,
    metadata: {
      ...jetSet2RecordBody.metadata,
      _file_indices: (jetSet2RecordBody.metadata._file_indices ?? []).map(
        ({ size: _size, ...index }) => index,
      ),
    },
  };

  it.each([
    ['its size as stated', jetSet2RecordBody, 14_190_227_850_197],
    ['its size summed from the members when unstated', jetSet2Unsized, 216_492_364_119],
  ])(
    'reports training_files.json with its member count and %s, alike on the index route and a cached manifest',
    async (_name, body, size) => {
      const bodies = { 'atlas-160006': body };
      const read = () => run({ recid: 'atlas-160006', index: 'training_files.json' });

      const viaIndexRoute = serve(bodies);
      const routed = await read();
      expect(requestPaths(viaIndexRoute.http)).toEqual([
        '/api/records/?q=recid%3Aatlas-160006&size=1&skip_files=1&ondemand=true',
        '/record/atlas-160006/file_index/training_files.json',
      ]);
      disposeInstalledService();

      const viaManifest = serve(bodies);
      await run({ recid: 'atlas-160006' });
      const fromManifest = await read();
      expect(requestPaths(viaManifest.http)).toEqual(['/api/records/atlas-160006']);

      for (const result of [routed, fromManifest]) {
        expect(success(result).indexes).toEqual([
          expect.objectContaining({ number_files: 3, size_in_bytes: size, availability: {} }),
        ]);
        expect(textOf(result)).toContain(
          `- **training_files.json**: 3 files, ${size} bytes, online Not available, on demand Not available`,
        );
      }
      expect(success(fromManifest).indexes).toEqual(success(routed).indexes);
    },
  );

  it.each([
    [
      'no port',
      'root://eospublic.cern.ch//eos/opendata/cms/a b#1.root',
      'https://opendata.cern.ch/eos/opendata/cms/a%20b%231.root',
    ],
    [
      'a port and one leading slash',
      'root://eospublic.cern.ch:1094/eos/opendata/x.h5',
      'https://opendata.cern.ch/eos/opendata/x.h5',
    ],
    ['another host', 'root://eosuser.cern.ch//eos/opendata/x.h5', undefined],
    ['a path outside /eos/opendata/', 'root://eospublic.cern.ch//eos/user/x.h5', undefined],
    ['a dot segment', 'root://eospublic.cern.ch//eos/opendata/../../api/records/1', undefined],
    ['the bare /eos/opendata/ directory', 'root://eospublic.cern.ch//eos/opendata/', undefined],
    ['an empty segment', 'root://eospublic.cern.ch//eos/opendata//x.h5', undefined],
    ['a trailing slash', 'root://eospublic.cern.ch//eos/opendata/atlas/', undefined],
    ['/eos/opendata/ followed by a slash', 'root://eospublic.cern.ch//eos/opendata//', undefined],
    ['a lone surrogate', 'root://eospublic.cern.ch//eos/opendata/\ud800.h5', undefined],
    ['another scheme', 'https://eospublic.cern.ch//eos/opendata/x.h5', undefined],
  ])('builds the HTTPS URL of a keyless member with %s', async (_name, uri, httpsUrl) => {
    serve({ '720': recordBody({ recid: '720', _files: [{ filename: 'x', size: 1, uri }] }) });
    const result = await run({ recid: '720' });
    const [file] = success(result).files;
    if (httpsUrl === undefined) {
      expect(file).not.toHaveProperty('https_url');
      expect(textOf(result)).toMatch(/\| Not available \|\n/);
    } else {
      expect(file?.https_url).toBe(httpsUrl);
    }
  });

  it('keeps the record files URL for a keyed member, wherever its URI points', async () => {
    serve({
      '721': recordBody({
        recid: '721',
        _files: [{ key: 'k.h5', size: 1, uri: 'root://eospublic.cern.ch//eos/opendata/x.h5' }],
      }),
    });
    expect(success(await run({ recid: '721' })).files[0]?.https_url).toBe(
      'https://opendata.cern.ch/record/721/files/k.h5',
    );
  });

  it.each([
    ['a nested key', 'dir/k #1.h5', 'https://opendata.cern.ch/record/723/files/dir/k%20%231.h5'],
    ['a .. segment', '../../api/records/1', undefined],
    ['a . segment', 'dir/./k.h5', undefined],
    ['an empty segment', 'dir//k.h5', undefined],
    ['a trailing slash', 'dir/', undefined],
    ['a lone slash', '/', undefined],
    ['a lone surrogate', 'k\ud800.h5', undefined],
  ])('builds the record files URL of a keyed file with %s', async (_name, key, httpsUrl) => {
    serve({
      '723': recordBody({
        recid: '723',
        _files: [{ key, size: 1, uri: 'root://eospublic.cern.ch//eos/opendata/x.h5' }],
      }),
    });
    const [file] = success(await run({ recid: '723' })).files;
    expect(file?.key).toBe(key);
    if (httpsUrl === undefined) expect(file).not.toHaveProperty('https_url');
    else expect(file?.https_url).toBe(httpsUrl);
  });

  it.each([
    ['a regular file', undefined],
    ['an index member read from the index route', 'k_file_index.json'],
  ])('lists %s whose key is not well-formed Unicode without an https_url', async (_name, index) => {
    const file = {
      key: 'k\ud800.h5',
      size: 1,
      uri: 'root://eospublic.cern.ch//eos/opendata/x.h5',
    };
    serve({
      '722': recordBody(
        index
          ? { recid: '722', _file_indices: [fileIndex(index, 1, { files: [file] })] }
          : { recid: '722', _files: [file] },
      ),
    });
    const result = await run({ recid: '722', ...(index ? { index } : {}) });
    const [listed] = success(result).files;
    expect(listed).toMatchObject({ key: 'k\ud800.h5', xrootd_uri: file.uri });
    expect(listed).not.toHaveProperty('https_url');
    expect(textOf(result)).toMatch(/\| Not available \|\n/);
  });
});

describe('cern_opendata_list_files children (umbrella records only)', () => {
  it('sets children to the isParentOf recids of a record with no files and no indexes', async () => {
    serve();
    const result = success(await run({ recid: '80020' }));
    expect(result).toMatchObject({
      recid: '80020',
      scope: 'record',
      files: [],
      indexes: [],
      children: ['80021', '80022'],
      has_more: false,
    });
  });

  it('leaves children empty for a record that holds files of its own, whatever its relations say', async () => {
    serve();
    const result = success(await run({ recid: '30518' }));
    expect(result.children).toEqual([]);
    expect(result.files).toHaveLength(1);
  });

  it('leaves children empty for an indexed record', async () => {
    serve({
      '705': recordBody({
        recid: '705',
        _file_indices: [fileIndex('x_file_index.json', 1)],
        relations: [{ type: 'isParentOf', recid: '706' }],
      }),
    });
    expect(success(await run({ recid: '705' })).children).toEqual([]);
  });

  it('ignores relations other than isParentOf and those without a recid', async () => {
    serve({
      '707': recordBody({
        recid: '707',
        relations: [
          { type: 'isChildOf', recid: '1' },
          { type: 'isRelatedTo', recid: '2' },
          { type: 'isParentOf', title: 'No recid' },
        ],
      }),
    });
    const result = success(await run({ recid: '707' }));
    expect(result.children).toEqual([]);
    expect(result.notice).toBe('This record has no files.');
  });

  it('names the first five child recids and an ellipsis for more', async () => {
    serve({
      '708': recordBody({
        recid: '708',
        relations: Array.from({ length: 7 }, (_, i) => ({
          type: 'isParentOf',
          recid: String(8100 + i),
        })),
      }),
    });
    const result = success(await run({ recid: '708' }));
    expect(result.children).toHaveLength(7);
    expect(result.notice).toBe(
      'This record holds no files itself; its files sit in 7 child records (8100, 8101, 8102, 8103, 8104, …). Call cern_opendata_list_files with one of those recids.',
    );
  });

  it('writes the umbrella notice without an ellipsis for up to five children', async () => {
    serve();
    expect(success(await run({ recid: '80020' })).notice).toBe(
      'This record holds no files itself; its files sit in 2 child records (80021, 80022). Call cern_opendata_list_files with one of those recids.',
    );
  });

  it('escapes child recids in the umbrella notice and keeps them as received in children', async () => {
    serve({
      '710': recordBody({
        recid: '710',
        relations: [
          { type: 'isParentOf', recid: '<img src=x>' },
          { type: 'isParentOf', recid: '[c](https://evil.example)' },
        ],
      }),
    });
    const result = success(await run({ recid: '710' }));
    expect(result.children).toEqual(['<img src=x>', '[c](https://evil.example)']);
    expect(result.notice).toBe(
      'This record holds no files itself; its files sit in 2 child records (&lt;img src=x&gt;, \\[c\\](https://evil.example)). Call cern_opendata_list_files with one of those recids.',
    );
  });
});

describe('cern_opendata_list_files enrichment', () => {
  it('zero-result page (umbrella): required fields at zero, with the child-record notice', async () => {
    serve();
    const result = success(await run({ recid: '80020', limit: 25 }));
    expect(result).toMatchObject({ truncated: false, shown: 0, cap: 25, totalCount: 0 });
    expect(result.notice).toContain('2 child records');
  });

  it('zero-result page (no files, no indexes, no children) says the record has no files', async () => {
    serve({ '709': recordBody({ recid: '709', title: 'Nothing' }) });
    const result = success(await run({ recid: '709' }));
    expect(result).toMatchObject({
      truncated: false,
      shown: 0,
      cap: 50,
      totalCount: 0,
      files: [],
      indexes: [],
      children: [],
      notice: 'This record has no files.',
    });
  });

  it('zero-result page (on-demand record the API lists no files for) reports the stated files on tape', async () => {
    serve({
      '13049': recordBody({
        recid: '13049',
        title:
          '/ZprimeLFVToEMu_M-1000_TuneZ2star_8TeV_madgraph/Summer12_DR53X-PU_S10_START53_V19E-v1/AODSIM',
        availability: 'ondemand',
        _availability_details: null,
        distribution: {
          availability: 'ondemand',
          formats: ['aodsim', 'root'],
          number_events: 9996,
          number_files: 2,
          size: 3_504_276_797,
        },
      }),
    });
    const raw = await run({ recid: '13049' });
    const result = success(raw);
    expect(result).toMatchObject({
      availability: 'ondemand',
      files: [],
      indexes: [],
      children: [],
      truncated: false,
      totalCount: 0,
    });
    expect(result.notice).toBe(
      "This record's 2 files (3504276797 bytes) are on tape (availability ondemand), and the portal's API does not list them; request them on the record's portal page (https://opendata.cern.ch/record/13049) before downloading.",
    );
    expect(textOf(raw, 1)).toContain('are on tape (availability ondemand)');
  });

  it('zero-result page (files stated but unlisted, not on demand) names the stated count without claiming tape', async () => {
    serve({
      '711': recordBody({
        recid: '711',
        availability: 'requested',
        distribution: { number_files: 3 },
      }),
    });
    expect(success(await run({ recid: '711' })).notice).toBe(
      "The record states 3 files, but the portal's API lists none of them; check the record's portal page (https://opendata.cern.ch/record/711).",
    );
  });

  it('keeps the child-record notice for an umbrella record that states the files of its children', async () => {
    serve({
      '712': recordBody({
        recid: '712',
        availability: 'ondemand',
        distribution: { number_files: 70_611, size: 1_000 },
        relations: [{ type: 'isParentOf', recid: '713' }],
      }),
    });
    expect(success(await run({ recid: '712' })).notice).toBe(
      'This record holds no files itself; its files sit in 1 child record (713). Call cern_opendata_list_files with that recid.',
    );
  });

  it('zero-result page (one stated file on tape) agrees the count with its noun', async () => {
    serve({
      '715': recordBody({
        recid: '715',
        availability: 'ondemand',
        distribution: { availability: 'ondemand', number_files: 1, size: 1 },
      }),
    });
    expect(success(await run({ recid: '715' })).notice).toBe(
      "This record's 1 file (1 byte) is on tape (availability ondemand), and the portal's API does not list it; request it on the record's portal page (https://opendata.cern.ch/record/715) before downloading.",
    );
  });

  it('zero-result page (one stated file, not on demand) agrees the count with its noun', async () => {
    serve({
      '716': recordBody({
        recid: '716',
        availability: 'requested',
        distribution: { number_files: 1 },
      }),
    });
    expect(success(await run({ recid: '716' })).notice).toBe(
      "The record states 1 file, but the portal's API does not list it; check the record's portal page (https://opendata.cern.ch/record/716).",
    );
  });

  it('zero-result file page (one index of one file) agrees each count with its noun', async () => {
    serve({
      '717': recordBody({ recid: '717', _file_indices: [fileIndex('x_file_index.json', 1)] }),
    });
    expect(success(await run({ recid: '717' })).notice).toBe(
      "Files are grouped into 1 file index (1 file); call cern_opendata_list_files with index set to one of the index keys to page its files, or fetch an index's uri_list_url for every XRootD URI at once.",
    );
  });

  it('says the record has no files when its distribution states none', async () => {
    serve({ '714': recordBody({ recid: '714', distribution: { number_files: 0, size: 0 } }) });
    expect(success(await run({ recid: '714' })).notice).toBe('This record has no files.');
  });

  it('zero-result file page (record scope, indexes only) groups the files under the indexes and counts tape files', async () => {
    serve();
    const result = success(await run({ recid: '24464' }));
    expect(result).toMatchObject({ truncated: false, shown: 0, cap: 50, totalCount: 0 });
    expect(result.notice).toBe(
      "Files are grouped into 2 file indexes (4 files); call cern_opendata_list_files with index set to one of the index keys to page its files, or fetch an index's uri_list_url for every XRootD URI at once. " +
        "1 file is on tape (availability on demand); request it on the record's portal page (https://opendata.cern.ch/record/24464) before downloading.",
    );
  });

  it('under-cap page: fewer files than the cap, not truncated, no notice', async () => {
    serve();
    const result = success(await run({ recid: '6004', limit: 50 }));
    expect(result).toMatchObject({ truncated: false, shown: 2, cap: 50, totalCount: 2 });
    expect(result).not.toHaveProperty('notice');
    expect(result).not.toHaveProperty('next_cursor');
  });

  it('under-cap page: the page that ends the list is short and carries no paging notice', async () => {
    serve({ '5000': recordBody({ recid: '5000', _files: regularFiles(120) }) });
    const first = success(await run({ recid: '5000', limit: 100 }));
    const last = success(
      await run({ recid: '5000', limit: 100, cursor: first.next_cursor as string }),
    );
    expect(last).toMatchObject({ truncated: false, shown: 20, cap: 100, totalCount: 120 });
    expect(last.has_more).toBe(false);
    expect(last).not.toHaveProperty('notice');
    expect(last).not.toHaveProperty('next_cursor');
  });

  it('counts tape files of a regular-file record in scope', async () => {
    serve({
      '710': recordBody({
        recid: '710',
        _files: [
          { key: 'a', size: 1, uri: 'root://x/a', availability: 'on demand' },
          { key: 'b', size: 1, uri: 'root://x/b', availability: 'online' },
          { key: 'c', size: 1, uri: 'root://x/c', availability: 'on demand' },
        ],
      }),
    });
    expect(success(await run({ recid: '710' })).notice).toBe(
      "2 files are on tape (availability on demand); request them on the record's portal page (https://opendata.cern.ch/record/710) before downloading.",
    );
  });

  it('truncated page: the guidance carries the range and the cursor instruction', async () => {
    serve({ '5000': recordBody({ recid: '5000', _files: regularFiles(120) }) });
    const result = success(await run({ recid: '5000', limit: 50 }));
    expect(result).toMatchObject({
      truncated: true,
      shown: 50,
      cap: 50,
      totalCount: 120,
      has_more: true,
    });
    expect(result.notice).toBe(
      'Showing files 1–50 of 120; call cern_opendata_list_files again with cursor set to next_cursor.',
    );
  });

  it('truncated page: tape and paging fragments compose into one notice', async () => {
    serve({
      '711': recordBody({
        recid: '711',
        _files: Array.from({ length: 4 }, (_, i) => ({
          key: `f${i}`,
          size: 1,
          uri: `root://x/${i}`,
          availability: 'on demand',
        })),
      }),
    });
    const result = success(await run({ recid: '711', limit: 3 }));
    expect(result.truncated).toBe(true);
    expect(result.notice).toBe(
      "4 files are on tape (availability on demand); request them on the record's portal page (https://opendata.cern.ch/record/711) before downloading. " +
        'Showing files 1–3 of 4; call cern_opendata_list_files again with cursor set to next_cursor.',
    );
  });

  it('totalCount is the files in scope: regular files in record scope, members in index scope', async () => {
    serve({
      '712': recordBody({
        recid: '712',
        _files: regularFiles(3),
        _file_indices: [fileIndex('i_file_index.json', 9)],
      }),
    });
    expect(success(await run({ recid: '712' })).totalCount).toBe(3);
    expect(success(await run({ recid: '712', index: 'i_file_index.json' })).totalCount).toBe(9);
  });

  it('writes the same fields into the text trailer', async () => {
    serve({ '5000': recordBody({ recid: '5000', _files: regularFiles(120) }) });
    const trailer = textOf(await run({ recid: '5000', limit: 50 }), 1);
    expect(trailer).toContain('**truncated:** true');
    expect(trailer).toContain('**shown:** 50');
    expect(trailer).toContain('**cap:** 50');
    expect(trailer).toContain('120 total');
    expect(trailer).toContain('Showing files 1–50 of 120');
  });
});

describe('cern_opendata_list_files paging', () => {
  it('walks a record scope with cursors: every file once, in order, from one upstream read', async () => {
    const { http } = serve({ '5000': recordBody({ recid: '5000', _files: regularFiles(120) }) });
    const keys: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    do {
      const page = success(await run({ recid: '5000', limit: 50, ...(cursor ? { cursor } : {}) }));
      keys.push(...page.files.map((file) => String(file.key)));
      sizes.push(page.shown);
      cursor = page.next_cursor;
      expect(page.has_more).toBe(cursor !== undefined);
    } while (cursor);
    expect(sizes).toEqual([50, 50, 20]);
    expect(keys).toEqual(Array.from({ length: 120 }, (_, i) => `file_${i}.root`));
    expect(http.calls).toHaveLength(1);
  });

  it('issues cursors that carry the recid, the index and the next offset', async () => {
    serve({ '5000': recordBody({ recid: '5000', _files: regularFiles(120) }) });
    const page = success(await run({ recid: '5000', limit: 50 }));
    expect(page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(page.next_cursor as string, 'base64url').toString())).toEqual({
      r: '5000',
      i: null,
      o: 50,
    });
  });

  it('pages an index with cursors bound to that index', async () => {
    serve({
      '6001': recordBody({ recid: '6001', _file_indices: [fileIndex('big_file_index.json', 130)] }),
    });
    const first = success(await run({ recid: '6001', index: 'big_file_index.json', limit: 50 }));
    expect(first.files).toHaveLength(50);
    expect(JSON.parse(Buffer.from(first.next_cursor as string, 'base64url').toString())).toEqual({
      r: '6001',
      i: 'big_file_index.json',
      o: 50,
    });
    const second = success(
      await run({
        recid: '6001',
        index: 'big_file_index.txt',
        limit: 50,
        cursor: first.next_cursor as string,
      }),
    );
    expect(second.files[0]?.key).toBe('big_file_index.json_50');
    const third = success(
      await run({
        recid: '6001',
        index: 'big_file_index.json',
        limit: 50,
        cursor: second.next_cursor as string,
      }),
    );
    expect(third.files.map((file) => file.key)).toEqual(
      Array.from({ length: 30 }, (_, i) => `big_file_index.json_${100 + i}`),
    );
    expect(third.has_more).toBe(false);
  });

  it('ends on a full page without a cursor when the list divides evenly', async () => {
    serve({ '5001': recordBody({ recid: '5001', _files: regularFiles(100) }) });
    const first = success(await run({ recid: '5001', limit: 50 }));
    const second = success(
      await run({ recid: '5001', limit: 50, cursor: first.next_cursor as string }),
    );
    expect(second).toMatchObject({ shown: 50, has_more: false, truncated: false });
    expect(second).not.toHaveProperty('next_cursor');
  });

  it('lets the page size change between pages; the cursor holds the offset only', async () => {
    serve({ '5000': recordBody({ recid: '5000', _files: regularFiles(120) }) });
    const first = success(await run({ recid: '5000', limit: 10 }));
    const second = success(
      await run({ recid: '5000', limit: 100, cursor: first.next_cursor as string }),
    );
    expect(second.files[0]?.key).toBe('file_10.root');
    expect(second.files).toHaveLength(100);
  });

  it('pages a 6,500-file record at limit 500 across 13 pages without losing or repeating a file', async () => {
    serve({ '5002': recordBody({ recid: '5002', _files: regularFiles(6_500) }) });
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = success(await run({ recid: '5002', limit: 500, ...(cursor ? { cursor } : {}) }));
      for (const file of page.files) seen.add(String(file.key));
      pages += 1;
      cursor = page.next_cursor;
      expect(page.totalCount).toBe(6_500);
    } while (cursor);
    expect(pages).toBe(13);
    expect(seen.size).toBe(6_500);
  });

  it('lists every index of a record with many indexes in one record-scope page', async () => {
    serve({
      '24465': recordBody({
        recid: '24465',
        _file_indices: Array.from({ length: 70 }, (_, i) =>
          fileIndex(`idx_${i}_file_index.json`, 20),
        ),
      }),
    });
    const result = success(await run({ recid: '24465', limit: 1 }));
    expect(result.indexes).toHaveLength(70);
    expect(result.files).toEqual([]);
    expect(result.notice).toContain('Files are grouped into 70 file indexes (1400 files)');
  });
});

describe('cern_opendata_list_files errors', () => {
  it('record_not_found: a 404 names the recid and routes to search', async () => {
    serve();
    const result = await run({ recid: '999999' });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'record_not_found', recid: '999999' });
    expect(error.message).toBe('No record has recid 999999.');
    expect(textOf(result)).toContain('Recovery: Call cern_opendata_search_records');
    expect(textOf(result)).toContain('reason record_not_found');
  });

  it('record_not_found is not cached: asking again asks the portal again', async () => {
    const { http } = serve();
    await run({ recid: '999999' });
    await run({ recid: '999999' });
    expect(http.calls).toHaveLength(2);
  });

  it.each([
    ['two indexes', '24464', 'nope_file_index.json'],
    ['one index', '705', 'nope_file_index.json'],
    ['no indexes', '6004', 'nope_file_index.json'],
    ['a regular file key', '6004', 'file_a.root'],
  ])(
    'index_not_found reads the same fresh and after record scope: %s',
    async (_name, recid, index) => {
      const { http } = serve({
        ...BODIES,
        '705': recordBody({ recid: '705', _file_indices: [fileIndex('x_file_index.json', 1)] }),
      });
      const fresh = await run({ recid, index });
      expect(http.calls).toHaveLength(2);
      await run({ recid });
      const cached = await run({ recid, index });
      expect(http.calls).toHaveLength(3);

      expect(errorOf(fresh)).toEqual({
        code: JsonRpcErrorCode.NotFound,
        message: `Record ${recid} has no file index with key "${index}".`,
        data: expect.objectContaining({ reason: 'index_not_found', recid, index }),
      });
      expect(errorOf(fresh).data).not.toHaveProperty('indexCount');
      expect(errorOf(cached)).toEqual(errorOf(fresh));
      expect(textOf(cached)).toBe(textOf(fresh));
      expect(textOf(fresh)).toContain(
        'Recovery: Call cern_opendata_list_files with this recid and no index',
      );
    },
  );

  describe('invalid_cursor', () => {
    const base = { recid: '6004' } as const;

    it.each([
      ['text that is not base64url', 'not*base64!'],
      ['base64url of non-JSON text', cursorOf('not json')],
      ['base64url JSON of the wrong shape', cursorOf({ r: '6004' })],
      ['a negative offset', cursorOf({ r: '6004', i: null, o: -1 })],
      ['a fractional offset', cursorOf({ r: '6004', i: null, o: 1.5 })],
      ['a numeric recid', cursorOf({ r: 6004, i: null, o: 1 })],
      ['a JSON array', cursorOf([1, 2, 3])],
      ['JSON null', cursorOf('null')],
    ])('rejects %s before any request', async (_name, cursor) => {
      const { http } = serve();
      const result = await run({ ...base, cursor });
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'invalid_cursor', recid: '6004', index: null });
      expect(error.message).toBe(
        'The cursor does not decode; it is not a next_cursor this tool issued.',
      );
      expect(http.calls).toHaveLength(0);
    });

    it('rejects a cursor issued for another record, naming it, before any request', async () => {
      const { http } = serve();
      const result = await run({ ...base, cursor: cursorOf({ r: '24464', i: null, o: 1 }) });
      const error = errorOf(result);
      expect(error.data).toMatchObject({ reason: 'invalid_cursor' });
      expect(error.message).toBe(
        'This cursor was issued for record 24464, not for this recid and index.',
      );
      expect(textOf(result)).toContain(
        'Recovery: Call cern_opendata_list_files again without cursor',
      );
      expect(http.calls).toHaveLength(0);
    });

    it('rejects a record-scope cursor used with an index, and the reverse', async () => {
      const { http } = serve();
      const recordCursor = cursorOf({ r: '24464', i: null, o: 1 });
      const indexCursor = cursorOf({ r: '24464', i: 'ds_a_file_index.json', o: 1 });
      const withIndex = errorOf(
        await run({ recid: '24464', index: 'ds_a_file_index.json', cursor: recordCursor }),
      );
      const withoutIndex = errorOf(await run({ recid: '24464', cursor: indexCursor }));
      expect(withIndex.data).toMatchObject({ reason: 'invalid_cursor' });
      expect(withoutIndex.data).toMatchObject({ reason: 'invalid_cursor' });
      expect(withoutIndex.message).toBe(
        'This cursor was issued for record 24464 index ds_a_file_index.json, not for this recid and index.',
      );
      expect(http.calls).toHaveLength(0);
    });

    it('rejects a cursor issued for another index of the same record', async () => {
      serve();
      const error = errorOf(
        await run({
          recid: '24464',
          index: 'ds_b_file_index.json',
          cursor: cursorOf({ r: '24464', i: 'ds_a_file_index.json', o: 1 }),
        }),
      );
      expect(error.data).toMatchObject({ reason: 'invalid_cursor' });
    });

    it('rejects a cursor past the end after reading the manifest, naming offset and total', async () => {
      const { http } = serve();
      const result = await run({ ...base, cursor: cursorOf({ r: '6004', i: null, o: 2 }) });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'invalid_cursor',
        recid: '6004',
        index: null,
        offset: 2,
        total: 2,
      });
      expect(error.message).toBe('The cursor points to file 3, past the 2 files in scope.');
      expect(http.calls).toHaveLength(1);
    });

    it('names a single file in scope in the singular', async () => {
      serve({ '719': recordBody({ recid: '719', _files: regularFiles(1) }) });
      const error = errorOf(
        await run({ recid: '719', cursor: cursorOf({ r: '719', i: null, o: 1 }) }),
      );
      expect(error.message).toBe('The cursor points to file 2, past the 1 file in scope.');
    });

    it('rejects a cursor far past the end of an index', async () => {
      serve();
      const error = errorOf(
        await run({
          recid: '24464',
          index: 'ds_a_file_index.json',
          cursor: cursorOf({ r: '24464', i: 'ds_a_file_index.json', o: 500 }),
        }),
      );
      expect(error.data).toMatchObject({ reason: 'invalid_cursor', offset: 500, total: 2 });
    });

    it('accepts the last valid offset and offset 0', async () => {
      serve();
      const last = success(await run({ ...base, cursor: cursorOf({ r: '6004', i: null, o: 1 }) }));
      expect(last.files.map((file) => file.key)).toEqual(['file_b.root']);
      const zero = success(await run({ ...base, cursor: cursorOf({ r: '6004', i: null, o: 0 }) }));
      expect(zero.files).toHaveLength(2);
    });

    it('accepts offset 0 on an empty scope', async () => {
      serve();
      const result = success(
        await run({ recid: '80020', cursor: cursorOf({ r: '80020', i: null, o: 0 }) }),
      );
      expect(result.files).toEqual([]);
    });

    it('checks the cursor before reading the record: a bad cursor on an unknown record is invalid_cursor', async () => {
      const { http } = serve();
      const error = errorOf(await run({ recid: '999999', cursor: 'not*base64!' }));
      expect(error.data).toMatchObject({ reason: 'invalid_cursor' });
      expect(http.calls).toHaveLength(0);
    });

    it('reports record_not_found for a well-formed cursor on an unknown record', async () => {
      serve();
      const error = errorOf(
        await run({ recid: '999999', cursor: cursorOf({ r: '999999', i: null, o: 5 }) }),
      );
      expect(error.data).toMatchObject({ reason: 'record_not_found' });
    });
  });

  it('upstream_unreadable: a file entry without a URI or size makes the manifest unreadable, uncached', async () => {
    const { http } = serve({
      '713': recordBody({ recid: '713', _files: [{ key: 'only-a-key.root' }] }),
    });
    const first = await run({ recid: '713' });
    const error = errorOf(first);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.message).toBe(
      'CERN Open Data returned a file entry for record 713 without an XRootD URI or size.',
    );
    expect(textOf(first)).toContain('Recovery: Call cern_opendata_list_files again in a minute');
    await run({ recid: '713' });
    expect(http.calls).toHaveLength(2);
  });

  it('upstream_unreadable: a file index without a key', async () => {
    serve({ '714': recordBody({ recid: '714', _file_indices: [{ files: [] }] }) });
    expect(errorOf(await run({ recid: '714' })).data).toMatchObject({
      reason: 'upstream_unreadable',
    });
  });

  it('upstream_unreadable: a file index whose key is not well-formed Unicode, uncached', async () => {
    const { http } = serve({
      '716': recordBody({ recid: '716', _file_indices: [fileIndex('a\ud800_file_index.json', 1)] }),
    });
    const result = await run({ recid: '716' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.message).toBe(
      'CERN Open Data returned a file index for record 716 whose key is not well-formed Unicode.',
    );
    expect(textOf(result)).toContain('Recovery: Call cern_opendata_list_files again in a minute');
    await run({ recid: '716' });
    expect(http.calls).toHaveLength(2);
  });

  it('upstream_unreadable: a member file without its URI', async () => {
    serve({
      '715': recordBody({
        recid: '715',
        _file_indices: [
          { key: 'x_file_index.json', files: [{ key: 'x_file_index.json_0', size: 1 }] },
        ],
      }),
    });
    expect(errorOf(await run({ recid: '715' })).data).toMatchObject({
      reason: 'upstream_unreadable',
    });
  });
});

describe('cern_opendata_list_files manifest cache', () => {
  it('reads the record once across pages, scopes and limits', async () => {
    const { http } = serve();
    await run({ recid: '24464' });
    await run({ recid: '24464', index: 'ds_a_file_index.json', limit: 1 });
    await run({ recid: '24464', index: 'ds_b_file_index.json' });
    expect(http.calls).toHaveLength(1);
  });

  it('reads again once the cached manifest expires', async () => {
    const clock = fakeClock();
    const { http } = serve(BODIES, { now: clock.now, manifestCache: { ttlMs: 60_000 } });
    await run({ recid: '6004' });
    clock.advance(59_000);
    await run({ recid: '6004' });
    expect(http.calls).toHaveLength(1);
    clock.advance(2_000);
    await run({ recid: '6004' });
    expect(http.calls).toHaveLength(2);
  });

  it('evicts the least recently used record past the cache size', async () => {
    const { http } = serve(BODIES, { manifestCache: { size: 1 } });
    await run({ recid: '6004' });
    await run({ recid: '24464' });
    await run({ recid: '6004' });
    expect(http.calls).toHaveLength(3);
  });

  it('keeps separate manifests per recid', async () => {
    const { http } = serve();
    const a = success(await run({ recid: '6004' }));
    const b = success(await run({ recid: '30518' }));
    expect(a.recid).toBe('6004');
    expect(b.recid).toBe('30518');
    expect(http.calls).toHaveLength(2);
  });
});

describe('cern_opendata_list_files format', () => {
  it('renders the header, the file table and the paging line for a regular-file record', async () => {
    serve();
    const text = textOf(await run({ recid: '6004' }));
    expect(text).toContain('## Files of record 6004: /DoubleMuParked/Run2012B-22Jan2013-v1/AOD');
    expect(text).toContain(
      '**Scope:** record · **Availability:** online (online files: 2, on-demand files: Not available)',
    );
    expect(text).toContain('**Portal:** https://opendata.cern.ch/record/6004');
    expect(text).toContain('### Files (2 on this page)');
    expect(text).toContain(
      '| Key | Filename | Size (bytes) | Checksum | Availability | XRootD URI | HTTPS URL |',
    );
    expect(text).toContain(
      '| file_a.root | Not available | 1024 | adler32:0a1b2c3d | online | root://eospublic.cern.ch//eos/opendata/cms/file_a.root | https://opendata.cern.ch/record/6004/files/file_a.root |',
    );
    expect(text).toContain(
      '| file_b.root | Not available | 2048 | Not available | Not available | root://eospublic.cern.ch//eos/opendata/cms/file_b.root | https://opendata.cern.ch/record/6004/files/file_b.root |',
    );
    expect(text.trimEnd().endsWith('**More files:** no')).toBe(true);
    expect(text).not.toContain('### File indexes');
    expect(text).not.toContain('**Child records:**');
  });

  it('renders every index with its counts, description and both URLs', async () => {
    serve();
    const text = textOf(await run({ recid: '24464' }));
    expect(text).toContain('### File indexes (2)');
    expect(text).toContain('- **ds_a_file_index.json**: 2 files, 300 bytes, online 1, on demand 1');
    expect(text).toContain('  - Description: First index');
    expect(text).toContain(
      '  - URI list: https://opendata.cern.ch/record/24464/file_index/ds_a_file_index.txt',
    );
    expect(text).toContain(
      '  - JSON: https://opendata.cern.ch/record/24464/file_index/ds_a_file_index.json',
    );
    expect(text).toContain(
      '- **ds_b_file_index.json**: 2 files, 500 bytes, online 2, on demand Not available',
    );
    expect(text).toContain('  - Description: Not available');
    expect(text).toContain('### Files (0 on this page)\nNo files on this page.');
    expect(text).toContain('(online files: 2, on-demand files: 2)');
  });

  it('renders an index scope with member filenames', async () => {
    serve();
    const text = textOf(await run({ recid: '24464', index: 'ds_a_file_index.json' }));
    expect(text).toContain('**Scope:** index');
    expect(text).toContain(
      '| ds_file_index.json_0 | part_0.root | 100 | adler32:00000000 | online |',
    );
    expect(text).toContain(
      '| ds_file_index.json_1 | part_1.root | 200 | adler32:00000001 | on demand |',
    );
    expect(text).not.toContain('ds_b_file_index.json**');
  });

  it('renders the child records of an umbrella record', async () => {
    serve();
    const text = textOf(await run({ recid: '80020' }));
    expect(text).toContain('**Child records:** 80021, 80022');
    expect(text).toContain('No files on this page.');
  });

  it('renders the next cursor when more files remain', async () => {
    serve({ '5000': recordBody({ recid: '5000', _files: regularFiles(120) }) });
    const result = await run({ recid: '5000', limit: 50 });
    const cursor = success(result).next_cursor as string;
    expect(textOf(result)).toContain(`**More files:** yes · **next_cursor:** \`${cursor}\``);
  });

  it('renders one table row per file on the page', async () => {
    serve({ '5000': recordBody({ recid: '5000', _files: regularFiles(120) }) });
    const text = textOf(await run({ recid: '5000', limit: 17 }));
    const rows = text.split('\n').filter((line) => line.startsWith('| file_'));
    expect(rows).toHaveLength(17);
    expect(text).toContain('### Files (17 on this page)');
  });

  it('renders a missing title as Not available and keeps title text on one line', async () => {
    serve({
      '716': recordBody({ recid: '716', _files: regularFiles(1) }),
      '717': recordBody({ recid: '717', title: 'T\r\n# Injected\n- [x](http://e.example)' }),
    });
    expect(textOf(await run({ recid: '716' }))).toContain('## Files of record 716: Not available');
    const text = textOf(await run({ recid: '717' }));
    expect(text.split('\n')[0]).toBe(
      '## Files of record 717: T  # Injected - \\[x\\](http://e.example)',
    );
    expect(text.split('\n').some((line) => line.startsWith('# '))).toBe(false);
  });

  it('keeps CR/LF, pipes and markup in keys, names, checksums and descriptions inside their table and list slots', async () => {
    serve({
      '718': recordBody({
        recid: '718',
        title: 'Hostile',
        _files: [
          {
            key: 'a|b\nc.root',
            filename: 'x\n# y|z',
            size: 5,
            checksum: 'adler32:\n- bad',
            uri: 'root://x/a b\n[1]',
            availability: 'on\r\ndemand',
          },
        ],
        _file_indices: [
          {
            ...fileIndex('k\n## y_file_index.json', 1),
            description: 'Desc\n# Heading | x [l](http://e.example)',
          },
        ],
      }),
    });
    const text = textOf(await run({ recid: '718' }));
    const lines = text.split('\n');
    const rows = lines.filter((line) => line.startsWith('| a'));
    expect(rows).toEqual([
      '| a\\|b c.root | x # y\\|z | 5 | adler32: - bad | on  demand | root://x/a%20b%0A%5B1%5D | https://opendata.cern.ch/record/718/files/a%7Cb%0Ac.root |',
    ]);
    expect(
      lines.filter(
        (line) =>
          line.startsWith('#') && !line.startsWith('###') && !line.startsWith('## Files of record'),
      ),
    ).toEqual([]);
    expect(lines.some((line) => line.startsWith('- bad'))).toBe(false);
    expect(text).toContain(
      '- **k ## y_file_index.json**: 1 file, 100 bytes, online 1, on demand Not available',
    );
    expect(text).toContain('  - Description: Desc # Heading \\| x \\[l\\](http://e.example)');
    expect(text).toContain(
      '  - URI list: https://opendata.cern.ch/record/718/file_index/k%0A%23%23%20y_file_index.txt',
    );
  });

  it('renders the same keys and sizes that structuredContent carries', async () => {
    serve({ '5003': recordBody({ recid: '5003', _files: regularFiles(30) }) });
    const result = await run({ recid: '5003', limit: 30 });
    const text = textOf(result);
    for (const file of success(result).files) {
      expect(text).toContain(`| ${file.key} |`);
      expect(text).toContain(`| ${file.size_in_bytes} |`);
      expect(text).toContain(file.https_url);
      expect(text).toContain(file.xrootd_uri);
      if (file.checksum) expect(text).toContain(file.checksum);
    }
  });
});
