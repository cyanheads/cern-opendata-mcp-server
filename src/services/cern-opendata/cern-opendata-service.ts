/**
 * @fileoverview CERN Open Data Portal client: a paced, retried, deadline-bound
 * plain-fetch boundary with a per-route status accept-list and byte ceiling,
 * plus the record, doc, manifest and validated-run-list reads every tool
 * builds on. One instance per process; caches live here.
 * @module services/cern-opendata/cern-opendata-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import {
  internalError,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ClassifiedId } from './identifiers.js';
import { str, toManifest, toValidatedRunList } from './normalize.js';
import { noticeValue, PORTAL_ORIGIN } from './text.js';
import type {
  Budget,
  CompactManifest,
  LookupMatch,
  RawHit,
  RawSearchResponse,
  RunList,
  SearchOutcome,
  SearchPage,
  SearchParams,
  SearchRejection,
  ValidatedRunList,
} from './types.js';

const MiB = 1024 * 1024;

/** One tool call's total upstream budget (Requirements: Deadline). */
const CALL_BUDGET_MS = 50_000;
/** Longest a request may wait in the pacer queue before shedding. */
const MAX_QUEUE_WAIT_MS = 20_000;
/** Longest one HTTP attempt (headers and body) may take. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** `retry-after` default for a 429 that omits it (the portal's window is a minute). */
const DEFAULT_RETRY_AFTER_S = 60;
const CACHE_TTL_MS = 15 * 60_000;
const VALIDATED_RUNS_COLLECTION = 'CMS-Validated-Runs';
const SERVICE_LABEL = 'CERN Open Data';

/**
 * The upstream routes, each with its own byte ceiling and accepted statuses.
 * Only search reads a 400 as a result; a search 404 is accepted so it can be
 * reported as an unreadable portal answer, not as a missing record.
 */
type Route = 'search' | 'record' | 'doc' | 'file';

const ROUTES: Record<Route, { accept: ReadonlySet<number>; limitBytes: number }> = {
  search: { accept: new Set([200, 400, 404, 429]), limitBytes: 8 * MiB },
  record: { accept: new Set([200, 404, 429]), limitBytes: 32 * MiB },
  doc: { accept: new Set([200, 404, 429]), limitBytes: 2 * MiB },
  file: { accept: new Set([200, 404, 429]), limitBytes: 2 * MiB },
};

/** What one boundary request yields: a parsed body, a 400 rejection, or a 404. */
type Fetched<T> =
  | { status: 200; body: T }
  | { status: 400; rejection: SearchRejection }
  | { status: 404 };

interface RequestSpec<T> {
  operation: string;
  /** Envelope check: the typed body, or `undefined` when the JSON is not the expected shape. */
  parse: (json: unknown) => T | undefined;
  route: Route;
  url: string;
}

/** Abortable sleep; resolves after `ms` or rejects with the signal's reason. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Constructor options — the test seams. Production uses the defaults. */
export interface CernOpenDataServiceOptions {
  /** Fetch implementation (tests pass `createFetchMock(routes).fetch`). */
  fetch?: typeof fetch;
  /** Validated-run collection TTL (default 15 min). */
  listCacheTtlMs?: number;
  /** Compact-manifest LRU: entry count (default 8) and TTL (default 15 min). */
  manifestCache?: { size?: number; ttlMs?: number };
  /** Clock in epoch ms (budget, header gate, caches). */
  now?: () => number;
  /** Sleep used by the header gate. */
  sleep?: Sleep;
  /** `User-Agent` sent on every request. */
  userAgent?: string;
}

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** A small TTL'd LRU keyed by string. */
class TtlLru<V> {
  readonly #entries = new Map<string, { expiresAt: number; value: V }>();

