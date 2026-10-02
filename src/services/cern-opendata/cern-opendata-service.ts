/**
 * @fileoverview CERN Open Data Portal client: a paced, retried, deadline-bound
 * plain-fetch boundary with a per-route status accept-list, byte ceiling and
 * attempt cap, plus the record, index, doc, manifest and validated-run-list
 * reads every tool builds on. One instance per process; caches live here.
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
import {
  definedOnly,
  pathSegment,
  recordUrl,
  str,
  toCompactIndex,
  toManifest,
  toRecordHead,
  toValidatedRunList,
} from './normalize.js';
import { noticeValue, PORTAL_ORIGIN } from './text.js';
import type {
  Budget,
  CompactManifest,
  IndexListing,
  IndexLookup,
  LookupMatch,
  RawFileIndex,
  RawHit,
  RawSearchResponse,
  RecordHead,
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
/**
 * Longest one HTTP attempt (headers and body) may take on every route but the
 * record GET, leaving room for a retry after a slow first byte.
 */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** `retry-after` default for a 429 that omits it (the portal's window is a minute). */
const DEFAULT_RETRY_AFTER_S = 60;
/** The portal's rate-limit window: 60 requests per client IP per minute. */
const RATE_WINDOW_MS = 60_000;
const CACHE_TTL_MS = 15 * 60_000;
const VALIDATED_RUNS_COLLECTION = 'CMS-Validated-Runs';
const SERVICE_LABEL = 'CERN Open Data';

/**
 * The upstream routes, each with its own byte ceiling, accepted statuses and
 * attempt cap. Only search reads a 400 as a result; a search 404 is accepted
 * so it can be reported as an unreadable portal answer, not as a missing
 * record. A record GET attempt has no cap of its own and runs to the call's
 * deadline: a retry restarts a download of the same size, so cutting a slow
 * transfer turns a late success into a certain failure (Decision 45).
 */
type Route = 'search' | 'record' | 'index' | 'doc' | 'file';

const ROUTES: Record<
  Route,
  { accept: ReadonlySet<number>; attemptTimeoutMs?: number; limitBytes: number }
> = {
  search: {
    accept: new Set([200, 400, 404, 429]),
    limitBytes: 8 * MiB,
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
  },
  record: { accept: new Set([200, 404, 429]), limitBytes: 32 * MiB },
  index: {
    accept: new Set([200, 404, 429]),
    limitBytes: 8 * MiB,
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
  },
  doc: {
    accept: new Set([200, 404, 429]),
    limitBytes: 2 * MiB,
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
  },
  file: {
    accept: new Set([200, 404, 429]),
    limitBytes: 2 * MiB,
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
  },
};

/** What one boundary request yields: a parsed body, a 400 rejection, or a 404. */
type Fetched<T> =
  | { status: 200; body: T }
  | { status: 400; rejection: SearchRejection }
  | { status: 404 };

interface RequestSpec<T> {
  /** Called with the status of every response, attempt by attempt. */
  onStatus?: (status: number) => void;
  operation: string;
  /** Envelope check: the typed body, or `undefined` when the JSON is not the expected shape. */
  parse: (json: unknown) => T | undefined;
  /** The recid a record GET reads, named in its deadline message. */
  recid?: string;
  route: Route;
  url: string;
}

/** Abortable sleep; resolves after `ms` or rejects with the signal's reason. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Constructor options — the test seams. Production uses the defaults. */
export interface CernOpenDataServiceOptions {
  /** Fetch implementation (tests pass `createFetchMock(routes).fetch`). */
  fetch?: typeof fetch;
  /**
   * Index-read LRUs, one entry per recid and key and one record head per
   * recid: entry count (default 16) and TTL (default 15 min).
   */
  indexCache?: { size?: number; ttlMs?: number };
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

  delete(key: string): void {
    this.#entries.delete(key);
  }

  /** Drop every entry whose key `match` accepts. */
  deleteWhere(match: (key: string) => boolean): void {
    for (const key of this.#entries.keys()) if (match(key)) this.#entries.delete(key);
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

/** The per-index route's envelope: the entry for exactly `key`, with a `files` array. */
function indexEnvelope(key: string): (json: unknown) => RawFileIndex | undefined {
  return (json) =>
    isRecord(json) && json.key === key && Array.isArray(json.files)
      ? (json as RawFileIndex)
      : undefined;
}

/** A manifest's record-level fields, without its file lists. */
function headOf({ recid, title, availability, availability_details }: RecordHead): RecordHead {
  return definedOnly<RecordHead>({ recid, title, availability, availability_details });
}

/**
 * The message for a call whose 50 s budget ran out mid-request: it names the
 * portal, the budget and the next step, never an operation name or a
 * millisecond figure. A record GET names the record and its portal page,
 * whose pager lists the files the API could not send in time.
 */
function deadlineMessage(recid: string | undefined): string {
  const budget = `this call's ${CALL_BUDGET_MS / 1000} s budget`;
  return recid === undefined
    ? `${SERVICE_LABEL} did not answer within ${budget}; call again in a minute.`
    : `${SERVICE_LABEL} did not finish sending record ${recid} within ${budget}; call again in a minute, or browse its files at ${recordUrl(recid)}.`;
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
  appendAll(query, 'category', params.category);
  appendAll(query, 'keywords', params.keywords);
  appendAll(query, 'magnet_polarity', params.magnet_polarity);
  appendAll(query, 'stripping_stream', params.stripping_stream);
  appendAll(query, 'stripping_version', params.stripping_version);
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
  /** Index reads whose search found the record, with its head, by `{recid}/{key}` (a recid holds no `/`). */
  readonly #indexes: TtlLru<IndexListing>;
  /** Record heads from index reads' searches, by recid, so another key of the record skips the search. */
  readonly #heads: TtlLru<RecordHead>;
  /** Counts manifests cached; an index read that saw it change while in flight is not cached. */
  #manifestEpoch = 0;
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
    const indexCacheSize = options.indexCache?.size ?? 16;
    const indexCacheTtlMs = options.indexCache?.ttlMs ?? CACHE_TTL_MS;
    this.#indexes = new TtlLru(indexCacheSize, indexCacheTtlMs, this.#now);
    this.#heads = new TtlLru(indexCacheSize, indexCacheTtlMs, this.#now);
    this.#listCacheTtlMs = options.listCacheTtlMs ?? CACHE_TTL_MS;
    this.#pacer = createPacer({
      name: 'cern-opendata',
      limits: [{ requests: 50, perMs: RATE_WINDOW_MS }],
      maxConcurrent: 4,
      cooldown: { baseMs: 60_000, maxMs: 120_000 },
    });
  }

  /** A fresh 50 s budget; start one per tool call and pass it to every method. */
  startBudget(): Budget {
    return { deadlineAt: this.#now() + CALL_BUDGET_MS };
  }

  /**
   * One search page. Resolves with `{ kind: 'page' }`, `{ kind: 'rejected' }`
   * carrying the portal's 400 (`The syntax of the search query is invalid.`,
   * `Maximum number of 10000 results have been reached.`, …), or
   * `{ kind: 'server_error' }` carrying the error retries ended on when every
   * attempt answered 500. Every other failure throws.
   */
  async search(params: SearchParams, budget: Budget, ctx: Context): Promise<SearchOutcome> {
    const statuses: number[] = [];
    let fetched: Fetched<RawSearchResponse>;
    try {
      fetched = await this.#request(
        {
          route: 'search',
          url: `${PORTAL_ORIGIN}/api/records/?${searchQuery(params).toString()}`,
          operation: 'CernOpenData.search',
          parse: parseSearchEnvelope,
          onStatus: (status) => statuses.push(status),
        },
        budget,
        ctx,
      );
    } catch (error) {
      const everyAttempt500 =
        error instanceof McpError &&
        error.data?.status === 500 &&
        statuses.length === error.data.retryAttempts &&
        statuses.every((status) => status === 500);
      if (everyAttempt500) return { kind: 'server_error', error };
      throw error;
    }
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
   * the server built it wrong, so it is raised as `InternalError`, and a 500
   * on every attempt is thrown as the `ServiceUnavailable` retries ended on.
   */
  async searchBuilt(params: SearchParams, budget: Budget, ctx: Context): Promise<SearchPage> {
    const outcome = await this.search(params, budget, ctx);
    if (outcome.kind === 'server_error') throw outcome.error;
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
   * ceiling, an attempt cut only at the call's deadline), or `null` on 404.
   * Successful reads are cached (LRU, 15 min) and drop the record's cached
   * index reads and head, so once the manifest is evicted no older read of
   * the record is served again.
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
        recid,
      },
      budget,
      ctx,
    );
    if (fetched.status !== 200) return null;
    const manifest = toManifest(recid, fetched.body.metadata);
    this.#manifests.set(recid, manifest);
    this.#manifestEpoch++;
    this.#heads.delete(recid);
    this.#indexes.deleteWhere((key) => key.startsWith(`${recid}/`));
    return manifest;
  }

  /**
   * One file index with its record's head, read without the full record
   * (Decision 44). A cached manifest answers with no request. Otherwise
   * `GET /record/{recid}/file_index/{key}` (8 MiB ceiling, the key one path
   * segment, no query string, since `?qos=online` drops files) runs beside the
   * record's files-skipped `q=recid:` search, which supplies the head and
   * tells a 404 for a missing index from one for a missing record. Either read
   * failing fails the call. A head already cached for the recid stands in for
   * the search. `.`, `..` and a key that is not well-formed Unicode (it cannot
   * be percent-encoded) are `index_not_found` without a request (Decision 39).
   * A found index is cached per recid and key when the search found its
   * record, and the head per recid (LRU, 15 min), unless a manifest was cached
   * while the read was in flight.
   */
  async getIndex(recid: string, key: string, budget: Budget, ctx: Context): Promise<IndexLookup> {
    const manifest = this.#manifests.get(recid);
    if (manifest) {
      const index = manifest.indexes.find((entry) => entry.key === key);
      return index
        ? { kind: 'found', listing: { record: headOf(manifest), index } }
        : { kind: 'index_not_found' };
    }
    if (pathSegment(key) === undefined || !key.isWellFormed()) return { kind: 'index_not_found' };
    const cacheKey = `${recid}/${key}`;
    const cached = this.#indexes.get(cacheKey);
    if (cached) return { kind: 'found', listing: cached };

    const cachedHead = this.#heads.get(recid);
    const epoch = this.#manifestEpoch;
    const [fetched, hit] = await Promise.all([
      this.#request(
        {
          route: 'index',
          url: `${PORTAL_ORIGIN}/record/${encodeURIComponent(recid)}/file_index/${encodeURIComponent(key)}`,
          operation: 'CernOpenData.getIndex',
          parse: indexEnvelope(key),
        },
        budget,
        ctx,
      ),
      cachedHead ? undefined : this.findRecord(recid, budget, ctx),
    ]);
    const head = cachedHead ?? (hit ? toRecordHead(recid, hit.metadata) : undefined);
    const cacheable = epoch === this.#manifestEpoch;
    if (hit && head && cacheable) this.#heads.set(recid, head);
    if (fetched.status !== 200) return { kind: head ? 'index_not_found' : 'record_not_found' };
    const listing: IndexListing = {
      record: head ?? { recid },
      index: toCompactIndex(fetched.body, recid),
    };
    if (head && cacheable) this.#indexes.set(cacheKey, listing);
    return { kind: 'found', listing };
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
   * by the number in the recid (`cms-1001` sorts as 1001). One search with
   * files included; cached for 15 minutes.
   */
  async getValidatedRunLists(budget: Budget, ctx: Context): Promise<ValidatedRunList[]> {
    if (this.#runLists && this.#runLists.expiresAt > this.#now()) return this.#runLists.lists;
    const page = await this.searchBuilt(
      { collections: [VALIDATED_RUNS_COLLECTION], size: 100, skipFiles: false },
      budget,
      ctx,
    );
    const recidNumber = (recid: string) => Number(recid.slice(recid.lastIndexOf('-') + 1));
    const lists = page.hits
      .flatMap((hit) => toValidatedRunList(hit) ?? [])
      .sort((a, b) => recidNumber(a.recid) - recidNumber(b.recid));
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
    this.#indexes.clear();
    this.#heads.clear();
    this.#runLists = undefined;
  }

  /**
   * The HTTP boundary: retry outside, pacer inside, one deadline across every
   * attempt. A pacer or header-gate shed (`pacer_shed`) is re-thrown as the
   * declared `rate_limited` with its `retryAfter`; a deadline expiry stays
   * `Timeout` with `retry_deadline_exceeded`, reworded for the caller.
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
      if (error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded') {
        throw timeout(deadlineMessage(spec.recid), error.data, { cause: error });
      }
      throw error;
    }
  }

  /**
   * One attempt: header gate, fetch under the route's flat attempt timer
   * (none for the record GET), status dispatch, bounded read. The timer is
   * never clamped to the time left: `signal` alone carries the call's
   * deadline, so its expiry always reads as `retry_deadline_exceeded`.
   */
  async #attempt<T>(
    spec: RequestSpec<T>,
    budget: Budget,
    signal: AbortSignal,
    ctx: Context,
  ): Promise<Fetched<T>> {
    await this.#headerGate(budget, signal);
    const { attemptTimeoutMs } = ROUTES[spec.route];
    const perAttempt = new AbortController();
    const timer =
      attemptTimeoutMs === undefined
        ? undefined
        : setTimeout(() => perAttempt.abort(), attemptTimeoutMs);
    try {
      const response = await this.#fetch(spec.url, {
        signal: AbortSignal.any([signal, perAttempt.signal]),
        headers: { accept: 'application/json', 'user-agent': this.#userAgent },
        redirect: 'manual',
      });
      this.#updateGate(response.headers);
      return await this.#dispatch(spec, response, ctx);
    } catch (error) {
      if (signal.aborted || error instanceof McpError) throw error;
      if (attemptTimeoutMs !== undefined && perAttempt.signal.aborted) {
        throw timeout(`${SERVICE_LABEL} did not answer within ${attemptTimeoutMs / 1000} s.`, {
          timeoutMs: attemptTimeoutMs,
        });
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
    spec.onStatus?.(status);
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw serviceUnavailable(
        `${SERVICE_LABEL} answered ${status}, a redirect this server does not follow.`,
        { status, retryable: false },
      );
    }
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

  /**
   * Record the last rate-limit headers. The reset is clamped to one window past
   * now: the portal's window is a minute, and a later reset (a skewed clock or
   * a faulty header) would otherwise shed every call until then, since a shed
   * sends no request that could bring fresher headers.
   */
  #updateGate(headers: Headers): void {
    const remaining = Number.parseInt(headers.get('x-ratelimit-remaining') ?? '', 10);
    const reset = Number.parseInt(headers.get('x-ratelimit-reset') ?? '', 10);
    if (Number.isFinite(remaining) && Number.isFinite(reset)) {
      this.#gate = { remaining, resetAtMs: Math.min(reset * 1000, this.#now() + RATE_WINDOW_MS) };
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
