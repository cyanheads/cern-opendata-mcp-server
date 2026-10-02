/**
 * @fileoverview Tests for the CernOpenData service methods: search query
 * building and result mapping, lookup (matching, collapsing, the uppercase-DOI
 * retry), findRecord, the manifest cache, getIndex and its index and record-head
 * caches, docs, and the validated-run lists and their files. Upstream I/O is a
 * strict fetch fake.
 * @module tests/services/cern-opendata/service-methods.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CernOpenDataService,
  isPageWindowRejection,
} from '@/services/cern-opendata/cern-opendata-service.js';
import { classifyIdentifier } from '@/services/cern-opendata/identifiers.js';
import { toManifest, twinOf } from '@/services/cern-opendata/normalize.js';
import {
  failureOf,
  fakeClock,
  makeService,
  requestedUrls,
  settle,
} from '../../fixtures/cern-opendata-harness.js';
import {
  aggregationsBody,
  collisionDatasetHit,
  docHit,
  emptySearchBody,
  fileIndexRoute,
  filesRecordBody,
  hit,
  indexedRecordBody,
  jetSet2RecordBody,
  jsonResponse,
  LIST_SPECS,
  type ListSpec,
  licensedDatasetHit,
  NOT_FOUND_BODY,
  nanoaodRecordBody,
  portalRoute,
  prefixedCmsHit,
  prefixedDatasetHit,
  RUN_LIST_BODY,
  recordBody,
  recordSearchRoute,
  SYNTAX_ERROR_BODY,
  searchBody,
  softwareHit,
  umbrellaRecordBody,
  validatedListHit,
  validatedRunsSearchBody,
  WINDOW_ERROR_BODY,
} from '../../fixtures/cern-opendata-upstream.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Responder = Parameters<typeof portalRoute>[1];
const searchRoute = (respond: Responder, once = false) =>
  portalRoute('/api/records/', respond, { once });
const recordRoute = (respond: Responder, once = false) =>
  portalRoute(/^\/api\/records\/\d+$/, respond, { once });
const docRoute = (respond: Responder) => portalRoute(/^\/api\/docs\/.+/, respond);
const fileRoute = (respond: Responder, once = false) =>
  portalRoute(/^\/record\/\d+\/files\/.+/, respond, { once });

const ids = (...inputs: string[]) => inputs.map(classifyIdentifier);
const q = (url: URL) => url.searchParams.get('q');

/** A search responder that answers from the `q` the service sent. */
const answerByQuery =
  (answer: (query: string) => ReturnType<typeof searchBody>): Responder =>
  (request) =>
    jsonResponse(answer(new URL(request.url).searchParams.get('q') ?? ''));

describe('search', () => {
  it('sends only the size, skip_files and ondemand for a bare call', async () => {
    const { service, http, ctx } = makeService([searchRoute(jsonResponse(emptySearchBody))]);
    await service.search({ size: 10 }, service.startBudget(), ctx);
    expect([...new URL(http.calls[0]?.request.url ?? '').searchParams]).toEqual([
      ['size', '10'],
      ['skip_files', '1'],
      ['ondemand', 'true'],
    ]);
  });

  it('sends every filter under its portal name, repeating list values', async () => {
    const { service, http, ctx } = makeService([searchRoute(jsonResponse(emptySearchBody))]);
    await service.search(
      {
        q: 'muon "Z boson"',
        type: ['Dataset', 'Software'],
        experiment: ['CMS'],
        collision_energy: ['13TeV, 13.6TeV'],
        collision_type: ['PbPb', 'Pb-Pb'],
        file_type: ['nanoaod', 'aod'],
        availability: ['online'],
        collections: ['CMS-Primary-Datasets'],
        year: '2012--',
        number_events: '--500',
        sort: '-mostrecent',
        size: 25,
        page: 3,
      },
      service.startBudget(),
      ctx,
    );
    expect([...new URL(http.calls[0]?.request.url ?? '').searchParams]).toEqual([
      ['q', 'muon "Z boson"'],
      ['type', 'Dataset'],
      ['type', 'Software'],
      ['experiment', 'CMS'],
      ['collision_energy', '13TeV, 13.6TeV'],
      ['collision_type', 'PbPb'],
      ['collision_type', 'Pb-Pb'],
      ['file_type', 'nanoaod'],
      ['file_type', 'aod'],
      ['availability', 'online'],
      ['collections', 'CMS-Primary-Datasets'],
      ['year', '2012--'],
      ['number_events', '--500'],
      ['sort', '-mostrecent'],
      ['size', '25'],
      ['page', '3'],
      ['skip_files', '1'],
      ['ondemand', 'true'],
    ]);
  });

  it('drops skip_files when files are wanted, and omits page 1 and an unset sort', async () => {
    const { service, http, ctx } = makeService([searchRoute(jsonResponse(emptySearchBody))]);
    await service.search({ size: 100, skipFiles: false }, service.startBudget(), ctx);
    const names = [...new URL(http.calls[0]?.request.url ?? '').searchParams.keys()];
    expect(names).toEqual(['size', 'ondemand']);
  });

  it('never sends a parameter outside the allowlist', async () => {
    const { service, http, ctx } = makeService([searchRoute(jsonResponse(emptySearchBody))]);
    await service.search(
      { size: 1, q: 'x', subtype: 'Collision', experimnt: 'ATLAS', bogus: 1 } as never,
      service.startBudget(),
      ctx,
    );
    const names = new Set(new URL(http.calls[0]?.request.url ?? '').searchParams.keys());
    expect([...names].sort()).toEqual(['ondemand', 'q', 'size', 'skip_files']);
  });

  it('round-trips a query with quotes, slashes, unicode and plus signs', async () => {
    const { service, http, ctx } = makeService([searchRoute(jsonResponse(emptySearchBody))]);
    const query = 'title:"/DoubleMu/Run2012B-v1/AOD" AND µ+ c++ & x=y #z';
    await service.search({ q: query, size: 1 }, service.startBudget(), ctx);
    expect(q(new URL(http.calls[0]?.request.url ?? ''))).toBe(query);
  });

  it('maps a page to its hits, total and facets, leaving links.next unread', async () => {
    const { service, ctx } = makeService([
      searchRoute(
        jsonResponse(
          searchBody([collisionDatasetHit, docHit], {
            total: 926,
            hasNext: true,
            aggregations: aggregationsBody,
          }),
        ),
      ),
    ]);
    const outcome = await service.search({ size: 2 }, service.startBudget(), ctx);
    expect(outcome.kind).toBe('page');
    if (outcome.kind !== 'page') return;
    expect(outcome.page.hits.map((h) => h.id)).toEqual([6004, 'cms-guide-docker']);
    expect(outcome.page.total).toBe(926);
    expect(outcome.page.aggregations).toEqual(aggregationsBody);
    expect(Object.keys(outcome.page).sort()).toEqual(['aggregations', 'hits', 'total']);
  });

  it('reports an empty page and a page past the end', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(emptySearchBody), true),
      searchRoute(jsonResponse(searchBody([], { total: 120 }))),
    ]);
    const empty = await service.search({ q: 'nothing', size: 10 }, service.startBudget(), ctx);
    expect(empty).toEqual({
      kind: 'page',
      page: { hits: [], total: 0, aggregations: {} },
    });
    const pastEnd = await service.search({ size: 10, page: 99 }, service.startBudget(), ctx);
    expect(pastEnd).toMatchObject({ kind: 'page', page: { hits: [], total: 120 } });
  });

  it('reads a page with no links object or a non-string next', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse({ hits: { hits: [], total: 0 } }), true),
      searchRoute(jsonResponse({ hits: { hits: [], total: 0 }, links: { next: null } })),
    ]);
    for (let i = 0; i < 2; i++) {
      const outcome = await service.search({ size: 1 }, service.startBudget(), ctx);
      expect(outcome).toEqual({ kind: 'page', page: { hits: [], total: 0, aggregations: {} } });
    }
  });

  it('returns the portal 400 for the caller to classify', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(SYNTAX_ERROR_BODY, { status: 400 }), true),
      searchRoute(jsonResponse(WINDOW_ERROR_BODY, { status: 400 })),
    ]);
    const syntax = await service.search({ q: 'a AND', size: 1 }, service.startBudget(), ctx);
    const window = await service.search({ page: 2000, size: 10 }, service.startBudget(), ctx);
    expect(syntax.kind === 'rejected' && isPageWindowRejection(syntax.rejection)).toBe(false);
    expect(window.kind === 'rejected' && isPageWindowRejection(window.rejection)).toBe(true);
  });
});

