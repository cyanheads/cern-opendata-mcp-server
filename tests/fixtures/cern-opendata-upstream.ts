/**
 * @fileoverview Upstream fixture bodies for CERN Open Data Portal tests, shaped
 * like the API Reference of `docs/design.md`: search envelopes, record and doc
 * GET bodies, validated-run lists and their files. Real public recids, DOIs and
 * dataset paths; the content is trimmed to what the tests read. Shared by the
 * service, normalizer and tool tests.
 * @module tests/fixtures/cern-opendata-upstream
 */

import type { FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';
import type { RawHit, RawMetadata } from '@/services/cern-opendata/types.js';

export const PORTAL = 'https://opendata.cern.ch';

// Response helpers

/** `x-ratelimit-*` headers the portal sends on every response (`reset` is epoch seconds). */
export function rateLimitHeaders(
  remaining: number,
  resetEpochSeconds: number,
): Record<string, string> {
  return {
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(resetEpochSeconds),
  };
}

/** A JSON response. Pass `headers: { 'retry-after': '60' }` for the header the portal adds to every response. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** A fetch-mock route matching the portal origin, a pathname and an optional query predicate. */
export function portalRoute(
  pathname: string | RegExp,
  respond: FetchMockRoute['respond'],
  options: { query?: (params: URLSearchParams) => boolean; once?: boolean } = {},
): FetchMockRoute {
  return {
    method: 'GET',
    match: (request) => {
      const url = new URL(request.url);
      if (url.origin !== PORTAL) return false;
      const pathMatches =
        typeof pathname === 'string' ? url.pathname === pathname : pathname.test(url.pathname);
      return pathMatches && (options.query?.(url.searchParams) ?? true);
    },
    respond,
    ...(options.once ? { once: true } : {}),
  };
}

export const NOT_FOUND_BODY = { status: 404, message: 'PID does not exist.' };
export const SYNTAX_ERROR_BODY = {
  status: 400,
  message: 'The syntax of the search query is invalid.',
};
export const WINDOW_ERROR_BODY = {
  status: 400,
  message: 'Maximum number of 10000 results have been reached.',
};
export const RANGE_ERROR_BODY = {
  status: 400,
  message: 'Validation error.',
  errors: [{ field: 'date_created', message: 'Invalid range format.' }],
};
export const HTML_ERROR_PAGE =
  '<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1></body></html>';

// Hits

/** One search hit; `id` is the recid for records and the slug for docs. */
export function hit(id: string | number, metadata: RawMetadata): RawHit {
  return { id, metadata };
}

/** Collision dataset with a DOI, no license of its own, and a link to validated-run list 1002. */
export const collisionDatasetHit: RawHit = hit(6004, {
  recid: '6004',
  title: '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
  type: { primary: 'Dataset', secondary: ['Collision'] },
  experiment: ['CMS'],
  collaboration: { name: 'CMS Collaboration' },
  run_period: ['Run2012B'],
  date_created: ['2012'],
  date_published: '2014',
  doi: '10.7483/OPENDATA.CMS.YLIC.86ZZ',
  collections: ['CMS-Primary-Datasets'],
  collision_information: { energy: '8TeV', type: 'pp' },
  distribution: {
    formats: ['aod', 'root'],
    number_events: 29_308_627,
    number_files: 158,
    size: 4_950_000_000_000,
    availability: 'online',
  },
  abstract: {
    description: '<p>Dimuon events recorded in 2012.</p>',
    links: [{ recid: '1002' }],
  },
  usage: {
    description: '<p>See the <a href="/docs/cms-guide-docker">Docker guide</a>.</p>',
    links: [{ description: 'CMS Docker guide', url: '/docs/cms-guide-docker#intro' }],
  },
});

/** Dataset stating its own license. */
export const licensedDatasetHit: RawHit = hit(30517, {
  recid: '30517',
  title:
    '/GluGluHToBB_M125_13TeV_powheg_pythia8/RunIIFall15MiniAODv2-PU25nsData2015v1-v1/MINIAODSIM',
  type: { primary: 'Dataset', secondary: ['Simulated'] },
  experiment: ['CMS'],
  license: { attribution: 'CC0-1.0' },
  doi: '10.7483/OPENDATA.CMS.TEST.0001',
  collision_information: { energy: '13TeV', type: 'pp' },
  distribution: { formats: ['miniaodsim'], number_events: 1_000, number_files: 1, size: 1_000 },
});

/** Software record stating GPL. */
export const softwareHit: RawHit = hit(101, {
  recid: '101',
  title: 'CMS analysis example: Higgs to four leptons',
  type: { primary: 'Software', secondary: ['Analysis'] },
  experiment: ['CMS'],
  license: { attribution: 'GPL-3.0-only' },
  source_code_repository: { url: 'https://github.com/cms-opendata-analyses/HiggsExample' },
  links: [{ description: 'Source', url: 'https://github.com/cms-opendata-analyses/HiggsExample' }],
  use_with: { description: '<p>Works with 6004.</p>', links: [{ recid: '6004' }] },
});

/** Sparse record: null `license`, `collision_information` and `run_period`, no DOI. */
export const sparseHit: RawHit = hit(1120, {
  recid: '1120',
  title: 'Sparse record',
  type: { primary: 'Software' },
  license: null,
  collision_information: null,
  run_period: null,
});

/** Documentation page: the hit id is the slug, there is no recid. */
export const docHit: RawHit = hit('cms-guide-docker', {
  slug: 'cms-guide-docker',
  title: 'Docker containers for CMS open data',
  type: { primary: 'Documentation', secondary: ['Guide'] },
  experiment: ['CMS'],
  tags: ['docker', 'cmssw'],
  short_description: { content: 'How to run the CMS open data containers.' },
  body: {
    content: '## <a name="intro">Introduction</a>\n\nRun `docker pull`.\n',
    format: 'md',
  },
});

/** News item: carries an `author` string and a publication date. */
export const newsHit: RawHit = hit('cms-releases-2026', {
  slug: 'cms-releases-2026',
  title: 'CMS releases 2026 data',
  type: { primary: 'News' },
  author: 'CERN Open Data team',
  date_published: '2026-03-01',
  short_description: { content: 'New data.' },
  body: { content: 'CMS has released new data.', format: 'md' },
});

/** Environment record with container images, a release and a global tag. */
export const environmentSystemHit: RawHit = hit(12100, {
  recid: '12100',
  title: 'CMS 2012 virtual machine',
  type: { primary: 'Environment', secondary: ['VM'] },
  experiment: ['CMS'],
  system_details: {
    release: 'CMSSW_5_3_32',
    global_tag: 'FT53_V21A_AN6',
    container_images: [
      { name: 'cmsopendata/cmssw_5_3_32', registry: 'dockerhub' },
      { name: 'cmsopendata/other' },
      { registry: 'dockerhub' },
    ],
    recid: '12101',
    description: 'VM <b>image</b>',
  },
});

// Aggregations

export const aggregationsBody = {
  experiment: {
    buckets: [
      { key: 'ATLAS', doc_count: 12 },
      { key: 'CMS', doc_count: 700 },
    ],
    sum_other_doc_count: 3,
  },
  type: {
    buckets: [
      {
        key: 'Dataset',
        doc_count: 600,
        subtype: {
          buckets: [
            { key: 'Collision', doc_count: 500 },
            { key: 'Simulated', doc_count: 100 },
          ],
        },
      },
      { key: 'Glossary', doc_count: 5, subtype: { buckets: [] } },
      {
        key: 'Software',
        doc_count: 90,
        subtype: { buckets: [{ key: 'Analysis', doc_count: 90 }] },
      },
    ],
    sum_other_doc_count: 0,
  },
  year: {
    buckets: [
      { key: 1_325_376_000_000, key_as_string: '2012', doc_count: 400 },
      { key: 1_356_998_400_000, key_as_string: '2013', doc_count: 300 },
    ],
  },
  number_events: {
    buckets: [
      { key: '1000--9999', from: 1000, to: 9999, doc_count: 7 },
      { key: '10000000--', from: 10_000_000, doc_count: 40 },
    ],
  },
  collision_energy: { buckets: [{ key: '8TeV', doc_count: 300 }], sum_other_doc_count: 2 },
  collision_type: { buckets: [{ key: 'pp', doc_count: 300 }], sum_other_doc_count: 0 },
  file_type: { buckets: [{ key: 'aod', doc_count: 250 }], sum_other_doc_count: 11 },
  availability: { buckets: [{ key: 'online', doc_count: 650 }], sum_other_doc_count: 0 },
};

// Search envelopes

export interface SearchBodyOptions {
  aggregations?: Record<string, unknown>;
  /** Present when more pages follow. */
  hasNext?: boolean;
  total?: number;
}

/** A 200 search body: `{ hits: { hits, total }, links, aggregations }`. */
export function searchBody(hits: readonly RawHit[], options: SearchBodyOptions = {}) {
  return {
    hits: { hits, total: options.total ?? hits.length },
    links: {
      self: `${PORTAL}/api/records/?page=1&size=10`,
      ...(options.hasNext ? { next: `${PORTAL}/api/records/?page=2&size=10` } : {}),
    },
    aggregations: options.aggregations ?? {},
  };
}

export const emptySearchBody = searchBody([], { total: 0 });

// Record GET bodies (full manifests)

/** Regular files with checksums, the bucket and version ids a manifest must drop. */
const FILE_A = {
  key: 'file_a.root',
  size: 1024,
  checksum: 'adler32:0a1b2c3d',
  uri: 'root://eospublic.cern.ch//eos/opendata/cms/file_a.root',
  availability: 'online',
  bucket: 'b1',
  file_id: 'f1',
  version_id: 'v1',
  tags: { uri_cold: 'root://cold/file_a.root' },
};
const FILE_B = {
  key: 'file_b.root',
  size: 2048,
  uri: 'root://eospublic.cern.ch//eos/opendata/cms/file_b.root',
};

/** One index member, as listed under a file index. */
export function indexFile(n: number, extras: Record<string, unknown> = {}) {
  return {
    key: `ds_file_index.json_${n}`,
    filename: `part_${n}.root`,
    size: 100 * (n + 1),
    checksum: `adler32:0000000${n}`,
    uri: `root://eospublic.cern.ch//eos/opendata/atlas/part_${n}.root`,
    availability: n % 2 === 0 ? 'online' : 'on demand',
    ...extras,
  };
}

/** `GET /api/records/{recid}` wrapper. */
export function recordBody(metadata: RawMetadata) {
  return {
    id: Number(metadata.recid ?? 0),
    created: '2020-01-01T00:00:00+00:00',
    updated: '2026-01-01T00:00:00+00:00',
    links: { self: `${PORTAL}/api/records/${metadata.recid}`, bucket: `${PORTAL}/api/files/b1` },
    metadata,
  };
}

/** A record with two regular files and no indexes. */
export const filesRecordBody = recordBody({
  recid: '6004',
  title: '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
  availability: 'online',
  _availability_details: { online: 2 },
  _files: [FILE_A, FILE_B],
});

/** A record with two file indexes of two files each, one index half on tape. */
export const indexedRecordBody = recordBody({
  recid: '24464',
  title: 'ATLAS DAOD_PHYSLITE sample',
  availability: 'partial',
  _availability_details: { online: 2, 'on demand': 2 },
  _file_indices: [
    {
      key: 'ds_a_file_index.json',
      description: 'First index',
      number_files: 2,
      size: 300,
      availability: { online: 1, 'on demand': 1 },
      files: [indexFile(0), indexFile(1)],
    },
    {
      key: 'ds_b_file_index.json',
      number_files: 2,
      size: 500,
      availability: { online: 2 },
      files: [indexFile(2), indexFile(3)],
    },
  ],
});

/** Umbrella record: no files, no indexes, children as `isParentOf`. */
export const umbrellaRecordBody = recordBody({
  recid: '80020',
  title: 'ATLAS PHYSLITE umbrella',
  availability: 'ondemand',
  relations: [
    { type: 'isParentOf', recid: '80021' },
    { type: 'isParentOf', recid: '80022' },
    { type: 'isParentOf', title: 'No recid here' },
    { type: 'isChildOf', recid: '80000' },
    { type: 'isRelatedTo', recid: '80030' },
  ],
});

/**
 * NANOAOD record 30518: `isParentOf` points at its MINIAOD counterpart 30501
 * while the record holds files of its own, so `children` stays unset.
 */
export const nanoaodRecordBody = recordBody({
  recid: '30518',
  title: '/GluGluHToBB_M125_13TeV_powheg_pythia8/RunIIFall15NanoAODv2/NANOAODSIM',
  availability: 'online',
  _files: [FILE_A],
  relations: [{ type: 'isParentOf', recid: '30501', title: 'MINIAOD counterpart' }],
});

// Validated-run lists

export interface ListSpec {
  energy?: string;
  key: string;
  periods: string[];
  recid: string;
}

/** The lists of the validated-run collection the tests need, including both twin shapes. */
export const LIST_SPECS: readonly ListSpec[] = [
  {
    recid: '1002',
    key: 'Cert_190456-208686_8TeV_22Jan2013ReReco_Collisions12_JSON.txt',
    periods: ['Run2012A', 'Run2012B', 'Run2012C', 'Run2012D'],
    energy: '8TeV',
  },
  {
    recid: '1005',
    key: 'Cert_190456-208686_8TeV_22Jan2013ReReco_Collisions12_JSON_MuonPhys.txt',
    periods: ['Run2012A', 'Run2012B', 'Run2012C', 'Run2012D'],
    energy: '8TeV',
  },
  {
    recid: '14202',
    key: 'Cert_136033-149442_7TeV_HI_Collisions10_JSON_v2.txt',
    periods: ['HIRun2010'],
  },
  {
    recid: '14203',
    key: 'Cert_136033-149442_7TeV_HI_Collisions10_JSON_MuonPhys_v2.txt',
    periods: ['HIRun2010'],
  },
  {
    recid: '14208',
    key: 'Cert_177718-178078_2.76TeV_PromptReco_Collisions11_JSON_v2.txt',
    periods: ['Run2011A'],
    energy: '2.76TeV',
  },
  {
    recid: '14209',
    key: 'Cert_177718-178078_2.76TeV_PromptReco_Collisions11_JSON_MuonPhys.txt',
    periods: ['Run2011A'],
    energy: '2.76TeV',
  },
  {
    recid: '1000',
    key: 'Cert_136035-149442_7TeV_Apr21ReReco_Collisions10_JSON_v2.txt',
    periods: ['Run2010B'],
  },
];

/** One collection hit; the file carries the `_files` shape of the portal. */
export function validatedListHit(spec: ListSpec): RawHit {
  return hit(spec.recid, {
    recid: spec.recid,
    title: `CMS list of validated runs ${spec.key}`,
    type: { primary: 'Environment', secondary: ['Validation'] },
    experiment: ['CMS'],
    run_period: spec.periods,
    ...(spec.energy ? { collision_information: { energy: spec.energy, type: 'pp' } } : {}),
    _files: [
      {
        key: spec.key,
        size: 5_000,
        uri: `root://eospublic.cern.ch//eos/opendata/cms/validation/${spec.key}`,
      },
    ],
  });
}

/** The collection search body, with the lists out of recid order. */
export function validatedRunsSearchBody(specs: readonly ListSpec[] = LIST_SPECS) {
  return searchBody([...specs].reverse().map(validatedListHit));
}

/** A good-run list file: `{ "<run>": [[firstLumi, lastLumi], …] }`. */
export const RUN_LIST_BODY = {
  '190456': [
    [1, 91],
    [93, 111],
  ],
  '190459': [[1, 1]],
};

// Trigger and document-shaped text

/** A trigger abstract as the portal writes it: a blockquote with one `<p>` per line. */
export const TRIGGER_ABSTRACT_HTML =
  '<blockquote><p>first seen online on run 160404 (<a href="/record/3521">/cdaq/physics/Run2011/5e32/v4.2/HLT/V2</a>)</p>' +
  '<p>last  seen online on run 178380 (/cdaq/physics/Run2011/5e32/v4.2/HLT/V2)</p>' +
  '<p>V1: (runs 160404 - 163261) seeded by: L1_SingleMu12</p>' +
  '<p>See also the full list of triggers for CMS 2011 open data: <a href="/record/3000">list</a></p></blockquote>';

// Tool-layer fixtures

/** Dataset with every field the Record shape carries, for format-parity checks. */
export const richDatasetHit: RawHit = hit(9001, {
  recid: '9001',
  title: 'Rich dataset /A/B/C',
  title_additional: 'A descriptive secondary title',
  type: { primary: 'Dataset', secondary: ['Collision', 'Derived'] },
  experiment: ['CMS', 'ATLAS'],
  collections: ['CMS-Primary-Datasets', 'Another-Collection'],
  date_created: ['2011', '2012'],
  run_period: ['Run2011A', 'Run2012B'],
  run_numbers: ['160404', '160405'],
  collaboration: { name: 'CMS Collaboration', recid: '7000' },
  authors: [{ name: 'Ada Lovelace', orcid: '0000-0002-1825-0097' }, { name: 'Alan Turing' }],
  doi: '10.7483/OPENDATA.CMS.RICH.0001',
  date_published: '2024',
  date_reprocessed: '2025',
  availability: 'partial',
  collision_information: { energy: '13TeV', type: 'pp' },
  distribution: { formats: ['nanoaod', 'root'], number_events: 12_345, number_files: 7, size: 999 },
  _availability_details: { online: 5, 'on demand': 2 },
  abstract: {
    description: '<p>Abstract <b>text</b> with a <a href="/docs/cms-guide-docker">guide</a>.</p>',
    links: [{ recid: '1002', description: 'Validated runs, full validation' }],
  },
  methodology: { description: '<p>Method text.</p>' },
  usage: {
    description: '<p>Usage text.</p>',
    links: [{ description: 'CMS Docker guide', url: '/docs/cms-guide-docker#intro' }],
  },
  validation: { description: '<p>Validation text.</p>' },
  note: { description: '<p>Note text.</p>', links: [{ recid: '9002' }] },
  use_with: { description: '<p>Use with text.</p>', links: [{ recid: '6004' }] },
  links: [{ description: 'Source', url: 'https://github.com/example/rich' }],
  relations: [
    {
      type: 'isRelatedTo',
      recid: '9002',
      doi: '10.7483/OPENDATA.CMS.REL.0002',
      title: 'Related record',
      description: 'Companion',
    },
  ],
  system_details: {
    release: 'CMSSW_10_6_30',
    global_tag: '106X_dataRun2_v37',
    container_images: [{ name: 'cmsopendata/cmssw_10_6_30', registry: 'dockerhub' }],
    recid: '9003',
    description: '<p>Environment <i>notes</i>.</p>',
  },
  source_code_repository: { url: 'https://github.com/example/rich-source' },
  dataset_semantics_files: {
    url: '/eos/opendata/cms/semantics/rich.html',
    json: '/eos/opendata/cms/semantics/rich.json',
  },
});

/** `count` search hits with recids `start`, `start + 1`, … (dataset collision records). */
export function syntheticHits(count: number, start = 1000): RawHit[] {
  return Array.from({ length: count }, (_, i) => {
    const recid = String(start + i);
    return hit(recid, {
      recid,
      title: `Synthetic record ${recid}`,
      type: { primary: 'Dataset', secondary: ['Collision'] },
      experiment: ['CMS'],
    });
  });
}

/** A doc hit whose body is exactly `chars` characters long. */
export function docHitWithBody(slug: string, chars: number): RawHit {
  return hit(slug, {
    slug,
    title: `Long page ${slug}`,
    type: { primary: 'Documentation', secondary: ['Guide'] },
    body: { content: 'x'.repeat(chars), format: 'md' },
  });
}

/** Regular files `file_0.root` … `file_{count-1}.root`, in the portal's `_files` shape. */
export function regularFiles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    key: `file_${i}.root`,
    size: 1_000 + i,
    checksum: `adler32:${i.toString(16).padStart(8, '0')}`,
    uri: `root://eospublic.cern.ch//eos/opendata/cms/file_${i}.root`,
    availability: 'online',
    bucket: 'b1',
    file_id: `f${i}`,
    version_id: `v${i}`,
  }));
}

