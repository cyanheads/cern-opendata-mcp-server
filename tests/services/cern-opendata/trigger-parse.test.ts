/**
 * @fileoverview Tests for the trigger-abstract parser: the title's path and
 * dataset, the first/last-seen lines with their HLT menu links, per-version run
 * ranges and L1 seeds, the trigger-list link, the `parsed` flag, and the
 * three `HLT_IsoMu24` abstracts of API Reference § Trigger path records. The
 * parser never throws, so malformed and sparse metadata are covered too.
 * @module tests/services/cern-opendata/trigger-parse.test
 */

import { describe, expect, it } from 'vitest';
import { parseTrigger } from '@/services/cern-opendata/trigger-parse.js';
import type { RawMetadata } from '@/services/cern-opendata/types.js';
import {
  ISOMU24_2011_ABSTRACT,
  ISOMU24_2012_ABSTRACT,
  ISOMU24_2016_ABSTRACT,
  isoMu24Hit2011,
  isoMu24Hit2012,
  isoMu24Hit2016,
  TRIGGER_ABSTRACT_HTML,
} from '../../fixtures/cern-opendata-upstream.js';

const TITLE = 'High-Level Trigger path information HLT_IsoMu24 (SingleMu dataset)';

/** Metadata with the given title and abstract HTML. */
const meta = (abstract: string | undefined, title: string = TITLE): RawMetadata => ({
  title,
  ...(abstract === undefined ? {} : { abstract: { description: abstract } }),
});

const lines = (...rows: string[]) =>
  `<blockquote>${rows.map((r) => `<p>${r}</p>`).join('')}</blockquote>`;

describe('parseTrigger: the three HLT_IsoMu24 abstracts', () => {
  it('2011 (record 2561): menu links on both seen lines, a single-run version and the trigger list', () => {
    expect(parseTrigger(isoMu24Hit2011.metadata)).toEqual({
      path: 'HLT_IsoMu24',
      dataset: 'SingleMu',
      first_seen: {
        run: 160404,
        menu: '/cdaq/physics/Run2011/5e32/v4.2/HLT/V2',
        menu_recid: '3521',
      },
      last_seen: {
        run: 178380,
        menu: '/cdaq/physics/Run2011/5e32/v6.1/HLT/V2',
        menu_recid: '3530',
      },
      versions: [
        { version: 1, run_first: 160404, run_last: 163261, l1_seed: 'L1_SingleMu12' },
        { version: 2, run_first: 163269, run_last: 165970, l1_seed: 'L1_SingleMu12' },
        { version: 6, run_first: 166346, run_last: 166346, l1_seed: 'L1_SingleMu12' },
      ],
      trigger_list_recid: '3000',
      parsed: true,
    });
  });

  it('2012 (record 6537): a last-seen menu without a link has a name and no menu_recid', () => {
    const parsed = parseTrigger(isoMu24Hit2012.metadata);
    expect(parsed.first_seen).toEqual({
      run: 190456,
      menu: '/cdaq/physics/Run2012/5e33/v1.0/HLT/V1',
      menu_recid: '6001',
    });
    expect(parsed.last_seen).toEqual({ run: 209151, menu: '/cdaq/special/25ns/v1.1/HLT/V2' });
    expect(parsed.last_seen).not.toHaveProperty('menu_recid');
    expect(parsed.versions.map((v) => v.version)).toEqual([1, 3]);
    expect(parsed.versions[1]).toEqual({
      version: 3,
      run_first: 193834,
      run_last: 209151,
      l1_seed: 'L1_SingleMu16er',
    });
    expect(parsed.trigger_list_recid).toBe('6000');
    expect(parsed.parsed).toBe(true);
  });

  it('2016 (record 29551): versions without a seeded-by part carry no l1_seed, and no dataset suffix', () => {
    const parsed = parseTrigger(isoMu24Hit2016.metadata);
    expect(parsed.path).toBe('HLT_IsoMu24');
    expect(parsed).not.toHaveProperty('dataset');
    expect(parsed.versions).toEqual([
      { version: 1, run_first: 273158, run_last: 274443 },
      { version: 2, run_first: 274445, run_last: 284044 },
    ]);
    for (const version of parsed.versions) expect(version).not.toHaveProperty('l1_seed');
    expect(parsed.last_seen).toEqual({
      run: 284044,
      menu: '/cdaq/physics/Run2016/25ns15e33/v4.2.1/HLT/V9',
      menu_recid: '30302',
    });
    expect(parsed.trigger_list_recid).toBe('30300');
    expect(parsed.parsed).toBe(true);
  });

  it('parses the shared fixture abstract', () => {
    const parsed = parseTrigger(meta(TRIGGER_ABSTRACT_HTML));
    expect(parsed).toMatchObject({
      first_seen: { run: 160404, menu_recid: '3521' },
      last_seen: { run: 178380, menu: '/cdaq/physics/Run2011/5e32/v4.2/HLT/V2' },
      versions: [{ version: 1, run_first: 160404, run_last: 163261, l1_seed: 'L1_SingleMu12' }],
      trigger_list_recid: '3000',
      parsed: true,
    });
  });

  it('keeps the three abstracts as the fixtures export them (the shapes the design quotes)', () => {
    expect(ISOMU24_2011_ABSTRACT).toContain('first seen online on run 160404');
    expect(ISOMU24_2012_ABSTRACT).toContain('last  seen online on run 209151');
    expect(ISOMU24_2016_ABSTRACT).not.toContain('seeded by');
  });
});