describe('isPageWindowRejection', () => {
  it('matches the portal 10,000-result message and nothing else', () => {
    expect(isPageWindowRejection({ status: 400, message: WINDOW_ERROR_BODY.message })).toBe(true);
    expect(isPageWindowRejection({ status: 400, message: SYNTAX_ERROR_BODY.message })).toBe(false);
    expect(isPageWindowRejection({ status: 400, message: 'Validation error.' })).toBe(false);
  });
});

describe('lookup', () => {
  const doiUpper = '10.7483/OPENDATA.CMS.YLIC.86ZZ';
  const path = '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD';

  it('makes no request for an empty list or for ids none of which is recognized', async () => {
    const { service, http, ctx } = makeService([searchRoute(jsonResponse(emptySearchBody))]);
    expect(await service.lookup([], service.startBudget(), ctx)).toEqual({
      matches: [],
      missing: [],
    });
    const unrecognized = ids('has space', '-bad');
    expect(await service.lookup(unrecognized, service.startBudget(), ctx)).toEqual({
      matches: [],
      missing: unrecognized,
    });
    expect(http.calls).toHaveLength(0);
  });

  it('resolves every identifier form in one search', async () => {
    const { service, http, ctx } = makeService([
      searchRoute(
        jsonResponse(searchBody([collisionDatasetHit, softwareHit, docHit, licensedDatasetHit])),
      ),
    ]);
    const result = await service.lookup(
      ids('6004', '101', doiUpper, path, 'cms-guide-docker', 'recid:30517'),
      service.startBudget(),
      ctx,
    );
    expect(http.calls).toHaveLength(1);
    const url = requestedUrls(http)[0];
    expect(q(url as URL)).toBe(
      `recid:(6004 OR 101 OR 30517) OR doi:("${doiUpper}") OR title:("${path}") OR slug:("cms-guide-docker")`,
    );
    expect(Object.fromEntries((url as URL).searchParams)).toMatchObject({
      size: '100',
      sort: 'bestmatch',
      skip_files: '1',
      ondemand: 'true',
    });
    expect(result.missing).toEqual([]);
    expect(result.matches.map((m) => [m.hit.id, m.matchedInputs])).toEqual([
      [6004, ['6004', doiUpper, path]],
      [101, ['101']],
      ['cms-guide-docker', ['cms-guide-docker']],
      [30517, ['recid:30517']],
    ]);
  });

  it('resolves a numeric and a prefixed recid from one search, the prefixed one lowercased', async () => {
    const { service, http, ctx } = makeService([
      searchRoute(jsonResponse(searchBody([prefixedDatasetHit, collisionDatasetHit]))),
    ]);
    const result = await service.lookup(ids('6004', 'ATLAS-160006'), service.startBudget(), ctx);
    expect(http.calls).toHaveLength(1);
    expect(q(requestedUrls(http)[0] as URL)).toBe('recid:(6004 OR atlas-160006)');
    expect(result.matches.map((m) => [m.hit.id, m.matchedInputs])).toEqual([
      [6004, ['6004']],
      ['atlas-160006', ['ATLAS-160006']],
    ]);
    expect(result.missing).toEqual([]);
  });

  it('builds a clause only for the identifier kinds present', async () => {
    const { service, http, ctx } = makeService([searchRoute(jsonResponse(emptySearchBody))]);
    await service.lookup(ids('6004', '6005'), service.startBudget(), ctx);
    await service.lookup(ids('cms-guide-docker', 'other-slug'), service.startBudget(), ctx);
    expect(requestedUrls(http).map(q)).toEqual([
      'recid:(6004 OR 6005)',
      'slug:("cms-guide-docker" OR "other-slug")',
    ]);
  });

  it('collapses ids that resolve to one record and orders matches by first matching input', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(searchBody([softwareHit, collisionDatasetHit]))),
    ]);
    const result = await service.lookup(
      ids(path, '101', 'recid:6004', `doi:${doiUpper}`),
      service.startBudget(),
      ctx,
    );
    expect(result.matches.map((m) => [m.hit.id, m.matchedInputs])).toEqual([
      [6004, [path, 'recid:6004', `doi:${doiUpper}`]],
      [101, ['101']],
    ]);
  });

  it('keeps misses in input order, including unrecognized ids, and ignores hits no id asked for', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(searchBody([collisionDatasetHit, licensedDatasetHit]))),
    ]);
    const input = ids('999', 'not valid', '6004', 'missing-slug', '/A/B/C');
    const result = await service.lookup(input, service.startBudget(), ctx);
    expect(result.matches.map((m) => m.hit.id)).toEqual([6004]);
    expect(result.missing.map((id) => id.input)).toEqual([
      '999',
      'not valid',
      'missing-slug',
      '/A/B/C',
    ]);
  });

  it('matches dataset paths on the exact title and DOIs without regard to case', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(searchBody([collisionDatasetHit]))),
    ]);
    const result = await service.lookup(
      ids(path.toLowerCase(), doiUpper.toLowerCase()),
      service.startBudget(),
      ctx,
    );
    expect(result.matches[0]?.matchedInputs).toEqual([doiUpper.toLowerCase()]);
    expect(result.missing.map((id) => id.input)).toEqual([path.toLowerCase()]);
  });

  describe('uppercase DOI retry', () => {
    const lower = doiUpper.toLowerCase();

    it('retries a lowercase DOI the first search missed, with the uppercase spelling only', async () => {
      const { service, http, ctx } = makeService([
        searchRoute(
          answerByQuery((query) =>
            query.includes(`"${doiUpper}"`) ? searchBody([collisionDatasetHit]) : searchBody([]),
          ),
        ),
      ]);
      const result = await service.lookup(ids(lower, `doi:${lower}`), service.startBudget(), ctx);
      expect(requestedUrls(http).map(q)).toEqual([
        `doi:("${lower}" OR "${lower}")`,
        `doi:("${doiUpper}" OR "${doiUpper}")`,
      ]);
      expect(result.missing).toEqual([]);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.matchedInputs).toEqual([lower, `doi:${lower}`]);
    });

    it('retries only the DOIs that missed and leaves the other clauses out', async () => {
      const otherLower = '10.7483/opendata.cms.other.0001';
      const { service, http, ctx } = makeService([
        searchRoute(
          answerByQuery((query) => {
            if (query.includes(`"${doiUpper}"`) || query.includes(`"${lower}"`)) {
              return searchBody([collisionDatasetHit]);
            }
            return searchBody([]);
          }),
        ),
      ]);
      const result = await service.lookup(
        ids('6004', lower, otherLower),
        service.startBudget(),
        ctx,
      );
      expect(requestedUrls(http).map(q)).toEqual([
        `recid:(6004) OR doi:("${lower}" OR "${otherLower}")`,
        `doi:("${otherLower.toUpperCase()}")`,
      ]);
      expect(result.missing.map((id) => id.input)).toEqual([otherLower]);
    });

    it('does not retry a DOI that is already uppercase, or one the first search found', async () => {
      const { service, http, ctx } = makeService([searchRoute(jsonResponse(searchBody([])))]);
      await service.lookup(ids(doiUpper), service.startBudget(), ctx);
      expect(http.calls).toHaveLength(1);

      const found = makeService([searchRoute(jsonResponse(searchBody([collisionDatasetHit])))]);
      const result = await found.service.lookup(ids(lower), found.service.startBudget(), found.ctx);
      expect(found.http.calls).toHaveLength(1);
      expect(result.matches).toHaveLength(1);
    });

    it('reports a DOI still missing after the retry, with at most two requests', async () => {
      const { service, http, ctx } = makeService([searchRoute(jsonResponse(searchBody([])))]);
      const result = await service.lookup(ids(lower), service.startBudget(), ctx);
      expect(http.calls).toHaveLength(2);
      expect(result.missing.map((id) => id.input)).toEqual([lower]);
    });

    it('fails the call when the retry fails, never reporting the DOI missing', async () => {
      const { service, ctx } = makeService([
        searchRoute(jsonResponse(searchBody([])), true),
        searchRoute(new Response('down', { status: 503 })),
      ]);
      const failure = failureOf(
        await settle(() => service.lookup(ids(lower), service.startBudget(), ctx)),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('fails the call with rate_limited when the retry is rate limited', async () => {
      const { service, ctx } = makeService([
        searchRoute(jsonResponse(searchBody([])), true),
        searchRoute(new Response('', { status: 429, headers: { 'retry-after': '60' } })),
      ]);
      const failure = failureOf(
        await settle(() => service.lookup(ids(lower), service.startBudget(), ctx)),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(failure.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    });
  });

  it('treats a 400 on the query it built as an internal error naming the portal message', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(SYNTAX_ERROR_BODY, { status: 400 })),
    ]);
    await expect(service.lookup(ids('6004'), service.startBudget(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { upstreamMessage: 'The syntax of the search query is invalid.' },
    });
  });

  it('propagates rate limiting and unreadable bodies from the first search', async () => {
    const { service, ctx } = makeService([
      searchRoute(new Response('', { status: 429, headers: { 'retry-after': '60' } }), true),
      searchRoute(jsonResponse({ nope: true })),
    ]);
    const limited = failureOf(
      await settle(() => service.lookup(ids('6004'), service.startBudget(), ctx), 1_000),
    );
    expect(limited.data).toMatchObject({ reason: 'rate_limited' });
    await vi.advanceTimersByTimeAsync(61_000);
    const unreadable = failureOf(
      await settle(() => service.lookup(ids('6004'), service.startBudget(), ctx)),
    );
    expect(unreadable.data).toMatchObject({ reason: 'upstream_unreadable' });
  });
});

