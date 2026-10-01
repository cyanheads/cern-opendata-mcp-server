/**
 * @fileoverview Tests for the CernOpenData HTTP boundary: request shape, the
 * per-route status accept-list, byte ceilings, envelope checks and retry, the
 * 429 mapping, the pacer and header-gate sheds, the per-call budget and
 * cancellation. Upstream I/O is a strict fetch fake; retries run on fake timers.
 * @module tests/services/cern-opendata/service-boundary.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CernOpenDataService } from '@/services/cern-opendata/cern-opendata-service.js';
import type { Budget } from '@/services/cern-opendata/types.js';
import {
  failureOf,
  fakeClock,
  makeService,
  requestedUrls,
  settle,
} from '../../fixtures/cern-opendata-harness.js';
import {
  docHit,
  emptySearchBody,
  filesRecordBody,
  jsonResponse,
  NOT_FOUND_BODY,
  PORTAL,
  portalRoute,
  RANGE_ERROR_BODY,
  RUN_LIST_BODY,
  rateLimitHeaders,
  SYNTAX_ERROR_BODY,
  searchBody,
  WINDOW_ERROR_BODY,
} from '../../fixtures/cern-opendata-upstream.js';

const MiB = 1024 * 1024;
const DOC_BODY = { id: 'cms-guide-docker', metadata: docHit.metadata };

const docRoute = (respond: Parameters<typeof portalRoute>[1], once = false) =>
  portalRoute(/^\/api\/docs\/.+/, respond, { once });
const searchRoute = (respond: Parameters<typeof portalRoute>[1], once = false) =>
  portalRoute('/api/records/', respond, { once });
const recordRoute = (respond: Parameters<typeof portalRoute>[1], once = false) =>
  portalRoute(/^\/api\/records\/\d+$/, respond, { once });
const fileRoute = (respond: Parameters<typeof portalRoute>[1], once = false) =>
  portalRoute(/^\/record\/\d+\/files\/.+/, respond, { once });

/** A body of exactly `bytes` bytes that is a valid doc envelope. */
function docBodyOfSize(bytes: number): Uint8Array {
  const prefix = '{"metadata":{"pad":"';
  const suffix = '"}}';
  return new TextEncoder().encode(
    `${prefix}${'a'.repeat(bytes - prefix.length - suffix.length)}${suffix}`,
  );
}

describe('request shape', () => {
  it('sends GET with the configured User-Agent and a JSON accept header', async () => {
    const { service, http, ctx } = makeService([docRoute(jsonResponse(DOC_BODY))], {
      userAgent: 'cern-opendata-mcp-server/9.9.9',
    });
    await service.getDoc('cms-guide-docker', service.startBudget(), ctx);
    const { request } = http.calls[0] ?? {};
    expect(request?.method).toBe('GET');
    expect(request?.headers.get('user-agent')).toBe('cern-opendata-mcp-server/9.9.9');
    expect(request?.headers.get('accept')).toBe('application/json');
  });

  it('identifies itself even without a configured User-Agent', async () => {
    const { service, http, ctx } = makeService([docRoute(jsonResponse(DOC_BODY))]);
    await service.getDoc('x', service.startBudget(), ctx);
    expect(http.calls[0]?.request.headers.get('user-agent')).toBe('cern-opendata-mcp-server');
  });

  it('encodes the slug, recid and file key into the path', async () => {
    const { service, http, ctx } = makeService([
      docRoute(jsonResponse(DOC_BODY)),
      recordRoute(jsonResponse(filesRecordBody)),
      fileRoute(jsonResponse(RUN_LIST_BODY)),
    ]);
    const budget = service.startBudget();
    await service.getDoc('a b/c?d#e', budget, ctx);
    await service.getManifest('6004', budget, ctx);
    await service.getRunList('1002', 'Cert 1/2?x#y.txt', budget, ctx);
    expect(http.calls.map((call) => new URL(call.request.url).pathname)).toEqual([
      '/api/docs/a%20b%2Fc%3Fd%23e',
      '/api/records/6004',
      '/record/1002/files/Cert%201%2F2%3Fx%23y.txt',
    ]);
  });

  it('only ever talks to the portal origin', async () => {
    const { service, http, ctx } = makeService([searchRoute(jsonResponse(emptySearchBody))]);
    await service.search({ q: 'x', size: 1 }, service.startBudget(), ctx);
    expect(requestedUrls(http).every((url) => url.origin === PORTAL)).toBe(true);
  });
});

