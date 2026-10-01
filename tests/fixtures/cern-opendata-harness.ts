/**
 * @fileoverview Test harness for `CernOpenDataService`: a controllable clock, a
 * service wired to a strict fetch fake, and a helper that drives a call through
 * the retry ladder under fake timers. No live network.
 * @module tests/fixtures/cern-opendata-harness
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  type FetchMockRoute,
  type runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { vi } from 'vitest';
import {
  CernOpenDataService,
  type CernOpenDataServiceOptions,
  getCernOpenDataService,
  initCernOpenDataService,
} from '@/services/cern-opendata/cern-opendata-service.js';

/** A manual clock plus a `sleep` seam that advances it and records every wait. */
export function fakeClock(start = Date.UTC(2026, 9, 1, 12, 0, 0)) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    sleeps,
    sleep: (ms: number) => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
  };
}

export interface ServiceHarness {
  ctx: Context;
  http: FetchMockHarness;
  service: CernOpenDataService;
}

/** A service reading from a fetch fake that serves exactly `routes`. */
export function makeService(
  routes: readonly FetchMockRoute[],
  options: CernOpenDataServiceOptions = {},
  ctx: Context = createMockContext(),
): ServiceHarness {
  const http = createFetchMock(routes);
  const service = new CernOpenDataService({ fetch: http.fetch, ...options });
  return { service, http, ctx };
}

/** The outcome of a call driven by {@link settle}. */
export type Settled<T> = { ok: true; value: T } | { error: unknown; ok: false };

/**
 * Start `run`, advance fake timers past every retry backoff, and report how it
 * ended. Requires `vi.useFakeTimers()`; the call is never left unawaited, so a
 * rejection cannot surface as an unhandled one.
 */
export async function settle<T>(run: () => Promise<T>, advanceMs = 120_000): Promise<Settled<T>> {
  const outcome = run().then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  return outcome;
}

/** The `McpError` a settled call failed with. */
export function failureOf<T>(settled: Settled<T>): McpError {
  if (settled.ok) throw new Error('Expected the call to fail.');
  if (!(settled.error instanceof McpError)) throw settled.error;
  return settled.error;
}

/** The request URLs a fetch fake saw, in order. */
export function requestedUrls(http: FetchMockHarness): URL[] {
  return http.calls.map((call) => new URL(call.request.url));
}

/**
 * Initialize the process-wide service (the one tool and resource handlers read)
 * on a strict fetch fake serving exactly `routes`. Pair with
 * {@link disposeInstalledService} in `afterEach`.
 */
export function installService(
  routes: readonly FetchMockRoute[],
  options: CernOpenDataServiceOptions = {},
): { http: FetchMockHarness; service: CernOpenDataService } {
  const http = createFetchMock(routes);
  initCernOpenDataService({ fetch: http.fetch, ...options });
  const service = getCernOpenDataService();
  installed.add(service);
  return { http, service };
}

const installed = new Set<CernOpenDataService>();

/** Dispose every service {@link installService} created; safe when none was. */
export function disposeInstalledService(): void {
  for (const service of installed) service.dispose();
  installed.clear();
}

/** A tool result as `runToolContract` returns it. */
export type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** The text of the result's first content block. */
export function textOf(result: ContractResult, block = 0): string {
  const content = result.content[block];
  if (content?.type !== 'text') throw new Error(`Expected a text block at ${block}.`);
  return content.text;
}

/** `structuredContent` of a successful result, typed by the caller. */
export function dataOf<T>(result: ContractResult): T {
  if (result.isError) throw new Error(`Expected success, got: ${textOf(result)}`);
  return result.structuredContent as T;
}

/** The `{ code, message, data }` error of a failed result. */
export function errorOf(result: ContractResult): {
  code: number;
  data?: Record<string, unknown>;
  message: string;
} {
  if (!result.isError) throw new Error('Expected the tool call to fail.');
  const error = (result.structuredContent as { error?: ReturnType<typeof errorOf> }).error;
  if (!error) throw new Error('A failed result carries no structuredContent.error.');
  return error;
}
