/**
 * @fileoverview Pure mappings from raw portal payloads to the output shapes:
 * search hits, facets, the shared Record shape (license and citation
 * included), compact file manifests and validated-run lists. Strings are kept
 * exactly as received; absent fields are omitted, never defaulted.
 * @module services/cern-opendata/normalize
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { PORTAL_ORIGIN, sliceText } from './text.js';
import type {
  AvailabilityCounts,
  Citation,
  CompactFile,
  CompactIndex,
  CompactManifest,
  Facet,
  FacetBucket,
  Facets,
  License,
  LinkSource,
  RawAggregation,
  RawFile,
  RawFileIndex,
  RawHit,
  RawMetadata,
  RecordCategory,
  RecordHead,
  RecordLink,
  RecordRelation,
  RecordShape,
  RecordType,
  RecordVariable,
  RunListVariant,
  SearchHit,
  SystemDetails,
  ValidatedRunList,
} from './types.js';

/** Doc and news bodies are cut at this many characters (Decision 14). */
export const DOC_BODY_MAX_CHARS = 30_000;

/** The citation request text CERN attaches to reused data (Decision 13). */
export const CITATION_REQUEST =
  'CERN asks reusers to cite the data they use; cite this DOI in applications and publications.';

/** Every key of `T` listed explicitly; optional keys may be `undefined` and are then omitted. */
type Loose<T> = { [K in keyof T]-?: undefined extends T[K] ? T[K] | undefined : T[K] };

/**
 * Build `T` from a literal that names every key, dropping the `undefined`
 * ones, so absent optional fields are omitted rather than set to `undefined`.
 */
export function definedOnly<T extends object>(fields: Loose<T>): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

/** A non-blank string as received, else `undefined`. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A finite number, else `undefined`. */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The non-blank strings of an array (or a lone string), else `undefined` when none remain. */
export function strList(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : [value];
  const strings = items.filter((item): item is string => str(item) !== undefined);
  return strings.length > 0 ? strings : undefined;
}

/**
 * A portal value bound for a request path segment, or `undefined` for `.` and
 * `..`: `encodeURIComponent` leaves them as they are, and the URL parser then
 * resolves them as dot segments, retargeting the request.
 */
export function pathSegment(value: string | undefined): string | undefined {
  return value === '.' || value === '..' ? undefined : value;
}

/** `https://opendata.cern.ch/record/{recid}`. */
export function recordUrl(recid: string): string {
  return `${PORTAL_ORIGIN}/record/${encodeURIComponent(recid)}`;
}

/** `https://opendata.cern.ch/docs/{slug}`. */
export function docUrl(slug: string): string {
  return `${PORTAL_ORIGIN}/docs/${encodeURIComponent(slug)}`;
}

/** The portal page of a hit: the doc page when it has a slug, else the record page. */
export function portalUrlOf(hit: RawHit): string {
  const slug = str(hit.metadata.slug);
  return slug ? docUrl(slug) : recordUrl(str(hit.metadata.recid) ?? String(hit.id));
}

/** `{ primary, secondary }`, with `secondary` `[]` when absent. */
export function recordTypeOf(meta: RawMetadata): RecordType {
  return {
    primary: str(meta.type?.primary) ?? '',
    secondary: strList(meta.type?.secondary) ?? [],
  };
}

/** Record-level availability: `metadata.availability`, else `distribution.availability`. */
export function availabilityOf(meta: RawMetadata): string | undefined {
  return str(meta.availability) ?? str(meta.distribution?.availability);
}

/** `{ online?, "on demand"? }` counts with the space-keyed state renamed to `on_demand`. */
export function availabilityCounts(
  raw: Record<string, number> | null | undefined,
): AvailabilityCounts | undefined {
  if (!raw || typeof raw !== 'object') return;
  return definedOnly<AvailabilityCounts>({
    online: num(raw.online),
    on_demand: num(raw['on demand']),
  });
}

