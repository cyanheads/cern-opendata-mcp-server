/**
 * @fileoverview CERN Open Data types: the raw portal payloads (sparse, every
 * field optional unless the envelope check guarantees it) and the normalized
 * shapes the service and `normalize.ts` hand to tools.
 * @module services/cern-opendata/types
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';

// Raw upstream payloads (opendata.cern.ch, invenio-records-rest)

/** A link entry in `abstract`, `note`, `usage`, `validation`, `use_with` or software `links`. */
export interface RawLink {
  description?: string;
  recid?: string;
  url?: string;
}

/** A described section of record metadata (`abstract`, `methodology`, `usage`, …). */
export interface RawSection {
  description?: string;
  links?: RawLink[];
}

/** One entry of a record's inline variable dictionary (`dataset_semantics`). */
export interface RawVariable {
  description?: string;
  type?: string;
  unit?: string;
  variable?: string;
}

/** One file: an entry of `_files` / `files`, or a member of a file index. */
export interface RawFile {
  /** `online` or `on demand`. */
  availability?: string;
  checksum?: string;
  filename?: string;
  key?: string;
  size?: number;
  uri?: string;
}

/** One entry of `_file_indices`, or the body of `GET /record/{recid}/file_index/{key}`. */
export interface RawFileIndex {
  /** File counts by state: `{ online?, "on demand"? }`; empty (`{}`) on some records. */
  availability?: Record<string, number>;
  description?: string;
  files?: RawFile[];
  key?: string;
  number_files?: number | null;
  size?: number | null;
}

/** A record's (or doc's) `metadata` object. Fields are optional and may be `null` upstream. */
export interface RawMetadata {
  _availability_details?: Record<string, number> | null;
  _file_indices?: RawFileIndex[];
  _files?: RawFile[];
  abstract?: RawSection | null;
  author?: string;
  authors?: { name?: string; orcid?: string }[];
  availability?: string;
  body?: { content?: string; format?: string } | null;
  /** Physics category: one object, `secondary` and `source` often absent. */
  categories?: { primary?: string; secondary?: string[] | string; source?: string } | null;
  collaboration?: { name?: string; recid?: string } | null;
  collections?: string[];
  collision_information?: { energy?: string; type?: string } | null;
  /** Inline variable dictionary; `description` is HTML. */
  dataset_semantics?: RawVariable[] | null;
  dataset_semantics_files?: { json?: string; url?: string } | null;
  date_created?: string[] | string;
  date_published?: string;
  date_reprocessed?: string;
  distribution?: {
    availability?: string;
    formats?: string[];
    number_events?: number;
    number_files?: number;
    size?: number;
  } | null;
  doi?: string;
  experiment?: string[] | string;
  files?: RawFile[];
  keywords?: string[];
  license?: { attribution?: string | null } | null;
  links?: RawLink[];
  /** LHCb: `MagDown` or `MagUp`. */
  magnet_polarity?: string;
  methodology?: RawSection | null;
  note?: RawSection | null;
  /** CMS simulated data: the pile-up description (HTML) and the pile-up datasets, linked by `title`. */
  pileup?: { description?: string; links?: { recid?: string; title?: string }[] } | null;
  recid?: string;
  relations?: {
    description?: string;
    doi?: string;
    recid?: string;
    title?: string;
    type?: string;
  }[];
  run_numbers?: string[];
  run_period?: string[] | string | null;
  short_description?: { content?: string } | null;
  slug?: string;
  source_code_repository?: { url?: string } | null;
  /** LHCb datasets and stripping pages. */
  stripping?: { stream?: string; version?: string } | null;
  system_details?: {
    container_images?: { name?: string; registry?: string }[];
    description?: string;
    global_tag?: string;
    recid?: string;
    release?: string;
  } | null;
  tags?: string[];
  title?: string;
  title_additional?: string;
  type?: { primary?: string; secondary?: string[] | string } | null;
  usage?: RawSection | null;
  use_with?: RawSection | null;
  validation?: RawSection | null;
}