describe('per-route accept-list', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('search accepts 200, 400 and 404', () => {
    it('returns a page for 200', async () => {
      const { service, ctx } = makeService([
        searchRoute(jsonResponse(searchBody([docHit], { total: 1 }))),
      ]);
      const outcome = await service.search({ q: 'x', size: 10 }, service.startBudget(), ctx);
      expect(outcome.kind).toBe('page');
    });

    it('returns the portal 400 as a rejection, not an error, and does not retry it', async () => {
      const { service, http, ctx } = makeService([
        searchRoute(jsonResponse(SYNTAX_ERROR_BODY, { status: 400 })),
      ]);
      const outcome = await service.search({ q: 'a AND', size: 10 }, service.startBudget(), ctx);
      expect(outcome).toEqual({
        kind: 'rejected',
        rejection: { status: 400, message: 'The syntax of the search query is invalid.' },
      });
      expect(http.calls).toHaveLength(1);
    });

    it('keeps the 400 field errors and the page-window message', async () => {
      const { service, ctx } = makeService([
        searchRoute(jsonResponse(RANGE_ERROR_BODY, { status: 400 }), true),
        searchRoute(jsonResponse(WINDOW_ERROR_BODY, { status: 400 })),
      ]);
      const budget = service.startBudget();
      expect(await service.search({ year: '2012', size: 10 }, budget, ctx)).toEqual({
        kind: 'rejected',
        rejection: {
          status: 400,
          message: 'Validation error.',
          errors: [{ field: 'date_created', message: 'Invalid range format.' }],
        },
      });
      expect(await service.search({ page: 2000, size: 10 }, budget, ctx)).toEqual({
        kind: 'rejected',
        rejection: { status: 400, message: 'Maximum number of 10000 results have been reached.' },
      });
    });

    it('filters malformed entries out of the 400 field errors', async () => {
      const { service, ctx } = makeService([
        searchRoute(
          jsonResponse(
            {
              message: 'Invalid pagination parameters.',
              errors: [{ field: 'size', message: 'bad' }, 'junk', null, { field: 5 }, {}],
            },
            { status: 400 },
          ),
        ),
      ]);
      const outcome = await service.search({ size: 0 }, service.startBudget(), ctx);
      expect(outcome).toMatchObject({
        kind: 'rejected',
        rejection: { errors: [{ field: 'size', message: 'bad' }, {}, {}] },
      });
    });

    it('uses a non-JSON 400 body as the message, capped, and a blank one as Bad request.', async () => {
      const { service, ctx } = makeService([
        searchRoute(new Response(`  ${'x'.repeat(800)}  `, { status: 400 }), true),
        searchRoute(new Response('', { status: 400 }), true),
        searchRoute(jsonResponse({ detail: 'no message field' }, { status: 400 })),
      ]);
      const budget = service.startBudget();
      const long = await service.search({ size: 1 }, budget, ctx);
      expect(long.kind === 'rejected' && long.rejection.message).toBe('x'.repeat(500));
      const blank = await service.search({ size: 1 }, budget, ctx);
      expect(blank.kind === 'rejected' && blank.rejection.message).toBe('Bad request.');
      const noMessage = await service.search({ size: 1 }, budget, ctx);
      expect(noMessage.kind === 'rejected' && noMessage.rejection.message).toContain(
        'no message field',
      );
    });

    it('reports a search 404 as an unreadable portal answer, not a missing record, without retry', async () => {
      const { service, http, ctx } = makeService([
        searchRoute(jsonResponse(NOT_FOUND_BODY, { status: 404 })),
      ]);
      await expect(service.search({ size: 1 }, service.startBudget(), ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unreadable' },
      });
      expect(http.calls).toHaveLength(1);
    });

    it.each([
      [403, JsonRpcErrorCode.Forbidden],
      [401, JsonRpcErrorCode.Unauthorized],
    ])(
      'maps an unlisted status %i through the HTTP error classifier, without retry',
      async (status, code) => {
        const { service, http, ctx } = makeService([searchRoute(new Response('nope', { status }))]);
        await expect(service.search({ size: 1 }, service.startBudget(), ctx)).rejects.toMatchObject(
          {
            code,
            data: { status },
          },
        );
        expect(http.calls).toHaveLength(1);
      },
    );
  });

  describe.each([
    ['record', 'getManifest', recordRoute],
    ['doc', 'getDoc', docRoute],
  ] as const)('%s accepts 200 and 404', (_route, method, routeOf) => {
    const call = (
      service: CernOpenDataService,
      budget: Budget,
      ctx: ReturnType<typeof createMockContext>,
    ) =>
      method === 'getManifest'
        ? service.getManifest('6004', budget, ctx)
        : service.getDoc('cms-guide-docker', budget, ctx);

    it('returns null for 404 without retry', async () => {
      const { service, http, ctx } = makeService([
        routeOf(jsonResponse(NOT_FOUND_BODY, { status: 404 })),
      ]);
      expect(await call(service, service.startBudget(), ctx)).toBeNull();
      expect(http.calls).toHaveLength(1);
    });

    it('treats a 400 as an error, not a result', async () => {
      const { service, http, ctx } = makeService([
        routeOf(jsonResponse({ status: 400, message: 'bad' }, { status: 400 })),
      ]);
      await expect(call(service, service.startBudget(), ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { status: 400 },
      });
      expect(http.calls).toHaveLength(1);
    });
  });

  describe('file accepts 200 and 404', () => {
    it('treats a 400 as an error', async () => {
      const { service, ctx } = makeService([
        fileRoute(jsonResponse({ status: 400, message: 'bad' }, { status: 400 })),
      ]);
      await expect(
        service.getRunList('1002', 'k.txt', service.startBudget(), ctx),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    });
  });

  describe('server errors', () => {
    it.each([
      [500, JsonRpcErrorCode.ServiceUnavailable],
      [502, JsonRpcErrorCode.ServiceUnavailable],
      [503, JsonRpcErrorCode.ServiceUnavailable],
      [504, JsonRpcErrorCode.Timeout],
    ])('retries a %i twice and then fails with the mapped code', async (status, code) => {
      const { service, http, ctx } = makeService([docRoute(new Response('down', { status }))]);
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx)),
      );
      expect(failure.code).toBe(code);
      expect(failure.data).toMatchObject({ status, retryAttempts: 3 });
      expect(http.calls).toHaveLength(3);
    });

    it('does not retry a 501', async () => {
      const { service, http, ctx } = makeService([docRoute(new Response('', { status: 501 }))]);
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx)),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(http.calls).toHaveLength(1);
    });

    it('recovers when a retry succeeds', async () => {
      const { service, http, ctx } = makeService([
        docRoute(new Response('down', { status: 503 }), true),
        docRoute(jsonResponse(DOC_BODY)),
      ]);
      const settled = await settle(() => service.getDoc('x', service.startBudget(), ctx));
      expect(settled.ok && settled.value?.metadata.slug).toBe('cms-guide-docker');
      expect(http.calls).toHaveLength(2);
    });

    // The portal sends `retry-after: 60` on every response; Decision 10 says only a 429 reads it.
    it('retries a 503 that carries the portal-wide retry-after: 60 header', async () => {
      const { service, http, ctx } = makeService([
        docRoute(new Response('down', { status: 503, headers: { 'retry-after': '60' } }), true),
        docRoute(jsonResponse(DOC_BODY)),
      ]);
      const settled = await settle(() => service.getDoc('x', service.startBudget(), ctx));
      expect(settled.ok).toBe(true);
      expect(http.calls).toHaveLength(2);
    });
  });

  describe('network failures', () => {
    it('wraps a failed connection as ServiceUnavailable with the cause, after three attempts', async () => {
      const cause = new TypeError('fetch failed');
      const fetchSpy = vi.fn(() => Promise.reject(cause));
      const service = new CernOpenDataService({ fetch: fetchSpy as unknown as typeof fetch });
      const ctx = createMockContext();
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx)),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(failure.message).toContain('Could not reach CERN Open Data');
      expect(failure.message).toContain('fetch failed');
      expect(failure.data).toMatchObject({ retryAttempts: 3 });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('recovers when the connection returns', async () => {
      const calls: number[] = [];
      const fetchFake = vi.fn(async () => {
        calls.push(calls.length);
        if (calls.length === 1) throw new TypeError('socket hang up');
        return jsonResponse(DOC_BODY);
      });
      const service = new CernOpenDataService({ fetch: fetchFake as unknown as typeof fetch });
      const ctx = createMockContext();
      const settled = await settle(() => service.getDoc('x', service.startBudget(), ctx));
      expect(settled.ok).toBe(true);
      expect(fetchFake).toHaveBeenCalledTimes(2);
    });
  });
});