/** One compact search hit. */
export function toSearchHit(hit: RawHit): SearchHit {
  const meta = hit.metadata;
  return definedOnly<SearchHit>({
    id: String(hit.id),
    recid: str(meta.recid),
    slug: str(meta.slug),
    title: str(meta.title),
    title_additional: str(meta.title_additional),
    type: recordTypeOf(meta),
    experiment: strList(meta.experiment),
    run_period: strList(meta.run_period),
    date_created: strList(meta.date_created),
    collections: strList(meta.collections),
    formats: strList(meta.distribution?.formats),
    doi: str(meta.doi),
    date_published: str(meta.date_published),
    availability: availabilityOf(meta),
    collision_energy: str(meta.collision_information?.energy),
    collision_type: str(meta.collision_information?.type),
    number_events: num(meta.distribution?.number_events),
    number_files: num(meta.distribution?.number_files),
    size_in_bytes: num(meta.distribution?.size),
    short_description: str(meta.short_description?.content),
    portal_url: portalUrlOf(hit),
  });
}

type FacetKind = 'terms' | 'range' | 'histogram';

const FACET_KINDS: Record<keyof Facets, FacetKind> = {
  experiment: 'terms',
  type: 'terms',
  collision_energy: 'terms',
  collision_type: 'terms',
  file_type: 'terms',
  availability: 'terms',
  year: 'histogram',
  number_events: 'range',
  category: 'terms',
  keywords: 'terms',
  magnet_polarity: 'terms',
  stripping_stream: 'terms',
  stripping_version: 'terms',
};

/** Every facet search returns, in the order `cern_opendata_search_records` lists them. */
export const FACET_KEYS = Object.keys(FACET_KINDS) as (keyof Facets)[];

/** The facets whose buckets nest a second level: the raw sub-aggregation and the field it becomes. */
const NESTED_LEVELS: Partial<
  Record<keyof Facets, readonly ['subtype', 'subtypes'] | readonly ['subcategory', 'subcategories']>
> = {
  type: ['subtype', 'subtypes'],
  category: ['subcategory', 'subcategories'],
};

function toFacet(agg: RawAggregation | undefined, key: keyof Facets): Facet {
  const kind = FACET_KINDS[key];
  const nested = NESTED_LEVELS[key];
  const buckets = (agg?.buckets ?? []).flatMap((bucket): FacetBucket[] => {
    const value =
      kind === 'histogram'
        ? (str(bucket.key_as_string) ?? str(String(bucket.key ?? '')))
        : str(String(bucket.key ?? ''));
    if (value === undefined || (key === 'type' && value === 'Glossary')) return [];
    const level =
      nested &&
      bucket[nested[0]]?.buckets?.flatMap((sub) => {
        const subValue = str(String(sub.key ?? ''));
        return subValue === undefined ? [] : [{ value: subValue, count: num(sub.doc_count) ?? 0 }];
      });
    return [
      {
        value,
        count: num(bucket.doc_count) ?? 0,
        ...(nested && level ? { [nested[1]]: level } : {}),
      },
    ];
  });
  return { buckets, other_count: kind === 'terms' ? (num(agg?.sum_other_doc_count) ?? 0) : 0 };
}

/**
 * The thirteen facets search exposes. `year` buckets use `key_as_string`; range
 * and histogram facets report `other_count: 0`; `type` buckets nest `subtypes`
 * and `category` buckets `subcategories`; the Glossary bucket is dropped from
 * `type`. Values are kept as received, a leading space included. A facet the
 * portal omitted comes back with no buckets.
 */
export function toFacets(aggregations: Record<string, RawAggregation>): Facets {
  return Object.fromEntries(
    FACET_KEYS.map((key) => [key, toFacet(aggregations[key], key)]),
  ) as Record<keyof Facets, Facet>;
}

/** How many glossary entries the `type` facet counted (the zero-hit glossary notice). */
export function glossaryFacetCount(aggregations: Record<string, RawAggregation>): number {
  const bucket = aggregations.type?.buckets?.find((b) => b.key === 'Glossary');
  return num(bucket?.doc_count) ?? 0;
}