/** One search hit, a record GET body, or a doc GET body. */
export interface RawHit {
  /** recid for records; slug for docs and news. */
  id: string | number;
  metadata: RawMetadata;
}

/** A terms bucket; the `type` facet nests a `subtype` terms aggregation, `category` a `subcategory` one. */
export interface RawBucket {
  doc_count?: number;
  key?: string | number;
  key_as_string?: string;
  subcategory?: RawAggregation;
  subtype?: RawAggregation;
}

/** One facet aggregation (terms, range or date histogram). */
export interface RawAggregation {
  buckets?: RawBucket[];
  sum_other_doc_count?: number;
}

/** The search envelope; the boundary guarantees `hits.hits` is an array and `hits.total` a number. */
export interface RawSearchResponse {
  aggregations?: Record<string, RawAggregation>;
  hits: { hits: RawHit[]; total: number };
}

// Service-level shapes

/** One tool call's upstream time budget; every request of the call draws on it. */
export interface Budget {
  /** Epoch ms after which no upstream request may start or continue. */
  deadlineAt: number;
}

/**
 * Portal sort spellings; an unknown key would be silently ignored upstream, so
 * only these are sent. Direction comes only from a `-` prefix (descending): the
 * portal ignores the default order its sort options declare.
 */
export type SortKey = 'bestmatch' | '-mostrecent' | 'title' | '-title';

/** Search parameters. Only these names are ever sent; `ondemand=true` is always added. */
export interface SearchParams {
  availability?: readonly string[];
  /** `Primary` or `Primary::Secondary`; the portal ignores a `subcategory` parameter. */
  category?: readonly string[];
  collections?: readonly string[];
  collision_energy?: readonly string[];
  collision_type?: readonly string[];
  experiment?: readonly string[];
  file_type?: readonly string[];
  keywords?: readonly string[];
  magnet_polarity?: readonly string[];
  /** Range string `min--max`, `min--` or `--max` on `distribution.number_events`. */
  number_events?: string;
  /** 1-based page; omitted means page 1. */
  page?: number;
  q?: string;
  /** Page size (`size`), at least 1. */
  size: number;
  /** Sends `skip_files=1` (drops inline file manifests). Default `true`. */
  skipFiles?: boolean;
  sort?: SortKey;
  stripping_stream?: readonly string[];
  stripping_version?: readonly string[];
  type?: readonly string[];
  /** Range string `from--to`, `from--` or `--to` on `date_created`. */
  year?: string;
}

/**
 * A successful search page. Hits are raw; `normalize.ts` maps them to output
 * shapes. Paging is derived from `total`, never from `links.next` (Decision 25).
 */
export interface SearchPage {
  aggregations: Record<string, RawAggregation>;
  hits: RawHit[];
  total: number;
}

/** A 400 answer to a search, as the portal worded it. */
export interface SearchRejection {
  errors?: { field?: string; message?: string }[];
  message: string;
  status: 400;
}

/**
 * `search()` result: a page, the portal's 400 rejection, or a `server_error`
 * when every attempt answered 500, carrying the error retries ended on. The
 * portal answers some malformed queries with a 500 instead of its 400.
 */
export type SearchOutcome =
  | { kind: 'page'; page: SearchPage }
  | { kind: 'rejected'; rejection: SearchRejection }
  | { kind: 'server_error'; error: McpError };

/** A hit matched to the lookup inputs that resolved to it. */
export interface LookupMatch {
  hit: RawHit;
  /** The `input` strings (as given) that resolved to this record, in input order. */
  matchedInputs: string[];
}

