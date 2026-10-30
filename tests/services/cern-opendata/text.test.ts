/**
 * @fileoverview Tests for upstream-text rendering helpers: entity decoding, URL
 * printing, HTML to text, fences, inline neutralization, notice values,
 * character caps and counts that agree with their noun.
 * @module tests/services/cern-opendata/text.test
 */

import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  capText,
  countOf,
  decodeEntities,
  fence,
  fenceHtml,
  htmlToText,
  inline,
  inlineOrNA,
  inlineSpelling,
  NOT_AVAILABLE,
  noticeList,
  noticeValue,
  oneLine,
  PORTAL_ORIGIN,
  printUrl,
  sliceText,
  stripTags,
} from '@/services/cern-opendata/text.js';
import {
  HLT_MENU_TABLE_1701_HTML,
  L1_MENU_TABLE_3700_HTML,
  METHODOLOGY_5202_HTML,
  METHODOLOGY_5208_HTML,
  TRIGGER_ABSTRACT_HTML,
} from '../../fixtures/cern-opendata-upstream.js';
import { expectLinearGrowth, expectLinearTime } from '../../fixtures/cpu-time.js';
import { variablesHit12220 } from '../../fixtures/record-metadata-upstream.js';

describe('decodeEntities', () => {
  it('decodes named, decimal and hex references', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      `a & b <c> "d" 'e'`,
    );
    expect(decodeEntities('&#65;&#x42;&#X43;')).toBe('ABC');
    expect(decodeEntities('p&#8211;q &ndash; &Upsilon;&mu;')).toBe('p–q – Υμ');
    expect(decodeEntities('&#x1F600;')).toBe('\u{1F600}');
  });

  it('decodes once, never twice', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('leaves unknown names and invalid code points as written', () => {
    expect(decodeEntities('&bogus; &#0; &#xD800; &#1114112; &#xZZ; & &amp')).toBe(
      '&bogus; &#0; &#xD800; &#1114112; &#xZZ; & &amp',
    );
  });

  it('leaves names of built-in object members as written', () => {
    const members = '&constructor; &toString; &valueOf; &hasOwnProperty; &isPrototypeOf;';
    expect(decodeEntities(members)).toBe(members);
    expect(htmlToText(`<p>${members}</p>`)).toBe(members);
  });
});

describe('absoluteUrl', () => {
  it('resolves portal-relative paths and passes everything else through', () => {
    expect(absoluteUrl('/record/3521')).toBe(`${PORTAL_ORIGIN}/record/3521`);
    expect(absoluteUrl('//evil.example/x')).toBe('//evil.example/x');
    expect(absoluteUrl('https://example.org/x')).toBe('https://example.org/x');
    expect(absoluteUrl('docs/x')).toBe('docs/x');
  });
});

describe('printUrl', () => {
  it('percent-encodes characters that break markdown or autolinks', () => {
    expect(printUrl('https://x.test/a[b]c d')).toBe('https://x.test/a%5Bb%5Dc%20d');
    expect(printUrl('https://x.test/<a>|(b)`"\\')).toBe(
      'https://x.test/%3Ca%3E%7C%28b%29%60%22%5C',
    );
  });

  it('encodes line breaks, control characters and bidi controls', () => {
    expect(printUrl('https://x.test/a\nb\rc\u0000d\u0085e f')).toBe(
      'https://x.test/a%0Ab%0Dc%00d%C2%85e%E2%80%A8f',
    );
    expect(printUrl('https://x.test/‮a⁦b‏c')).toBe('https://x.test/%E2%80%AEa%E2%81%A6b%E2%80%8Fc');
  });

  it('trims, resolves relative portal paths, and keeps ordinary URLs intact', () => {
    expect(printUrl('  /record/3521  ')).toBe(`${PORTAL_ORIGIN}/record/3521`);
    expect(printUrl('https://github.com/a/b?x=1&y=2#frag')).toBe(
      'https://github.com/a/b?x=1&y=2#frag',
    );
  });
});

