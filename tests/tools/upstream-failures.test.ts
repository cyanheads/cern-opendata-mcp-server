/**
 * @fileoverview Upstream failure classes on the wire for the three tools that
 * reach the portal: rate limits (a 429 and the client-side pacer shed), non-2xx
 * statuses, network failures, malformed and oversized bodies, stalls, and
 * cancellation. Each class is run against search_records, get_records and
 * list_files and must surface as the declared or baseline error, with the
 * declared recovery in the text.
 * @module tests/tools/upstream-failures.test.ts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecords } from '@/mcp-server/tools/definitions/get-records.tool.js';
import { listFiles } from '@/mcp-server/tools/definitions/list-files.tool.js';
import { searchRecords } from '@/mcp-server/tools/definitions/search-records.tool.js';
import {
  type ContractResult,
  disposeInstalledService,
  errorOf,
  installService,
  settle,
  textOf,
} from '../fixtures/cern-opendata-harness.js';
import {
  emptySearchBody,
  filesRecordBody,
  HTML_ERROR_PAGE,
  jsonResponse,
  portalRoute,
} from '../fixtures/cern-opendata-upstream.js';

const MiB = 1024 * 1024;

interface Target {
  /** The body a healthy upstream answers with. */
  healthy: unknown;
  /** Input number `n`: a distinct upstream request each time (no cache hits). */
  input: (n: number) => unknown;
  /** Byte ceiling of the route the tool reads. */
  limitBytes: number;
  name: string;
  route: (respond: Parameters<typeof portalRoute>[1]) => ReturnType<typeof portalRoute>;
  tool: string;
}

const searchRoute = (respond: Parameters<typeof portalRoute>[1]) =>
  portalRoute('/api/records/', respond);
const recordRoute = (respond: Parameters<typeof portalRoute>[1]) =>
  portalRoute(/^\/api\/records\/\d+$/, respond);

const TARGETS: Target[] = [
  {
    name: 'search_records',
    tool: 'cern_opendata_search_records',
    route: searchRoute,
    healthy: emptySearchBody,
    limitBytes: 8 * MiB,
    input: (n) => ({ query: `q${n}` }),
  },
  {
    name: 'get_records',
    tool: 'cern_opendata_get_records',
    route: searchRoute,
    healthy: emptySearchBody,
    limitBytes: 8 * MiB,
    input: (n) => ({ ids: [String(1000 + n)] }),
  },
  {
    name: 'list_files',
    tool: 'cern_opendata_list_files',
    route: recordRoute,
    healthy: filesRecordBody,
    limitBytes: 32 * MiB,
    input: (n) => ({ recid: String(1000 + n) }),
  },
];

const DEFINITIONS = {
  cern_opendata_search_records: searchRecords,
  cern_opendata_get_records: getRecords,
  cern_opendata_list_files: listFiles,
} as const;

function call(target: Target, n = 0, signal?: AbortSignal): Promise<ContractResult> {
  const definition = DEFINITIONS[target.tool as keyof typeof DEFINITIONS];
  return runToolContract(
    definition as typeof searchRecords,
    target.input(n) as never,
    signal ? { context: { signal } } : undefined,
  );
}

async function settled(target: Target, n = 0, signal?: AbortSignal): Promise<ContractResult> {
  const outcome = await settle(() => call(target, n, signal));
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  disposeInstalledService();
});