describe('findRecord', () => {
  it('searches q=recid:{n} with one hit and no files', async () => {
    const { service, http, ctx } = makeService([
      searchRoute(jsonResponse(searchBody([collisionDatasetHit]))),
    ]);
    const found = await service.findRecord('6004', service.startBudget(), ctx);
    expect(found?.id).toBe(6004);
    const url = requestedUrls(http)[0] as URL;
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'recid:6004',
      size: '1',
      skip_files: '1',
      ondemand: 'true',
    });
  });

  it('returns null for no hits, and for a hit with another recid', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(emptySearchBody), true),
      searchRoute(jsonResponse(searchBody([softwareHit]))),
    ]);
    expect(await service.findRecord('6004', service.startBudget(), ctx)).toBeNull();
    expect(await service.findRecord('6004', service.startBudget(), ctx)).toBeNull();
  });

  it('picks the hit whose recid matches among several', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(searchBody([softwareHit, collisionDatasetHit]))),
    ]);
    expect((await service.findRecord('6004', service.startBudget(), ctx))?.id).toBe(6004);
  });

  it('finds a prefixed recid with q=recid:{prefix}-{n}', async () => {
    const { service, http, ctx } = makeService([
      searchRoute(jsonResponse(searchBody([collisionDatasetHit, prefixedCmsHit]))),
    ]);
    expect((await service.findRecord('cms-93956', service.startBudget(), ctx))?.id).toBe(
      'cms-93956',
    );
    expect(q(requestedUrls(http)[0] as URL)).toBe('recid:cms-93956');
  });

  it('treats a 400 as an internal error', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(SYNTAX_ERROR_BODY, { status: 400 })),
    ]);
    await expect(service.findRecord('6004', service.startBudget(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
    });
  });

  it('escapes the portal text of a 400 in the message and keeps it as received in data', async () => {
    const body = '<img src=x> [a](https://evil.example)';
    const { service, ctx } = makeService([searchRoute(new Response(body, { status: 400 }))]);
    await expect(service.findRecord('6004', service.startBudget(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message:
        'CERN Open Data rejected a query this server built: &lt;img src=x&gt; \\[a\\](https://evil.example)',
      data: { upstreamMessage: body },
    });
  });
});