  constructor(
    private readonly size: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    if (entry.expiresAt <= this.now()) return;
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.#entries.size > this.size) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

const RunListSchema = z.record(
  z.string().regex(/^\d+$/),
  z.array(z.tuple([z.number().int(), z.number().int()])),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSearchEnvelope(json: unknown): RawSearchResponse | undefined {
  if (!isRecord(json) || !isRecord(json.hits)) return;
  const { hits, total } = json.hits;
  if (!Array.isArray(hits) || typeof total !== 'number') return;
  if (!hits.every((hit) => isRecord(hit) && isRecord(hit.metadata))) return;
  return json as unknown as RawSearchResponse;
}

function parseMetadataEnvelope(json: unknown): RawHit | undefined {
  if (!isRecord(json) || !isRecord(json.metadata)) return;
  return json as unknown as RawHit;
}

function upstreamUnreadable(
  message: string,
  data: Record<string, unknown> = {},
  cause?: unknown,
): McpError {
  return serviceUnavailable(
    message,
    { reason: 'upstream_unreadable', ...data },
    cause === undefined ? undefined : { cause },
  );
}

/** Read a body as UTF-8 text, cancelling the stream once it passes `limitBytes`. */
async function readBounded(response: Response, limitBytes: number): Promise<string> {
  const tooLarge = () =>
    upstreamUnreadable(
      `${SERVICE_LABEL} sent a response larger than this endpoint's ${limitBytes / MiB} MiB ceiling.`,
      { retryable: false, limitBytes },
    );
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parts: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

/** The 400 body as a rejection; a non-JSON body becomes the message itself. */
function toRejection(text: string): SearchRejection {
  try {
    const json: unknown = JSON.parse(text);
    if (isRecord(json) && typeof json.message === 'string') {
      const errors = Array.isArray(json.errors)
        ? json.errors.filter(isRecord).map((error) => ({
            ...(typeof error.field === 'string' ? { field: error.field } : {}),
            ...(typeof error.message === 'string' ? { message: error.message } : {}),
          }))
        : undefined;
      return { status: 400, message: json.message, ...(errors ? { errors } : {}) };
    }
  } catch {
    // Not JSON: fall through and carry the raw text.
  }
  return { status: 400, message: text.trim().slice(0, 500) || 'Bad request.' };
}

/**
 * An unexpected status as a thrown error. The response is rebuilt without its
 * `retry-after` header and its reason phrase. The portal sends
 * `retry-after: 60` on every response; only a 429 reads it (Decision 10), so a
 * 5xx carrying it into `data.retryAfter` would make `withRetry` fail fast
 * instead of retrying. The reason phrase is upstream text, so it stays out of
 * the message and is kept as received in `data.statusText`.
 */
function unexpectedStatus(response: Response): Promise<McpError> {
  const headers = new Headers(response.headers);
  headers.delete('retry-after');
  return httpErrorFromResponse(new Response(response.body, { status: response.status, headers }), {
    service: SERVICE_LABEL,
    ...(response.statusText ? { data: { statusText: response.statusText } } : {}),
  });
}

function parseRetryAfterSeconds(value: string | null): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_RETRY_AFTER_S;
}

/** The deepest match search pages to: the portal rejects `page × size > 10000` with a 400. */
export const PAGE_WINDOW = 10_000;

/** True for the portal's 400 for `page × size > 10000`. */
export function isPageWindowRejection(rejection: SearchRejection): boolean {
  return rejection.message.startsWith('Maximum number of');
}

function appendAll(query: URLSearchParams, name: string, values: readonly string[] | undefined) {
  for (const value of values ?? []) query.append(name, value);
}

/** Build the search query string from allowlisted names only. */
function searchQuery(params: SearchParams): URLSearchParams {
  const query = new URLSearchParams();
  if (params.q !== undefined) query.set('q', params.q);
  appendAll(query, 'type', params.type);
  appendAll(query, 'experiment', params.experiment);
  appendAll(query, 'collision_energy', params.collision_energy);
  appendAll(query, 'collision_type', params.collision_type);
  appendAll(query, 'file_type', params.file_type);
  appendAll(query, 'availability', params.availability);
  appendAll(query, 'collections', params.collections);
  if (params.year !== undefined) query.set('year', params.year);
  if (params.number_events !== undefined) query.set('number_events', params.number_events);
  if (params.sort !== undefined) query.set('sort', params.sort);
  query.set('size', String(params.size));
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.skipFiles ?? true) query.set('skip_files', '1');
  query.set('ondemand', 'true');
  return query;
}

/** Quote a value validated to contain no `"` or `\` for an OpenSearch phrase clause. */
function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(' OR ');
}

/** The OR-joined `q` for a lookup, one clause per identifier form present. */
function lookupQuery(ids: readonly ClassifiedId[]): string | undefined {
  const of = (kind: ClassifiedId['kind']) =>
    ids.filter((id) => id.kind === kind).map((id) => id.value);
  const clauses: string[] = [];
  const recids = of('recid');
  const dois = of('doi');
  const paths = of('cms_dataset_path');
  const slugs = of('doc_slug');
  if (recids.length > 0) clauses.push(`recid:(${recids.join(' OR ')})`);
  if (dois.length > 0) clauses.push(`doi:(${quoted(dois)})`);
  if (paths.length > 0) clauses.push(`title:(${quoted(paths)})`);
  if (slugs.length > 0) clauses.push(`slug:(${quoted(slugs)})`);
  return clauses.length > 0 ? clauses.join(' OR ') : undefined;
}

/** Whether a hit resolves a classified id (the match rules of `cern_opendata_get_records`). */
function hitMatches(hit: RawHit, id: ClassifiedId): boolean {
  const meta = hit.metadata;
  switch (id.kind) {
    case 'recid':
      return str(meta.recid) === id.value;
    case 'doi':
      return str(meta.doi)?.toUpperCase() === id.value.toUpperCase();
    case 'cms_dataset_path':
      return str(meta.title) === id.value;
    case 'doc_slug':
      return str(meta.slug) === id.value;
    default:
      return false;
  }
}

/**
 * Client for `https://opendata.cern.ch`. Every method takes the call's
 * {@link Budget} (from {@link CernOpenDataService.startBudget}) and the request
 * `ctx`; all requests share one pacer.
 */
export class CernOpenDataService {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: Sleep;
  readonly #userAgent: string;
  readonly #pacer: Pacer;
  readonly #manifests: TtlLru<CompactManifest>;
  readonly #listCacheTtlMs: number;
  #runLists: { expiresAt: number; lists: ValidatedRunList[] } | undefined;
  /** Last rate-limit headers seen (best effort; the portal's counter is per backend). */
  #gate: { remaining: number; resetAtMs: number } | undefined;