describe('htmlToText', () => {
  it.each([
    [
      '12210',
      '<img alt="Production workflow" src="/eos/opendata/cms/software/TrackerRecHitProducerTool/production-workflow.png"  width="85%">',
      '![Production workflow](https://opendata.cern.ch/eos/opendata/cms/software/TrackerRecHitProducerTool/production-workflow.png)',
    ],
    [
      '22350',
      '<img src="https://cds.cern.ch/record/1456510/files/pictures_samples_dimuonSpectrum_40pb-1_mod-combined.png" width=50% align="middle">',
      '![](https://cds.cern.ch/record/1456510/files/pictures_samples_dimuonSpectrum_40pb-1_mod-combined.png)',
    ],
  ])('keeps the source image reference from record %s', (_id, html, expected) => {
    expect(html).toContain('<img ');
    expect(htmlToText(html)).toBe(expected);
    expect(fenceHtml(html)).toBe(`\`\`\`\n${expected}\n\`\`\``);
  });

  it('characterizes image-free composition beside an escaped image example', () => {
    expect(htmlToText('<table><tr><td><a href="/x">x < 2<td>&lt;img src=/y&gt;</table>')).toBe(
      'x < 2 <https://opendata.cern.ch/x> | <img src=/y>',
    );
  });

  it('does not interpret image syntax inside another tag attribute', () => {
    expect(htmlToText('<span title="<img src=/hidden>">text</span>')).toBe('">text');
  });

  it.each([
    [
      'double quotes',
      '<img alt="Production workflow" src="/workflow.png">',
      '![Production workflow](https://opendata.cern.ch/workflow.png)',
    ],
    [
      'single quotes',
      "<IMG SRC='/plot.png' ALT='Plot'>",
      '![Plot](https://opendata.cern.ch/plot.png)',
    ],
    [
      'unquoted attributes',
      '<img src=/plot.png alt=Plot>',
      '![Plot](https://opendata.cern.ch/plot.png)',
    ],
    ['no alt', '<img src="https://cds.cern.ch/plot.png"/>', '![](https://cds.cern.ch/plot.png)'],
    ['missing src', '<img alt="Plot">', 'Plot'],
    ['empty src', '<img src="" alt="Plot">', 'Plot'],
    ['no attributes', '<img>', ''],
    [
      'data-src before src',
      '<img data-src="/wrong" src="/right" alt="A">',
      '![A](https://opendata.cern.ch/right)',
    ],
    ['data-src alone', '<img data-src="/wrong" alt="A">', 'A'],
    [
      'quoted attribute contents',
      '<img title="src=/wrong > alt=wrong" src="/right" alt="A">',
      '![A](https://opendata.cern.ch/right)',
    ],
    [
      'first duplicate attribute',
      '<img src="/first" src="/second" alt="A">',
      '![A](https://opendata.cern.ch/first)',
    ],
    [
      'an image anchor',
      '<a href="/x"><img alt="a" src="/y"></a>',
      '![a](https://opendata.cern.ch/y) <https://opendata.cern.ch/x>',
    ],
    [
      'an image anchor ended by its cell',
      '<table><td><a href="/x"><img alt="a" src="/y"><td>b</table>',
      '![a](https://opendata.cern.ch/y) <https://opendata.cern.ch/x> | b',
    ],
    [
      'entities decoded once',
      '<img alt="&amp;lt;b&amp;gt; &lt;c&gt;" src="/x?a=1&amp;amp;b=2">',
      '![&lt;b&gt; <c>](https://opendata.cern.ch/x?a=1&amp;b=2)',
    ],
    [
      'URL delimiters and controls',
      '<img src="/a&#91;b&#93; (c)&lt;d&gt;&#10;e&#0;f&#x202e;" alt="A">',
      '![A](https://opendata.cern.ch/a%5Bb%5D%20%28c%29%3Cd%3E%0Ae&#0;f%E2%80%AE)',
    ],
    [
      'alt delimiters and breaks',
      '<img src="/x" alt="a&#92;&#91;b&#93;&#10;c&#13;d&#x2028;e">',
      '![a\\\\\\[b\\]\\nc\\rd\\u2028e](https://opendata.cern.ch/x)',
    ],
  ])('preserves an image reference with %s', (_shape, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it('keeps image references inert inside adaptive fences and inline slots', () => {
    const html = '<img src="/x" alt="``` | [a]">';
    expect(fenceHtml(html)).toBe('````\n![``` | \\[a\\]](https://opendata.cern.ch/x)\n````');
    expect(inline(htmlToText('<img src="/x" alt="a">'))).toBe(
      '!\\[a\\](https://opendata.cern.ch/x)',
    );
  });

  it.each([
    ['an unclosed tag', '<img alt="tail', '<img alt="tail'],
    ['an unclosed quote after a tag end', '<img alt="a>tail', 'tail'],
    [
      'a literal backslash before a closing quote',
      '<img alt="a\\" src=/x>',
      '![a\\\\](https://opendata.cern.ch/x)',
    ],
    [
      'quotes and tag delimiters inside a quoted alt',
      `<img alt='a " > b' src='/x'>`,
      '![a " > b](https://opendata.cern.ch/x)',
    ],
    [
      'a control-bearing source',
      '<img src="/a\u0000b&#1;c">',
      '![](https://opendata.cern.ch/a%00b%01c)',
    ],
    ['a different element name', '<imagination src=/x>', ''],
  ])('keeps image parsing bounded and literal for %s', (_shape, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it.each<[string, (length: number) => string]>([
    ['digits in an image attribute', (n) => `<img src="/${'1'.repeat(n)}">`],
    ['image openers', (n) => '<img '.repeat(n / 5)],
    ['nested image openers', (n) => `${'<img '.repeat(n / 10)}${'>'.repeat(n / 2)}`],
    ['unclosed quoted attributes', (n) => `<img alt="${'x > '.repeat(n / 4)}`],
    ['quote-heavy attributes', (n) => `<img ${'a="b" '.repeat(n / 6)}src=/x>`],
    ['a line ending in a break', (n) => `<img alt="${'§1 x'.repeat(n / 4)}\ny" src=/x>`],
    ['breaks throughout', (n) => `<img alt="${'  \r\n'.repeat(n / 4)}" src=/x>`],
  ])('converts %s with bounded image scanning', (shape, make) => {
    expectLinearGrowth(make, htmlToText, {
      maxMs: 250,
      to: shape === 'digits in an image attribute' ? 320_000 : 40_000,
    });
  });

  it('drops tags and turns block elements and breaks into line breaks', () => {
    expect(htmlToText('<p>one</p><p>two<br>three<br/>four</p>')).toBe('one\n\ntwo\nthree\nfour');
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('a\n\nb');
    expect(htmlToText('<h2>Title</h2><blockquote>quoted</blockquote>')).toBe('Title\n\nquoted');
    expect(htmlToText('<span>in</span><b>line</b>')).toBe('inline');
  });

  it('keeps the label of an anchor', () => {
    expect(htmlToText('<a href="/record/3521">menu</a> and <a href="">nothing</a>')).toContain(
      'menu',
    );
    expect(htmlToText('<a href="">nothing</a>')).toBe('nothing');
    expect(htmlToText('<a class="x" href="https://x.test/p"><em>deep</em></a>')).toContain('deep');
  });

  it('renders anchors as text followed by the printable URL', () => {
    expect(htmlToText('<a href="/record/3521">menu</a>')).toBe(
      `menu <${PORTAL_ORIGIN}/record/3521>`,
    );
    expect(htmlToText(`<a href='https://x.test/a b'>site</a>`)).toBe('site <https://x.test/a%20b>');
    expect(htmlToText('<a href=https://x.test/p>bare</a>')).toBe('bare <https://x.test/p>');
    expect(htmlToText('<a href="https://x.test/p">https://x.test/p</a>')).toBe(
      '<https://x.test/p>',
    );
    expect(htmlToText('<a href="https://x.test/?a=1&amp;b=2">A &amp; B</a>')).toBe(
      'A & B <https://x.test/?a=1&b=2>',
    );
  });

  it('removes scripts, styles and comments with their content', () => {
    expect(
      htmlToText('<p>a</p><script>alert(1)</script><style>p{x:y}</style><!-- hidden --><p>b</p>'),
    ).toBe('a\n\nb');
  });

  it('keeps escaped markup as literal text', () => {
    expect(htmlToText('<p>use &lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe(
      'use <script>alert(1)</script>',
    );
  });

  it('collapses whitespace and runs of blank lines', () => {
    expect(htmlToText('  <p>a   b\t c</p>\n\n\n<p></p><p></p><p></p><p>d</p>  ')).toBe(
      'a b c\n\nd',
    );
  });

  it('returns an empty string for empty or tag-only input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<p></p><br>')).toBe('');
  });

  it('renders a trigger abstract with one paragraph per line and the double space collapsed', () => {
    const lines = htmlToText(TRIGGER_ABSTRACT_HTML)
      .split('\n')
      .filter((line) => line !== '');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      `first seen online on run 160404 (/cdaq/physics/Run2011/5e32/v4.2/HLT/V2 <${PORTAL_ORIGIN}/record/3521>)`,
    );
    expect(lines[1]).toBe(
      'last seen online on run 178380 (/cdaq/physics/Run2011/5e32/v4.2/HLT/V2)',
    );
    expect(lines[2]).toBe('V1: (runs 160404 - 163261) seeded by: L1_SingleMu12');
    expect(lines[3]).toBe(
      `See also the full list of triggers for CMS 2011 open data: list <${PORTAL_ORIGIN}/record/3000>`,
    );
  });

  it('keeps an unclosed comment, script or anchor as the tag strip leaves it', () => {
    expect(htmlToText('a<!-- b')).toBe('a<!-- b');
    expect(htmlToText('a<script>b')).toBe('ab');
    expect(htmlToText('<a href="/x">open')).toBe('open');
    expect(htmlToText('a < b')).toBe('a < b');
  });

  it('reads a quoted href past a > inside the quotes', () => {
    expect(htmlToText('<a href="/x?a>b">t</a>')).toBe(`t <${PORTAL_ORIGIN}/x?a%3Eb>`);
  });

  it.each([
    ['a tag pair', 'a<b>c</b>d', 'acd'],
    ['a letter after < with a > later', 'a<b>c', 'ac'],
    ['a tag with attributes', '<span class="x" id=y>t</span>', 't'],
    ['self-closing breaks', 'a<br/>b<br />c', 'a\nb\nc'],
    ['a comment', 'a<!-- note -->b', 'ab'],
    ['a doctype and a processing instruction', '<!DOCTYPE html><?xml version="1.0"?>t', 't'],
    ['an end tag with no name', 'a</>b', 'ab'],
    ['an anchor', 'see <a href="/record/1">one</a>.', `see one <${PORTAL_ORIGIN}/record/1>.`],
    ['an anchor whose label holds a tag', '<a href="/x"><i>it</i></a>', `it <${PORTAL_ORIGIN}/x>`],
    ['an unclosed tag', 'a<b c', 'a<b c'],
    ['an unclosed end tag', 'a</b c', 'a</b c'],
    ['a < at the end', 'a<', 'a<'],
  ])('renders %s as it always has', (_shape, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it.each([
    [
      '5202',
      METHODOLOGY_5202_HTML,
      'An event was selected if there were two muons in the event, both with |eta| < 2.4, at least one muon was a global muon, the invariant mass of the two muons was > 0.3 GeV and < 300 GeV, and they have opposite-sign charge.',
    ],
    [
      '5208',
      METHODOLOGY_5208_HTML,
      'An event was selected if there were two muons in the event with pT > 20 GeV and |eta| < 2.1 and the invariant mass of the two muons was > 60 GeV and < 120 GeV.',
    ],
  ])('renders every selection cut of record %s in full', (_recid, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it.each([
    ['a space', 'x < 2 and y > 1', 'x < 2 and y > 1'],
    ['a digit', 'a<2>b', 'a<2>b'],
    ['an equals sign', 'x <= 5 and y >= 3', 'x <= 5 and y >= 3'],
    ['another <', 'a << b >> c', 'a << b >> c'],
    ['a non-ASCII letter', 'a <é> b', 'a <é> b'],
    ['a space, before a real tag', '|eta| < 2.4 <b>and</b> more', '|eta| < 2.4 and more'],
  ])('keeps a < followed by %s as text', (_follower, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it('keeps a bare < in an anchor label', () => {
    expect(htmlToText('<a href="/x">pT < 20 GeV, mass > 5 GeV</a>')).toBe(
      `pT < 20 GeV, mass > 5 GeV <${PORTAL_ORIGIN}/x>`,
    );
  });

  it.each([
    [
      'an inline tag in an anchor label',
      '<a href="/x">mass <<b>GeV</b></a> and m > 3',
      `mass <GeV <${PORTAL_ORIGIN}/x> and m > 3`,
    ],
    ['a comment', 'x <<!-- c -->y > z', 'x <y > z'],
    ['a script', 'x <<script>s</script>y > z', 'x <y > z'],
    ['a style element', 'x <<style>p{}</style>y > z', 'x <y > z'],
    ['an anchor', 'x <<a href="/y">z</a> > w', `x <z <${PORTAL_ORIGIN}/y> > w`],
  ])('keeps a bare < as text once %s after it is gone', (_removed, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it.each<[string, (count: number) => string, (count: number) => string]>([
    ['20,000 unclosed anchors', (n) => '<a href=x>'.repeat(n), () => ''],
    [
      'an anchor whose bare href and text run 20,000 characters each',
      (n) => `<a href=${'x'.repeat(n)}>${'y'.repeat(n)}`,
      (n) => 'y'.repeat(n),
    ],
    ['20,000 unclosed comments', (n) => '<!--'.repeat(n), (n) => '<!--'.repeat(n)],
    ['20,000 unclosed scripts', (n) => '<script>'.repeat(n), () => ''],
    ['20,000 block tags with no closing >', (n) => '<p'.repeat(n), (n) => '<p'.repeat(n)],
    ['20,000 tag openers with no closing >', (n) => '<'.repeat(n), (n) => '<'.repeat(n)],
  ])('converts %s in linear time', (_shape, make, expected) => {
    expect(htmlToText(make(20_000))).toBe(expected(20_000));
    expectLinearTime(make, htmlToText, { sizes: [1_250, 5_000, 20_000], maxMs: 250 });
  });

  it.each<[string, (length: number) => string]>([
    ['a run of bare <', (n) => '<'.repeat(n)],
    ['< followed by a space', (n) => '< '.repeat(n / 2)],
    ['a bare < before an inline tag', (n) => 'm <<b>x</b> '.repeat(n / 12)],
    ['a bare < before a comment', (n) => 'x <<!-- c -->y '.repeat(n / 15)],
    ['unclosed block openers', (n) => '<p'.repeat(n / 2)],
  ])('converts %s in time linear in its length', (_shape, make) => {
    expectLinearTime(make, htmlToText, { maxMs: 200 });
  });
});

describe('htmlToText tables', () => {
  const portal = (path: string) => `<${PORTAL_ORIGIN}${path}>`;

  it('reads an unclosed anchor outside a table to the next </a>, as it always has', () => {
    expect(htmlToText('<p><a href="/x">open</p><p>more <a href="/y">two</a></p>')).toBe(
      `openmore two ${portal('/x')}`,
    );
  });

  it('splits lines at a decoded line break, as it always has', () => {
    expect(htmlToText('<p>a&#10;  b | c</p>')).toBe('a\nb | c');
  });

  it("renders record 1701's header and each row as one line of cells joined by |", () => {
    expect(htmlToText(HLT_MENU_TABLE_1701_HTML).split('\n')).toEqual([
      'The list of trigger configuration files for the CMS 2012 collision data (Run201A, Run2012B, Run2012C and Run2012D):',
      '',
      'Run number | Software version | Trigger configuration',
      '',
      '190456 - 190465 | CMSSW_5_2_3_patch1 <https://github.com/cms-sw/cmssw-cvs/tree/CMSSW_5_2_3_patch1> | ' +
        `/cdaq/physics/Run2012/5e33/v4.4/HLT/V5 ${portal('/record/6123')}`,
      '',
      '190482 - 190539 | CMSSW_5_2_3_patch1 <https://github.com/cms-sw/cmssw-cvs/tree/CMSSW_5_2_3_patch1> | ' +
        `/cdaq/physics/Run2012/5e33/v4.4/HLT/V7 ${portal('/record/6134')}`,
    ]);
  });

  it("renders every menu URL of record 3700, whose anchors end at their cell's </td>", () => {
    const rows = [
      ['157942', '3701', 'v0', '0x101e'],
      ['161205', '3702', 'v1', '0x101f'],
      ['161568', '3703', 'v2', '0x1020'],
      ['165897', '3704', 'v3', '0x1021'],
      ['170065', '3705', 'v4', '0x1022'],
      ['173212', '3706', 'v5', '0x1023'],
      ['176725', '3707', 'v6', '0x1024'],
    ].map(
      ([run, recid, version, key]) =>
        `${run} | L1Menu_Collisions2011_${version}_L1T_Scales_20101224_Imp0_${key} ${portal(`/record/${recid}`)}`,
    );
    expect(htmlToText(L1_MENU_TABLE_3700_HTML)).toBe(
      ['Starting from run | L1 trigger information', ...rows].join('\n\n'),
    );
  });

  it("renders record 12220's four-column table, cells spaced and wrapped in <p>", () => {
    const html = variablesHit12220.metadata.abstract?.description ?? '';
    const lines = htmlToText(html).split('\n');
    expect(lines.slice(-9)).toEqual([
      'Data set name | Description | Number of events | Number of files',
      '',
      'QCD300to600 | QCD, flat pT hat spectrum, 300 < pT hat < 600 GeV | 1497600 | 2496',
      '',
      'QCD400to600 | QCD, flat pT hat spectrum, 400 < pT hat < 600 GeV | 1989000 | 3315',
      '',
      'QCD600to3000 | QCD, flat pT hat spectrum, 600 < pT hat < 3000 GeV | 2974800 | 4959',
      '',
      'ttbar | ttbar, fully hadronic decays, pT of the top/antitop greater than 400 GeV | 2969109 | 4055',
    ]);
  });

  it('ends an anchor at its own cell, so a later cell keeps its text and anchors', () => {
    expect(
      htmlToText(
        '<table><tr><td><a href="/record/1">one</td><td>two <a href="/record/2">three</a></td></tr></table>',
      ),
    ).toBe(`one ${portal('/record/1')} | two three ${portal('/record/2')}`);
  });

  it.each([
    ['the next <td', '<table><tr><td><a href="/x">a<td>b</table>', `a ${portal('/x')} | b`],
    ['the next <th', '<table><tr><th><a href="/x">a<th>b</table>', `a ${portal('/x')} | b`],
    ['the next <tr', '<table><tr><td><a href="/x">a<tr><td>b</table>', `a ${portal('/x')}\nb`],
    ['</td>', '<table><tr><td><a href="/x">a</td>b</table>', `a ${portal('/x')}b`],
    ['</th>', '<table><tr><th><a href="/x">a</th>b</table>', `a ${portal('/x')}b`],
    ['</tr>', '<table><tr><td><a href="/x">a</tr>b</table>', `a ${portal('/x')}\nb`],
    ['</table>', '<table><tr><td><a href="/x">a</table>b', `a ${portal('/x')}\nb`],
  ])('ends an unclosed anchor at %s', (_tag, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it('keeps an empty cell in its place', () => {
    expect(htmlToText('<table><tr><td></td><td>b</td><td> </td><td>d</td></tr></table>')).toBe(
      '| b | | d',
    );
  });

  it("keeps a row's text before its first cell as a cell, unless it is only tags and whitespace", () => {
    expect(htmlToText('<table><tr>Run<td>a</td><td>b</td></tr></table>')).toBe('Run | a | b');
    expect(htmlToText('<table><tr><b> </b><td>a</td><td>b</td></tr></table>')).toBe('a | b');
  });

  it.each<[string, (length: number) => string]>([
    ['unclosed anchors', (n) => '<a href=x>'.repeat(n / 10)],
    ['anchors each ended by </td>', (n) => '<a href=x>y</td>'.repeat(n / 16)],
    ['anchors each ended by <td', (n) => '<a href=x>y<td>'.repeat(n / 15)],
    ['one anchor before a run of </td>', (n) => `<a href=x>${'y</td>'.repeat(n / 6)}`],
    ['cell openers with no >', (n) => '<td'.repeat(n / 3)],
    ['cell openers', (n) => '<td>x'.repeat(n / 5)],
    ['nested openers before a </td>', (n) => `${'<a'.repeat(n / 4)}${'>'.repeat(n / 2)}</td>`],
    [
      'nested anchors before a </td>',
      (n) => `${'<a href=x'.repeat(n / 18)}${'>'.repeat(n / 2)}</td>`,
    ],
    ['an unclosed quoted href before a </td>', (n) => `<a href="${'x>y'.repeat(n / 3)}</td>`],
    ['quoted hrefs each ended by </tr>', (n) => '<a href="u">t</tr>'.repeat(n / 18)],
    ['cell openers interleaved with line breaks', (n) => '<td>x<br>'.repeat(n / 9)],
    ['a row of cells before a line break', (n) => `${'<td>x'.repeat(n / 5)}<br>y`],
  ])('converts %s in time linear in its length', (_shape, make) => {
    expectLinearGrowth(make, htmlToText, { maxMs: 250 });
  });
});

describe('stripTags', () => {
  it('opens a tag only at a < followed by an ASCII letter, /, ! or ?', () => {
    expect(stripTags('a<b>c</b><!x><?y>d')).toBe('acd');
    expect(stripTags('|eta| < 2.4, mass > 0.3 and < 300')).toBe(
      '|eta| < 2.4, mass > 0.3 and < 300',
    );
    expect(stripTags('a<1>b<=c>d<<e>')).toBe('a<1>b<=c>d<');
  });

  it.each<[string, (length: number) => string]>([
    ['a run of < with no closer', (n) => '<'.repeat(n)],
    ['< followed by a space', (n) => '< '.repeat(n / 2)],
    ['unclosed openers', (n) => '<a'.repeat(n / 2)],
    ['nested openers, <a<a<a…>>>', (n) => `${'<a'.repeat(n / 4)}${'>'.repeat(n / 2)}`],
    ['closed tags between bare < and >', (n) => '<b>x < y > z'.repeat(n / 12)],
  ])('strips %s in time linear in its length', (_shape, make) => {
    expectLinearTime(make, stripTags, { maxMs: 50 });
  });
});

describe('fence', () => {
  it('uses three backticks for plain text', () => {
    expect(fence('plain')).toBe('```\nplain\n```');
    expect(fence('')).toBe('```\n\n```');
  });

  it('is longer than the longest backtick run inside the text', () => {
    expect(fence('a ``` b')).toBe('````\na ``` b\n````');
    expect(fence('`` and ````` and `')).toBe('``````\n`` and ````` and `\n``````');
  });

  it('cannot be closed by the fenced text, whatever it contains', () => {
    for (const text of ['```', '````', '```\n``` injected\n```', '`'.repeat(40), 'a`b``c```d']) {
      const fenced = fence(text);
      const marker = /^`+/.exec(fenced)?.[0] ?? '';
      const longestInside = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
      expect(marker.length).toBeGreaterThan(longestInside);
      expect(marker.length).toBeGreaterThanOrEqual(3);
      expect(fenced.endsWith(`\n${marker}`)).toBe(true);
    }
  });

  it('fenceHtml fences the converted text', () => {
    expect(fenceHtml('<p>a</p><p>b ``` c</p>')).toBe('````\na\n\nb ``` c\n````');
  });
});

describe('inline', () => {
  it('flattens line breaks and tabs to a space', () => {
    expect(inline('a\nb\r\nc\td\u0085e f g')).toBe('a b  c d e f g');
  });

  it('strips C0, DEL and C1 controls and bidi controls', () => {
    expect(inline('a\u0000b\u001Bc\u007Fd\u009Fe')).toBe('abcde');
    expect(inline('a؜b‎c‏d‪e‮f⁦g⁩h')).toBe('abcdefgh');
  });

  it('escapes the backslash before brackets and pipes, and entity-encodes angle brackets', () => {
    expect(inline('[a](b) | c')).toBe('\\[a\\](b) \\| c');
    expect(inline('\\[x')).toBe('\\\\\\[x');
    expect(inline('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it('keeps an upstream value in one line of one table cell', () => {
    const hostile = 'cell | next\n| row |\n# Heading\n[link](https://evil.example)\r\n```';
    const out = inline(hostile);
    expect(out).not.toMatch(/[\n\r]/);
    expect(out).not.toMatch(/(?<!\\)\|/);
    expect(out).not.toMatch(/(?<!\\)\[/);
  });

  it('trims the result', () => {
    expect(inline('  x \n')).toBe('x');
  });

  it('renders absence as Not available and keeps zero', () => {
    expect(inlineOrNA(undefined)).toBe(NOT_AVAILABLE);
    expect(inlineOrNA(NOT_AVAILABLE)).toBe(NOT_AVAILABLE);
    expect(inlineOrNA(0)).toBe('0');
    expect(inlineOrNA(1234)).toBe('1234');
    expect(inlineOrNA('a|b\nc')).toBe('a\\|b c');
  });
});

describe('inlineSpelling', () => {
  it('renders a value without edge whitespace or a comma exactly as inline does', () => {
    for (const value of ['Heavy-Ion Physics', 'a|b', '<b>', 'x\ny', '']) {
      expect(inlineSpelling(value), value).toBe(inline(value));
    }
  });

  it('quotes a value with leading or trailing whitespace and keeps that whitespace', () => {
    expect(inlineSpelling(' Heavy-Ion Physics')).toBe('" Heavy-Ion Physics"');
    expect(inlineSpelling('MagUp  ')).toBe('"MagUp  "');
    expect(inlineSpelling(' a ')).toBe('" a "');
  });

  it('quotes a value holding a comma, so a list of values does not read it as two', () => {
    expect(inlineSpelling('13TeV, 13.6TeV')).toBe('"13TeV, 13.6TeV"');
    expect(inlineSpelling('Heavy Fermions, Heavy Righ-Handed Neutrinos')).toBe(
      '"Heavy Fermions, Heavy Righ-Handed Neutrinos"',
    );
    expect(inlineSpelling(' a,b')).toBe('" a,b"');
  });

  it('neutralizes a quoted value like an inline slot', () => {
    expect(inlineSpelling('\n[x](https://evil.example) |‮')).toBe(
      '" \\[x\\](https://evil.example) \\|"',
    );
  });
});

describe('noticeValue', () => {
  it('neutralizes a value like an inline slot: brackets, pipes and backslashes escaped, angle brackets as entities', () => {
    expect(noticeValue('[docs](https://evil.example) <img src=y> | \\')).toBe(
      '\\[docs\\](https://evil.example) &lt;img src=y&gt; \\| \\\\',
    );
  });

  it('flattens line breaks and strips control and bidi characters', () => {
    expect(noticeValue('a\nb\u{2028}c\u{0}d\u{202E}e')).toBe('a b cde');
  });

  it('leaves an ordinary slug or recid unchanged', () => {
    expect(noticeValue('cms-guide-docker')).toBe('cms-guide-docker');
    expect(noticeValue('1002')).toBe('1002');
  });

  it('cuts a value at 200 characters and marks the cut', () => {
    expect(noticeValue('x'.repeat(200))).toBe('x'.repeat(200));
    expect(noticeValue('x'.repeat(201))).toBe(`${'x'.repeat(200)}…`);
  });

  it('never splits a surrogate pair at the cut', () => {
    expect(noticeValue(`${'x'.repeat(199)}\u{1F600}tail`)).toBe(`${'x'.repeat(199)}…`);
  });

  it('cuts before escaping, so an escape is never split', () => {
    expect(noticeValue('<'.repeat(250))).toBe(`${'&lt;'.repeat(200)}…`);
  });
});

describe('noticeList', () => {
  it('joins neutralized values, or says Not available when there are none', () => {
    expect(noticeList(['Run2012A', '<b>'])).toBe('Run2012A, &lt;b&gt;');
    expect(noticeList([])).toBe(NOT_AVAILABLE);
    expect(noticeList(undefined)).toBe(NOT_AVAILABLE);
  });
});

describe('oneLine', () => {
  it('collapses each whitespace run holding a line break to one space and leaves other runs', () => {
    expect(oneLine('a \n b\r\n\tc  d\u{2028}e\u{85}f\u{2029} g')).toBe('a b c  d e f g');
    expect(oneLine('no breaks  here')).toBe('no breaks  here');
  });

  it.each<[string, (count: number) => string, (count: number) => string]>([
    ['40,000 spaces', (n) => `a${' '.repeat(n)}b`, (n) => `a${' '.repeat(n)}b`],
    ['40,000 spaces before a line break', (n) => `a${' '.repeat(n)}\nb`, () => 'a b'],
  ])('flattens %s in linear time', (_shape, make, expected) => {
    expect(oneLine(make(40_000))).toBe(expected(40_000));
    expectLinearTime(make, oneLine, { sizes: [2_500, 10_000, 40_000], maxMs: 250 });
  });
});

describe('capText', () => {
  it('returns text within the cap unchanged', () => {
    expect(capText('abc', 3)).toEqual({ text: 'abc', length: 3, truncated: false });
    expect(capText('', 3)).toEqual({ text: '', length: 0, truncated: false });
  });

  it('cuts at the cap and keeps the original length', () => {
    expect(capText('abcdef', 4)).toEqual({ text: 'abcd', length: 6, truncated: true });
  });

  it('never splits a surrogate pair at the cut', () => {
    const text = `ab\u{1F600}cd`;
    const capped = capText(text, 3);
    expect(capped).toEqual({ text: 'ab', length: text.length, truncated: true });
    expect(capText(text, 4).text).toBe('ab\u{1F600}');
  });
});

describe('sliceText', () => {
  it('returns up to maxUnits code units from the offset, with where it starts and ends', () => {
    expect(sliceText('abcdef', 0, 10)).toEqual({ text: 'abcdef', start: 0, end: 6 });
    expect(sliceText('abcdef', 2, 3)).toEqual({ text: 'cde', start: 2, end: 5 });
    expect(sliceText('abcdef', 4, 3)).toEqual({ text: 'ef', start: 4, end: 6 });
  });

  it('ends before a surrogate pair the cap would split', () => {
    expect(sliceText('ab\u{1F600}cd', 0, 3)).toEqual({ text: 'ab', start: 0, end: 2 });
    expect(sliceText('ab\u{1F600}cd', 0, 4)).toEqual({ text: 'ab\u{1F600}', start: 0, end: 4 });
  });

  it('starts an offset on the second half of a pair at its first half', () => {
    expect(sliceText('ab\u{1F600}cd', 3, 3)).toEqual({ text: '\u{1F600}c', start: 2, end: 5 });
    expect(sliceText('ab\u{1F600}cd', 2, 3)).toEqual({ text: '\u{1F600}c', start: 2, end: 5 });
  });

  it('rebuilds the text exactly when each slice starts where the last one ended', () => {
    const text = `abcd\u{1F600}efgh\u{1F601}\u{1F602}ij\u{1F603}`;
    const slices: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      const slice = sliceText(text, offset, 5);
      expect(slice.start).toBe(offset);
      expect(slice.end).toBeGreaterThan(offset);
      expect(slice.text.length).toBeLessThanOrEqual(5);
      expect(Number.isNaN(slice.text.codePointAt(0))).toBe(false);
      const last = slice.text.charCodeAt(slice.text.length - 1);
      if (slice.end < text.length) expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      slices.push(slice.text);
      offset = slice.end;
    }
    expect(slices.join('')).toBe(text);
    expect(slices.length).toBeGreaterThan(3);
  });
});

describe('countOf', () => {
  it('uses the singular for exactly one and the plural otherwise', () => {
    expect(countOf(1, 'file')).toBe('1 file');
    expect(countOf(0, 'file')).toBe('0 files');
    expect(countOf(2, 'file')).toBe('2 files');
    expect(countOf(3504276797, 'byte')).toBe('3504276797 bytes');
  });

  it('takes an irregular plural', () => {
    expect(countOf(1, 'match', 'matches')).toBe('1 match');
    expect(countOf(4, 'match', 'matches')).toBe('4 matches');
    expect(countOf(1, 'glossary entry', 'glossary entries')).toBe('1 glossary entry');
  });
});