/** One file index holding `count` members keyed `<key>_<n>`. */
export function fileIndex(key: string, count: number, extras: Record<string, unknown> = {}) {
  const files = Array.from({ length: count }, (_, i) => ({
    key: `${key}_${i}`,
    filename: `part_${i}.root`,
    size: 100,
    checksum: `adler32:${i.toString(16).padStart(8, '0')}`,
    uri: `root://eospublic.cern.ch//eos/opendata/atlas/${key}/part_${i}.root`,
    availability: 'online',
  }));
  return {
    key,
    number_files: count,
    size: 100 * count,
    availability: { online: count },
    files,
    ...extras,
  };
}

// Wave 3: validated runs, analysis environments, trigger paths

/**
 * Lists that make Run2011A ambiguous next to 14208/14209 in {@link LIST_SPECS}:
 * three full lists (1001, 14206, 14208) and two muons-only (14207, 14209).
 * 14206/14207 are twins; 1001 has no muons-only twin.
 */
export const RUN2011A_EXTRA_SPECS: readonly ListSpec[] = [
  {
    recid: '1001',
    key: 'Cert_160404-180252_7TeV_ReRecoNov08_Collisions11_JSON.txt',
    periods: ['Run2011A', 'Run2011B'],
    energy: '7TeV',
  },
  {
    recid: '14206',
    key: 'Cert_160404-177515_7TeV_PromptReco_Collisions11_JSON.txt',
    periods: ['Run2011A'],
    energy: '7TeV',
  },
  {
    recid: '14207',
    key: 'Cert_160404-177515_7TeV_PromptReco_Collisions11_JSON_MuonPhys.txt',
    periods: ['Run2011A'],
    energy: '7TeV',
  },
];