describe.each(TARGETS)('$name: upstream failures on the wire', (target) => {
  it('maps a 429 to rate_limited with retryAfter and the declared recovery, without retrying', async () => {
    const { http } = installService([
      target.route(() => new Response('', { status: 429, headers: { 'retry-after': '60' } })),
    ]);
    const result = await settled(target);
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    const text = textOf(result);
    expect(text).toContain('Recovery: Wait the retryAfter seconds');
    expect(text).toContain(`call ${target.tool} again`);
    expect(text).toContain('reason rate_limited');
    expect(http.calls).toHaveLength(1);
  });

  it('sheds the 51st request inside a minute as rate_limited before any request', async () => {
    const { http } = installService([target.route(() => jsonResponse(target.healthy))]);
    for (let n = 0; n < 50; n++) {
      expect((await call(target, n)).isError, `call ${n}`).toBeFalsy();
    }
    expect(http.calls).toHaveLength(50);
    const outcome = await settle(() => call(target, 50), 100);
    if (!outcome.ok) throw outcome.error;
    const result = outcome.value;
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RateLimited);
    expect(errorOf(result).data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    expect(http.calls).toHaveLength(50);
  });

  it('fails a persistent 503 as ServiceUnavailable after three attempts', async () => {
    const { http } = installService([target.route(() => new Response('down', { status: 503 }))]);
    const result = await settled(target);
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(http.calls).toHaveLength(3);
  });

  it('recovers when a 502 is followed by a healthy answer', async () => {
    let calls = 0;
    const { http } = installService([
      target.route(() =>
        ++calls === 1 ? new Response('bad gateway', { status: 502 }) : jsonResponse(target.healthy),
      ),
    ]);
    const result = await settled(target);
    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(2);
  });

  it('fails a refused connection as ServiceUnavailable, naming the portal, after three attempts', async () => {
    const fetchFake = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    installService([], { fetch: fetchFake as unknown as typeof fetch });
    const result = await settled(target);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(errorOf(result).message).toContain('Could not reach CERN Open Data');
    expect(fetchFake).toHaveBeenCalledTimes(3);
  });

  it('maps an HTML body on a 200 to upstream_unreadable, retried, with the declared recovery', async () => {
    const { http } = installService([
      target.route(() => new Response(HTML_ERROR_PAGE, { status: 200 })),
    ]);
    const result = await settled(target);
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(error.data).not.toMatchObject({ retryable: false });
    expect(textOf(result)).toContain(`Recovery: Call ${target.tool} again in a minute`);
    expect(http.calls).toHaveLength(3);
  });

  it('maps JSON without the expected envelope to upstream_unreadable', async () => {
    installService([target.route(() => jsonResponse({ unexpected: true }))]);
    const result = await settled(target);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(errorOf(result).data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('maps an empty 200 body to upstream_unreadable', async () => {
    installService([target.route(() => new Response('', { status: 200 }))]);
    expect(errorOf(await settled(target)).data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('maps a declared content-length over the ceiling to non-retryable upstream_unreadable', async () => {
    const { http } = installService([
      target.route(
        () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-length': String(target.limitBytes + 1) },
          }),
      ),
    ]);
    const result = await settled(target);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_unreadable',
      retryable: false,
      limitBytes: target.limitBytes,
    });
    expect(textOf(result)).toContain('not retryable');
    expect(http.calls).toHaveLength(1);
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
    const result = await settled(target);
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.Timeout);
  });

  it('reports a cancelled call as RequestCancelled without a request', async () => {
    const { http } = installService([target.route(() => jsonResponse(target.healthy))]);
    const controller = new AbortController();
    controller.abort(new Error('client left'));
    const result = await settled(target, 0, controller.signal);
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(http.calls).toHaveLength(0);
  });
});

describe('search_records: a streamed body over the 8 MiB ceiling', () => {
  it('maps it to non-retryable upstream_unreadable after one request', async () => {
    const { http } = installService([
      searchRoute(() => new Response('x'.repeat(8 * MiB + 1), { status: 200 })),
    ]);
    const result = await settled(TARGETS[0] as Target);
    expect(errorOf(result).data).toMatchObject({
      reason: 'upstream_unreadable',
      retryable: false,
      limitBytes: 8 * MiB,
    });
    expect(http.calls).toHaveLength(1);
  });
});

describe('list_files: a streamed body over the 32 MiB ceiling', () => {
  it('maps it to non-retryable upstream_unreadable after one request', async () => {
    const { http } = installService([
      recordRoute(() => new Response('x'.repeat(32 * MiB + 1), { status: 200 })),
    ]);
    const result = await settled(TARGETS[2] as Target);
    expect(errorOf(result).data).toMatchObject({
      reason: 'upstream_unreadable',
      retryable: false,
      limitBytes: 32 * MiB,
    });
    expect(http.calls).toHaveLength(1);
  });
});
