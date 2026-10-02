/**
 * @fileoverview Tests for the canonical vocabulary: canonicalization, known-value
 * checks, Glossary detection, and the reference tables.
 * @module tests/services/cern-opendata/vocabulary.test
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  HEAVY_ION_SPELLINGS,
  isGlossaryType,
  isKnownValue,
  PARAM_TOPIC,
  PBPB_SPELLINGS,
  REFERENCE_TABLES,
  REFERENCE_TOPICS,
  SEARCHABLE_TYPE_PRIMARIES,
  SPELLING_EXPANSIONS,
  type VocabularyParam,
} from '@/services/cern-opendata/vocabulary.js';
import { expectLinearTime } from '../../fixtures/cpu-time.js';

const MEGABYTE_SIZES = [62_500, 250_000, 1_000_000] as const;

const tableOf = (topic: (typeof REFERENCE_TOPICS)[number]) => {
  const table = REFERENCE_TABLES.find((candidate) => candidate.topic === topic);
  if (!table) throw new Error(`No table for ${topic}`);
  return table;
};

describe('canonicalize', () => {
  it.each([
    ['experiment', 'lhcb', 'LHCb'],
    ['experiment', ' cms ', 'CMS'],
    ['experiment', 'Alice', 'ALICE'],
    ['collision_energy', '13 tev', '13TeV'],
    ['collision_energy', '13.6tev', '13.6TeV'],
    ['collision_energy', '89-94 gev', '89-94 GeV'],
    ['collision_energy', '89 - 94GeV', '89-94 GeV'],
    ['collision_energy', '13TeV,13.6TeV', '13TeV, 13.6TeV'],
    ['collision_type', 'PB-PB', 'PbPb'],
    ['collision_type', 'Pb-Pb', 'PbPb'],
    ['collision_type', 'pbpb', 'PbPb'],
    ['collision_type', 'PP', 'pp'],
    ['collision_type', 'e+E-', 'e+e-'],
    ['file_type', 'NANOAOD', 'nanoaod'],
    ['file_type', 'nanoaod', 'nanoaod'],
    ['file_type', 'daod_physlite', 'DAOD_PHYSLITE'],
    ['file_type', 'TAR.GZ', 'tar.gz'],
    ['file_type', 'ntuple', 'NTuple'],
    ['availability', 'on demand', 'ondemand'],
    ['availability', 'on-demand', 'ondemand'],
    ['availability', 'ON-DEMAND', 'ondemand'],
    ['availability', 'ONLINE', 'online'],
    ['type', 'dataset', 'Dataset'],
    ['type', 'dataset/collision', 'Dataset::Collision'],
    ['type', 'dataset:collision', 'Dataset::Collision'],
    ['type', 'Dataset::Collision', 'Dataset::Collision'],
    ['type', 'DATASET :: COLLISION', 'Dataset::Collision'],
    ['type', 'supplementaries/configuration hlt', 'Supplementaries::Configuration HLT'],
    ['type', 'supplementaries:computing note', 'Supplementaries::Computing Note'],
    ['type', 'news', 'News'],
    ['category', 'higgs physics/standard model', 'Higgs Physics::Standard Model'],
    ['category', 'HIGGS PHYSICS : standard model', 'Higgs Physics::Standard Model'],
    ['category', 'exotica:dark matter', 'Exotica::Dark Matter'],
    ['category', ' heavy-ion physics', 'Heavy-Ion Physics'],
    ['category', 'heavy-ionphysics', 'Heavy-Ion Physics'],
    [
      'category',
      'exotica/heavy fermions,heavy righ-handed neutrinos',
      'Exotica::Heavy Fermions, Heavy Righ-Handed Neutrinos',
    ],
    ['category', 'susy', 'Susy'],
    ['category', 'SUPERSYMMETRY', 'Supersymmetry'],
    ['category', 'higgs', 'Higgs'],
    ['category', 'standard model physics::top physics', 'Standard Model Physics::Top physics'],
    ['category', 'standard model/top physics', 'Standard Model::Top physics'],
    ['magnet_polarity', 'magdown', 'MagDown'],
    ['magnet_polarity', 'MAG UP', 'MagUp'],
    ['stripping_stream', 'dimuon', 'DIMUON'],
    ['stripping_stream', 'Charm.Mdst', 'CHARM.MDST'],
    ['stripping_version', 'Stripping21r1', 'stripping21r1'],
    ['stripping_version', 'STRIPPING29R2P3', 'stripping29r2p3'],
  ] as [VocabularyParam, string, string][])('%s: %j becomes %j', (param, raw, expected) => {
    expect(canonicalize(param, raw)).toBe(expected);
  });

  it('returns an unknown value trimmed and otherwise as given', () => {
    expect(canonicalize('experiment', '  Belle II ')).toBe('Belle II');
    expect(canonicalize('file_type', ' Weird.Format ')).toBe('Weird.Format');
    expect(canonicalize('type', ' foo/bar ')).toBe('foo/bar');
    expect(canonicalize('collision_energy', '14 TeV')).toBe('14 TeV');
  });

  it('normalizes a type separator in linear time, however much whitespace surrounds it', () => {
    const make = (n: number) => {
      const spaces = ' '.repeat(n);
      return [`a${spaces}b`, `dataset${spaces}/ collision`] as const;
    };
    const [plain, paired] = make(1_000_000);
    expect(canonicalize('type', plain)).toBe(plain);
    expect(canonicalize('type', paired)).toBe('Dataset::Collision');
    expectLinearTime(make, (values) => values.map((value) => canonicalize('type', value)), {
      sizes: MEGABYTE_SIZES,
      maxMs: 250,
    });
  });

  it('normalizes a category separator in linear time, however much whitespace surrounds it', () => {
    const make = (n: number) => {
      const spaces = ' '.repeat(n);
      return `higgs physics${spaces}/${spaces}standard model`;
    };
    expect(canonicalize('category', make(1_000_000))).toBe('Higgs Physics::Standard Model');
    expectLinearTime(make, (value) => canonicalize('category', value), {
      sizes: MEGABYTE_SIZES,
      maxMs: 250,
    });
  });

  it('normalizes the separator only for paired parameters', () => {
    expect(canonicalize('stripping_stream', 'dimuon/ew')).toBe('dimuon/ew');
    expect(canonicalize('experiment', 'cms:atlas')).toBe('cms:atlas');
  });

  it('is idempotent over every canonical value of every table, under the parameter it belongs to', () => {
    const params = Object.keys(PARAM_TOPIC) as VocabularyParam[];
    for (const table of REFERENCE_TABLES) {
      const owners = params.filter((key) => PARAM_TOPIC[key] === table.topic);
      if (owners.length === 0) continue;
      for (const { value } of table.entries) {
        if (table.topic === 'record_types' && value === 'Glossary') continue;
        if (table.topic === 'availability' && value === 'on demand') continue;
        const known = owners.filter((param) => isKnownValue(param, value));
        expect(known, `${table.topic}: ${value}`).toHaveLength(1);
        for (const param of known) {
          expect(canonicalize(param, value), `${param}: ${value}`).toBe(value);
        }
      }
    }
  });
});

describe('isKnownValue', () => {
  it('is true only for the canonical spelling', () => {
    expect(isKnownValue('experiment', 'LHCb')).toBe(true);
    expect(isKnownValue('experiment', 'lhcb')).toBe(false);
    expect(isKnownValue('collision_energy', '13TeV, 13.6TeV')).toBe(true);
    expect(isKnownValue('collision_energy', '13TeV,13.6TeV')).toBe(false);
    expect(isKnownValue('availability', 'ondemand')).toBe(true);
    expect(isKnownValue('availability', 'on-demand')).toBe(false);
    expect(isKnownValue('collision_type', 'Pb-Pb')).toBe(false);
    expect(isKnownValue('file_type', 'Belle2')).toBe(false);
  });

  it('does not treat Glossary as a known type', () => {
    expect(isKnownValue('type', 'Glossary')).toBe(false);
    expect(canonicalize('type', 'glossary')).toBe('glossary');
  });
});

describe('isGlossaryType', () => {
  it.each([['Glossary'], ['glossary'], [' GLOSSARY'], ['Glossary::Term'], ['glossary/x']])(
    'detects %j',
    (value) => {
      expect(isGlossaryType(value)).toBe(true);
    },
  );

  it.each([['Dataset'], ['Documentation::Guide'], ['News'], ['']])('passes %j', (value) => {
    expect(isGlossaryType(value)).toBe(false);
  });
});

describe('vocabulary constants', () => {
  it('serves the six reachable primaries by default, without Glossary', () => {
    expect([...SEARCHABLE_TYPE_PRIMARIES]).toEqual([
      'Dataset',
      'Documentation',
      'Environment',
      'Software',
      'Supplementaries',
      'News',
    ]);
    for (const primary of SEARCHABLE_TYPE_PRIMARIES) {
      expect(isKnownValue('type', primary)).toBe(true);
    }
  });

  it('expands PbPb to both upstream spellings', () => {
    expect([...PBPB_SPELLINGS]).toEqual(['PbPb', 'Pb-Pb']);
  });

  it('expands Heavy-Ion Physics to its spelling with a leading space too', () => {
    expect([...HEAVY_ION_SPELLINGS]).toEqual(['Heavy-Ion Physics', ' Heavy-Ion Physics']);
  });

  it('keys every spelling expansion by a canonical value of its parameter, and nothing else', () => {
    expect(Object.keys(SPELLING_EXPANSIONS)).toEqual(['collision_type', 'category']);
    expect(SPELLING_EXPANSIONS.collision_type?.get('PbPb')).toBe(PBPB_SPELLINGS);
    expect(SPELLING_EXPANSIONS.category?.get('Heavy-Ion Physics')).toBe(HEAVY_ION_SPELLINGS);
    for (const [param, table] of Object.entries(SPELLING_EXPANSIONS)) {
      for (const [value, spellings] of table) {
        expect(isKnownValue(param as VocabularyParam, value), value).toBe(true);
        expect(spellings[0], value).toBe(value);
      }
      for (const member of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        expect(table.get(member), `${param}: ${member}`).toBeUndefined();
      }
    }
  });

  it('routes every filter parameter to a reference topic that exists', () => {
    for (const topic of Object.values(PARAM_TOPIC)) {
      expect(REFERENCE_TOPICS).toContain(topic);
    }
    expect(PARAM_TOPIC.type).toBe('record_types');
    expect(PARAM_TOPIC.collision_energy).toBe('collision_energies');
    expect(PARAM_TOPIC.category).toBe('categories');
    expect(PARAM_TOPIC.magnet_polarity).toBe('lhcb');
    expect(PARAM_TOPIC.stripping_stream).toBe('lhcb');
    expect(PARAM_TOPIC.stripping_version).toBe('lhcb');
  });
});

describe('REFERENCE_TABLES', () => {
  it('has one table per topic, in topic order', () => {
    expect(REFERENCE_TABLES.map((table) => table.topic)).toEqual([...REFERENCE_TOPICS]);
  });

  it('gives every table a summary and every entry a value and meaning', () => {
    for (const table of REFERENCE_TABLES) {
      expect(table.summary.length, table.topic).toBeGreaterThan(0);
      expect(table.entries.length, table.topic).toBeGreaterThan(0);
      for (const entry of table.entries) {
        expect(entry.value.trim(), table.topic).not.toBe('');
        expect(entry.meaning.trim(), `${table.topic}: ${entry.value}`).not.toBe('');
      }
    }
  });

  it('has no duplicate values within a table', () => {
    for (const table of REFERENCE_TABLES) {
      const values = table.entries.map((entry) => entry.value);
      expect(new Set(values).size, table.topic).toBe(values.length);
    }
  });

  it('carries the verified counts', () => {
    expect(tableOf('experiments').entries).toHaveLength(9);
    expect(tableOf('collision_energies').entries).toHaveLength(15);
    expect(tableOf('collision_types').entries).toHaveLength(5);
    expect(tableOf('file_types').entries).toHaveLength(65);
    expect(tableOf('categories').entries).toHaveLength(39);
    expect(tableOf('lhcb').entries).toHaveLength(25);
  });

  it('lists 18 category primaries and 21 pairs, each with the experiments that use it', () => {
    const entries = tableOf('categories').entries;
    const pairs = entries.filter((entry) => entry.value.includes('::'));
    expect(entries.length - pairs.length).toBe(18);
    expect(pairs).toHaveLength(21);
    for (const { value, meaning } of entries) {
      expect(meaning, value).toMatch(/^Experiments: (CMS|ATLAS|DELPHI)(, (CMS|ATLAS|DELPHI))*\./);
      expect(value, value).toBe(value.trim());
    }
    const byValue = new Map(entries.map((entry) => [entry.value, entry.meaning]));
    expect(byValue.get('Higgs Physics::Standard Model')).toBe('Experiments: CMS, ATLAS.');
    expect(byValue.get('Supersymmetry')).toBe('Experiments: CMS. A different value from Susy.');
    expect(byValue.get('Susy')).toBe('Experiments: DELPHI. A different value from Supersymmetry.');
    expect(byValue.get('Heavy-Ion Physics')).toContain('leading space');
    expect(byValue.get('Exotica::Heavy Fermions, Heavy Righ-Handed Neutrinos')).toContain(
      'the comma belongs to it',
    );
    expect(byValue.has(' Heavy-Ion Physics')).toBe(false);
  });

  it('dates the categories snapshot and names what the 10-value cap hides', () => {
    const { summary } = tableOf('categories');
    expect(summary).toContain('2026-10-01');
    expect(summary).toContain('cern_opendata_search_records');
    expect(summary).toContain('hides Supersymmetry and Standard Model Physics');
    expect(summary).toMatch(
      /Higgs and Higgs Physics, Susy and Supersymmetry, and Standard Model and Standard Model Physics are distinct/,
    );
  });

  it('lists the LHCb polarities, then the 11 streams, then the 12 versions, each under its own filter', () => {
    const entries = tableOf('lhcb').entries;
    const of = (param: VocabularyParam) =>
      entries.filter((entry) => isKnownValue(param, entry.value)).map((entry) => entry.value);
    expect(of('magnet_polarity')).toEqual(['MagDown', 'MagUp']);
    expect(of('stripping_stream')).toHaveLength(11);
    expect(of('stripping_stream')).toContain('COMMONPARTICLES');
    expect(of('stripping_version')).toHaveLength(12);
    expect(of('stripping_version')).toEqual(
      expect.arrayContaining(['stripping21r1', 'stripping29r2p3']),
    );
    for (const { value, meaning } of entries) {
      const param = (['magnet_polarity', 'stripping_stream', 'stripping_version'] as const).find(
        (candidate) => isKnownValue(candidate, value),
      );
      expect(meaning, value).toMatch(new RegExp(`^${param}: `));
    }
    expect(tableOf('lhcb').summary).toContain('2026-10-01');
  });

  it('keeps 13TeV, 13.6TeV as one value', () => {
    const values = tableOf('collision_energies').entries.map((entry) => entry.value);
    expect(values).toContain('13TeV, 13.6TeV');
    expect(values).toContain('13TeV');
    expect(values).toContain('13.6TeV');
  });

  it('lists Glossary as not served, apart from the filterable types', () => {
    const entries = tableOf('record_types').entries;
    const glossary = entries.find((entry) => entry.value === 'Glossary');
    expect(glossary?.meaning).toMatch(/not served/i);
    expect(entries.map((entry) => entry.value)).toEqual(
      expect.arrayContaining([
        'Dataset',
        'Dataset::Collision',
        'Environment::Validation',
        'Supplementaries::Trigger',
        'News',
      ]),
    );
  });

  it('documents the file-level availability spelling with a space', () => {
    const values = tableOf('availability').entries.map((entry) => entry.value);
    expect(values).toEqual(['online', 'partial', 'ondemand', 'requested', 'on demand']);
  });

  it('states the run-period snapshot date and where the live data is', () => {
    const table = tableOf('run_periods');
    expect(table.summary).toContain('2026-10-01');
    expect(table.summary).toContain('cern_opendata_get_validated_runs');
  });

  it('states trigger coverage as 2011-2016, the years that hold path records', () => {
    expect(tableOf('run_periods').summary).toMatch(/CMS trigger path records cover 2011-2016\.$/);
  });

  it('lists muons-only lists where they exist and says so where they do not', () => {
    const entries = new Map(
      tableOf('run_periods').entries.map((entry) => [entry.value, entry.meaning]),
    );
    expect(entries.get('Run2012B')).toBe(
      'Validated-run lists (recids) full: 1002; muons_only: 1005.',
    );
    expect(entries.get('Run2011A')).toContain('full: 1001, 14206, 14208');
    expect(entries.get('Run2011A')).toContain('muons_only: 14207, 14209');
    expect(entries.get('Run2010B')).toContain('no muons_only list');
    expect(entries.get('Commissioning2010')).toContain('no muons_only list');
    expect(entries.get('Run2016H')).toContain('14220');
  });

  it('documents each identifier form with the tool that takes it', () => {
    const entries = tableOf('identifiers').entries;
    expect(entries.map((entry) => entry.value)).toEqual([
      'recid',
      'DOI',
      'CMS dataset path',
      'documentation slug',
      'file-index key',
      'trigger path',
      'run period',
    ]);
    for (const entry of entries) {
      expect(entry.meaning, entry.value).toMatch(/cern_opendata_[a-z_]+/);
    }
  });

  it('describes a file-index key as matched exactly, not only the _file_index.json form', () => {
    const key = tableOf('identifiers').entries.find((entry) => entry.value === 'file-index key');
    expect(key?.meaning).toBe(
      'An indexes[].key from cern_opendata_list_files, matched exactly: usually ending _file_index.json, or a name such as training_files.json; the .txt spelling is accepted. Taken by cern_opendata_list_files as index.',
    );
  });

  it('explains why a title: wildcard on a path matches nothing, without calling field wildcards broken', () => {
    const wildcard = tableOf('query_syntax').entries.find((entry) => entry.value === 'HLT_IsoMu*');
    expect(wildcard?.meaning).toBe(
      'Trailing wildcard on a bare term. title is stored as one whole-title term, so title:HLT_IsoMu* matches nothing (trigger titles begin "High-Level Trigger path information").',
    );
  });
});