/** {@link LIST_SPECS} plus {@link RUN2011A_EXTRA_SPECS}. */
export const ALL_LIST_SPECS: readonly ListSpec[] = [...LIST_SPECS, ...RUN2011A_EXTRA_SPECS];

/** A collision dataset hit linking the given validated-run list recids from `abstract.links`/`note.links`. */
export function datasetLinkingLists(
  recid: string,
  linked: { abstract?: readonly string[]; note?: readonly string[] },
  extra: RawMetadata = {},
): RawHit {
  return hit(recid, {
    recid,
    title: `/Dataset${recid}/Run2012B-22Jan2013-v1/AOD`,
    type: { primary: 'Dataset', secondary: ['Collision'] },
    experiment: ['CMS'],
    run_period: ['Run2012B'],
    abstract: {
      description: '<p>Linked lists.</p>',
      links: (linked.abstract ?? []).map((r) => ({ recid: r })),
    },
    ...(linked.note
      ? { note: { description: '<p>Note.</p>', links: linked.note.map((r) => ({ recid: r })) } }
      : {}),
    ...extra,
  });
}

/** `GET /api/docs/{slug}` body: a guide whose markdown is `content`. */
export function docBody(slug: string, content: string, title = `Guide ${slug}`) {
  return {
    id: slug,
    metadata: {
      slug,
      title,
      type: { primary: 'Documentation', secondary: ['Guide'] },
      experiment: ['CMS'],
      body: { content, format: 'md' },
    },
  };
}