describe('bounded reads and envelope checks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('byte ceilings', () => {
    it.each([
      [
        'search',
        8 * MiB,
        (s: CernOpenDataService, b: Budget, c: ReturnType<typeof createMockContext>) =>
          s.search({ size: 1 }, b, c),
        searchRoute,
      ],
      [
        'record',
        32 * MiB,
        (s: CernOpenDataService, b: Budget, c: ReturnType<typeof createMockContext>) =>
          s.getManifest('1', b, c),
        recordRoute,
      ],
      [
        'doc',
        2 * MiB,
        (s: CernOpenDataService, b: Budget, c: ReturnType<typeof createMockContext>) =>
          s.getDoc('x', b, c),
        docRoute,
      ],
      [
        'file',
        2 * MiB,
        (s: CernOpenDataService, b: Budget, c: ReturnType<typeof createMockContext>) =>
          s.getRunList('1', 'k', b, c),
        fileRoute,
      ],
    ] as const)(
      '%s: a declared content-length over the ceiling is unreadable and not retried',
      async (_name, limit, run, routeOf) => {
        const { service, http, ctx } = makeService([
          routeOf(() => new Response('{}', { headers: { 'content-length': String(limit + 1) } })),
        ]);
        const failure = failureOf(
          await settle(async () => await run(service, service.startBudget(), ctx)),
        );
        expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(failure.data).toMatchObject({
          reason: 'upstream_unreadable',
          retryable: false,
          limitBytes: limit,
        });
        expect(http.calls).toHaveLength(1);
      },
    );

    it('doc: a streamed body past 2 MiB with no content-length is unreadable and not retried', async () => {
      const { service, http, ctx } = makeService([
        docRoute(() => new Response(docBodyOfSize(2 * MiB + 1))),
      ]);
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx)),
      );
      expect(failure.data).toMatchObject({ reason: 'upstream_unreadable', retryable: false });
      expect(failure.message).toContain('2 MiB');
      expect(http.calls).toHaveLength(1);
    });

    it('doc: a body of exactly 2 MiB is read', async () => {
      const { service, ctx } = makeService([docRoute(() => new Response(docBodyOfSize(2 * MiB)))]);
      const doc = await service.getDoc('x', service.startBudget(), ctx);
      expect(doc?.metadata).toBeDefined();
    });

    it('search: 8 MiB + 1 byte is unreadable', async () => {
      const { service, ctx } = makeService([
        searchRoute(() => new Response(new Uint8Array(8 * MiB + 1).fill(97))),
      ]);
      const failure = failureOf(
        await settle(() => service.search({ size: 1 }, service.startBudget(), ctx)),
      );
      expect(failure.data).toMatchObject({ reason: 'upstream_unreadable', limitBytes: 8 * MiB });
    });

    it('applies the ceiling to a 400 body too', async () => {
      const { service, ctx } = makeService([
        searchRoute(() => new Response(new Uint8Array(8 * MiB + 1).fill(97), { status: 400 })),
      ]);
      const failure = failureOf(
        await settle(() => service.search({ size: 1 }, service.startBudget(), ctx)),
      );
      expect(failure.data).toMatchObject({ reason: 'upstream_unreadable', retryable: false });
    });

    it('stops reading a stream once it is over the ceiling', async () => {
      let pulls = 0;
      let cancelled = false;
      const chunk = new Uint8Array(MiB).fill(97);
      const { service, ctx } = makeService([
        docRoute(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  pulls += 1;
                  controller.enqueue(chunk);
                },
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        ),
      ]);
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx)),
      );
      expect(failure.data).toMatchObject({ retryable: false });
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(10);
    });
  });

  describe('decoding', () => {
    it('decodes a multi-byte character split across stream chunks', async () => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ metadata: { title: 'Zeeman é – µ' } }),
      );
      const split = bytes.indexOf(0xc3) + 1;
      const { service, ctx } = makeService([
        docRoute(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes.slice(0, split));
                  controller.enqueue(bytes.slice(split));
                  controller.close();
                },
              }),
            ),
        ),
      ]);
      const doc = await service.getDoc('x', service.startBudget(), ctx);
      expect(doc?.metadata.title).toBe('Zeeman é – µ');
    });
  });

  describe('unreadable bodies are retried', () => {
    it('fails an HTML page served with 200 as upstream_unreadable after three attempts', async () => {
      const { service, http, ctx } = makeService([
        docRoute(new Response('<html><body>Bad gateway</body></html>')),
      ]);
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx)),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(failure.data).toMatchObject({ reason: 'upstream_unreadable', retryAttempts: 3 });
      expect(failure.data).not.toHaveProperty('retryable');
      expect(failure.message).toContain('not JSON');
      expect(failure.cause).toBeDefined();
      expect(http.calls).toHaveLength(3);
    });

    it('recovers when a later attempt returns JSON', async () => {
      const { service, http, ctx } = makeService([
        docRoute(new Response('<html>oops</html>'), true),
        docRoute(jsonResponse(DOC_BODY)),
      ]);
      const settled = await settle(() => service.getDoc('x', service.startBudget(), ctx));
      expect(settled.ok).toBe(true);
      expect(http.calls).toHaveLength(2);
    });

    it.each([
      ['an empty body', ''],
      ['null', 'null'],
      ['an array', '[]'],
      ['a string', '"x"'],
    ])('rejects %s as an unreadable doc', async (_name, body) => {
      const { service, ctx } = makeService([docRoute(new Response(body))]);
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx)),
      );
      expect(failure.data).toMatchObject({ reason: 'upstream_unreadable' });
    });

    it.each([
      ['no metadata', {}],
      ['null metadata', { metadata: null }],
      ['array metadata', { metadata: [] }],
    ])('rejects a record body with %s', async (_name, body) => {
      const { service, ctx } = makeService([recordRoute(jsonResponse(body))]);
      const failure = failureOf(
        await settle(() => service.getManifest('1', service.startBudget(), ctx)),
      );
      expect(failure.data).toMatchObject({ reason: 'upstream_unreadable' });
      expect(failure.message).toContain('record envelope');
    });

    it.each([
      ['an empty object', {}],
      ['hits without a list', { hits: { total: 1 } }],
      ['a string total', { hits: { hits: [], total: '5' } }],
      ['a missing total', { hits: { hits: [] } }],
      ['hits that are not records', { hits: { hits: [1], total: 1 } }],
      ['a hit without metadata', { hits: { hits: [{ id: 1 }], total: 1 } }],
      ['a hit with null metadata', { hits: { hits: [{ id: 1, metadata: null }], total: 1 } }],
      ['hits as an object', { hits: { hits: {}, total: 1 } }],
    ])('rejects a search body with %s', async (_name, body) => {
      const { service, http, ctx } = makeService([searchRoute(jsonResponse(body))]);
      const failure = failureOf(
        await settle(() => service.search({ size: 1 }, service.startBudget(), ctx)),
      );
      expect(failure.data).toMatchObject({ reason: 'upstream_unreadable' });
      expect(failure.message).toContain('search envelope');
      expect(http.calls).toHaveLength(3);
    });
  });
});