describe('getManifest', () => {
  it('returns the compact manifest and serves a repeat read from the cache', async () => {
    const { service, http, ctx } = makeService([recordRoute(jsonResponse(filesRecordBody))]);
    const first = await service.getManifest('6004', service.startBudget(), ctx);
    const second = await service.getManifest('6004', service.startBudget(), ctx);
    expect(first?.files.map((file) => file.key)).toEqual(['file_a.root', 'file_b.root']);
    expect(second).toBe(first);
    expect(http.calls).toHaveLength(1);
  });

  it('returns null on 404 and does not cache it', async () => {
    const { service, http, ctx } = makeService([
      recordRoute(jsonResponse(NOT_FOUND_BODY, { status: 404 }), true),
      recordRoute(jsonResponse(filesRecordBody)),
    ]);
    expect(await service.getManifest('6004', service.startBudget(), ctx)).toBeNull();
    expect(await service.getManifest('6004', service.startBudget(), ctx)).not.toBeNull();
    expect(http.calls).toHaveLength(2);
  });

  it('does not cache a failed read', async () => {
    const { service, http, ctx } = makeService([
      recordRoute(new Response('', { status: 503 }), true),
      recordRoute(new Response('', { status: 503 }), true),
      recordRoute(new Response('', { status: 503 }), true),
      recordRoute(jsonResponse(filesRecordBody)),
    ]);
    const failure = failureOf(
      await settle(() => service.getManifest('6004', service.startBudget(), ctx)),
    );
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(await service.getManifest('6004', service.startBudget(), ctx)).not.toBeNull();
    expect(http.calls).toHaveLength(4);
  });

  it('raises upstream_unreadable, unretried and uncached, for a file with no address', async () => {
    const broken = recordBody({ recid: '1', _files: [{ key: 'k', size: 1 }] });
    const { service, http, ctx } = makeService([recordRoute(jsonResponse(broken))]);
    await expect(service.getManifest('1', service.startBudget(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unreadable' },
    });
    await expect(service.getManifest('1', service.startBudget(), ctx)).rejects.toBeDefined();
    expect(http.calls).toHaveLength(2);
  });

  it('keeps each recid separate', async () => {
    const { service, http, ctx } = makeService([
      portalRoute('/api/records/6004', jsonResponse(filesRecordBody)),
      portalRoute('/api/records/24464', jsonResponse(indexedRecordBody)),
    ]);
    const budget = service.startBudget();
    expect((await service.getManifest('6004', budget, ctx))?.recid).toBe('6004');
    expect((await service.getManifest('24464', budget, ctx))?.indexes).toHaveLength(2);
    expect(http.calls).toHaveLength(2);
  });

  describe('cache lifetime', () => {
    it('expires an entry once its TTL has passed', async () => {
      const clock = fakeClock();
      const { service, http, ctx } = makeService([recordRoute(jsonResponse(filesRecordBody))], {
        now: clock.now,
        manifestCache: { ttlMs: 1_000 },
      });
      await service.getManifest('6004', service.startBudget(), ctx);
      clock.advance(999);
      await service.getManifest('6004', service.startBudget(), ctx);
      expect(http.calls).toHaveLength(1);
      clock.advance(1);
      await service.getManifest('6004', service.startBudget(), ctx);
      expect(http.calls).toHaveLength(2);
    });

    it('defaults to a 15 minute TTL', async () => {
      const clock = fakeClock();
      const { service, http, ctx } = makeService([recordRoute(jsonResponse(filesRecordBody))], {
        now: clock.now,
      });
      await service.getManifest('6004', service.startBudget(), ctx);
      clock.advance(15 * 60_000 - 1);
      await service.getManifest('6004', service.startBudget(), ctx);
      expect(http.calls).toHaveLength(1);
      clock.advance(1);
      await service.getManifest('6004', service.startBudget(), ctx);
      expect(http.calls).toHaveLength(2);
    });

    it('evicts the least recently used entry past the size, and a read refreshes recency', async () => {
      const fetchedRecids: string[] = [];
      const { service, ctx } = makeService(
        [
          recordRoute((request) => {
            const recid = new URL(request.url).pathname.split('/').pop() ?? '';
            fetchedRecids.push(recid);
            return jsonResponse(
              recordBody({ recid, _files: [{ key: 'k', uri: 'root://x/k', size: 1 }] }),
            );
          }),
        ],
        { manifestCache: { size: 2 } },
      );
      const read = (recid: string) => service.getManifest(recid, service.startBudget(), ctx);
      await read('1');
      await read('2');
      await read('1');
      expect(fetchedRecids).toEqual(['1', '2']);
      await read('3');
      expect(fetchedRecids).toEqual(['1', '2', '3']);
      await read('1');
      expect(fetchedRecids).toEqual(['1', '2', '3']);
      await read('2');
      expect(fetchedRecids).toEqual(['1', '2', '3', '2']);
    });

    it('holds 8 manifests by default', async () => {
      const fetchedRecids: string[] = [];
      const { service, ctx } = makeService([
        recordRoute((request) => {
          const recid = new URL(request.url).pathname.split('/').pop() ?? '';
          fetchedRecids.push(recid);
          return jsonResponse(recordBody({ recid }));
        }),
      ]);
      const read = (recid: string) => service.getManifest(recid, service.startBudget(), ctx);
      for (let recid = 1; recid <= 8; recid++) await read(String(recid));
      for (let recid = 1; recid <= 8; recid++) await read(String(recid));
      expect(fetchedRecids).toHaveLength(8);
      await read('9');
      await read('1');
      expect(fetchedRecids).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '1']);
    });
  });

  describe('children (umbrella records only)', () => {
    it('lists the isParentOf recids of a record with no files', async () => {
      const { service, ctx } = makeService([recordRoute(jsonResponse(umbrellaRecordBody))]);
      const manifest = await service.getManifest('80020', service.startBudget(), ctx);
      expect(manifest).toMatchObject({ files: [], indexes: [], children: ['80021', '80022'] });
    });

    it('leaves children unset for NANOAOD 30518, which holds files and points isParentOf at MINIAOD 30501', async () => {
      const { service, ctx } = makeService([recordRoute(jsonResponse(nanoaodRecordBody))]);
      const manifest = await service.getManifest('30518', service.startBudget(), ctx);
      expect(manifest?.files).toHaveLength(1);
      expect(manifest?.children).toEqual([]);
    });

    it('keeps the cached manifest identical, children included', async () => {
      const { service, ctx } = makeService([recordRoute(jsonResponse(umbrellaRecordBody))]);
      const first = await service.getManifest('80020', service.startBudget(), ctx);
      const second = await service.getManifest('80020', service.startBudget(), ctx);
      expect(second?.children).toEqual(first?.children);
    });
  });
});