/** A `Supplementaries::Trigger` hit: the title names the path, `abstract.description` is the HTML. */
export function triggerHit(
  recid: string,
  path: string,
  abstractHtml: string | undefined,
  options: { dataset?: string; year?: string } = {},
): RawHit {
  const dataset = options.dataset ? ` (${options.dataset} dataset)` : '';
  return hit(recid, {
    recid,
    title: `High-Level Trigger path information ${path}${dataset}`,
    type: { primary: 'Supplementaries', secondary: ['Trigger'] },
    experiment: ['CMS'],
    collections: ['CMS-Trigger-Information'],
    ...(options.year ? { date_created: [options.year] } : {}),
    run_period: null,
    ...(abstractHtml === undefined ? {} : { abstract: { description: abstractHtml } }),
  });
}

/**
 * The three `HLT_IsoMu24` abstracts, written in the line forms API Reference
 * § Trigger path records records: record 2561 (2011) with menu links on both
 * seen lines and a single-run version, 6537 (2012) whose last-seen menu is
 * plain text, and 29551 (2016) whose versions carry no `seeded by` part.
 */
export const ISOMU24_2011_ABSTRACT =
  '<blockquote><p>first seen online on run 160404 (<a href="/record/3521">/cdaq/physics/Run2011/5e32/v4.2/HLT/V2</a>)</p>' +
  '<p>last  seen online on run 178380 (<a href="/record/3530">/cdaq/physics/Run2011/5e32/v6.1/HLT/V2</a>)</p>' +
  '<p>V1: (runs 160404 - 163261) seeded by: L1_SingleMu12</p>' +
  '<p>V2: (runs 163269 - 165970) seeded by: L1_SingleMu12</p>' +
  '<p>V6: (run 166346) seeded by: L1_SingleMu12</p>' +
  '<p>See also the full list of triggers for CMS 2011 open data: <a href="/record/3000">list</a></p></blockquote>';

