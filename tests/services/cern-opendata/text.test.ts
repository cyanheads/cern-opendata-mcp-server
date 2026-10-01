/**
 * @fileoverview Tests for upstream-text rendering helpers: entity decoding, URL
 * printing, HTML to text, fences, inline neutralization, character caps and
 * counts that agree with their noun.
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
  NOT_AVAILABLE,
  PORTAL_ORIGIN,
  printUrl,
} from '@/services/cern-opendata/text.js';
import { TRIGGER_ABSTRACT_HTML } from '../../fixtures/cern-opendata-upstream.js';

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