describe('getIndex', () => {
  const BODIES = {
    '6004': filesRecordBody,
    '24464': indexedRecordBody,
    'atlas-160006': jetSet2RecordBody,
  };
  const indexRoutes = (bodies: typeof BODIES = BODIES) => [
    fileIndexRoute(bodies),
    recordSearchRoute(bodies),
  ];
  const indexPath = (recid: string, key: string) =>
    `/record/${recid}/file_index/${encodeURIComponent(key)}`;
  const searchPath = (recid: string) =>
    `/api/records/?q=recid%3A${recid}&size=1&skip_files=1&ondemand=true`;
  const paths = (http: ReturnType<typeof makeService>['http']) =>
    requestedUrls(http)
      .map((url) => `${url.pathname}${url.search}`)
      .sort();
  const HEAD_24464 = {
    recid: '24464',
    title: 'ATLAS DAOD_PHYSLITE sample',
    availability: 'partial',
    availability_details: { online: 2, on_demand: 2 },
  };

  it('reads the index route and the record search, never the record GET', async () => {
    const { service, http, ctx } = makeService(indexRoutes());
    const lookup = await service.getIndex(
      '24464',
      'ds_a_file_index.json',
      service.startBudget(),
      ctx,
    );
    expect(lookup).toEqual({
      kind: 'found',
      listing: {
        record: HEAD_24464,
        index: toManifest('24464', indexedRecordBody.metadata).indexes[0],
      },
    });
    expect(paths(http)).toEqual([searchPath('24464'), indexPath('24464', 'ds_a_file_index.json')]);
  });

  it('sends the key as one encoded path segment with no query string', async () => {
    const { service, http, ctx } = makeService(indexRoutes());
    await service.getIndex('24464', 'a b/c?d#e&qos=online.json', service.startBudget(), ctx);
    const index = requestedUrls(http).find((url) => url.pathname.includes('/file_index/'));
    expect(index?.pathname).toBe('/record/24464/file_index/a%20b%2Fc%3Fd%23e%26qos%3Donline.json');
    expect(index?.search).toBe('');
  });

  it('reads a prefixed record, whose members carry no key', async () => {
    const { service, http, ctx } = makeService(indexRoutes());
    const lookup = await service.getIndex(
      'atlas-160006',
      'training_files.json',
      service.startBudget(),
      ctx,
    );
    expect(paths(http)).toEqual([
      searchPath('atlas-160006'),
      indexPath('atlas-160006', 'training_files.json'),
    ]);
    if (lookup.kind !== 'found') throw new Error(`Expected found, got ${lookup.kind}`);
    expect(lookup.listing.record).toEqual({
      recid: 'atlas-160006',
      title: 'ATLAS multi-process simulation for ML-based jet flavour tagging (JetSet2)',
      availability: 'online',
    });
    expect(lookup.listing.index).toMatchObject({
      number_files: 3,
      size: 14_190_227_850_197,
      availability: {},
    });
    expect(lookup.listing.index.files.map((file) => file.filename)).toEqual([
      'jetset2-release_v1.pp_output_train-full_0.h5',
      'jetset2-release_v1.pp_output_train-full_1.h5',
      'jetset2-release_v1.pp_output_train-full_10.h5',
    ]);
    for (const file of lookup.listing.index.files) expect(file).not.toHaveProperty('key');
  });

  it('serves an index of a cached manifest with no request, and a miss as the index route would', async () => {
    const { service, http, ctx } = makeService([
      recordRoute(jsonResponse(indexedRecordBody)),
      ...indexRoutes(),
    ]);
    const manifest = await service.getManifest('24464', service.startBudget(), ctx);
    const found = await service.getIndex(
      '24464',
      'ds_b_file_index.json',
      service.startBudget(),
      ctx,
    );
    const missing = await service.getIndex('24464', 'nope.json', service.startBudget(), ctx);
    expect(found).toEqual({
      kind: 'found',
      listing: { record: HEAD_24464, index: manifest?.indexes[1] },
    });
    expect(missing).toEqual({ kind: 'index_not_found' });
    expect(http.calls).toHaveLength(1);
  });

  it.each([['.'], ['..'], ['a\ud800.json']])(
    'answers the dot segment or ill-formed key %j as index_not_found without a request',
    async (key) => {
      const { service, http, ctx } = makeService(indexRoutes());
      expect(await service.getIndex('24464', key, service.startBudget(), ctx)).toEqual({
        kind: 'index_not_found',
      });
      expect(http.calls).toHaveLength(0);
    },
  );

  it('settles a 404 as index_not_found when the search finds the record, else record_not_found', async () => {
    const { service, ctx } = makeService(indexRoutes());
    expect(await service.getIndex('6004', 'x.json', service.startBudget(), ctx)).toEqual({
      kind: 'index_not_found',
    });
    expect(await service.getIndex('999999', 'x.json', service.startBudget(), ctx)).toEqual({
      kind: 'record_not_found',
    });
  });

  it('lists an index the portal serves even when its search finds no hit, with the recid alone', async () => {
    const { service, ctx } = makeService([
      fileIndexRoute(BODIES),
      searchRoute(jsonResponse(emptySearchBody)),
    ]);
    const lookup = await service.getIndex(
      '24464',
      'ds_a_file_index.json',
      service.startBudget(),
      ctx,
    );
    expect(lookup.kind === 'found' && lookup.listing.record).toEqual({ recid: '24464' });
  });

  describe('cache', () => {
    it('serves the same index again with no request', async () => {
      const { service, http, ctx } = makeService(indexRoutes());
      const first = await service.getIndex(
        '24464',
        'ds_a_file_index.json',
        service.startBudget(),
        ctx,
      );
      const second = await service.getIndex(
        '24464',
        'ds_a_file_index.json',
        service.startBudget(),
        ctx,
      );
      expect(second).toEqual(first);
      expect(http.calls).toHaveLength(2);
    });

    it('reads another index of the same record with one request, the record search not repeated', async () => {
      const { service, http, ctx } = makeService(indexRoutes());
      await service.getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx);
      const other = await service.getIndex(
        '24464',
        'ds_b_file_index.json',
        service.startBudget(),
        ctx,
      );
      expect(other).toEqual({
        kind: 'found',
        listing: {
          record: HEAD_24464,
          index: toManifest('24464', indexedRecordBody.metadata).indexes[1],
        },
      });
      const missing = await service.getIndex('24464', 'nope.json', service.startBudget(), ctx);
      expect(missing).toEqual({ kind: 'index_not_found' });
      expect(paths(http)).toEqual([
        searchPath('24464'),
        indexPath('24464', 'ds_a_file_index.json'),
        indexPath('24464', 'ds_b_file_index.json'),
        indexPath('24464', 'nope.json'),
      ]);
    });

    it('expires after its TTL, and after 15 minutes by default, reading both again', async () => {
      const clock = fakeClock();
      const short = makeService(indexRoutes(), { now: clock.now, indexCache: { ttlMs: 1_000 } });
      const read = (service: CernOpenDataService, ctx = short.ctx) =>
        service.getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx);
      await read(short.service);
      clock.advance(999);
      await read(short.service);
      expect(short.http.calls).toHaveLength(2);
      clock.advance(1);
      await read(short.service);
      expect(short.http.calls).toHaveLength(4);

      const standard = makeService(indexRoutes(), { now: clock.now });
      await read(standard.service);
      clock.advance(15 * 60_000 - 1);
      await read(standard.service);
      expect(standard.http.calls).toHaveLength(2);
      clock.advance(1);
      await read(standard.service);
      expect(paths(standard.http)).toEqual([
        searchPath('24464'),
        searchPath('24464'),
        indexPath('24464', 'ds_a_file_index.json'),
        indexPath('24464', 'ds_a_file_index.json'),
      ]);
    });

    it('evicts the least recently used index past the size', async () => {
      const { service, http, ctx } = makeService(indexRoutes(), { indexCache: { size: 1 } });
      const read = (key: string) => service.getIndex('24464', key, service.startBudget(), ctx);
      await read('ds_a_file_index.json');
      await read('ds_b_file_index.json');
      await read('ds_a_file_index.json');
      expect(
        requestedUrls(http).filter((url) => url.pathname.includes('/file_index/')),
      ).toHaveLength(3);
    });

    it('does not cache an index read that a manifest of the record overtook in flight', async () => {
      const clock = fakeClock();
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { service, http, ctx } = makeService(
        [
          portalRoute(
            /\/file_index\//,
            async () => {
              await held;
              return jsonResponse(indexedRecordBody.metadata._file_indices?.[0]);
            },
            { once: true },
          ),
          recordRoute(jsonResponse(indexedRecordBody)),
          ...indexRoutes(),
        ],
        { now: clock.now, manifestCache: { ttlMs: 1_000 } },
      );
      const read = () =>
        service.getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx);
      const inFlight = read();
      await service.getManifest('24464', service.startBudget(), ctx);
      release();
      expect((await inFlight).kind).toBe('found');
      clock.advance(1_000);
      await read();
      expect(paths(http)).toEqual([
        '/api/records/24464',
        searchPath('24464'),
        searchPath('24464'),
        indexPath('24464', 'ds_a_file_index.json'),
        indexPath('24464', 'ds_a_file_index.json'),
      ]);
    });

    it('does not cache a 404 or a failed read', async () => {
      const { service, http, ctx } = makeService([
        portalRoute(/\/file_index\//, new Response('', { status: 503 }), { once: true }),
        portalRoute(/\/file_index\//, new Response('', { status: 503 }), { once: true }),
        portalRoute(/\/file_index\//, new Response('', { status: 503 }), { once: true }),
        ...indexRoutes(),
      ]);
      const failure = failureOf(
        await settle(() =>
          service.getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx),
        ),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      await service.getIndex('24464', 'nope.json', service.startBudget(), ctx);
      await service.getIndex('24464', 'nope.json', service.startBudget(), ctx);
      const found = await service.getIndex(
        '24464',
        'ds_a_file_index.json',
        service.startBudget(),
        ctx,
      );
      expect(found.kind).toBe('found');
      expect(
        requestedUrls(http).filter((url) => url.pathname.includes('/file_index/')),
      ).toHaveLength(6);
    });

    it('is cleared by dispose', async () => {
      const { service, ctx } = makeService(indexRoutes());
      await service.getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx);
      service.dispose();
      await expect(
        service.getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    });
  });

  describe('a failure in either read fails the call with its own reason', () => {
    it('raises the index route 429 as rate_limited while the search succeeds', async () => {
      const { service, ctx } = makeService([
        portalRoute(
          /\/file_index\//,
          new Response('', { status: 429, headers: { 'retry-after': '20' } }),
        ),
        recordSearchRoute(BODIES),
      ]);
      await expect(
        service.getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited', retryAfter: 20 },
      });
    });

    it('raises a search 404 as upstream_unreadable while the index answers', async () => {
      const { service, ctx } = makeService([
        fileIndexRoute(BODIES),
        searchRoute(jsonResponse(NOT_FOUND_BODY, { status: 404 })),
      ]);
      await expect(
        service.getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unreadable' },
      });
    });

    it('raises a search 429 as rate_limited while the index answers', async () => {
      const { service, ctx } = makeService([
        fileIndexRoute(BODIES),
        searchRoute(new Response('', { status: 429, headers: { 'retry-after': '15' } })),
      ]);
      await expect(
        service.getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx),
      ).rejects.toMatchObject({ data: { reason: 'rate_limited', retryAfter: 15 } });
    });

    it('raises an index member without a URI as upstream_unreadable, the index uncached', async () => {
      const broken = recordBody({
        recid: '24464',
        _file_indices: [{ key: 'k.json', files: [{ filename: 'f.root', size: 1 }] }],
      });
      const { service, http, ctx } = makeService(indexRoutes({ ...BODIES, '24464': broken }));
      for (let i = 0; i < 2; i++) {
        await expect(
          service.getIndex('24464', 'k.json', service.startBudget(), ctx),
        ).rejects.toMatchObject({ data: { reason: 'upstream_unreadable' } });
      }
      expect(paths(http)).toEqual([
        searchPath('24464'),
        indexPath('24464', 'k.json'),
        indexPath('24464', 'k.json'),
      ]);
    });

    it('rejects with the cancellation when the caller cancels while the search is in flight, never a partial listing', async () => {
      const controller = new AbortController();
      const ctx = createMockContext({ signal: controller.signal });
      const { service, http } = makeService(
        [
          fileIndexRoute(BODIES),
          searchRoute(
            (request) =>
              new Promise<Response>((_resolve, reject) => {
                request.signal.addEventListener('abort', () => reject(request.signal.reason), {
                  once: true,
                });
              }),
          ),
        ],
        {},
        ctx,
      );
      const pending = service
        .getIndex('24464', 'ds_a_file_index.json', service.startBudget(), ctx)
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await vi.advanceTimersByTimeAsync(10);
      expect(http.calls).toHaveLength(2);
      controller.abort(new Error('caller left'));
      const settled = await pending;
      expect(settled).toMatchObject({ ok: false, error: { message: 'caller left' } });
    });
  });
});