describe('parseTrigger: title', () => {
  it.each([
    [
      'High-Level Trigger path information HLT_IsoMu24 (SingleMu dataset)',
      'HLT_IsoMu24',
      'SingleMu',
    ],
    ['High-Level Trigger path information HLT_IsoMu24', 'HLT_IsoMu24', undefined],
    ['  High-Level Trigger path information   HLT_Mu9  (Mu dataset)  ', 'HLT_Mu9', 'Mu'],
    [
      'high-level trigger path information HLT_Ele27 (SingleElectron dataset)',
      'HLT_Ele27',
      'SingleElectron',
    ],
    ['High-Level Trigger path information HLT_Jet30_v1 (Jet dataset)', 'HLT_Jet30_v1', 'Jet'],
    ['High-Level Trigger path information HLT_X (Mu Run2011A dataset)', 'HLT_X', 'Mu Run2011A'],
  ])('reads %j as path %s and dataset %s', (title, path, dataset) => {
    const parsed = parseTrigger({ title });
    expect(parsed.path).toBe(path);
    if (dataset === undefined) expect(parsed).not.toHaveProperty('dataset');
    else expect(parsed.dataset).toBe(dataset);
  });

  it.each([
    ['an unrelated title', 'Something else entirely'],
    ['an empty title', ''],
    ['the prefix alone', 'High-Level Trigger path information'],
  ])('reads %s as no path and no dataset', (_name, title) => {
    const parsed = parseTrigger({ title });
    expect(parsed).not.toHaveProperty('path');
    expect(parsed).not.toHaveProperty('dataset');
    expect(parsed.parsed).toBe(false);
  });
});

describe('parseTrigger: the parsed flag', () => {
  const FIRST = 'first seen online on run 100 (/cdaq/a/V1)';
  const VERSION = 'V1: (runs 100 - 200) seeded by: L1_A';

  it('is true with a first-seen line and at least one version', () => {
    expect(parseTrigger(meta(lines(FIRST, VERSION))).parsed).toBe(true);
  });

  it('is false without a first-seen line, whatever else parsed', () => {
    const parsed = parseTrigger(meta(lines('last  seen online on run 200', VERSION)));
    expect(parsed.parsed).toBe(false);
    expect(parsed.versions).toHaveLength(1);
    expect(parsed.last_seen).toEqual({ run: 200 });
  });

  it('is false without a version line, keeping the first-seen run', () => {
    const parsed = parseTrigger(meta(lines(FIRST)));
    expect(parsed.parsed).toBe(false);
    expect(parsed.first_seen).toMatchObject({ run: 100 });
    expect(parsed.versions).toEqual([]);
  });

  it('is false when every version line fails to parse', () => {
    const parsed = parseTrigger(
      meta(lines(FIRST, 'V1 runs 100 to 200', 'version one: (runs a - b)')),
    );
    expect(parsed.parsed).toBe(false);
    expect(parsed.versions).toEqual([]);
  });

  it.each([
    ['no abstract at all', undefined],
    ['an empty abstract', ''],
    ['a whitespace abstract', '   '],
    ['a plain-text abstract with no tags', 'first seen online on run 5 V1: (runs 5 - 6)'],
  ])('is false and empty for %s', (_name, abstract) => {
    const parsed = parseTrigger(meta(abstract));
    expect(parsed.parsed).toBe(false);
    expect(parsed.versions).toEqual([]);
    expect(parsed).not.toHaveProperty('last_seen');
    expect(parsed).not.toHaveProperty('trigger_list_recid');
  });
});

