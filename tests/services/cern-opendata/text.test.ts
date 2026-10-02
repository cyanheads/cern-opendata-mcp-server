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
  METHODOLOGY_5202_HTML,
  METHODOLOGY_5208_HTML,
  TRIGGER_ABSTRACT_HTML,
} from '../../fixtures/cern-opendata-upstream.js';
import { expectLinearTime } from '../../fixtures/cpu-time.js';

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