/** One file in a compact manifest. */
export interface CompactFile {
  /** `online` or `on demand`, when the portal states it. */
  availability?: string;
  checksum?: string;
  filename?: string;
  /**
   * The portal's file key (index members: `<index>.json_<n>`), when it states
   * one; some index members carry none (Decision 24).
   */
  key?: string;
  /** Size in bytes. */
  size: number;
  /** XRootD URI (`root://eospublic.cern.ch//eos/opendata/…`). */
  uri: string;
}

/** File counts by availability state. */
export interface AvailabilityCounts {
  on_demand?: number;
  online?: number;
}

/**
 * One file index in a compact manifest. A count or size the portal does not
 * state falls back to the members listed.
 */
export interface CompactIndex {
  /** As the portal states it; `{}` when it states none. */
  availability: AvailabilityCounts;
  description?: string;
  files: CompactFile[];
  /** The `.json` key (`…_file_index.json`, `training_files.json`). */
  key: string;
  /** As stated, else the member count. */
  number_files: number;
  /** Total size in bytes: as stated, else the members' summed size. */
  size: number;
}

/** The record-level fields every `list_files` scope reports, whichever read served them. */
export interface RecordHead {
  availability?: string;
  availability_details?: AvailabilityCounts;
  recid: string;
  title?: string;
}

/** A record's file manifest, compacted for caching (bucket ids, version ids and tags dropped). */
export interface CompactManifest extends RecordHead {
  /**
   * The recids in `relations[type=isParentOf]` — set only when the record holds
   * no regular files and no indexes (an umbrella record); `[]` otherwise.
   */
  children: string[];
  /** Regular files (not index members). */
  files: CompactFile[];
  indexes: CompactIndex[];
  /**
   * `distribution.number_files` as the record states it. A tape-resident
   * (`ondemand`) record states its files while the API lists none of them.
   */
  number_files?: number;
  /** `distribution.size` in bytes, as the record states it. */
  size?: number;
}

/** One file index with its record's head: what an `index` call lists. */
export interface IndexListing {
  index: CompactIndex;
  record: RecordHead;
}

/** `getIndex()` result, the same whichever read answered it: a cached manifest or the index route. */
export type IndexLookup =
  | { kind: 'found'; listing: IndexListing }
  | { kind: 'index_not_found' }
  | { kind: 'record_not_found' };

/** A validated-run list variant, from file-key naming. */
export type RunListVariant = 'full' | 'muons_only';

/** One list of the `CMS-Validated-Runs` collection. */
export interface ValidatedRunList {
  collision_energy?: string;
  file_key: string;
  recid: string;
  run_periods: string[];
  /** Key with `_MuonPhys`, a trailing `_v<n>` and the extension removed; twins share it. */
  stem: string;
  title: string;
  variant: RunListVariant;
  xrootd_uri?: string;
}

/** A parsed good-run list: run number → inclusive luminosity-section ranges. */
export type RunList = Record<string, [number, number][]>;

// Output shapes (shared by the tools and the record resource)

/** A record's type. `secondary` is `[]` when absent. */
export interface RecordType {
  primary: string;
  secondary: string[];
}

/** One compact search hit. */
export interface SearchHit {
  availability?: string;
  collections?: string[];
  collision_energy?: string;
  collision_type?: string;
  date_created?: string[];
  date_published?: string;
  doi?: string;
  experiment?: string[];
  formats?: string[];
  /** The recid for records, the slug for docs and news. */
  id: string;
  number_events?: number;
  number_files?: number;
  portal_url: string;
  recid?: string;
  run_period?: string[];
  short_description?: string;
  size_in_bytes?: number;
  slug?: string;
  title?: string;
  title_additional?: string;
  type: RecordType;
}

/** One facet bucket; `type` buckets carry their `subtypes`, `category` buckets their `subcategories`. */
export interface FacetBucket {
  count: number;
  subcategories?: { count: number; value: string }[];
  subtypes?: { count: number; value: string }[];
  value: string;
}

/** One facet: its buckets plus the count hidden past the bucket cap (0 for range and histogram facets). */
export interface Facet {
  buckets: FacetBucket[];
  other_count: number;
}