describe('parseTrigger: seen lines', () => {
  it('reads first and last seen case-insensitively, whatever the spacing', () => {
    const parsed = parseTrigger(
      meta(lines('FIRST   SEEN  ONLINE ON RUN 11 (/m/V1)', 'Last seen online on run 22 (/m/V2)')),
    );
    expect(parsed.first_seen).toEqual({ run: 11, menu: '/m/V1' });
    expect(parsed.last_seen).toEqual({ run: 22, menu: '/m/V2' });
  });

  it('keeps the first of a repeated seen line', () => {
    const parsed = parseTrigger(
      meta(lines('first seen online on run 1 (/a/V1)', 'first seen online on run 2 (/b/V1)')),
    );
    expect(parsed.first_seen).toEqual({ run: 1, menu: '/a/V1' });
  });

  it('omits the menu when the parentheses are empty or absent', () => {
    expect(parseTrigger(meta(lines('first seen online on run 3 ()'))).first_seen).toEqual({
      run: 3,
    });
    expect(parseTrigger(meta(lines('first seen online on run 3'))).first_seen).toEqual({ run: 3 });
    expect(parseTrigger(meta(lines('first seen online on run 3 (   )'))).first_seen).toEqual({
      run: 3,
    });
  });

  it('keeps a menu name that holds parentheses of its own', () => {
    const parsed = parseTrigger(
      meta(lines('first seen online on run 4 (/cdaq/physics (test)/V2)')),
    );
    expect(parsed.first_seen?.menu).toBe('/cdaq/physics (test)/V2');
  });

  it('decodes entities in the menu name', () => {
    const parsed = parseTrigger(meta(lines('first seen online on run 5 (/cdaq/a&amp;b/V2)')));
    expect(parsed.first_seen?.menu).toBe('/cdaq/a&b/V2');
  });

  it('takes menu_recid from an absolute portal link, in either scheme, and ignores other links', () => {
    expect(
      parseTrigger(
        meta(
          lines(
            'first seen online on run 6 (<a href="https://opendata.cern.ch/record/77">/m/V1</a>)',
            'last seen online on run 7 (<a href="http://opendata.cern.ch/record/78?ln=en">/m/V2</a>)',
          ),
        ),
      ),
    ).toMatchObject({
      first_seen: { run: 6, menu: '/m/V1', menu_recid: '77' },
      last_seen: { run: 7, menu: '/m/V2', menu_recid: '78' },
    });
    const other = parseTrigger(
      meta(lines('first seen online on run 8 (<a href="/docs/some-guide">/m/V1</a>)')),
    );
    expect(other.first_seen).toEqual({ run: 8, menu: '/m/V1' });
  });

  it('takes the first record link of a line holding two', () => {
    const parsed = parseTrigger(
      meta(
        lines(
          'first seen online on run 9 (<a href="/record/1">/a/V1</a> <a href="/record/2">/b/V1</a>)',
        ),
      ),
    );
    expect(parsed.first_seen?.menu_recid).toBe('1');
  });
});