describe('429 and rate limiting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('retry-after on a 429', () => {
    it.each([
      ['60', 60],
      ['120', 120],
      ['11', 11],
      ['30.5', 31],
      [null, 60],
      ['abc', 60],
      ['0', 60],
      ['-5', 60],
      ['', 60],
    ])('reads %j as %i seconds and fails fast', async (header, expected) => {
      const { service, http, ctx } = makeService([
        docRoute(
          new Response('slow down', {
            status: 429,
            headers: header === null ? {} : { 'retry-after': header },
          }),
        ),
      ]);
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx)),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(failure.data).toMatchObject({ reason: 'rate_limited', retryAfter: expected });
      expect(http.calls).toHaveLength(1);
    });

    it.each([
      [
        'search',
        (s: CernOpenDataService, b: Budget, c: ReturnType<typeof createMockContext>) =>
          s.search({ size: 1 }, b, c),
        searchRoute,
      ],
      [
        'record',
        (s: CernOpenDataService, b: Budget, c: ReturnType<typeof createMockContext>) =>
          s.getManifest('1', b, c),
        recordRoute,
      ],
      [
        'doc',
        (s: CernOpenDataService, b: Budget, c: ReturnType<typeof createMockContext>) =>
          s.getDoc('x', b, c),
        docRoute,
      ],
      [
        'file',
        (s: CernOpenDataService, b: Budget, c: ReturnType<typeof createMockContext>) =>
          s.getRunList('1', 'k', b, c),
        fileRoute,
      ],
    ] as const)('maps a %s 429 to rate_limited', async (_name, run, routeOf) => {
      const { service, ctx } = makeService([
        routeOf(new Response('', { status: 429, headers: { 'retry-after': '60' } })),
      ]);
      const failure = failureOf(
        await settle(async () => await run(service, service.startBudget(), ctx)),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(failure.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    });

    it('honors a short retry-after once, then surfaces the pacer cooldown the 429 closed', async () => {
      const { service, http, ctx } = makeService([
        docRoute(new Response('', { status: 429, headers: { 'retry-after': '5' } })),
      ]);
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx)),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(failure.data).toMatchObject({ reason: 'rate_limited' });
      expect(failure.data?.retryAfter).toBeGreaterThan(0);
      expect(failure.data?.retryAfter).toBeLessThanOrEqual(60);
      expect(http.calls).toHaveLength(1);
    });
  });

  it('closes the gate for later calls on the same service until the cooldown ends', async () => {
    const { service, http, ctx } = makeService([
      docRoute(new Response('', { status: 429, headers: { 'retry-after': '60' } }), true),
      docRoute(jsonResponse(DOC_BODY)),
    ]);
    failureOf(await settle(() => service.getDoc('x', service.startBudget(), ctx), 1_000));
    expect(http.calls).toHaveLength(1);

    const shed = failureOf(
      await settle(() => service.getDoc('x', service.startBudget(), ctx), 1_000),
    );
    expect(shed.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(shed.data).toMatchObject({ reason: 'rate_limited' });
    expect(shed.data?.retryAfter).toBeGreaterThan(50);
    expect(shed.data?.retryAfter).toBeLessThanOrEqual(60);
    expect(http.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(61_000);
    const settled = await settle(() => service.getDoc('x', service.startBudget(), ctx), 1_000);
    expect(settled.ok).toBe(true);
    expect(http.calls).toHaveLength(2);
  });

  describe('pacer shed', () => {
    it('sheds the 51st request inside a minute as rate_limited with retryAfter, before any request', async () => {
      const { service, http, ctx } = makeService([docRoute(jsonResponse(DOC_BODY))]);
      for (let i = 0; i < 50; i++) {
        await service.getDoc('x', service.startBudget(), ctx);
      }
      expect(http.calls).toHaveLength(50);

      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx), 100),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(failure.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
      expect(failure.cause).toBeInstanceOf(McpError);
      expect((failure.cause as McpError).data).toMatchObject({ reason: 'pacer_shed' });
      expect(http.calls).toHaveLength(50);
    });

    it('queues a request whose slot opens within 20 s instead of shedding it', async () => {
      const { service, http, ctx } = makeService([docRoute(jsonResponse(DOC_BODY))]);
      for (let i = 0; i < 50; i++) {
        await service.getDoc('x', service.startBudget(), ctx);
      }
      await vi.advanceTimersByTimeAsync(50_000);
      const settled = await settle(() => service.getDoc('x', service.startBudget(), ctx), 15_000);
      expect(settled.ok).toBe(true);
      expect(http.calls).toHaveLength(51);
    });

    it('frees the budget as the window slides', async () => {
      const { service, ctx } = makeService([docRoute(jsonResponse(DOC_BODY))]);
      for (let i = 0; i < 50; i++) {
        await service.getDoc('x', service.startBudget(), ctx);
      }
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(service.getDoc('x', service.startBudget(), ctx)).resolves.toBeDefined();
    });
  });
});