/** The record's license statement (Decision 12). */
export function licenseOf(meta: RawMetadata): License {
  const attribution = str(meta.license?.attribution);
  if (attribution) {
    return {
      id: attribution,
      basis: 'record',
      statement: `Licensed ${attribution}, as stated on the record.`,
    };
  }
  if (meta.type?.primary === 'Dataset') {
    return {
      id: 'CC0-1.0',
      basis: 'cern_terms_default',
      statement:
        'CC0-1.0 under the CERN Open Data Terms of Use; the record states no license of its own.',
    };
  }
  return {
    basis: 'not_stated',
    statement:
      "The record states no license. Software, environments, documentation and supplementary material are licensed separately from the CC0 data (software is commonly GPL); check the record's portal page.",
  };
}

/**
 * The portal's "Cite as" (Decision 13): `{author}; ` for each author, then
 * `{collaboration.name} ({date_published}). {title_additional ?? title}. CERN
 * Open Data Portal. DOI:{doi}`, leaving out any part the record lacks.
 */
export function citationOf(meta: RawMetadata, doi: string): Citation {
  const collaboration = str(meta.collaboration?.name);
  const date = str(meta.date_published);
  const title = str(meta.title_additional) ?? str(meta.title);
  const parts = (authorsOf(meta) ?? []).map((author) => `${author.name};`);
  if (collaboration && date) parts.push(`${collaboration} (${date}).`);
  else if (collaboration) parts.push(`${collaboration}.`);
  else if (date) parts.push(`(${date}).`);
  if (title) parts.push(title.endsWith('.') ? title : `${title}.`);
  parts.push(`CERN Open Data Portal. DOI:${doi}`);
  return { text: parts.join(' '), doi, request: CITATION_REQUEST };
}

const LINK_SECTIONS = ['abstract', 'note', 'usage', 'validation', 'use_with'] as const;

/** Pile-up links name their dataset in `title`, which becomes the link's `description`. */
function pileupLinksOf(meta: RawMetadata) {
  const links = meta.pileup?.links;
  return Array.isArray(links)
    ? links.map((link) => ({ recid: link?.recid, description: link?.title }))
    : undefined;
}

function linksOf(meta: RawMetadata): RecordLink[] {
  const sections: [LinkSource, unknown][] = [
    ...LINK_SECTIONS.map((source): [LinkSource, unknown] => [source, meta[source]?.links]),
    ['pileup', pileupLinksOf(meta)],
    ['software', meta.links],
  ];
  return sections.flatMap(([source, links]) =>
    (Array.isArray(links) ? links : []).flatMap((link) => {
      const recid = str(link?.recid);
      const url = str(link?.url);
      const description = str(link?.description);
      if (!recid && !url && !description) return [];
      return [definedOnly<RecordLink>({ source, recid, url, description })];
    }),
  );
}

function relationsOf(meta: RawMetadata): RecordRelation[] {
  return (Array.isArray(meta.relations) ? meta.relations : []).flatMap((relation) => {
    const type = str(relation?.type);
    if (!type) return [];
    return [
      definedOnly<RecordRelation>({
        type,
        recid: str(relation.recid),
        doi: str(relation.doi),
        title: str(relation.title),
        description: str(relation.description),
      }),
    ];
  });
}

/** `system_details` with `recid` renamed `environment_recid`; `undefined` when it states nothing. */
export function systemDetailsOf(meta: RawMetadata): SystemDetails | undefined {
  const details = meta.system_details;
  if (!details || typeof details !== 'object') return;
  const images = Array.isArray(details.container_images)
    ? details.container_images.flatMap((image) => {
        const name = str(image?.name);
        return name
          ? [
              definedOnly<{ name: string; registry?: string }>({
                name,
                registry: str(image.registry),
              }),
            ]
          : [];
      })
    : undefined;
  const shaped = definedOnly<SystemDetails>({
    release: str(details.release),
    global_tag: str(details.global_tag),
    container_images: images && images.length > 0 ? images : undefined,
    environment_recid: str(details.recid),
    description: str(details.description),
  });
  return Object.keys(shaped).length > 0 ? shaped : undefined;
}