export const ISOMU24_2012_ABSTRACT =
  '<blockquote><p>first seen online on run 190456 (<a href="/record/6001">/cdaq/physics/Run2012/5e33/v1.0/HLT/V1</a>)</p>' +
  '<p>last  seen online on run 209151 (/cdaq/special/25ns/v1.1/HLT/V2)</p>' +
  '<p>V1: (runs 190456 - 193621) seeded by: L1_SingleMu16er</p>' +
  '<p>V3: (runs 193834 - 209151) seeded by: L1_SingleMu16er</p>' +
  '<p>See also the full list of triggers for CMS 2012 open data: <a href="/record/6000">list</a></p></blockquote>';

export const ISOMU24_2016_ABSTRACT =
  '<blockquote><p>first seen online on run 273158 (<a href="/record/30301">/cdaq/physics/Run2016/25ns15e33/v4.2.1/HLT/V2</a>)</p>' +
  '<p>last  seen online on run 284044 (<a href="/record/30302">/cdaq/physics/Run2016/25ns15e33/v4.2.1/HLT/V9</a>)</p>' +
  '<p>V1: (runs 273158 - 274443)</p>' +
  '<p>V2: (runs 274445 - 284044)</p>' +
  '<p>See also the full list of triggers for CMS 2016 open data: <a href="/record/30300">list</a></p></blockquote>';

export const isoMu24Hit2011 = triggerHit('2561', 'HLT_IsoMu24', ISOMU24_2011_ABSTRACT, {
  dataset: 'SingleMu',
  year: '2011',
});
export const isoMu24Hit2012 = triggerHit('6537', 'HLT_IsoMu24', ISOMU24_2012_ABSTRACT, {
  dataset: 'SingleMu',
  year: '2012',
});
export const isoMu24Hit2016 = triggerHit('29551', 'HLT_IsoMu24', ISOMU24_2016_ABSTRACT, {
  year: '2016',
});