  constructor(options: CernOpenDataServiceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#userAgent = options.userAgent ?? 'cern-opendata-mcp-server';
    this.#manifests = new TtlLru(
      options.manifestCache?.size ?? 8,
      options.manifestCache?.ttlMs ?? CACHE_TTL_MS,
      this.#now,
    );
    this.#listCacheTtlMs = options.listCacheTtlMs ?? CACHE_TTL_MS;
    this.#pacer = createPacer({
      name: 'cern-opendata',
      limits: [{ requests: 50, perMs: 60_000 }],
      maxConcurrent: 4,
      cooldown: { baseMs: 60_000, maxMs: 120_000 },
    });
  }

  /** A fresh 50 s budget; start one per tool call and pass it to every method. */
  startBudget(): Budget {
    return { deadlineAt: this.#now() + CALL_BUDGET_MS };
  }

  /**
   * One search page. Resolves with `{ kind: 'page' }`, or `{ kind: 'rejected' }`
   * carrying the portal's 400 (`The syntax of the search query is invalid.`,
   * `Maximum number of 10000 results have been reached.`, …).
   */
  async search(params: SearchParams, budget: Budget, ctx: Context): Promise<SearchOutcome> {
    const fetched = await this.#request(
      {
        route: 'search',
        url: `${PORTAL_ORIGIN}/api/records/?${searchQuery(params).toString()}`,
        operation: 'CernOpenData.search',
        parse: parseSearchEnvelope,
      },
      budget,
      ctx,
    );
    if (fetched.status === 400) return { kind: 'rejected', rejection: fetched.rejection };
    if (fetched.status === 404) throw upstreamUnreadable(`${SERVICE_LABEL} search answered 404.`);
    const { body } = fetched;
    return {
      kind: 'page',
      page: {
        hits: body.hits.hits,
        total: body.hits.total,
        aggregations: body.aggregations ?? {},
      },
    };
  }

  /**
   * A search the server built itself, from validated input only: a 400 means
   * the server built it wrong, so it is raised as `InternalError`.
   */
  async searchBuilt(params: SearchParams, budget: Budget, ctx: Context): Promise<SearchPage> {
    const outcome = await this.search(params, budget, ctx);
    if (outcome.kind === 'rejected') {
      throw internalError(
        `${SERVICE_LABEL} rejected a query this server built: ${noticeValue(outcome.rejection.message)}`,
        { upstreamMessage: outcome.rejection.message },
      );
    }
    return outcome.page;
  }

  /**
   * Resolve classified ids in one search (`q` of OR-joined clauses,
   * `size=100`, `sort=bestmatch`), plus at most one retry with uppercased DOIs
   * that missed. Ids resolving to one record collapse into one match, ordered
   * by first matching input; `missing` keeps input order and includes every
   * `unrecognized` id. No request is made when no id is recognized. A failed
   * retry fails the call (Decision 23).
   */
  async lookup(
    ids: readonly ClassifiedId[],
    budget: Budget,
    ctx: Context,
  ): Promise<{ matches: LookupMatch[]; missing: ClassifiedId[] }> {
    const recognized = ids.filter((id) => id.kind !== 'unrecognized');
    const hits = await this.#lookupHits(recognized, budget, ctx);

    const missedDois = recognized.filter(
      (id) =>
        id.kind === 'doi' &&
        id.value !== id.value.toUpperCase() &&
        !hits.some((hit) => hitMatches(hit, id)),
    );
    if (missedDois.length > 0) {
      const upper = missedDois.map((id) => ({ ...id, value: id.value.toUpperCase() }));
      hits.push(...(await this.#lookupHits(upper, budget, ctx)));
    }

    const matches = new Map<string, LookupMatch>();
    const missing: ClassifiedId[] = [];
    for (const id of ids) {
      const hit = id.kind === 'unrecognized' ? undefined : hits.find((h) => hitMatches(h, id));
      if (!hit) {
        missing.push(id);
        continue;
      }
      const key = String(hit.id);
      const existing = matches.get(key);
      if (existing) existing.matchedInputs.push(id.input);
      else matches.set(key, { hit, matchedInputs: [id.input] });
    }
    return { matches: [...matches.values()], missing };
  }

  async #lookupHits(ids: readonly ClassifiedId[], budget: Budget, ctx: Context): Promise<RawHit[]> {
    const q = lookupQuery(ids);
    if (q === undefined) return [];
    const page = await this.searchBuilt({ q, size: 100, sort: 'bestmatch' }, budget, ctx);
    return page.hits;
  }

  /** The record hit for `recid` (`q=recid:{n}`, `size=1`, files skipped), or `null` when none. */
  async findRecord(recid: string, budget: Budget, ctx: Context): Promise<RawHit | null> {
    const page = await this.searchBuilt({ q: `recid:${recid}`, size: 1 }, budget, ctx);
    return page.hits.find((hit) => str(hit.metadata.recid) === recid) ?? null;
  }

  /**
   * The record's compact file manifest from `GET /api/records/{recid}` (32 MiB
   * ceiling), or `null` on 404. Successful reads are cached (LRU, 15 min).
   */
  async getManifest(recid: string, budget: Budget, ctx: Context): Promise<CompactManifest | null> {
    const cached = this.#manifests.get(recid);
    if (cached) return cached;
    const fetched = await this.#request(
      {
        route: 'record',
        url: `${PORTAL_ORIGIN}/api/records/${encodeURIComponent(recid)}`,
        operation: 'CernOpenData.getManifest',
        parse: parseMetadataEnvelope,
      },
      budget,
      ctx,
    );
    if (fetched.status !== 200) return null;
    const manifest = toManifest(recid, fetched.body.metadata);
    this.#manifests.set(recid, manifest);
    return manifest;
  }

  /** A documentation or news page from `GET /api/docs/{slug}` (2 MiB ceiling), or `null` on 404. */
  async getDoc(slug: string, budget: Budget, ctx: Context): Promise<RawHit | null> {
    const fetched = await this.#request(
      {
        route: 'doc',
        url: `${PORTAL_ORIGIN}/api/docs/${encodeURIComponent(slug)}`,
        operation: 'CernOpenData.getDoc',
        parse: parseMetadataEnvelope,
      },
      budget,
      ctx,
    );
    return fetched.status === 200 ? fetched.body : null;
  }

  /**
   * Every list of the `CMS-Validated-Runs` collection, with file keys, sorted
   * by recid. One search with files included; cached for 15 minutes.
   */
  async getValidatedRunLists(budget: Budget, ctx: Context): Promise<ValidatedRunList[]> {
    if (this.#runLists && this.#runLists.expiresAt > this.#now()) return this.#runLists.lists;
    const page = await this.searchBuilt(
      { collections: [VALIDATED_RUNS_COLLECTION], size: 100, skipFiles: false },
      budget,
      ctx,
    );
    const lists = page.hits
      .flatMap((hit) => toValidatedRunList(hit) ?? [])
      .sort((a, b) => Number(a.recid) - Number(b.recid));
    this.#runLists = { lists, expiresAt: this.#now() + this.#listCacheTtlMs };
    return lists;
  }

  /**
   * A good-run list from `GET /record/{recid}/files/{key}` (2 MiB ceiling),
   * validated as `{ "<run>": [[first, last], …] }`. A 404 for a key the
   * collection listed clears the collection cache and throws
   * `upstream_unreadable`.
   */
  async getRunList(recid: string, key: string, budget: Budget, ctx: Context): Promise<RunList> {
    const fetched = await this.#request(
      {
        route: 'file',
        url: `${PORTAL_ORIGIN}/record/${encodeURIComponent(recid)}/files/${encodeURIComponent(key)}`,
        operation: 'CernOpenData.getRunList',
        parse: (json) => {
          const parsed = RunListSchema.safeParse(json);
          return parsed.success ? (parsed.data as RunList) : undefined;
        },
      },
      budget,
      ctx,
    );
    if (fetched.status !== 200) {
      this.#runLists = undefined;
      throw upstreamUnreadable(
        `${SERVICE_LABEL} answered 404 for file ${noticeValue(key)} of validated-run list ${noticeValue(recid)}, which the collection lists.`,
        { recid, key },
      );
    }
    return fetched.body;
  }

  /** Dispose the pacer (queued waiters are cancelled) and clear the caches. */
  dispose(): void {
    this.#pacer.dispose();
    this.#manifests.clear();
    this.#runLists = undefined;
  }

  /**
   * The HTTP boundary: retry outside, pacer inside, one deadline across every
   * attempt. A pacer or header-gate shed (`pacer_shed`) is re-thrown as the
   * declared `rate_limited` with its `retryAfter`.
   */
  async #request<T>(spec: RequestSpec<T>, budget: Budget, ctx: Context): Promise<Fetched<T>> {
    const remainingMs = budget.deadlineAt - this.#now();
    if (remainingMs <= 0) {
      throw timeout(
        `The ${CALL_BUDGET_MS / 1000} s budget for this call ran out before ${SERVICE_LABEL} could be asked again.`,
        { reason: 'call_budget_exhausted', budgetMs: CALL_BUDGET_MS },
      );
    }
    try {
      return await withRetry(
        (attempt) =>
          this.#pacer.run((signal) => this.#attempt(spec, budget, signal, ctx), {
            signal: attempt.signal,
            maxWaitMs: Math.min(MAX_QUEUE_WAIT_MS, attempt.remainingMs),
          }),
        {
          maxRetries: 2,
          baseDelayMs: 1_000,
          maxDelayMs: 10_000,
          deadlineMs: remainingMs,
          signal: ctx.signal,
          operation: spec.operation,
          context: ctx,
        },
      );
    } catch (error) {
      if (error instanceof McpError && error.data?.reason === 'pacer_shed') {
        const retryAfter = Number(error.data.retryAfter) || DEFAULT_RETRY_AFTER_S;
        throw rateLimited(
          `This server's request budget for ${SERVICE_LABEL} (60 a minute per client IP) is spent; retry after ${retryAfter} s.`,
          { reason: 'rate_limited', retryAfter },
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** One attempt: header gate, fetch under a per-attempt timer, status dispatch, bounded read. */
  async #attempt<T>(
    spec: RequestSpec<T>,
    budget: Budget,
    signal: AbortSignal,
    ctx: Context,
  ): Promise<Fetched<T>> {
    await this.#headerGate(budget, signal);
    const timeoutMs = Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, budget.deadlineAt - this.#now()));
    const perAttempt = new AbortController();
    const timer = setTimeout(() => perAttempt.abort(), timeoutMs);
    try {
      const response = await this.#fetch(spec.url, {
        signal: AbortSignal.any([signal, perAttempt.signal]),
        headers: { accept: 'application/json', 'user-agent': this.#userAgent },
      });
      this.#updateGate(response.headers);
      return await this.#dispatch(spec, response, ctx);
    } catch (error) {
      if (signal.aborted || error instanceof McpError) throw error;
      if (perAttempt.signal.aborted) {
        throw timeout(`${SERVICE_LABEL} did not answer within ${timeoutMs} ms.`, { timeoutMs });
      }
      throw serviceUnavailable(
        `Could not reach ${SERVICE_LABEL}: ${error instanceof Error ? error.message : String(error)}`,
        {},
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #dispatch<T>(spec: RequestSpec<T>, response: Response, ctx: Context): Promise<Fetched<T>> {
    const { accept, limitBytes } = ROUTES[spec.route];
    const { status } = response;
    if (!accept.has(status)) throw await unexpectedStatus(response);
    if (status === 429) {
      await response.body?.cancel().catch(() => undefined);
      const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'));
      throw rateLimited(
        `${SERVICE_LABEL} answered 429: its limit of 60 requests a minute per client IP is spent.`,
        { reason: 'rate_limited', retryAfter },
      );
    }
    if (status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 404 };
    }
    const text = await readBounded(response, limitBytes);
    if (status === 400) return { status: 400, rejection: toRejection(text) };

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      ctx.log.debug('CERN Open Data body is not JSON', { operation: spec.operation });
      throw upstreamUnreadable(
        `${SERVICE_LABEL} answered with a body that is not JSON.`,
        {},
        error,
      );
    }
    const body = spec.parse(json);
    if (body === undefined) {
      throw upstreamUnreadable(
        `${SERVICE_LABEL} answered with JSON missing the expected ${spec.route} envelope.`,
      );
    }
    return { status: 200, body };
  }

  /**
   * Best-effort second guard behind the pacer: when the last response left
   * `x-ratelimit-remaining` ≤ 1 before `x-ratelimit-reset`, sleep to the reset
   * if it fits the budget, else shed with `pacer_shed`.
   */
  async #headerGate(budget: Budget, signal: AbortSignal): Promise<void> {
    if (!this.#gate || this.#gate.remaining > 1) return;
    const waitMs = this.#gate.resetAtMs - this.#now();
    if (waitMs <= 0) return;
    if (waitMs <= budget.deadlineAt - this.#now()) {
      await this.#sleep(waitMs, signal);
      return;
    }
    throw rateLimited(
      `${SERVICE_LABEL}'s rate-limit window resets in ${Math.ceil(waitMs / 1000)} s, past this call's deadline.`,
      { reason: 'pacer_shed', retryAfter: Math.ceil(waitMs / 1000) },
    );
  }

  #updateGate(headers: Headers): void {
    const remaining = Number.parseInt(headers.get('x-ratelimit-remaining') ?? '', 10);
    const reset = Number.parseInt(headers.get('x-ratelimit-reset') ?? '', 10);
    if (Number.isFinite(remaining) && Number.isFinite(reset)) {
      this.#gate = { remaining, resetAtMs: reset * 1000 };
    }
  }
}

let service: CernOpenDataService | undefined;

/** Create the process-wide service. Call once from `createApp({ setup })`. */
export function initCernOpenDataService(options?: CernOpenDataServiceOptions): void {
  service = new CernOpenDataService(options);
}

/** The process-wide service; throws when `initCernOpenDataService()` has not run. */
export function getCernOpenDataService(): CernOpenDataService {
  if (!service) {
    throw new Error(
      'CernOpenDataService not initialized: call initCernOpenDataService() in createApp setup().',
    );
  }
  return service;
}
