/**
 * @fileoverview Tests for the shared tool input helpers: blank-as-unset
 * optionals, comma-or-array lists, vocabulary lists, the recid input, and the
 * unrecognized-values report.
 * @module tests/shared/inputs.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  blankAsUnset,
  listInput,
  recidInput,
  requiredListInput,
  unrecognizedValues,
  vocabularyListInput,
} from '@/mcp-server/tools/inputs.js';
import { expectLinearTime } from '../fixtures/cpu-time.js';

const element = z.string().max(100);
const MEGABYTE_SIZES = [62_500, 250_000, 1_000_000] as const;

const RECID_MESSAGE =
  'A recid is 1-12 digits (6004), optionally after an experiment prefix (atlas-160006).';

describe('blankAsUnset', () => {
  const schema = z.object({
    text: blankAsUnset(z.string().optional()),
    count: blankAsUnset(z.number().int().min(1).max(50).optional()),
    mode: blankAsUnset(z.enum(['a', 'b']).optional()),
    items: blankAsUnset(z.array(z.string()).optional()),
  });

  it.each([[''], ['   '], ['\t\n']])('reads %j as unset on every optional kind', (blank) => {
    expect(schema.parse({ text: blank, count: blank, mode: blank, items: blank })).toEqual({
      text: undefined,
      count: undefined,
      mode: undefined,
      items: undefined,
    });
  });

  it('passes real values through untouched', () => {
    expect(schema.parse({ text: ' x ', count: 5, mode: 'a', items: ['q'] })).toEqual({
      text: ' x ',
      count: 5,
      mode: 'a',
      items: ['q'],
    });
  });

  it('accepts omitted keys', () => {
    expect(schema.parse({})).toEqual({});
  });

  it('still validates a non-blank value', () => {
    expect(schema.safeParse({ count: 0 }).success).toBe(false);
    expect(schema.safeParse({ mode: 'c' }).success).toBe(false);
    expect(schema.safeParse({ count: '5' }).success).toBe(false);
  });
});

describe('listInput', () => {
  const list = listInput(3, element);
  const parse = (value: unknown) => list.safeParse(value);

  it('accepts an array, a comma-separated string, or a lone value', () => {
    expect(parse(['a', 'b'])).toMatchObject({ success: true, data: ['a', 'b'] });
    expect(parse('a,b')).toMatchObject({ success: true, data: ['a', 'b'] });
    expect(parse('a')).toMatchObject({ success: true, data: ['a'] });
  });

  it('trims items, drops empties, and dedupes in first-seen order', () => {
    expect(parse(' a , b ,, a ,  ,c')).toMatchObject({ success: true, data: ['a', 'b', 'c'] });
    expect(parse(['b', ' b ', 'a', '', 'b'])).toMatchObject({ success: true, data: ['b', 'a'] });
  });

  it.each([[undefined], [''], ['   '], [','], [' , , '], [[]], [['', ' ']]])(
    'reads %j as unset',
    (value) => {
      expect(parse(value)).toEqual({ success: true, data: undefined });
    },
  );

  it('accepts exactly max items and fails past it with one too_big issue', () => {
    expect(parse('a,b,c')).toMatchObject({ success: true });
    const result = parse(Array.from({ length: 500 }, (_, i) => `item${i}`));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe('too_big');
  });

  it('counts the cap after dedupe and trimming', () => {
    expect(parse('a,a,a,a,b,c')).toMatchObject({ success: true, data: ['a', 'b', 'c'] });
  });

  it('applies the element schema to each kept item', () => {
    const result = parse(['ok', 'x'.repeat(101)]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([1]);
  });

  it('rejects non-string items and non-list values through the schema', () => {
    expect(parse([1, 'a']).success).toBe(false);
    expect(parse(5).success).toBe(false);
    expect(parse({ a: 1 }).success).toBe(false);
  });

  it('canonicalizes each item before the dedupe', () => {
    const canonical = listInput(5, element, { canonicalize: (item) => item.toUpperCase() });
    expect(canonical.parse('a, A, b')).toEqual(['A', 'B']);
  });

  it('passes an item over the element cap through uncanonicalized, so the element schema rejects it', () => {
    const seen: string[] = [];
    const canonical = listInput(5, element, {
      canonicalize: (item) => {
        seen.push(item);
        return item.toUpperCase();
      },
    });
    const result = canonical.safeParse(['a', ` ${'x'.repeat(101)} `]);
    expect(seen).toEqual(['a']);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]).toMatchObject({ code: 'too_big', path: [1] });
    expect(canonical.parse(`a, ${'x'.repeat(100)}`)).toEqual(['A', 'X'.repeat(100)]);
  });

  it('requires an element schema with a length cap', () => {
    expect(() => listInput(3, z.string())).toThrow('.max()');
    expect(() => requiredListInput(3, z.string())).toThrow('.max()');
  });

  it('treats a string isWholeValue accepts as one value instead of splitting it', () => {
    const whole = listInput(5, element, { isWholeValue: (raw) => raw === 'x, y' });
    expect(whole.parse('x, y')).toEqual(['x, y']);
    expect(whole.parse('x, z')).toEqual(['x', 'z']);
  });

  it('sits in an object as an optional key', () => {
    const schema = z.object({ tags: listInput(2, element) });
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ tags: '' })).toEqual({ tags: undefined });
  });
});

describe('requiredListInput', () => {
  const list = requiredListInput(20, z.string().max(500));

  it('accepts arrays and comma-separated strings', () => {
    expect(list.parse(['6004', '6005'])).toEqual(['6004', '6005']);
    expect(list.parse('6004, 6005,6004')).toEqual(['6004', '6005']);
  });

  it.each([[undefined], [''], ['  '], [','], [[]], [['', ' ']]])(
    'requires at least one item: %j',
    (value) => {
      expect(list.safeParse(value).success).toBe(false);
    },
  );

  it('allows exactly 20 and fails past it with one issue', () => {
    expect(list.safeParse(Array.from({ length: 20 }, (_, i) => `id${i}`)).success).toBe(true);
    const result = list.safeParse(Array.from({ length: 300 }, (_, i) => `id${i}`));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe('too_big');
  });

  it('applies the 500-character element cap', () => {
    expect(list.safeParse(['x'.repeat(500)]).success).toBe(true);
    expect(list.safeParse(['x'.repeat(501)]).success).toBe(false);
  });
});

describe('vocabularyListInput', () => {
  it('canonicalizes filter values and accepts both list forms', () => {
    const experiment = vocabularyListInput('experiment', 9);
    expect(experiment.parse('lhcb, cms')).toEqual(['LHCb', 'CMS']);
    expect(experiment.parse(['Atlas', 'ATLAS'])).toEqual(['ATLAS']);
  });

  it('passes an unknown value through trimmed', () => {
    expect(vocabularyListInput('file_type', 10).parse(' Weird.Format ')).toEqual(['Weird.Format']);
  });

  it('normalizes record-type separators', () => {
    expect(vocabularyListInput('type', 7).parse('dataset/collision, software:analysis')).toEqual([
      'Dataset::Collision',
      'Software::Analysis',
    ]);
  });

  it('reads blanks as unset', () => {
    const schema = z.object({ experiment: vocabularyListInput('experiment', 9) });
    for (const blank of ['', '  ', ' , ', []]) {
      expect(schema.parse({ experiment: blank })).toEqual({ experiment: undefined });
    }
    expect(schema.parse({})).toEqual({});
  });

  it('caps the list and each element', () => {
    const experiment = vocabularyListInput('experiment', 2);
    expect(experiment.safeParse('a,b,c').success).toBe(false);
    expect(experiment.safeParse('x'.repeat(101)).success).toBe(false);
  });

  describe('type', () => {
    const type = vocabularyListInput('type', 7);

    it.each([
      ['Glossary'],
      ['glossary'],
      ['Dataset, Glossary'],
      [['glossary::Term']],
      ['GLOSSARY/x'],
    ])('rejects Glossary in any form: %j', (value) => {
      const result = type.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(
        'Glossary entries are not served by this server.',
      );
    });

    it('accepts everything else', () => {
      expect(type.parse('Dataset, News')).toEqual(['Dataset', 'News']);
    });
  });

  describe('collision_energy', () => {
    const energy = vocabularyListInput('collision_energy', 15);

    it('keeps the combined 13TeV, 13.6TeV string as one upstream value', () => {
      expect(energy.parse('13TeV, 13.6TeV')).toEqual(['13TeV, 13.6TeV']);
      expect(energy.parse('13TeV,13.6TeV')).toEqual(['13TeV, 13.6TeV']);
      expect(energy.parse('13 tev, 13.6 tev')).toEqual(['13TeV, 13.6TeV']);
    });

    it('splits a string that is not one known value on commas', () => {
      expect(energy.parse('13TeV, 8TeV')).toEqual(['13TeV', '8TeV']);
      expect(energy.parse('13TeV, 13.6TeV, 8TeV')).toEqual(['13TeV', '13.6TeV', '8TeV']);
    });

    it('treats the array form as separate items', () => {
      expect(energy.parse(['13TeV', '13.6TeV'])).toEqual(['13TeV', '13.6TeV']);
      expect(energy.parse(['13TeV, 13.6TeV'])).toEqual(['13TeV, 13.6TeV']);
    });
  });

  describe('category', () => {
    const category = vocabularyListInput('category', 20);
    const COMMA_VALUE = 'Exotica::Heavy Fermions, Heavy Righ-Handed Neutrinos';

    it('keeps a known value that holds a comma whole, in any case and separator', () => {
      expect(category.parse(COMMA_VALUE)).toEqual([COMMA_VALUE]);
      expect(category.parse('exotica/heavy fermions,heavy righ-handed neutrinos')).toEqual([
        COMMA_VALUE,
      ]);
    });

    it('splits a string that is not one known value on commas', () => {
      expect(category.parse('Exotica::Dark Matter, Supersymmetry')).toEqual([
        'Exotica::Dark Matter',
        'Supersymmetry',
      ]);
      expect(category.parse('susy, higgs')).toEqual(['Susy', 'Higgs']);
    });

    it('keeps the comma value whole beside other values in one string, any order or spelling', () => {
      expect(category.parse(`${COMMA_VALUE}, Supersymmetry`)).toEqual([
        COMMA_VALUE,
        'Supersymmetry',
      ]);
      expect(
        category.parse('supersymmetry, exotica/heavy fermions, heavy righ-handed neutrinos, susy'),
      ).toEqual(['Supersymmetry', COMMA_VALUE, 'Susy']);
      expect(category.parse(`,${COMMA_VALUE},`)).toEqual([COMMA_VALUE]);
    });

    it('checks every adjacent pair of a long string for a rejoin in linear time', () => {
      const make = (n: number) => 'a,'.repeat(n / 2);
      expect(category.parse(make(200_000))).toEqual(['a']);
      expectLinearTime(make, (value) => category.safeParse(value), {
        sizes: [12_500, 50_000, 200_000],
        maxMs: 250,
      });
    });

    it('treats the array form as separate items, so the comma value can sit beside others', () => {
      expect(category.parse([COMMA_VALUE, 'supersymmetry'])).toEqual([
        COMMA_VALUE,
        'Supersymmetry',
      ]);
    });

    it('normalizes the primary/secondary separator as type does', () => {
      expect(category.parse('higgs physics/standard model, EXOTICA : dark matter')).toEqual([
        'Higgs Physics::Standard Model',
        'Exotica::Dark Matter',
      ]);
    });
  });

  it.each([
    ['magnet_polarity', 2, 'magdown, MAG UP', ['MagDown', 'MagUp']],
    ['stripping_stream', 11, 'dimuon, charm.mdst', ['DIMUON', 'CHARM.MDST']],
    [
      'stripping_version',
      12,
      'Stripping21r1, STRIPPING29R2P3',
      ['stripping21r1', 'stripping29r2p3'],
    ],
  ] as const)('canonicalizes the LHCb filter %s', (param, max, raw, expected) => {
    expect(vocabularyListInput(param, max).parse(raw)).toEqual(expected);
  });

  it('maps PbPb spellings to the canonical value', () => {
    expect(vocabularyListInput('collision_type', 5).parse('Pb-Pb, pp')).toEqual(['PbPb', 'pp']);
  });
});

describe('recidInput', () => {
  const recid = recidInput();

  it.each([
    ['6004', '6004'],
    [' 6004 ', '6004'],
    ['recid:6004', '6004'],
    ['RECID: 6004', '6004'],
    ['https://opendata.cern.ch/record/6004', '6004'],
    ['http://opendata.cern.ch/record/6004', '6004'],
    ['https://opendata.cern.ch/api/records/6004', '6004'],
    ['https://opendata.cern.ch/record/6004/files/x.root?download=1#top', '6004'],
    ['123456789012', '123456789012'],
    ['0123456789012', '123456789012'],
    ['06004', '6004'],
    ['atlas-160006', 'atlas-160006'],
    ['ATLAS-160006', 'atlas-160006'],
    ['recid:atlas-160006', 'atlas-160006'],
    ['https://opendata.cern.ch/record/atlas-160006', 'atlas-160006'],
    ['http://opendata.cern.ch/api/records/atlas-160006/files', 'atlas-160006'],
    ['atlas-0160006', 'atlas-160006'],
    ['cms-93956', 'cms-93956'],
    ['abcdefghijklmnop-123456789012', 'abcdefghijklmnop-123456789012'],
  ])('reduces %j to %j', (raw, expected) => {
    expect(recid.parse(raw)).toBe(expected);
  });

  it.each([
    ['atlas-'],
    ['atlas-0'],
    ['atlas_160006'],
    ['atlas-160006x'],
    ['atlas-1234567890123'],
    ['abcdefghijklmnopq-160006'],
    ['-160006'],
    ['atlas--160006'],
    ['at las-160006'],
    ['recid:atlas-'],
    ['https://opendata.cern.ch/record/atlas-160006evil'],
  ])('rejects the prefixed spelling %j with the grammar, never echoing it', (raw) => {
    const [issue, ...rest] = recid.safeParse(raw).error?.issues ?? [];
    expect(rest).toEqual([]);
    expect(issue?.message).toBe(RECID_MESSAGE);
    expect(JSON.stringify({ ...issue, message: undefined })).not.toContain(raw);
  });

  it('rejects a recid of 13 digits or more without echoing it', () => {
    for (const raw of ['1234567890123', '7'.repeat(1_000_000)]) {
      const result = recid.safeParse(raw);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).not.toContain(raw.slice(0, 13));
    }
  });

  it.each([
    [''],
    ['  '],
    ['abc'],
    ['60 04'],
    ['-6004'],
    ['6004.5'],
    ['recid:'],
    ['https://opendata.cern.ch/docs/cms-guide-docker'],
    ['https://example.org/record/6004'],
    [6004],
    [null],
    [undefined],
  ])('rejects %j', (raw) => {
    expect(recid.safeParse(raw).success).toBe(false);
  });

  it('explains the expected form in the error', () => {
    const result = recid.safeParse('abc');
    expect(result.error?.issues[0]?.message).toBe(RECID_MESSAGE);
  });

  it('reads a blank as unset when wrapped with blankAsUnset(...optional())', () => {
    const optional = blankAsUnset(recidInput().optional());
    expect(optional.parse('')).toBeUndefined();
    expect(optional.parse('   ')).toBeUndefined();
    expect(optional.parse(undefined)).toBeUndefined();
    expect(optional.parse('recid:6004')).toBe('6004');
    expect(optional.safeParse('abc').success).toBe(false);
  });
});

describe('preprocessing a megabyte of caller text', () => {
  const spaces = (n: number) => ' '.repeat(n);
  const long = (n: number) => `a${spaces(n)}b`;
  const vocabularyParams = [
    'type',
    'experiment',
    'collision_energy',
    'collision_type',
    'file_type',
    'availability',
    'category',
    'magnet_polarity',
    'stripping_stream',
    'stripping_version',
  ] as const;

  it.each<[string, z.ZodType, (n: number) => unknown]>([
    ...vocabularyParams.map((param): [string, z.ZodType, (n: number) => unknown] => [
      `a ${param} item`,
      vocabularyListInput(param, 5),
      long,
    ]),
    ['a type item in an array', vocabularyListInput('type', 7), (n) => [long(n)]],
    [
      'a category pair padded around its separator, matched whole before splitting',
      vocabularyListInput('category', 20),
      (n) => `higgs physics${spaces(n)}/${spaces(n)}standard model, x`,
    ],
    ['a collection item', listInput(10, element), long],
    ['an identifier', requiredListInput(20, z.string().max(500)), long],
    ['a padded recid', recidInput(), (n) => `${spaces(n)}6004x`],
    [
      'a record URL with a long recid',
      recidInput(),
      (n) => `https://opendata.cern.ch/record/${'1'.repeat(n)}x`,
    ],
    ['a recid with a long prefix', recidInput(), (n) => `${'a'.repeat(n)}-6004`],
    [
      'a record URL with a long prefix and no number',
      recidInput(),
      (n) => `https://opendata.cern.ch/record/${'a'.repeat(n)}-x`,
    ],
  ])('rejects %s in linear time', (_name, schema, make) => {
    expect(schema.safeParse(make(1_000_000)).success).toBe(false);
    expectLinearTime(make, (value) => schema.safeParse(value), {
      sizes: MEGABYTE_SIZES,
      maxMs: 250,
    });
  });
});

describe('unrecognizedValues', () => {
  it('reports the values outside the verified table, tagged with the parameter', () => {
    expect(unrecognizedValues('experiment', ['CMS', 'Belle II'])).toEqual([
      { param: 'experiment', value: 'Belle II' },
    ]);
    expect(unrecognizedValues('collision_energy', ['13TeV, 13.6TeV', '14TeV'])).toEqual([
      { param: 'collision_energy', value: '14TeV' },
    ]);
  });

  it('reports a Pb-Pb spelling that was not canonicalized, and nothing for canonical input', () => {
    expect(unrecognizedValues('collision_type', ['PbPb', 'pp'])).toEqual([]);
    expect(unrecognizedValues('collision_type', ['Pb-Pb'])).toEqual([
      { param: 'collision_type', value: 'Pb-Pb' },
    ]);
  });

  it('returns nothing for an unset or empty list', () => {
    expect(unrecognizedValues('experiment', undefined)).toEqual([]);
    expect(unrecognizedValues('experiment', [])).toEqual([]);
  });

  it('agrees with what vocabularyListInput leaves unrecognized', () => {
    const parsed = vocabularyListInput('file_type', 10).parse('NANOAOD, nope');
    expect(unrecognizedValues('file_type', parsed)).toEqual([
      { param: 'file_type', value: 'nope' },
    ]);
  });
});