function authorsOf(meta: RawMetadata): RecordShape['authors'] {
  const authors = (Array.isArray(meta.authors) ? meta.authors : []).flatMap((author) => {
    const name = str(author?.name);
    return name
      ? [definedOnly<{ name: string; orcid?: string }>({ name, orcid: str(author.orcid) })]
      : [];
  });
  if (authors.length > 0) return authors;
  const newsAuthor = str(meta.author);
  return newsAuthor ? [{ name: newsAuthor }] : undefined;
}

function distributionOf(meta: RawMetadata): RecordShape['distribution'] {
  const distribution = meta.distribution;
  if (!distribution || typeof distribution !== 'object') return;
  return definedOnly<NonNullable<RecordShape['distribution']>>({
    formats: strList(distribution.formats) ?? [],
    number_events: num(distribution.number_events),
    number_files: num(distribution.number_files),
    size_in_bytes: num(distribution.size),
  });
}

function datasetSemanticsOf(meta: RawMetadata): RecordShape['dataset_semantics'] {
  const files = meta.dataset_semantics_files;
  if (!files || typeof files !== 'object') return;
  const html = str(files.url);
  const json = str(files.json);
  if (!html && !json) return;
  return definedOnly<NonNullable<RecordShape['dataset_semantics']>>({
    html_url: html ? `${PORTAL_ORIGIN}${html.startsWith('/') ? '' : '/'}${html}` : undefined,
    json_url: json ? `${PORTAL_ORIGIN}${json.startsWith('/') ? '' : '/'}${json}` : undefined,
  });
}

/** `dataset_semantics[]` as `{ variable, type?, unit?, description_html? }`; an entry without `variable` is dropped. */
function variablesOf(meta: RawMetadata): RecordVariable[] | undefined {
  const entries = meta.dataset_semantics;
  if (!Array.isArray(entries)) return;
  const variables = entries.flatMap((entry) => {
    const variable = str(entry?.variable);
    return variable
      ? [
          definedOnly<RecordVariable>({
            variable,
            type: str(entry.type),
            unit: str(entry.unit),
            description_html: str(entry.description),
          }),
        ]
      : [];
  });
  return variables.length > 0 ? variables : undefined;
}

/** `categories` as `{ primary, secondary[], source? }`; `undefined` without a primary. */
function categoryOf(meta: RawMetadata): RecordCategory | undefined {
  const primary = str(meta.categories?.primary);
  if (!primary) return;
  return definedOnly<RecordCategory>({
    primary,
    secondary: strList(meta.categories?.secondary) ?? [],
    source: str(meta.categories?.source),
  });
}

function strippingOf(meta: RawMetadata): RecordShape['stripping'] {
  const shaped = definedOnly<NonNullable<RecordShape['stripping']>>({
    stream: str(meta.stripping?.stream),
    version: str(meta.stripping?.version),
  });
  return Object.keys(shaped).length > 0 ? shaped : undefined;
}

/**
 * The shared Record shape for one hit (also a record GET or doc GET body).
 * `matchedInputs` lists the caller's ids that resolved here; the resource
 * passes `[recid]`. A doc or news body is returned as a slice of at most
 * {@link DOC_BODY_MAX_CHARS} UTF-16 units from `bodyOffset` (Decision 50).
 */