describe('header gate', () => {
  const resetIn = (clock: ReturnType<typeof fakeClock>, seconds: number) =>
    Math.floor(clock.now() / 1000) + seconds;

  it('does nothing while the remaining count is above one', async () => {
    const clock = fakeClock();
    const { service, ctx } = makeService(
      [
        docRoute(() =>
          jsonResponse(DOC_BODY, { headers: rateLimitHeaders(2, resetIn(clock, 30)) }),
        ),
      ],
      { now: clock.now, sleep: clock.sleep },
    );
    await service.getDoc('x', service.startBudget(), ctx);
    await service.getDoc('x', service.startBudget(), ctx);
    expect(clock.sleeps).toEqual([]);
  });

  it.each([[0], [1]])(
    'sleeps to the reset when %i requests remain and the reset fits the budget',
    async (remaining) => {
      const clock = fakeClock();
      const { service, http, ctx } = makeService(
        [
          docRoute(() =>
            jsonResponse(DOC_BODY, { headers: rateLimitHeaders(remaining, resetIn(clock, 5)) }),
          ),
        ],
        { now: clock.now, sleep: clock.sleep },
      );
      await service.getDoc('x', service.startBudget(), ctx);
      expect(clock.sleeps).toEqual([]);
      await service.getDoc('x', service.startBudget(), ctx);
      expect(clock.sleeps).toEqual([5_000]);
      expect(http.calls).toHaveLength(2);
    },
  );

  it('does not sleep again once the reset has passed', async () => {
    const clock = fakeClock();
    const { service, ctx } = makeService(
      [docRoute(() => jsonResponse(DOC_BODY, { headers: rateLimitHeaders(0, resetIn(clock, 5)) }))],
      { now: clock.now, sleep: clock.sleep },
    );
    await service.getDoc('x', service.startBudget(), ctx);
    await service.getDoc('x', service.startBudget(), ctx);
    await service.getDoc('x', service.startBudget(), ctx);
    expect(clock.sleeps).toEqual([5_000, 5_000]);
  });

  it('hands the sleep seam the attempt signal so a cancel can interrupt the wait', async () => {
    const clock = fakeClock();
    const signals: AbortSignal[] = [];
    const { service, ctx } = makeService(
      [docRoute(() => jsonResponse(DOC_BODY, { headers: rateLimitHeaders(0, resetIn(clock, 5)) }))],
      {
        now: clock.now,
        sleep: (ms, signal) => {
          signals.push(signal);
          return clock.sleep(ms);
        },
      },
    );
    await service.getDoc('x', service.startBudget(), ctx);
    await service.getDoc('x', service.startBudget(), ctx);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it('sheds as rate_limited with retryAfter when the reset is past the call budget, without a request', async () => {
    const clock = fakeClock();
    const { service, http, ctx } = makeService(
      [
        docRoute(() =>
          jsonResponse(DOC_BODY, { headers: rateLimitHeaders(0, resetIn(clock, 120)) }),
        ),
      ],
      { now: clock.now, sleep: clock.sleep },
    );
    await service.getDoc('x', service.startBudget(), ctx);
    const failure = await service.getDoc('x', service.startBudget(), ctx).then(
      () => {
        throw new Error('Expected the second call to fail.');
      },
      (error: unknown) => error as McpError,
    );
    expect(failure).toBeInstanceOf(McpError);
    expect(failure.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(failure.data).toMatchObject({ reason: 'rate_limited', retryAfter: 120 });
    expect((failure.cause as McpError).data).toMatchObject({ reason: 'pacer_shed' });
    expect(clock.sleeps).toEqual([]);
    expect(http.calls).toHaveLength(1);
  });

  it('sleeps when the wait is exactly what is left of the budget', async () => {
    const clock = fakeClock();
    const { service, ctx } = makeService(
      [
        docRoute(() =>
          jsonResponse(DOC_BODY, { headers: rateLimitHeaders(0, resetIn(clock, 50)) }),
        ),
      ],
      { now: clock.now, sleep: clock.sleep },
    );
    await service.getDoc('x', service.startBudget(), ctx);
    await service.getDoc('x', service.startBudget(), ctx);
    expect(clock.sleeps).toEqual([50_000]);
  });

  it('charges the wait against the budget of the call that waits', async () => {
    const clock = fakeClock();
    const { service, ctx } = makeService(
      [
        docRoute(() =>
          jsonResponse(DOC_BODY, { headers: rateLimitHeaders(0, resetIn(clock, 30)) }),
        ),
      ],
      { now: clock.now, sleep: clock.sleep },
    );
    await service.getDoc('x', service.startBudget(), ctx);
    const budget = { deadlineAt: clock.now() + 20_000 };
    await expect(service.getDoc('x', budget, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: 30 },
    });
  });

  it('is updated by every response, so a healthy count lifts a closed gate', async () => {
    const clock = fakeClock();
    const remaining = [0, 59, 59];
    const { service, ctx } = makeService(
      [
        docRoute(() =>
          jsonResponse(DOC_BODY, {
            headers: rateLimitHeaders(remaining.shift() ?? 59, resetIn(clock, 5)),
          }),
        ),
      ],
      { now: clock.now, sleep: clock.sleep },
    );
    await service.getDoc('x', service.startBudget(), ctx);
    await service.getDoc('x', service.startBudget(), ctx);
    await service.getDoc('x', service.startBudget(), ctx);
    expect(clock.sleeps).toEqual([5_000]);
  });

  it('reads the headers off a 404 too', async () => {
    const clock = fakeClock();
    const { service, ctx } = makeService(
      [
        docRoute(() =>
          jsonResponse(NOT_FOUND_BODY, {
            status: 404,
            headers: rateLimitHeaders(0, resetIn(clock, 5)),
          }),
        ),
      ],
      { now: clock.now, sleep: clock.sleep },
    );
    expect(await service.getDoc('x', service.startBudget(), ctx)).toBeNull();
    expect(await service.getDoc('x', service.startBudget(), ctx)).toBeNull();
    expect(clock.sleeps).toEqual([5_000]);
  });

  it.each([
    ['only the remaining header', { 'x-ratelimit-remaining': '0' }],
    ['only the reset header', { 'x-ratelimit-reset': '9999999999' }],
    ['non-numeric values', { 'x-ratelimit-remaining': 'zero', 'x-ratelimit-reset': 'soon' }],
    ['no headers', {}],
  ])('opens no gate from %s', async (_name, headers) => {
    const clock = fakeClock();
    const { service, ctx } = makeService([docRoute(() => jsonResponse(DOC_BODY, { headers }))], {
      now: clock.now,
      sleep: clock.sleep,
    });
    await service.getDoc('x', service.startBudget(), ctx);
    await service.getDoc('x', service.startBudget(), ctx);
    expect(clock.sleeps).toEqual([]);
  });

  it('ignores a reset that is already in the past', async () => {
    const clock = fakeClock();
    const { service, ctx } = makeService(
      [
        docRoute(() =>
          jsonResponse(DOC_BODY, { headers: rateLimitHeaders(0, resetIn(clock, -10)) }),
        ),
      ],
      { now: clock.now, sleep: clock.sleep },
    );
    await service.getDoc('x', service.startBudget(), ctx);
    await service.getDoc('x', service.startBudget(), ctx);
    expect(clock.sleeps).toEqual([]);
  });
});

describe('per-call budget', () => {
  it('starts a 50 s budget from the clock', () => {
    const clock = fakeClock();
    const service = new CernOpenDataService({ now: clock.now });
    expect(service.startBudget()).toEqual({ deadlineAt: clock.now() + 50_000 });
    clock.advance(1_000);
    expect(service.startBudget().deadlineAt).toBe(clock.now() + 50_000);
  });

  it('fails call_budget_exhausted before any request when the budget is already spent', async () => {
    const clock = fakeClock();
    const { service, http, ctx } = makeService([docRoute(jsonResponse(DOC_BODY))], {
      now: clock.now,
    });
    const spent: Budget = { deadlineAt: clock.now() };
    await expect(service.getDoc('x', spent, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'call_budget_exhausted', budgetMs: 50_000 },
    });
    await expect(service.getDoc('x', { deadlineAt: clock.now() - 1 }, ctx)).rejects.toMatchObject({
      data: { reason: 'call_budget_exhausted' },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('draws every request of one call from the same budget', async () => {
    const clock = fakeClock();
    const { service, http, ctx } = makeService(
      [
        docRoute(() => {
          clock.advance(30_000);
          return jsonResponse(DOC_BODY);
        }),
      ],
      { now: clock.now },
    );
    const budget = service.startBudget();
    await service.getDoc('a', budget, ctx);
    await service.getDoc('b', budget, ctx);
    await expect(service.getDoc('c', budget, ctx)).rejects.toMatchObject({
      data: { reason: 'call_budget_exhausted' },
    });
    expect(http.calls).toHaveLength(2);
  });

  describe('deadline and attempt timeouts', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A fetch that never answers and rejects when its signal aborts. */
    const hangingFetch = () =>
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );

    it('stops a hanging request at the call deadline with retry_deadline_exceeded', async () => {
      const fetchFake = hangingFetch();
      const service = new CernOpenDataService({ fetch: fetchFake as unknown as typeof fetch });
      const ctx = createMockContext();
      const budget: Budget = { deadlineAt: Date.now() + 5_000 };
      const failure = failureOf(await settle(() => service.getDoc('x', budget, ctx), 10_000));
      expect(failure.code).toBe(JsonRpcErrorCode.Timeout);
      expect(failure.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
      expect(fetchFake).toHaveBeenCalledTimes(1);
    });

    it('cuts a stalled attempt at 30 s, retries, and ends inside the 50 s call budget', async () => {
      const fetchFake = hangingFetch();
      const service = new CernOpenDataService({ fetch: fetchFake as unknown as typeof fetch });
      const ctx = createMockContext();
      const startedAt = Date.now();
      const failure = failureOf(
        await settle(() => service.getDoc('x', service.startBudget(), ctx), 120_000),
      );
      expect(failure.code).toBe(JsonRpcErrorCode.Timeout);
      expect(failure.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
      expect(fetchFake.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(fetchFake.mock.calls.length).toBeLessThanOrEqual(3);
      expect(Date.now() - startedAt).toBe(120_000);
    });

    it('reports a per-attempt stall as Timeout naming the attempt limit when the deadline is far off', async () => {
      let calls = 0;
      const fetchFake = vi.fn((_url: unknown, init?: RequestInit) => {
        calls += 1;
        if (calls > 1) return Promise.resolve(jsonResponse(DOC_BODY));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      });
      const service = new CernOpenDataService({ fetch: fetchFake as unknown as typeof fetch });
      const ctx = createMockContext();
      const settled = await settle(() => service.getDoc('x', service.startBudget(), ctx), 60_000);
      expect(settled.ok).toBe(true);
      expect(fetchFake).toHaveBeenCalledTimes(2);
    });
  });

  it('fails a lookup whose follow-up request runs out of budget, never reporting the id missing', async () => {
    const clock = fakeClock();
    const { service, http, ctx } = makeService(
      [
        searchRoute(() => {
          clock.advance(60_000);
          return jsonResponse(emptySearchBody);
        }),
      ],
      { now: clock.now },
    );
    await expect(
      service.lookup(
        [
          {
            input: '10.7483/opendata.cms.ylic.86zz',
            kind: 'doi',
            value: '10.7483/opendata.cms.ylic.86zz',
          },
        ],
        service.startBudget(),
        ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'call_budget_exhausted' } });
    expect(http.calls).toHaveLength(1);
  });
});

describe('cancellation and disposal', () => {
  it('rejects without a request when the caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller left'));
    const { service, http, ctx } = makeService(
      [docRoute(jsonResponse(DOC_BODY))],
      {},
      createMockContext({ signal: controller.signal }),
    );
    await expect(service.getDoc('x', service.startBudget(), ctx)).rejects.toThrow('caller left');
    expect(http.calls).toHaveLength(0);
  });

  it('abandons an in-flight request when the caller cancels, with no retry', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchFake = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const service = new CernOpenDataService({ fetch: fetchFake as unknown as typeof fetch });
      const ctx = createMockContext({ signal: controller.signal });
      const pending = settle(() => service.getDoc('x', service.startBudget(), ctx), 1_000);
      await vi.advanceTimersByTimeAsync(10);
      controller.abort(new Error('caller left'));
      const settled = await pending;
      expect(settled.ok).toBe(false);
      expect(fetchFake).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels requests after dispose and no longer serves cached manifests', async () => {
    const { service, http, ctx } = makeService([recordRoute(jsonResponse(filesRecordBody))]);
    await service.getManifest('6004', service.startBudget(), ctx);
    await service.getManifest('6004', service.startBudget(), ctx);
    expect(http.calls).toHaveLength(1);

    service.dispose();
    await expect(service.getManifest('6004', service.startBudget(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(http.calls).toHaveLength(1);
    expect(() => service.dispose()).not.toThrow();
  });
});

describe('concurrency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at most four requests at once and starts the next as one finishes', async () => {
    const pending: ((response: Response) => void)[] = [];
    const fetchFake = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    );
    const service = new CernOpenDataService({ fetch: fetchFake as unknown as typeof fetch });
    const ctx = createMockContext();
    const calls = Array.from({ length: 5 }, (_, i) =>
      service.getDoc(`slug-${i}`, service.startBudget(), ctx),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFake).toHaveBeenCalledTimes(4);

    pending[0]?.(jsonResponse(DOC_BODY));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFake).toHaveBeenCalledTimes(5);

    for (const resolve of pending.slice(1)) resolve(jsonResponse(DOC_BODY));
    const docs = await Promise.all(calls);
    expect(docs.every((doc) => doc?.metadata.slug === 'cms-guide-docker')).toBe(true);
  });
});