describe('parseTrigger: version lines', () => {
  const versionsOf = (...rows: string[]) => parseTrigger(meta(lines(...rows))).versions;

  it('reads a run range, a single run, and compact or spaced dashes', () => {
    expect(versionsOf('V1: (runs 10 - 20)', 'V2: (run 30)', 'V10:(runs 40-50)')).toEqual([
      { version: 1, run_first: 10, run_last: 20 },
      { version: 2, run_first: 30, run_last: 30 },
      { version: 10, run_first: 40, run_last: 50 },
    ]);
  });

  it('keeps the L1 seed text after seeded by, trimmed, with entities decoded', () => {
    expect(versionsOf('V1: (runs 1 - 2) seeded by:   L1_A OR L1_B  ')).toEqual([
      { version: 1, run_first: 1, run_last: 2, l1_seed: 'L1_A OR L1_B' },
    ]);
    expect(versionsOf('V1: (runs 1 - 2) seeded by: L1_A &amp; L1_B')[0]?.l1_seed).toBe(
      'L1_A & L1_B',
    );
  });

  it('keeps versions in document order, not sorted', () => {
    expect(versionsOf('V3: (run 3)', 'V1: (run 1)', 'V2: (run 2)').map((v) => v.version)).toEqual([
      3, 1, 2,
    ]);
  });

  it('skips lines that are not version lines', () => {
    expect(
      versionsOf('V1: (runs 1 - 2)', 'Vx: (runs 3 - 4)', 'seeded by: L1_A', 'V2: (runs 5 -)'),
    ).toEqual([{ version: 1, run_first: 1, run_last: 2 }]);
  });

  it('reads <br> separated lines as well as <p> blocks', () => {
    const html =
      'first seen online on run 1 (/a/V1)<br>V1: (runs 1 - 2) seeded by: L1_A<br/>V2: (run 3)';
    const parsed = parseTrigger(meta(html));
    expect(parsed.parsed).toBe(true);
    expect(parsed.versions.map((v) => v.version)).toEqual([1, 2]);
  });
});

describe('parseTrigger: trigger-list link', () => {
  it('takes the first record link of the See also line', () => {
    const parsed = parseTrigger(
      meta(
        lines(
          'See also the full list of triggers for CMS 2011 open data: <a href="/record/10">a</a> <a href="/record/11">b</a>',
        ),
      ),
    );
    expect(parsed.trigger_list_recid).toBe('10');
  });

  it('is absent when the See also line links no record', () => {
    expect(
      parseTrigger(meta(lines('See also the full list of triggers: <a href="/docs/x">list</a>')))
        .trigger_list_recid,
    ).toBeUndefined();
    expect(parseTrigger(meta(lines('See also the list'))).trigger_list_recid).toBeUndefined();
  });

  it('ignores a record link on a line that is not a See also line', () => {
    expect(
      parseTrigger(meta(lines('Related: <a href="/record/12">r</a>'))).trigger_list_recid,
    ).toBeUndefined();
  });
});

describe('parseTrigger: malformed metadata never throws', () => {
  it.each([
    ['an empty object', {}],
    ['a numeric title and an array abstract', { title: 123, abstract: { description: ['x'] } }],
    ['a null abstract', { title: TITLE, abstract: null }],
    ['an abstract with no description', { title: TITLE, abstract: {} }],
    [
      'unclosed tags',
      {
        title: TITLE,
        abstract: { description: '<blockquote><p>first seen online on run 5 (<a href="/rec' },
      },
    ],
    [
      'entity noise',
      { title: TITLE, abstract: { description: '<p>&#xZZ; &bogus; &#99999999;</p>' } },
    ],
  ] as [string, RawMetadata][])('survives %s', (_name, metadata) => {
    const parsed = parseTrigger(metadata);
    expect(parsed.parsed).toBe(false);
    expect(parsed.versions).toEqual([]);
  });

  it('survives a very long abstract of repeated lines and parses every version', () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => `V${i + 1}: (runs ${i} - ${i + 1})`);
    const parsed = parseTrigger(meta(lines('first seen online on run 0 (/m/V1)', ...rows)));
    expect(parsed.versions).toHaveLength(2_000);
    expect(parsed.parsed).toBe(true);
  });
});