/** The facets search returns. */
export interface Facets {
  availability: Facet;
  category: Facet;
  collision_energy: Facet;
  collision_type: Facet;
  experiment: Facet;
  file_type: Facet;
  keywords: Facet;
  magnet_polarity: Facet;
  number_events: Facet;
  stripping_stream: Facet;
  stripping_version: Facet;
  type: Facet;
  year: Facet;
}

/** Where a record's license statement comes from (Decision 12). */
export type LicenseBasis = 'record' | 'cern_terms_default' | 'not_stated';

export interface License {
  basis: LicenseBasis;
  id?: string;
  statement: string;
}

export interface Citation {
  doi: string;
  request: string;
  text: string;
}

/** Which metadata section a record link came from. */
export type LinkSource =
  | 'abstract'
  | 'note'
  | 'usage'
  | 'validation'
  | 'use_with'
  | 'pileup'
  | 'software';

export interface RecordLink {
  description?: string;
  recid?: string;
  source: LinkSource;
  url?: string;
}

export interface RecordRelation {
  description?: string;
  doi?: string;
  recid?: string;
  title?: string;
  /** Relayed verbatim (`isParentOf`, `isChildOf`, `isRelatedTo`), never interpreted. */
  type: string;
}

/** One variable of a record's dictionary; `description_html` as received. */
export interface RecordVariable {
  description_html?: string;
  type?: string;
  unit?: string;
  variable: string;
}

/** A record's physics category; `secondary` is `[]` when absent. */
export interface RecordCategory {
  primary: string;
  secondary: string[];
  source?: string;
}

export interface SystemDetails {
  /** `registry` is omitted for an image entry that does not state one. */
  container_images?: { name: string; registry?: string }[];
  description?: string;
  environment_recid?: string;
  global_tag?: string;
  release?: string;
}

/** The Record shape shared by `cern_opendata_get_records` and `cern-opendata://record/{recid}`. */
export interface RecordShape {
  abstract_html?: string;
  authors?: { name: string; orcid?: string }[];
  availability?: string;
  availability_details?: AvailabilityCounts;
  /** Doc/news body: a slice of at most 30,000 UTF-16 units from `body_offset`. */
  body?: string;
  body_format?: string;
  /** Whole body length in UTF-16 units. */
  body_length?: number;
  /** Where more body starts; present only when more follows the slice. */
  body_next_offset?: number;
  /** Where the slice starts in the whole body. */
  body_offset?: number;
  /** True when more body follows the slice. */
  body_truncated?: boolean;
  category?: RecordCategory;
  citation?: Citation;
  collaboration?: { name: string; recid?: string };
  collections?: string[];
  collision_energy?: string;
  collision_type?: string;
  dataset_semantics?: { html_url?: string; json_url?: string };
  date_created?: string[];
  date_published?: string;
  date_reprocessed?: string;
  distribution?: {
    formats: string[];
    number_events?: number;
    number_files?: number;
    size_in_bytes?: number;
  };
  doi?: string;
  experiment?: string[];
  id: string;
  keywords?: string[];
  kind: 'record' | 'doc';
  license: License;
  links: RecordLink[];
  /** LHCb magnet polarity. */
  magnet_polarity?: string;
  matched_inputs: string[];
  methodology_html?: string;
  note_html?: string;
  pileup_html?: string;
  portal_url: string;
  recid?: string;
  relations: RecordRelation[];
  run_numbers?: string[];
  run_period?: string[];
  short_description?: string;
  slug?: string;
  source_code_repository_url?: string;
  stripping?: { stream?: string; version?: string };
  system_details?: SystemDetails;
  tags?: string[];
  title?: string;
  title_additional?: string;
  type: RecordType;
  usage_html?: string;
  use_with_html?: string;
  validation_html?: string;
  variables?: RecordVariable[];
}