describe('getDoc', () => {
  it('returns the doc body as the portal sent it', async () => {
    const body = { id: 'cms-guide-docker', metadata: docHit.metadata };
    const { service, ctx } = makeService([docRoute(jsonResponse(body))]);
    const doc = await service.getDoc('cms-guide-docker', service.startBudget(), ctx);
    expect(doc).toEqual(body);
  });

  it('returns null for a slug the portal does not know', async () => {
    const { service, ctx } = makeService([docRoute(jsonResponse(NOT_FOUND_BODY, { status: 404 }))]);
    expect(await service.getDoc('nope', service.startBudget(), ctx)).toBeNull();
  });
});

describe('getValidatedRunLists', () => {
  it('searches the collection with files included, sorted by recid', async () => {
    const { service, http, ctx } = makeService([
      searchRoute(jsonResponse(validatedRunsSearchBody())),
    ]);
    const lists = await service.getValidatedRunLists(service.startBudget(), ctx);
    expect(Object.fromEntries((requestedUrls(http)[0] as URL).searchParams)).toEqual({
      collections: 'CMS-Validated-Runs',
      size: '100',
      ondemand: 'true',
    });
    expect(lists.map((list) => list.recid)).toEqual([
      '1000',
      '1002',
      '1005',
      '14202',
      '14203',
      '14208',
      '14209',
    ]);
  });

  it('orders a prefixed list recid by its number among the numeric ones', async () => {
    const specs: ListSpec[] = [
      { recid: '14202', key: 'Cert_b_JSON.txt', periods: ['RunB'] },
      { recid: 'cms-93999', key: 'Cert_e_JSON.txt', periods: ['RunE'] },
      { recid: 'cms-1001', key: 'Cert_a2_JSON.txt', periods: ['RunA'] },
      { recid: '1000', key: 'Cert_a_JSON.txt', periods: ['RunA'] },
      { recid: '93950', key: 'Cert_d_JSON.txt', periods: ['RunD'] },
    ];
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(validatedRunsSearchBody(specs))),
    ]);
    const lists = await service.getValidatedRunLists(service.startBudget(), ctx);
    expect(lists.map((list) => list.recid)).toEqual([
      '1000',
      'cms-1001',
      '14202',
      '93950',
      'cms-93999',
    ]);
  });

  it('maps each list with its variant, stem, periods and energy', async () => {
    const { service, ctx } = makeService([searchRoute(jsonResponse(validatedRunsSearchBody()))]);
    const lists = await service.getValidatedRunLists(service.startBudget(), ctx);
    const muons = lists.find((list) => list.recid === '1005');
    expect(muons).toMatchObject({
      variant: 'muons_only',
      stem: 'Cert_190456-208686_8TeV_22Jan2013ReReco_Collisions12_JSON',
      run_periods: ['Run2012A', 'Run2012B', 'Run2012C', 'Run2012D'],
      collision_energy: '8TeV',
    });
    expect(lists.find((list) => list.recid === '1000')).not.toHaveProperty('collision_energy');
  });

  it('pairs the validated-run twins 14208 and 14209 by key stem, whichever way round', async () => {
    const { service, ctx } = makeService([searchRoute(jsonResponse(validatedRunsSearchBody()))]);
    const lists = await service.getValidatedRunLists(service.startBudget(), ctx);
    const byRecid = (recid: string) => lists.find((list) => list.recid === recid);
    const full = byRecid('14208');
    const muons = byRecid('14209');
    expect(full?.file_key).toMatch(/_JSON_v2\.txt$/);
    expect(muons?.file_key).toMatch(/_JSON_MuonPhys\.txt$/);
    expect(full && twinOf(full, lists)?.recid).toBe('14209');
    expect(muons && twinOf(muons, lists)?.recid).toBe('14208');
    expect(byRecid('1000') && twinOf(byRecid('1000') as never, lists)).toBeUndefined();
  });

  it('skips collection hits that carry no file key', async () => {
    const noFile = hit('5', { recid: '5', title: 'No file', _files: [] });
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(searchBody([noFile, validatedListHit(LIST_SPECS[0] as never)]))),
    ]);
    expect(
      (await service.getValidatedRunLists(service.startBudget(), ctx)).map((l) => l.recid),
    ).toEqual(['1002']);
  });

  it('returns an empty list for an empty collection', async () => {
    const { service, ctx } = makeService([searchRoute(jsonResponse(emptySearchBody))]);
    expect(await service.getValidatedRunLists(service.startBudget(), ctx)).toEqual([]);
  });

  describe('cache', () => {
    it('serves a repeat read from one cached request', async () => {
      const { service, http, ctx } = makeService([
        searchRoute(jsonResponse(validatedRunsSearchBody())),
      ]);
      const first = await service.getValidatedRunLists(service.startBudget(), ctx);
      const second = await service.getValidatedRunLists(service.startBudget(), ctx);
      expect(second).toBe(first);
      expect(http.calls).toHaveLength(1);
    });

    it('expires after listCacheTtlMs, and after 15 minutes by default', async () => {
      const clock = fakeClock();
      const short = makeService([searchRoute(jsonResponse(validatedRunsSearchBody()))], {
        now: clock.now,
        listCacheTtlMs: 1_000,
      });
      await short.service.getValidatedRunLists(short.service.startBudget(), short.ctx);
      clock.advance(999);
      await short.service.getValidatedRunLists(short.service.startBudget(), short.ctx);
      expect(short.http.calls).toHaveLength(1);
      clock.advance(1);
      await short.service.getValidatedRunLists(short.service.startBudget(), short.ctx);
      expect(short.http.calls).toHaveLength(2);

      const fallback = makeService([searchRoute(jsonResponse(validatedRunsSearchBody()))], {
        now: clock.now,
      });
      await fallback.service.getValidatedRunLists(fallback.service.startBudget(), fallback.ctx);
      clock.advance(15 * 60_000 - 1);
      await fallback.service.getValidatedRunLists(fallback.service.startBudget(), fallback.ctx);
      expect(fallback.http.calls).toHaveLength(1);
      clock.advance(1);
      await fallback.service.getValidatedRunLists(fallback.service.startBudget(), fallback.ctx);
      expect(fallback.http.calls).toHaveLength(2);
    });

    it('does not cache a failed read', async () => {
      const { service, http, ctx } = makeService([
        searchRoute(new Response('', { status: 503 }), true),
        searchRoute(new Response('', { status: 503 }), true),
        searchRoute(new Response('', { status: 503 }), true),
        searchRoute(jsonResponse(validatedRunsSearchBody())),
      ]);
      failureOf(await settle(() => service.getValidatedRunLists(service.startBudget(), ctx)));
      expect(await service.getValidatedRunLists(service.startBudget(), ctx)).toHaveLength(7);
      expect(http.calls).toHaveLength(4);
    });
  });

  it('treats a 400 on its own query as an internal error', async () => {
    const { service, ctx } = makeService([
      searchRoute(jsonResponse(SYNTAX_ERROR_BODY, { status: 400 })),
    ]);
    await expect(service.getValidatedRunLists(service.startBudget(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
    });
  });
});

