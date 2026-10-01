/**
 * @fileoverview Tests for the pure payload mappings: search hits, facets, the
 * shared Record shape with license and citation, compact manifests, and
 * validated-run lists including the twin pairing. Includes sparse payloads.
 * @module tests/services/cern-opendata/normalize.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  availabilityCounts,
  availabilityOf,
  CITATION_REQUEST,
  citationOf,
  DOC_BODY_MAX_CHARS,
  definedOnly,
  docUrl,
  glossaryFacetCount,
  licenseOf,
  num,
  portalUrlOf,
  recordTypeOf,
  recordUrl,
  runListStem,
  runListVariant,
  str,
  strList,
  systemDetailsOf,
  toFacets,
  toManifest,
  toRecord,
  toSearchHit,
  toValidatedRunList,
  twinOf,
} from '@/services/cern-opendata/normalize.js';
import type { RawHit, ValidatedRunList } from '@/services/cern-opendata/types.js';
import {
  aggregationsBody,
  collisionDatasetHit,
  docHit,
  environmentSystemHit,
  filesRecordBody,
  hit,
  indexedRecordBody,
  LIST_SPECS,
  licensedDatasetHit,
  nanoaodRecordBody,
  newsHit,
  softwareHit,
  sparseHit,
  umbrellaRecordBody,
  validatedListHit,
} from '../../fixtures/cern-opendata-upstream.js';

function expectUnreadable(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    const mcp = error as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(mcp.data).toMatchObject({ reason: 'upstream_unreadable' });
    return;
  }
  throw new Error('Expected upstream_unreadable.');
}

describe('scalar helpers', () => {
  it('str keeps non-blank strings as received and drops everything else', () => {
    expect(str(' a ')).toBe(' a ');
    for (const value of ['', '   ', 5, null, undefined, {}, ['a']]) {
      expect(str(value)).toBeUndefined();
    }
  });

  it('num keeps finite numbers, including zero', () => {
    expect(num(0)).toBe(0);
    expect(num(-3.5)).toBe(-3.5);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
      expect(num(value)).toBeUndefined();
    }
  });

  it('strList takes arrays or a lone string and drops blanks and non-strings', () => {
    expect(strList(['a', '', ' ', 3, 'b'])).toEqual(['a', 'b']);
    expect(strList('x')).toEqual(['x']);
    expect(strList([])).toBeUndefined();
    expect(strList(['', ' '])).toBeUndefined();
    expect(strList(null)).toBeUndefined();
    expect(strList(undefined)).toBeUndefined();
  });

  it('definedOnly omits undefined keys but keeps null, zero and empty values', () => {
    const shaped = definedOnly<{ a?: string; b?: number; c?: string[]; d?: string }>({
      a: undefined,
      b: 0,
      c: [],
      d: '',
    });
    expect(shaped).toEqual({ b: 0, c: [], d: '' });
    expect('a' in shaped).toBe(false);
  });
});

describe('urls', () => {
  it('builds record and doc URLs with the id encoded', () => {
    expect(recordUrl('6004')).toBe('https://opendata.cern.ch/record/6004');
    expect(docUrl('cms-guide-docker')).toBe('https://opendata.cern.ch/docs/cms-guide-docker');
    expect(docUrl('a b/c')).toBe('https://opendata.cern.ch/docs/a%20b%2Fc');
  });

  it('prefers the slug, then the recid, then the hit id', () => {
    expect(portalUrlOf(docHit)).toBe('https://opendata.cern.ch/docs/cms-guide-docker');
    expect(portalUrlOf(collisionDatasetHit)).toBe('https://opendata.cern.ch/record/6004');
    expect(portalUrlOf(hit(77, {}))).toBe('https://opendata.cern.ch/record/77');
  });
});

describe('recordTypeOf and availabilityOf', () => {
  it('shapes the type and defaults the secondary list to []', () => {
    expect(recordTypeOf({ type: { primary: 'Dataset', secondary: ['Collision'] } })).toEqual({
      primary: 'Dataset',
      secondary: ['Collision'],
    });
    expect(recordTypeOf({ type: { primary: 'Software', secondary: 'Tool' } })).toEqual({
      primary: 'Software',
      secondary: ['Tool'],
    });
    expect(recordTypeOf({ type: { primary: 'News' } })).toEqual({ primary: 'News', secondary: [] });
  });

  it('returns an empty primary for a hit with no type', () => {
    expect(recordTypeOf({})).toEqual({ primary: '', secondary: [] });
    expect(recordTypeOf({ type: null })).toEqual({ primary: '', secondary: [] });
  });

  it('reads record availability from the record, then from the distribution', () => {
    expect(
      availabilityOf({ availability: 'partial', distribution: { availability: 'online' } }),
    ).toBe('partial');
    expect(availabilityOf({ distribution: { availability: 'online' } })).toBe('online');
    expect(availabilityOf({ availability: ' ', distribution: null })).toBeUndefined();
  });

  it('renames the space-keyed on-demand count and tolerates absent counts', () => {
    expect(availabilityCounts({ online: 3, 'on demand': 4 })).toEqual({ online: 3, on_demand: 4 });
    expect(availabilityCounts({ 'on demand': 0 })).toEqual({ on_demand: 0 });
    expect(availabilityCounts({})).toEqual({});
    expect(availabilityCounts(null)).toBeUndefined();
    expect(availabilityCounts(undefined)).toBeUndefined();
  });
});

describe('toSearchHit', () => {
  it('maps a full collision hit', () => {
    expect(toSearchHit(collisionDatasetHit)).toEqual({
      id: '6004',
      recid: '6004',
      title: '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
      type: { primary: 'Dataset', secondary: ['Collision'] },
      experiment: ['CMS'],
      run_period: ['Run2012B'],
      date_created: ['2012'],
      collections: ['CMS-Primary-Datasets'],
      formats: ['aod', 'root'],
      doi: '10.7483/OPENDATA.CMS.YLIC.86ZZ',
      date_published: '2014',
      availability: 'online',
      collision_energy: '8TeV',
      collision_type: 'pp',
      number_events: 29_308_627,
      number_files: 158,
      size_in_bytes: 4_950_000_000_000,
      portal_url: 'https://opendata.cern.ch/record/6004',
    });
  });

  it('maps a doc hit by slug with no recid', () => {
    const mapped = toSearchHit(docHit);
    expect(mapped).toMatchObject({
      id: 'cms-guide-docker',
      slug: 'cms-guide-docker',
      portal_url: 'https://opendata.cern.ch/docs/cms-guide-docker',
      short_description: 'How to run the CMS open data containers.',
    });
    expect('recid' in mapped).toBe(false);
  });

  it('omits every field a sparse hit lacks, and null sections do not throw', () => {
    expect(toSearchHit(sparseHit)).toEqual({
      id: '1120',
      recid: '1120',
      title: 'Sparse record',
      type: { primary: 'Software', secondary: [] },
      portal_url: 'https://opendata.cern.ch/record/1120',
    });
    expect(toSearchHit(hit(5, {}))).toEqual({
      id: '5',
      type: { primary: '', secondary: [] },
      portal_url: 'https://opendata.cern.ch/record/5',
    });
  });

  it('keeps zero counts and accepts a lone-string date_created', () => {
    const mapped = toSearchHit(
      hit(9, {
        recid: '9',
        date_created: '2012',
        distribution: { number_events: 0, number_files: 0, size: 0, formats: [] },
      }),
    );
    expect(mapped).toMatchObject({
      date_created: ['2012'],
      number_events: 0,
      number_files: 0,
      size_in_bytes: 0,
    });
    expect('formats' in mapped).toBe(false);
  });

  it('keeps upstream strings exactly as received', () => {
    const raw = 'Line one\nLine <b>two</b> | [x](y) `z`';
    expect(toSearchHit(hit(1, { recid: '1', title: raw })).title).toBe(raw);
  });
});

describe('toFacets', () => {
  const facets = toFacets(aggregationsBody);

  it('returns the eight facets', () => {
    expect(Object.keys(facets).sort()).toEqual([
      'availability',
      'collision_energy',
      'collision_type',
      'experiment',
      'file_type',
      'number_events',
      'type',
      'year',
    ]);
  });

  it('maps terms buckets with the count hidden past the cap', () => {
    expect(facets.experiment).toEqual({
      buckets: [
        { value: 'ATLAS', count: 12 },
        { value: 'CMS', count: 700 },
      ],
      other_count: 3,
    });
    expect(facets.file_type.other_count).toBe(11);
  });

  it('drops the Glossary type bucket and nests subtypes', () => {
    expect(facets.type.buckets.map((bucket) => bucket.value)).toEqual(['Dataset', 'Software']);
    expect(facets.type.buckets[0]).toEqual({
      value: 'Dataset',
      count: 600,
      subtypes: [
        { value: 'Collision', count: 500 },
        { value: 'Simulated', count: 100 },
      ],
    });
  });

  it('labels the year histogram by key_as_string with no hidden count', () => {
    expect(facets.year).toEqual({
      buckets: [
        { value: '2012', count: 400 },
        { value: '2013', count: 300 },
      ],
      other_count: 0,
    });
  });

  it('keeps range buckets by key', () => {
    expect(facets.number_events.buckets.map((bucket) => bucket.value)).toEqual([
      '1000--9999',
      '10000000--',
    ]);
    expect(facets.number_events.other_count).toBe(0);
  });

  it('returns an empty facet for every aggregation the portal omitted', () => {
    const empty = toFacets({});
    for (const facet of Object.values(empty)) {
      expect(facet).toEqual({ buckets: [], other_count: 0 });
    }
  });

  it('stringifies numeric keys, falls back to key for a histogram, and skips blank keys', () => {
    const mixed = toFacets({
      experiment: {
        buckets: [
          { key: 7, doc_count: 2 },
          { key: '', doc_count: 1 },
          { doc_count: 1 },
          { key: 'X' },
        ],
      },
      year: { buckets: [{ key: 1_325_376_000_000, doc_count: 4 }] },
    });
    expect(mixed.experiment.buckets).toEqual([
      { value: '7', count: 2 },
      { value: 'X', count: 0 },
    ]);
    expect(mixed.year.buckets).toEqual([{ value: '1325376000000', count: 4 }]);
  });

  it('reports the glossary count the type facet saw', () => {
    expect(glossaryFacetCount(aggregationsBody)).toBe(5);
    expect(glossaryFacetCount({})).toBe(0);
    expect(glossaryFacetCount({ type: { buckets: [{ key: 'Dataset', doc_count: 2 }] } })).toBe(0);
  });
});

describe('licenseOf', () => {
  it('relays the license a record states', () => {
    expect(licenseOf(softwareHit.metadata)).toEqual({
      id: 'GPL-3.0-only',
      basis: 'record',
      statement: 'Licensed GPL-3.0-only, as stated on the record.',
    });
    expect(licenseOf(licensedDatasetHit.metadata)).toMatchObject({
      id: 'CC0-1.0',
      basis: 'record',
    });
  });

  it('stamps CC0-1.0 on a Dataset that states none, with the Terms of Use as basis', () => {
    for (const license of [undefined, null, { attribution: null }, { attribution: '  ' }]) {
      expect(
        licenseOf({ type: { primary: 'Dataset' }, ...(license === undefined ? {} : { license }) }),
      ).toMatchObject({ id: 'CC0-1.0', basis: 'cern_terms_default' });
    }
  });

  it('stamps nothing on non-datasets, and says they are licensed separately', () => {
    for (const primary of ['Software', 'Environment', 'Documentation', 'Supplementaries']) {
      const license = licenseOf({ type: { primary }, license: null });
      expect(license.basis).toBe('not_stated');
      expect('id' in license).toBe(false);
      expect(license.statement).toMatch(/licensed separately/);
    }
    expect(licenseOf({}).basis).toBe('not_stated');
  });
});

describe('citationOf', () => {
  it('builds the portal Cite-as text from collaboration, date, title and DOI', () => {
    expect(
      citationOf(
        {
          collaboration: { name: 'CMS Collaboration' },
          date_published: '2014',
          title: 'Dataset title',
          title_additional: 'Friendly title',
        },
        '10.7483/X',
      ),
    ).toEqual({
      text: 'CMS Collaboration (2014). Friendly title. CERN Open Data Portal. DOI:10.7483/X',
      doi: '10.7483/X',
      request: CITATION_REQUEST,
    });
  });

  it('falls back to the title, and does not double a trailing period', () => {
    expect(citationOf({ title: 'Plain.' }, '10.1/A').text).toBe(
      'Plain. CERN Open Data Portal. DOI:10.1/A',
    );
    expect(citationOf({ title: 'Plain' }, '10.1/A').text).toBe(
      'Plain. CERN Open Data Portal. DOI:10.1/A',
    );
  });

  it('leaves out each part the record lacks', () => {
    expect(citationOf({ collaboration: { name: 'ATLAS' } }, '10.1/A').text).toBe(
      'ATLAS. CERN Open Data Portal. DOI:10.1/A',
    );
    expect(citationOf({ date_published: '2020' }, '10.1/A').text).toBe(
      '(2020). CERN Open Data Portal. DOI:10.1/A',
    );
    expect(citationOf({}, '10.1/A').text).toBe('CERN Open Data Portal. DOI:10.1/A');
  });

  it('opens with the authors, each followed by a semicolon, when no collaboration is named', () => {
    expect(
      citationOf(
        {
          authors: [{ name: 'Rodriguez Marrero, Ana', orcid: '0000-0002-7145-630X' }],
          collaboration: null,
          date_published: '2014',
          title: 'Two-lepton/four-lepton analysis example of CMS 2010 open data',
        },
        '10.7483/OPENDATA.CMS.QXY9.X47P',
      ).text,
    ).toBe(
      'Rodriguez Marrero, Ana; (2014). Two-lepton/four-lepton analysis example of CMS 2010 open data. CERN Open Data Portal. DOI:10.7483/OPENDATA.CMS.QXY9.X47P',
    );
    expect(
      citationOf(
        {
          authors: [{ name: 'Rodriguez Marrero, Ana' }, { name: 'Lassila-Perini, Kati' }],
          date_published: '2016',
          title: 'Two-lepton/four-lepton analysis example of CMS 2011 open data',
        },
        '10.7483/OPENDATA.CMS.ETJK.JKMB',
      ).text,
    ).toBe(
      'Rodriguez Marrero, Ana; Lassila-Perini, Kati; (2016). Two-lepton/four-lepton analysis example of CMS 2011 open data. CERN Open Data Portal. DOI:10.7483/OPENDATA.CMS.ETJK.JKMB',
    );
  });

  it('credits the authors before the collaboration when the record names both', () => {
    expect(
      citationOf(
        {
          authors: [{ name: 'David, Gabor' }, { name: 'Potekhin, Maxim' }],
          collaboration: { name: 'PHENIX collaboration' },
          date_published: '2021',
          title:
            'Examples of basic analysis techniques for neutral meson and photon data from the PHENIX detector',
        },
        '10.7483/OPENDATA.PHENIX.70SC.C9E7',
      ).text,
    ).toBe(
      'David, Gabor; Potekhin, Maxim; PHENIX collaboration (2021). Examples of basic analysis techniques for neutral meson and photon data from the PHENIX detector. CERN Open Data Portal. DOI:10.7483/OPENDATA.PHENIX.70SC.C9E7',
    );
  });

  it('skips author entries without a name and needs no date', () => {
    expect(
      citationOf(
        { authors: [{ name: 'A. Person' }, { orcid: 'x' }, { name: ' ' }], title: 'T' },
        '10.1/A',
      ).text,
    ).toBe('A. Person; T. CERN Open Data Portal. DOI:10.1/A');
  });
});

describe('systemDetailsOf', () => {
  it('renames recid, keeps images with a name, and leaves registry out when absent', () => {
    expect(systemDetailsOf(environmentSystemHit.metadata)).toEqual({
      release: 'CMSSW_5_3_32',
      global_tag: 'FT53_V21A_AN6',
      container_images: [
        { name: 'cmsopendata/cmssw_5_3_32', registry: 'dockerhub' },
        { name: 'cmsopendata/other' },
      ],
      environment_recid: '12101',
      description: 'VM <b>image</b>',
    });
  });

  it('is undefined when nothing is stated', () => {
    expect(systemDetailsOf({})).toBeUndefined();
    expect(systemDetailsOf({ system_details: null })).toBeUndefined();
    expect(systemDetailsOf({ system_details: {} })).toBeUndefined();
    expect(
      systemDetailsOf({ system_details: { container_images: [{ registry: 'x' }] } }),
    ).toBeUndefined();
  });
});

describe('toRecord', () => {
  it('maps a full dataset with its citation, default license and links', () => {
    const record = toRecord(collisionDatasetHit, ['6004', 'recid:6004']);
    expect(record).toMatchObject({
      id: '6004',
      kind: 'record',
      recid: '6004',
      matched_inputs: ['6004', 'recid:6004'],
      doi: '10.7483/OPENDATA.CMS.YLIC.86ZZ',
      abstract_html: '<p>Dimuon events recorded in 2012.</p>',
      collaboration: { name: 'CMS Collaboration' },
      collision_energy: '8TeV',
      collision_type: 'pp',
      distribution: {
        formats: ['aod', 'root'],
        number_events: 29_308_627,
        number_files: 158,
        size_in_bytes: 4_950_000_000_000,
      },
      license: { id: 'CC0-1.0', basis: 'cern_terms_default' },
      portal_url: 'https://opendata.cern.ch/record/6004',
    });
    expect(record.citation).toEqual({
      text: 'CMS Collaboration (2014). /DoubleMuParked/Run2012B-22Jan2013-v1/AOD. CERN Open Data Portal. DOI:10.7483/OPENDATA.CMS.YLIC.86ZZ',
      doi: '10.7483/OPENDATA.CMS.YLIC.86ZZ',
      request: CITATION_REQUEST,
    });
    expect(record.links).toEqual([
      { source: 'abstract', recid: '1002' },
      { source: 'usage', url: '/docs/cms-guide-docker#intro', description: 'CMS Docker guide' },
    ]);
  });

  it('keeps HTML sections exactly as received', () => {
    const record = toRecord(collisionDatasetHit, []);
    expect(record.usage_html).toBe(
      '<p>See the <a href="/docs/cms-guide-docker">Docker guide</a>.</p>',
    );
  });

  it('gives a sparse record a minimal shape with no invented values', () => {
    const record = toRecord(sparseHit, ['1120']);
    expect(record).toEqual({
      id: '1120',
      kind: 'record',
      recid: '1120',
      matched_inputs: ['1120'],
      title: 'Sparse record',
      type: { primary: 'Software', secondary: [] },
      links: [],
      relations: [],
      license: expect.objectContaining({ basis: 'not_stated' }),
      portal_url: 'https://opendata.cern.ch/record/1120',
    });
  });

  it('survives an almost empty hit', () => {
    const record = toRecord(hit(5, {}), []);
    expect(record).toMatchObject({
      id: '5',
      kind: 'record',
      type: { primary: '', secondary: [] },
      links: [],
      relations: [],
    });
    expect('citation' in record).toBe(false);
    expect('distribution' in record).toBe(false);
  });

  it('maps a doc by slug with its body and no citation', () => {
    const record = toRecord(docHit, ['cms-guide-docker']);
    expect(record).toMatchObject({
      id: 'cms-guide-docker',
      kind: 'doc',
      slug: 'cms-guide-docker',
      tags: ['docker', 'cmssw'],
      body: '## <a name="intro">Introduction</a>\n\nRun `docker pull`.\n',
      body_format: 'md',
      body_length: 56,
      body_truncated: false,
      portal_url: 'https://opendata.cern.ch/docs/cms-guide-docker',
    });
    expect('citation' in record).toBe(false);
    expect('recid' in record).toBe(false);
  });

  it('uses the news author string when there is no author list', () => {
    expect(toRecord(newsHit, []).authors).toEqual([{ name: 'CERN Open Data team' }]);
    expect(
      toRecord(
        hit(1, {
          recid: '1',
          authors: [{ name: 'A. Person', orcid: '0000-0001' }, { orcid: 'x' }],
        }),
        [],
      ).authors,
    ).toEqual([{ name: 'A. Person', orcid: '0000-0001' }]);
  });

  describe('doc body cap', () => {
    const docOf = (content: string): RawHit =>
      hit('big', { slug: 'big', body: { content, format: 'md' } });

    it('leaves a body at the cap untouched', () => {
      const body = 'a'.repeat(DOC_BODY_MAX_CHARS);
      const record = toRecord(docOf(body), []);
      expect(record.body).toBe(body);
      expect(record).toMatchObject({ body_length: DOC_BODY_MAX_CHARS, body_truncated: false });
    });

    it('cuts a body past the cap and keeps its original length', () => {
      const record = toRecord(docOf('a'.repeat(DOC_BODY_MAX_CHARS + 1)), []);
      expect(record.body).toHaveLength(DOC_BODY_MAX_CHARS);
      expect(record).toMatchObject({ body_length: DOC_BODY_MAX_CHARS + 1, body_truncated: true });
    });

    it('does not split a surrogate pair at the cut', () => {
      const body = `${'a'.repeat(DOC_BODY_MAX_CHARS - 1)}\u{1F600}tail`;
      const record = toRecord(docOf(body), []);
      expect(record.body).toBe('a'.repeat(DOC_BODY_MAX_CHARS - 1));
      expect(record.body_truncated).toBe(true);
    });

    it('leaves body fields out when the doc has no body', () => {
      const record = toRecord(hit('x', { slug: 'x' }), []);
      for (const key of ['body', 'body_format', 'body_length', 'body_truncated']) {
        expect(key in record).toBe(false);
      }
    });
  });

  it('relays relations verbatim and skips entries with no type', () => {
    const record = toRecord(
      hit(1, {
        recid: '1',
        relations: [
          { type: 'isParentOf', recid: '2', title: 'Child' },
          { recid: '3' },
          { type: 'isChildOf', doi: '10.1/A', description: 'Up' },
        ],
      }),
      [],
    );
    expect(record.relations).toEqual([
      { type: 'isParentOf', recid: '2', title: 'Child' },
      { type: 'isChildOf', doi: '10.1/A', description: 'Up' },
    ]);
  });

  it('collects links from every section and skips empty ones', () => {
    const record = toRecord(
      hit(1, {
        recid: '1',
        note: { links: [{ recid: '9', description: 'Validated runs, muons only' }, {}] },
        validation: { links: [{ url: 'https://x.test/v' }] },
        use_with: { links: [{ recid: '4' }] },
        links: [{ url: 'https://x.test/src', description: 'Source' }],
      }),
      [],
    );
    expect(record.links).toEqual([
      { source: 'note', recid: '9', description: 'Validated runs, muons only' },
      { source: 'validation', url: 'https://x.test/v' },
      { source: 'use_with', recid: '4' },
      { source: 'software', url: 'https://x.test/src', description: 'Source' },
    ]);
  });

  it('resolves dataset semantics paths against the portal', () => {
    expect(
      toRecord(
        hit(1, {
          recid: '1',
          dataset_semantics_files: { url: '/eos/opendata/x.html', json: 'eos/opendata/x.json' },
        }),
        [],
      ).dataset_semantics,
    ).toEqual({
      html_url: 'https://opendata.cern.ch/eos/opendata/x.html',
      json_url: 'https://opendata.cern.ch/eos/opendata/x.json',
    });
    expect(
      toRecord(hit(1, { recid: '1', dataset_semantics_files: {} }), []).dataset_semantics,
    ).toBeUndefined();
  });

  it('gives an empty distribution format list when the portal lists none', () => {
    expect(
      toRecord(hit(1, { recid: '1', distribution: { number_events: 5 } }), []).distribution,
    ).toEqual({
      formats: [],
      number_events: 5,
    });
  });
});

describe('toManifest', () => {
  it('compacts regular files and drops bucket, file and version ids and tags', () => {
    expect(toManifest('6004', filesRecordBody.metadata)).toEqual({
      recid: '6004',
      title: '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
      availability: 'online',
      availability_details: { online: 2 },
      files: [
        {
          key: 'file_a.root',
          size: 1024,
          checksum: 'adler32:0a1b2c3d',
          uri: 'root://eospublic.cern.ch//eos/opendata/cms/file_a.root',
          availability: 'online',
        },
        {
          key: 'file_b.root',
          size: 2048,
          uri: 'root://eospublic.cern.ch//eos/opendata/cms/file_b.root',
        },
      ],
      indexes: [],
      children: [],
    });
  });

  it('compacts file indexes with availability counts', () => {
    const manifest = toManifest('24464', indexedRecordBody.metadata);
    expect(manifest.files).toEqual([]);
    expect(manifest.availability_details).toEqual({ online: 2, on_demand: 2 });
    expect(manifest.indexes).toHaveLength(2);
    expect(manifest.indexes[0]).toMatchObject({
      key: 'ds_a_file_index.json',
      description: 'First index',
      number_files: 2,
      size: 300,
      availability: { online: 1, on_demand: 1 },
    });
    expect(manifest.indexes[0]?.files.map((file) => file.key)).toEqual([
      'ds_file_index.json_0',
      'ds_file_index.json_1',
    ]);
    expect(manifest.indexes[1]).not.toHaveProperty('description');
    expect(manifest.children).toEqual([]);
  });

  it('derives index counts and size from member files when the portal omits them', () => {
    const manifest = toManifest('1', {
      _file_indices: [
        {
          key: 'x_file_index.json',
          files: [
            { key: 'k0', uri: 'root://a/0', size: 10 },
            { key: 'k1', uri: 'root://a/1', size: 15 },
          ],
        },
      ],
    });
    expect(manifest.indexes[0]).toMatchObject({ number_files: 2, size: 25, availability: {} });
  });

  it('reads files from `files` when `_files` is absent', () => {
    const manifest = toManifest('1', { files: [{ key: 'k', uri: 'root://a/k', size: 1 }] });
    expect(manifest.files).toEqual([{ key: 'k', uri: 'root://a/k', size: 1 }]);
  });

  it('returns an empty manifest for a record with no files and no relations', () => {
    expect(toManifest('7', {})).toEqual({ recid: '7', files: [], indexes: [], children: [] });
  });

  describe('umbrella-only children (Decision 21)', () => {
    it('sets children from isParentOf recids for a record with no files and no indexes', () => {
      expect(toManifest('80020', umbrellaRecordBody.metadata).children).toEqual(['80021', '80022']);
    });

    it('leaves children empty for NANOAOD 30518, whose isParentOf points at MINIAOD 30501 beside its own files', () => {
      const manifest = toManifest('30518', nanoaodRecordBody.metadata);
      expect(manifest.files).toHaveLength(1);
      expect(manifest.children).toEqual([]);
    });

    it('leaves children empty when the record has indexes but no regular files', () => {
      const manifest = toManifest('24464', {
        ...indexedRecordBody.metadata,
        relations: [{ type: 'isParentOf', recid: '1' }],
      });
      expect(manifest.indexes).toHaveLength(2);
      expect(manifest.children).toEqual([]);
    });

    it('ignores isChildOf and isRelatedTo and relations without a recid', () => {
      expect(
        toManifest('2', {
          relations: [
            { type: 'isChildOf', recid: '1' },
            { type: 'isRelatedTo', recid: '3' },
            { type: 'isParentOf' },
          ],
        }).children,
      ).toEqual([]);
    });
  });

  describe('files the portal lists without an address (Decision 24)', () => {
    it.each([
      ['key', { uri: 'root://a/k', size: 1 }],
      ['uri', { key: 'k', size: 1 }],
      ['size', { key: 'k', uri: 'root://a/k' }],
      ['blank key', { key: ' ', uri: 'root://a/k', size: 1 }],
      ['non-numeric size', { key: 'k', uri: 'root://a/k', size: '1' as unknown as number }],
    ])('rejects a file with no usable %s as upstream_unreadable', (_name, file) => {
      expectUnreadable(() => toManifest('1', { _files: [file] }));
    });

    it('rejects an index member without an address and an index without a key', () => {
      expectUnreadable(() =>
        toManifest('1', {
          _file_indices: [{ key: 'i_file_index.json', files: [{ key: 'k', size: 1 }] }],
        }),
      );
      expectUnreadable(() => toManifest('1', { _file_indices: [{ files: [] }] }));
    });

    it('accepts a zero-byte file', () => {
      expect(
        toManifest('1', { _files: [{ key: 'k', uri: 'root://a/k', size: 0 }] }).files[0]?.size,
      ).toBe(0);
    });
  });
});

describe('validated-run list naming', () => {
  const keyOf = (recid: string) => {
    const spec = LIST_SPECS.find((candidate) => candidate.recid === recid);
    if (!spec) throw new Error(`No list ${recid}`);
    return spec.key;
  };

  it('detects the muons-only variant by _MuonPhys in the key', () => {
    expect(runListVariant(keyOf('1002'))).toBe('full');
    expect(runListVariant(keyOf('1005'))).toBe('muons_only');
    expect(runListVariant(keyOf('14203'))).toBe('muons_only');
    expect(runListVariant('Commissioning10-May19ReReco_900GeV.json')).toBe('full');
  });

  it('removes the extension, a trailing _v<n> and _MuonPhys from the stem', () => {
    expect(runListStem(keyOf('1002'))).toBe(
      'Cert_190456-208686_8TeV_22Jan2013ReReco_Collisions12_JSON',
    );
    expect(runListStem(keyOf('14202'))).toBe('Cert_136033-149442_7TeV_HI_Collisions10_JSON');
    expect(runListStem('Commissioning10-May19ReReco_900GeV.json')).toBe(
      'Commissioning10-May19ReReco_900GeV',
    );
    expect(runListStem('no_extension_v3')).toBe('no_extension');
  });

  it.each([
    ['1002', '1005', 'plain pair'],
    ['14202', '14203', 'both keys carry _v2'],
    ['14208', '14209', 'only the full key carries _v2'],
  ])('pairs %s with %s by stem (%s)', (fullRecid, muonsRecid) => {
    expect(runListStem(keyOf(fullRecid))).toBe(runListStem(keyOf(muonsRecid)));
  });

  it('does not pair lists that differ in more than the variant markers', () => {
    expect(runListStem(keyOf('1002'))).not.toBe(runListStem(keyOf('14208')));
    expect(runListStem('Commissioning10-May19ReReco_900GeV.json')).not.toBe(
      runListStem('Commissioning10-May19ReReco_7TeV.json'),
    );
  });
});

describe('toValidatedRunList', () => {
  it('maps a collection hit with the variant, stem and energy', () => {
    const spec = LIST_SPECS.find((candidate) => candidate.recid === '14209');
    if (!spec) throw new Error('missing spec');
    expect(toValidatedRunList(validatedListHit(spec))).toEqual({
      recid: '14209',
      title: `CMS list of validated runs ${spec.key}`,
      file_key: spec.key,
      variant: 'muons_only',
      stem: 'Cert_177718-178078_2.76TeV_PromptReco_Collisions11_JSON',
      run_periods: ['Run2011A'],
      collision_energy: '2.76TeV',
      xrootd_uri: `root://eospublic.cern.ch//eos/opendata/cms/validation/${spec.key}`,
    });
  });

  it('falls back to the documented title, empty periods and no energy for a sparse hit', () => {
    expect(toValidatedRunList(hit(5, { recid: '5', _files: [{ key: 'x_JSON.txt' }] }))).toEqual({
      recid: '5',
      title: 'CMS list of validated runs x_JSON.txt',
      file_key: 'x_JSON.txt',
      variant: 'full',
      stem: 'x_JSON',
      run_periods: [],
    });
  });

  it('reads the file from `files` when `_files` is absent', () => {
    expect(toValidatedRunList(hit(5, { recid: '5', files: [{ key: 'y.json' }] }))?.file_key).toBe(
      'y.json',
    );
  });

  it('returns undefined when the hit has no recid or no file key', () => {
    expect(toValidatedRunList(hit(5, { _files: [{ key: 'k' }] }))).toBeUndefined();
    expect(toValidatedRunList(hit(5, { recid: '5' }))).toBeUndefined();
    expect(toValidatedRunList(hit(5, { recid: '5', _files: [] }))).toBeUndefined();
    expect(toValidatedRunList(hit(5, { recid: '5', _files: [{ key: ' ' }] }))).toBeUndefined();
  });
});

describe('twinOf', () => {
  const lists: ValidatedRunList[] = LIST_SPECS.flatMap(
    (spec) => toValidatedRunList(validatedListHit(spec)) ?? [],
  );
  const byRecid = (recid: string) => {
    const found = lists.find((list) => list.recid === recid);
    if (!found) throw new Error(`No list ${recid}`);
    return found;
  };

  it.each([
    ['1002', '1005'],
    ['1005', '1002'],
    ['14202', '14203'],
    ['14203', '14202'],
    ['14208', '14209'],
    ['14209', '14208'],
  ])('pairs %s with %s', (recid, twin) => {
    expect(twinOf(byRecid(recid), lists)?.recid).toBe(twin);
  });

  it('pairs the 14208/14209 twins whose version suffixes differ', () => {
    expect(byRecid('14208').file_key).toMatch(/_JSON_v2\.txt$/);
    expect(byRecid('14209').file_key).toMatch(/_JSON_MuonPhys\.txt$/);
    expect(twinOf(byRecid('14208'), lists)).toBe(byRecid('14209'));
  });

  it('has no twin for a list without a muons-only counterpart', () => {
    expect(twinOf(byRecid('1000'), lists)).toBeUndefined();
  });

  it('never returns a list of the same variant, or the list itself', () => {
    const twin = twinOf(byRecid('1002'), lists);
    expect(twin?.variant).toBe('muons_only');
    expect(twinOf(byRecid('1002'), [byRecid('1002')])).toBeUndefined();
    const duplicateFull: ValidatedRunList = { ...byRecid('1002'), recid: '9999' };
    expect(twinOf(byRecid('1002'), [duplicateFull])).toBeUndefined();
  });

  it('finds nothing in an empty collection', () => {
    expect(twinOf(byRecid('1002'), [])).toBeUndefined();
  });
});
