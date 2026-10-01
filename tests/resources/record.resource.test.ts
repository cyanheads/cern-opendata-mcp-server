/**
 * @fileoverview Tests for the cern-opendata://record/{recid} resource: its
 * registration, params, the Record shape it returns (the same data as
 * cern_opendata_get_records), the declared errors, and the lookup it sends.
 * @module tests/resources/record.resource.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { recordResource } from '@/mcp-server/resources/definitions/record.resource.js';
import { getRecords } from '@/mcp-server/tools/definitions/get-records.tool.js';
import type { RawHit } from '@/services/cern-opendata/types.js';
import {
  disposeInstalledService,
  failureOf,
  installService,
  settle,
} from '../fixtures/cern-opendata-harness.js';
import {
  collisionDatasetHit,
  HTML_ERROR_PAGE,
  jsonResponse,
  licensedDatasetHit,
  portalRoute,
  SYNTAX_ERROR_BODY,
  searchBody,
  sparseHit,
} from '../fixtures/cern-opendata-upstream.js';

const searchRoute = (respond: Parameters<typeof portalRoute>[1]) =>
  portalRoute('/api/records/', respond);

const servePool = (pool: readonly RawHit[]) =>
  installService([searchRoute(() => jsonResponse(searchBody(pool)))]);

const ctxFor = (recid: string) =>
  createMockContext({
    errors: recordResource.errors,
    uri: new URL(`cern-opendata://record/${recid}`),
  });

function paramsFor(recid: string) {
  if (!recordResource.params) throw new Error('The resource declares no params.');
  return recordResource.params.parse({ recid });
}

const read = async (recid: string) => await recordResource.handler(paramsFor(recid), ctxFor(recid));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  disposeInstalledService();
});

describe('cern-opendata://record/{recid} registration', () => {
  it('is registered as a JSON resource with a public 15-minute cache hint and no listing', () => {
    expect(allResourceDefinitions).toContain(recordResource);
    expect(recordResource.name).toBe('cern-opendata-record');
    expect(recordResource.mimeType).toBe('application/json');
    expect(recordResource.cacheHint).toEqual({ ttlMs: 900_000, cacheScope: 'public' });
    expect(recordResource.list).toBeUndefined();
  });

  it('declares record_not_found plus the two shared errors, recoveries naming the resource read', () => {
    const byReason = Object.fromEntries(
      (recordResource.errors ?? []).map((entry) => [entry.reason, entry]),
    );
    expect(Object.keys(byReason)).toEqual([
      'record_not_found',
      'rate_limited',
      'upstream_unreadable',
    ]);
    expect(byReason.record_not_found?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(byReason.record_not_found?.recovery).toBe(
      "Call cern_opendata_search_records to find the record's recid, then read this resource or call cern_opendata_get_records with it.",
    );
    expect(byReason.rate_limited).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
    });
    expect(byReason.rate_limited?.recovery).toContain(
      'then read cern-opendata://record/{recid} again',
    );
    expect(byReason.upstream_unreadable).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
    });
    expect(byReason.upstream_unreadable?.recovery).toContain(
      'Read cern-opendata://record/{recid} again in a minute',
    );
  });
});

describe('cern-opendata://record/{recid} params', () => {
  it.each([['6004'], ['1'], ['0123']])('accepts the digits %j', (recid) => {
    expect(paramsFor(recid)).toEqual({ recid });
  });

  it.each([[''], ['abc'], ['60o4'], [' 6004'], ['6004 '], ['-1'], ['12.5'], ['recid:6004']])(
    'rejects %j',
    (recid) => {
      expect(recordResource.params?.safeParse({ recid }).success).toBe(false);
    },
  );
});

describe('cern-opendata://record/{recid} read', () => {
  it('returns the Record shape, with license and citation, from one lookup search', async () => {
    const { http } = servePool([collisionDatasetHit]);
    const record = await read('6004');
    expect(record).toEqual(expect.schemaMatching(recordResource.output as never));
    expect(record).toMatchObject({
      id: '6004',
      kind: 'record',
      recid: '6004',
      matched_inputs: ['6004'],
      title: '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
      license: { id: 'CC0-1.0', basis: 'cern_terms_default' },
      citation: { doi: '10.7483/OPENDATA.CMS.YLIC.86ZZ' },
      portal_url: 'https://opendata.cern.ch/record/6004',
    });
    expect(http.calls).toHaveLength(1);
    const params = new URL(http.calls[0]?.request.url ?? '').searchParams;
    expect(params.get('q')).toBe('recid:(6004)');
    expect(params.get('size')).toBe('100');
    expect(params.get('skip_files')).toBe('1');
    expect(params.get('ondemand')).toBe('true');
  });

  it('returns exactly what cern_opendata_get_records returns for the same recid', async () => {
    servePool([collisionDatasetHit, licensedDatasetHit, sparseHit]);
    for (const recid of ['6004', '30517', '1120']) {
      const fromResource = await read(recid);
      const viaTool = await runToolContract(getRecords, { ids: [recid] });
      const [fromTool] = (viaTool.structuredContent as { records: unknown[] }).records;
      expect(fromResource, recid).toEqual(fromTool);
    }
  });

  it('keeps a sparse record sparse', async () => {
    servePool([sparseHit]);
    const record = await read('1120');
    expect(record).not.toHaveProperty('citation');
    expect(record).not.toHaveProperty('doi');
    expect(record.license.basis).toBe('not_stated');
    expect(record).toEqual(expect.schemaMatching(recordResource.output as never));
  });

  it('picks the hit whose recid matches when the portal returns several', async () => {
    servePool([licensedDatasetHit, collisionDatasetHit]);
    expect((await read('6004')).id).toBe('6004');
  });

  it('keeps structuredContent strings as received', async () => {
    servePool([
      {
        id: 77,
        metadata: { recid: '77', title: 'A &amp; B <i>x</i>', type: { primary: 'Software' } },
      },
    ]);
    expect((await read('77')).title).toBe('A &amp; B <i>x</i>');
  });
});

describe('cern-opendata://record/{recid} errors', () => {
  it('record_not_found: no hit for the recid is a NotFound carrying the recid', async () => {
    servePool([]);
    const error = await read('999999').catch((e: McpError) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'No record has recid 999999.',
      data: { reason: 'record_not_found', recid: '999999' },
    });
  });

  it('record_not_found: hits for other recids do not satisfy the read', async () => {
    servePool([collisionDatasetHit, licensedDatasetHit]);
    const error = await read('555').catch((e: McpError) => e);
    expect(error).toMatchObject({ data: { reason: 'record_not_found', recid: '555' } });
  });

  it('record_not_found: a documentation page is not a record', async () => {
    servePool([
      {
        id: 'a-doc',
        metadata: { slug: 'a-doc', title: 'Doc', type: { primary: 'Documentation' } },
      },
    ]);
    const error = await read('1').catch((e: McpError) => e);
    expect(error).toMatchObject({ data: { reason: 'record_not_found' } });
  });

  it('rate_limited: a 429 carries retryAfter', async () => {
    installService([
      searchRoute(() => new Response('', { status: 429, headers: { 'retry-after': '60' } })),
    ]);
    const failure = failureOf(await settle(() => read('6004')));
    expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(failure.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
  });

  it('upstream_unreadable: an HTML body on a 200', async () => {
    installService([searchRoute(() => new Response(HTML_ERROR_PAGE, { status: 200 }))]);
    const failure = failureOf(await settle(() => read('6004')));
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('a 5xx fails as ServiceUnavailable after the retries', async () => {
    const { http } = installService([searchRoute(() => new Response('down', { status: 502 }))]);
    const failure = failureOf(await settle(() => read('6004')));
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(http.calls).toHaveLength(3);
  });

  it('a 400 on the lookup the server built is an internal error', async () => {
    installService([searchRoute(() => jsonResponse(SYNTAX_ERROR_BODY, { status: 400 }))]);
    const failure = failureOf(await settle(() => read('6004')));
    expect(failure.code).toBe(JsonRpcErrorCode.InternalError);
  });

  it('a cancelled read fails without a request', async () => {
    const { http } = servePool([collisionDatasetHit]);
    const controller = new AbortController();
    controller.abort(new Error('client left'));
    const ctx = createMockContext({
      errors: recordResource.errors,
      signal: controller.signal,
    });
    const settled = await settle(async () => await recordResource.handler(paramsFor('6004'), ctx));
    expect(settled.ok).toBe(false);
    expect(http.calls).toHaveLength(0);
  });
});