export function toRecord(hit: RawHit, matchedInputs: string[], bodyOffset = 0): RecordShape {
  const meta = hit.metadata;
  const slug = str(meta.slug);
  const doi = str(meta.doi);
  const body = str(meta.body?.content);
  const slice = body === undefined ? undefined : sliceText(body, bodyOffset, DOC_BODY_MAX_CHARS);
  const more = slice !== undefined && slice.end < (body?.length ?? 0);
  const collaborationName = str(meta.collaboration?.name);
  return definedOnly<RecordShape>({
    id: String(hit.id),
    kind: slug ? 'doc' : 'record',
    recid: str(meta.recid),
    slug,
    matched_inputs: matchedInputs,
    title: str(meta.title),
    title_additional: str(meta.title_additional),
    type: recordTypeOf(meta),
    experiment: strList(meta.experiment),
    collections: strList(meta.collections),
    date_created: strList(meta.date_created),
    run_period: strList(meta.run_period),
    run_numbers: strList(meta.run_numbers),
    collaboration: collaborationName
      ? definedOnly<{ name: string; recid?: string }>({
          name: collaborationName,
          recid: str(meta.collaboration?.recid),
        })
      : undefined,
    authors: authorsOf(meta),
    doi,
    date_published: str(meta.date_published),
    date_reprocessed: str(meta.date_reprocessed),
    availability: availabilityOf(meta),
    collision_energy: str(meta.collision_information?.energy),
    collision_type: str(meta.collision_information?.type),
    distribution: distributionOf(meta),
    availability_details: availabilityCounts(meta._availability_details),
    abstract_html: str(meta.abstract?.description),
    methodology_html: str(meta.methodology?.description),
    usage_html: str(meta.usage?.description),
    validation_html: str(meta.validation?.description),
    note_html: str(meta.note?.description),
    use_with_html: str(meta.use_with?.description),
    pileup_html: str(meta.pileup?.description),
    links: linksOf(meta),
    relations: relationsOf(meta),
    system_details: systemDetailsOf(meta),
    source_code_repository_url: str(meta.source_code_repository?.url),
    dataset_semantics: datasetSemanticsOf(meta),
    variables: variablesOf(meta),
    category: categoryOf(meta),
    keywords: strList(meta.keywords),
    magnet_polarity: str(meta.magnet_polarity),
    stripping: strippingOf(meta),
    short_description: str(meta.short_description?.content),
    tags: strList(meta.tags),
    body: slice?.text,
    body_format: str(meta.body?.format),
    body_length: body?.length,
    body_offset: slice?.start,
    body_next_offset: more ? slice?.end : undefined,
    body_truncated: slice ? more : undefined,
    license: licenseOf(meta),
    citation: doi ? citationOf(meta, doi) : undefined,
    portal_url: portalUrlOf(hit),
  });
}

function unreadable(message: string): never {
  throw serviceUnavailable(message, { reason: 'upstream_unreadable' });
}

/**
 * One file. Its XRootD URI and size are what `list_files` exists to return,
 * so a file without either is unreadable; `key` is relayed when stated and
 * never filled in, since some index members carry none (Decision 24).
 */
function toCompactFile(raw: RawFile, recid: string): CompactFile {
  const uri = str(raw?.uri);
  const size = num(raw?.size);
  if (!uri || size === undefined) {
    unreadable(
      `CERN Open Data returned a file entry for record ${recid} without an XRootD URI or size.`,
    );
  }
  return definedOnly<CompactFile>({
    key: str(raw.key),
    filename: str(raw.filename),
    size,
    checksum: str(raw.checksum),
    uri,
    availability: str(raw.availability),
  });
}

/**
 * One file index: a `_file_indices` entry of the record GET, or the body of
 * `GET /record/{recid}/file_index/{key}`, which is the same entry. An index
 * lists every file it holds, so a count or size the portal does not state
 * falls back to the member count and the members' summed size; availability
 * is relayed as stated, `{}` when it states none. An index without a key, with
 * a key that is not well-formed Unicode (its URI-list and JSON URLs cannot be
 * built), or with a member lacking its URI or size, is unreadable.
 */
