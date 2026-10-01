/**
 * @fileoverview Tests for recid spelling reduction and identifier classification.
 * @module tests/services/cern-opendata/identifiers.test
 */

import { describe, expect, it } from 'vitest';
import { classifyIdentifier, reduceRecidSpelling } from '@/services/cern-opendata/identifiers.js';

describe('reduceRecidSpelling', () => {
  it.each([
    ['6004', '6004'],
    ['  6004  ', '6004'],
    ['recid:6004', '6004'],
    ['RECID: 6004', '6004'],
    ['Recid:\t6004', '6004'],
    ['https://opendata.cern.ch/record/6004', '6004'],
    ['http://opendata.cern.ch/record/6004', '6004'],
    ['HTTPS://OPENDATA.CERN.CH/RECORD/6004', '6004'],
    ['https://opendata.cern.ch/api/records/6004', '6004'],
    ['https://opendata.cern.ch/record/6004/files/file.root', '6004'],
    ['https://opendata.cern.ch/record/6004?ln=en', '6004'],
    ['https://opendata.cern.ch/record/6004#files', '6004'],
    ['recid:https://opendata.cern.ch/record/6004', '6004'],
    ['06004', '6004'],
    ['0006004', '6004'],
    ['  06004  ', '6004'],
    ['recid:06004', '6004'],
    ['RECID: 0006004', '6004'],
    ['https://opendata.cern.ch/record/06004', '6004'],
    ['https://opendata.cern.ch/api/records/0006004?ln=en', '6004'],
    ['6004', '6004'],
    ['10', '10'],
    ['100', '100'],
    ['1005', '1005'],
    ['0', ''],
    ['000', ''],
  ])('reduces %j to %j', (raw, expected) => {
    expect(reduceRecidSpelling(raw)).toBe(expected);
  });

  it('leaves values it cannot reduce unvalidated', () => {
    expect(reduceRecidSpelling('abc')).toBe('abc');
    expect(reduceRecidSpelling('https://opendata.cern.ch/record/6004evil')).toBe(
      'https://opendata.cern.ch/record/6004evil',
    );
    expect(reduceRecidSpelling('https://evil.example/record/6004')).toBe(
      'https://evil.example/record/6004',
    );
    expect(reduceRecidSpelling('')).toBe('');
  });
});

