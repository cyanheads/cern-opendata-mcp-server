/**
 * @fileoverview Tests for the canonical vocabulary: canonicalization, known-value
 * checks, Glossary detection, and the reference tables.
 * @module tests/services/cern-opendata/vocabulary.test
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  isGlossaryType,
  isKnownValue,
  PARAM_TOPIC,
  PBPB_SPELLINGS,
  REFERENCE_TABLES,
  REFERENCE_TOPICS,
  SEARCHABLE_TYPE_PRIMARIES,
  type VocabularyParam,
} from '@/services/cern-opendata/vocabulary.js';

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
  ] as [VocabularyParam, string, string][])('%s: %j becomes %j', (param, raw, expected) => {
    expect(canonicalize(param, raw)).toBe(expected);
  });

  it('returns an unknown value trimmed and otherwise as given', () => {
    expect(canonicalize('experiment', '  Belle II ')).toBe('Belle II');
    expect(canonicalize('file_type', ' Weird.Format ')).toBe('Weird.Format');
    expect(canonicalize('type', ' foo/bar ')).toBe('foo/bar');
    expect(canonicalize('collision_energy', '14 TeV')).toBe('14 TeV');
  });

  it('is idempotent over every canonical value of every table', () => {
    for (const table of REFERENCE_TABLES) {
      const param = (Object.keys(PARAM_TOPIC) as VocabularyParam[]).find(
        (key) => PARAM_TOPIC[key] === table.topic,
      );
      if (!param) continue;
      for (const { value } of table.entries) {
        if (param === 'type' && value === 'Glossary') continue;
        if (param === 'availability' && value === 'on demand') continue;
        expect(canonicalize(param, value), `${param}: ${value}`).toBe(value);
        expect(isKnownValue(param, value), `${param}: ${value}`).toBe(true);
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

  it('routes every filter parameter to a reference topic that exists', () => {
    for (const topic of Object.values(PARAM_TOPIC)) {
      expect(REFERENCE_TOPICS).toContain(topic);
    }
    expect(PARAM_TOPIC.type).toBe('record_types');
    expect(PARAM_TOPIC.collision_energy).toBe('collision_energies');
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
});