export function toCompactIndex(raw: RawFileIndex, recid: string): CompactIndex {
  const key = str(raw?.key);
  if (!key) unreadable(`CERN Open Data returned a file index for record ${recid} without a key.`);
  if (!key.isWellFormed()) {
    unreadable(
      `CERN Open Data returned a file index for record ${recid} whose key is not well-formed Unicode.`,
    );
  }
  const files = (Array.isArray(raw.files) ? raw.files : []).map((file) =>
    toCompactFile(file, recid),
  );
  return definedOnly<CompactIndex>({
    key,
    description: str(raw.description),
    number_files: num(raw.number_files) ?? files.length,
    size: num(raw.size) ?? files.reduce((total, file) => total + file.size, 0),
    availability: availabilityCounts(raw.availability) ?? {},
    files,
  });
}

/**
 * The record-level fields `list_files` reports, read alike from a record GET
 * body and from the record's files-skipped search hit, so index-scope output
 * does not depend on which read served it.
 */
export function toRecordHead(recid: string, meta: RawMetadata): RecordHead {
  return definedOnly<RecordHead>({
    recid,
    title: str(meta.title),
    availability: availabilityOf(meta),
    availability_details: availabilityCounts(meta._availability_details),
  });
}

/**
 * Compact a full record GET body into the cached manifest. Regular files come
 * from `_files` (or `files`); `children` is set only for an umbrella record
 * holding no files and no indexes (Decision 21); `number_files` and `size` are
 * the record's stated `distribution`, kept for records the API lists no files
 * for (Decision 30). A file entry missing its URI or size makes the body
 * unreadable (`upstream_unreadable`).
 */
export function toManifest(recid: string, meta: RawMetadata): CompactManifest {
  const rawFiles = Array.isArray(meta._files)
    ? meta._files
    : Array.isArray(meta.files)
      ? meta.files
      : [];
  const files = rawFiles.map((file) => toCompactFile(file, recid));
  const indexes = (Array.isArray(meta._file_indices) ? meta._file_indices : []).map((index) =>
    toCompactIndex(index, recid),
  );
  const children =
    files.length === 0 && indexes.length === 0
      ? relationsOf(meta).flatMap((relation) =>
          relation.type === 'isParentOf' && relation.recid ? [relation.recid] : [],
        )
      : [];
  return {
    ...toRecordHead(recid, meta),
    ...definedOnly<Omit<CompactManifest, keyof RecordHead>>({
      files,
      indexes,
      children,
      number_files: num(meta.distribution?.number_files),
      size: num(meta.distribution?.size),
    }),
  };
}

/** `muons_only` when the file key contains `_MuonPhys`, else `full` (Decision 17). */
export function runListVariant(fileKey: string): RunListVariant {
  return fileKey.includes('_MuonPhys') ? 'muons_only' : 'full';
}

/** The key with its extension, a trailing `_v<n>` and `_MuonPhys` removed; twins share it. */
export function runListStem(fileKey: string): string {
  return fileKey
    .replace(/\.[^.]+$/, '')
    .replace(/_v\d+$/, '')
    .replace(/_MuonPhys/g, '');
}

/**
 * A validated-run list from a collection hit; `undefined` when the hit carries
 * no file, or no recid or file key usable in the file's request path.
 */
export function toValidatedRunList(hit: RawHit): ValidatedRunList | undefined {
  const meta = hit.metadata;
  const recid = pathSegment(str(meta.recid));
  const file = (Array.isArray(meta._files) ? meta._files : (meta.files ?? []))[0];
  const fileKey = pathSegment(str(file?.key));
  if (!recid || !fileKey) return;
  return definedOnly<ValidatedRunList>({
    recid,
    title: str(meta.title) ?? `CMS list of validated runs ${fileKey}`,
    file_key: fileKey,
    variant: runListVariant(fileKey),
    stem: runListStem(fileKey),
    run_periods: strList(meta.run_period) ?? [],
    collision_energy: str(meta.collision_information?.energy),
    xrootd_uri: str(file?.uri),
  });
}

/** The list sharing `list`'s stem with the other variant, if the collection has one. */
export function twinOf(
  list: ValidatedRunList,
  lists: readonly ValidatedRunList[],
): ValidatedRunList | undefined {
  return lists.find((other) => other.stem === list.stem && other.variant !== list.variant);
}