describe('classifyIdentifier', () => {
  it('classifies recid spellings and keeps the input as given', () => {
    expect(classifyIdentifier('  recid:6004 ')).toEqual({
      input: '  recid:6004 ',
      kind: 'recid',
      value: '6004',
    });
    expect(classifyIdentifier('https://opendata.cern.ch/record/6004')).toMatchObject({
      kind: 'recid',
      value: '6004',
    });
  });

  it('strips leading zeros from a recid, as the portal stores it, and keeps the input as given', () => {
    expect(classifyIdentifier('06004')).toEqual({ input: '06004', kind: 'recid', value: '6004' });
    expect(classifyIdentifier(' recid:0006004 ')).toMatchObject({ kind: 'recid', value: '6004' });
    expect(classifyIdentifier('https://opendata.cern.ch/record/06004')).toMatchObject({
      kind: 'recid',
      value: '6004',
    });
  });

  it('does not classify an all-zero number as a recid', () => {
    expect(classifyIdentifier('0').kind).not.toBe('recid');
    expect(classifyIdentifier('000').kind).not.toBe('recid');
  });

  it.each([
    ['10.7483/OPENDATA.CMS.YLIC.86ZZ'],
    ['doi:10.7483/OPENDATA.CMS.YLIC.86ZZ'],
    ['DOI: 10.7483/OPENDATA.CMS.YLIC.86ZZ'],
    ['https://doi.org/10.7483/OPENDATA.CMS.YLIC.86ZZ'],
    ['http://dx.doi.org/10.7483/OPENDATA.CMS.YLIC.86ZZ'],
    ['HTTPS://DOI.ORG/10.7483/OPENDATA.CMS.YLIC.86ZZ'],
  ])('classifies the DOI form %j', (input) => {
    expect(classifyIdentifier(input)).toEqual({
      input,
      kind: 'doi',
      value: '10.7483/OPENDATA.CMS.YLIC.86ZZ',
    });
  });

  it('keeps a lowercase DOI lowercase (the service owns the uppercase retry)', () => {
    expect(classifyIdentifier('10.7483/opendata.cms.ylic.86zz')).toMatchObject({
      kind: 'doi',
      value: '10.7483/opendata.cms.ylic.86zz',
    });
  });

  it.each([
    ['10.12/abc'],
    ['10.1234567890/abc'],
    ['10.7483/'],
    ['10.7483/has space'],
    ['10.7483/quote"inside'],
    ['10.7483/back\\slash'],
  ])('does not classify %j as a DOI', (input) => {
    expect(classifyIdentifier(input).kind).not.toBe('doi');
  });

  it('classifies a CMS dataset path', () => {
    const path = '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD';
    expect(classifyIdentifier(path)).toEqual({
      input: path,
      kind: 'cms_dataset_path',
      value: path,
    });
    expect(classifyIdentifier(` ${path} `)).toMatchObject({
      kind: 'cms_dataset_path',
      value: path,
    });
  });

  it.each([
    ['/A/B/C/'],
    ['/A/B'],
    ['/A/B/C/D'],
    ['//B/C'],
    ['/A/B/C D'],
    ['/A/B/C"'],
    ['/A/B/C\\'],
    ['A/B/C'],
  ])('does not classify %j as a dataset path', (input) => {
    expect(classifyIdentifier(input).kind).toBe('unrecognized');
  });

  it('classifies doc slugs, lowercased, from a bare slug or a docs URL', () => {
    expect(classifyIdentifier('CMS-Guide-Docker')).toEqual({
      input: 'CMS-Guide-Docker',
      kind: 'doc_slug',
      value: 'cms-guide-docker',
    });
    for (const url of [
      'https://opendata.cern.ch/docs/cms-guide-docker',
      'https://opendata.cern.ch/docs/cms-guide-docker/',
      'https://opendata.cern.ch/docs/cms-guide-docker?ln=en',
      'http://opendata.cern.ch/docs/cms-guide-docker#intro',
    ]) {
      expect(classifyIdentifier(url)).toMatchObject({
        kind: 'doc_slug',
        value: 'cms-guide-docker',
      });
    }
    expect(classifyIdentifier('cms.guide_v2-x')).toMatchObject({
      kind: 'doc_slug',
      value: 'cms.guide_v2-x',
    });
  });

  it('prefers recid over DOI over path over slug', () => {
    expect(classifyIdentifier('6004').kind).toBe('recid');
    expect(classifyIdentifier('10.7483/ABCD').kind).toBe('doi');
    expect(classifyIdentifier('/a/b/c').kind).toBe('cms_dataset_path');
    expect(classifyIdentifier('abc').kind).toBe('doc_slug');
  });

  it.each([
    [''],
    ['   '],
    ['-leading-dash'],
    ['has space'],
    ['recid:6004 OR 1'],
    ['https://opendata.cern.ch/docs/'],
    ['https://opendata.cern.ch/record/abc'],
    ['https://opendata.cern.ch/record/6004evil'],
    ['https://evil.example/docs/cms-guide-docker'],
    ['٣٤٥'],
  ])('classifies %j as unrecognized with the trimmed value', (input) => {
    expect(classifyIdentifier(input)).toEqual({
      input,
      kind: 'unrecognized',
      value: input.trim(),
    });
  });

  it('never lets a quote or backslash reach a classified value', () => {
    const hostile = [
      'x"y',
      'slug\\',
      '10.1234/ab"cd',
      '/a/b"/c',
      'recid:1" OR recid:2',
      '1") OR (title:"',
      'doi:10.1234/a\\"b',
      'cms-guide"-docker',
    ];
    for (const input of hostile) {
      const { kind, value } = classifyIdentifier(input);
      if (kind !== 'unrecognized') {
        expect(value).not.toMatch(/["\\]/);
      }
    }
  });
});