describe('getRunList', () => {
  const key = LIST_SPECS[0]?.key ?? '';

  it('reads the run → ranges object from the file route', async () => {
    const { service, http, ctx } = makeService([fileRoute(jsonResponse(RUN_LIST_BODY))]);
    expect(await service.getRunList('1002', key, service.startBudget(), ctx)).toEqual(
      RUN_LIST_BODY,
    );
    expect((requestedUrls(http)[0] as URL).pathname).toBe(`/record/1002/files/${key}`);
  });

  it('reads a list served as text/plain', async () => {
    const { service, ctx } = makeService([
      fileRoute(
        new Response(JSON.stringify(RUN_LIST_BODY), { headers: { 'content-type': 'text/plain' } }),
      ),
    ]);
    expect(await service.getRunList('1002', key, service.startBudget(), ctx)).toEqual(
      RUN_LIST_BODY,
    );
  });

  it('accepts an empty list', async () => {
    const { service, ctx } = makeService([fileRoute(jsonResponse({}))]);
    expect(await service.getRunList('1002', key, service.startBudget(), ctx)).toEqual({});
  });

  it.each([
    ['an array', []],
    ['a non-numeric run', { abc: [[1, 2]] }],
    ['an empty run key', { '': [[1, 2]] }],
    ['ranges that are not a list', { '190456': 'x' }],
    ['a range with three numbers', { '190456': [[1, 2, 3]] }],
    ['a range with one number', { '190456': [[1]] }],
    ['a fractional lumi section', { '190456': [[1.5, 2]] }],
    ['a string lumi section', { '190456': [['1', '2']] }],
    ['null', null],
  ])('raises upstream_unreadable for %s, after retries', async (_name, body) => {
    const { service, http, ctx } = makeService([fileRoute(jsonResponse(body))]);
    const failure = failureOf(
      await settle(() => service.getRunList('1002', key, service.startBudget(), ctx)),
    );
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(http.calls).toHaveLength(3);
  });

  describe('404 for a key the collection listed', () => {
    it('throws upstream_unreadable naming the list and file, without retry', async () => {
      const { service, http, ctx } = makeService([
        fileRoute(new Response('<html>404</html>', { status: 404 })),
      ]);
      await expect(
        service.getRunList('1002', key, service.startBudget(), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unreadable', recid: '1002', key },
      });
      expect(http.calls).toHaveLength(1);
    });

    it('escapes the key and recid in the message and keeps them as received in data', async () => {
      const { service, ctx } = makeService([
        portalRoute(/^\/record\/[^/]+\/files\/.+/, new Response('', { status: 404 })),
      ]);
      await expect(
        service.getRunList('7<b>', '[k](https://evil.example)', service.startBudget(), ctx),
      ).rejects.toMatchObject({
        message:
          'CERN Open Data answered 404 for file \\[k\\](https://evil.example) of validated-run list 7&lt;b&gt;, which the collection lists.',
        data: { recid: '7<b>', key: '[k](https://evil.example)' },
      });
    });

    it('clears the collection cache so the next read refetches the lists', async () => {
      const { service, http, ctx } = makeService([
        searchRoute(jsonResponse(validatedRunsSearchBody())),
        fileRoute(new Response('', { status: 404 })),
      ]);
      await service.getValidatedRunLists(service.startBudget(), ctx);
      await service.getValidatedRunLists(service.startBudget(), ctx);
      expect(http.calls).toHaveLength(1);

      await expect(
        service.getRunList('1002', key, service.startBudget(), ctx),
      ).rejects.toBeDefined();
      await service.getValidatedRunLists(service.startBudget(), ctx);
      expect(http.calls.map((call) => new URL(call.request.url).pathname)).toEqual([
        '/api/records/',
        `/record/1002/files/${key}`,
        '/api/records/',
      ]);
    });
  });
});

describe('construction', () => {
  it('works with no options, using the global fetch', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ id: 'x', metadata: {} }));
    const service = new CernOpenDataService();
    expect(await service.getDoc('x', service.startBudget(), createMockContext())).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
    service.dispose();
  });
});
