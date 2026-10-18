/**
 * @fileoverview Tests for the guide-markdown line scans: fenced code lines,
 * link reference definitions (first per label, CommonMark label matching) and
 * the labels bracketed spans name, each linear in its input.
 * @module tests/services/cern-opendata/guide-markdown.test
 */

import { describe, expect, it } from 'vitest';
import {
  bracketLabels,
  fencedLines,
  referenceDefinitions,
} from '@/services/cern-opendata/guide-markdown.js';
import { expectLinearGrowth } from '../../fixtures/cpu-time.js';

const definitionsOf = (body: string) => {
  const lines = body.split(/\r?\n/);
  return referenceDefinitions(lines, fencedLines(lines));
};

describe('fencedLines', () => {
  it('marks the fence lines and everything between them', () => {
    expect(fencedLines(['a', '```js', 'x', '```', 'b'])).toEqual([false, true, true, true, false]);
  });

  it('closes a fence only with a run of the same character at least as long', () => {
    expect(fencedLines(['~~~~', '~~~', '```', '~~~~~', 'b'])).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('keeps a fence open to the end when nothing closes it', () => {
    expect(fencedLines(['```', 'a', 'b'])).toEqual([true, true, true]);
  });
});

describe('referenceDefinitions', () => {
  it('reads a line opening with [label]: after at most three spaces, with its normalized label', () => {
    expect(
      definitionsOf('[installVB]: <https://x.test>\n   [b]: /b\n    [c]: /c\n\t[d]: /d'),
    ).toEqual([
      { label: 'INSTALLVB', line: 0 },
      { label: 'B', line: 1 },
    ]);
  });

  it('keeps the first definition of each label, matched case-folded with whitespace collapsed', () => {
    expect(
      definitionsOf('[Get  Started]: /one\n[get started]: /two\n[GET\tSTARTED]: /three'),
    ).toEqual([{ label: 'GET STARTED', line: 0 }]);
  });

  it('reads no definition inside fenced code', () => {
    expect(definitionsOf('```\n[a]: /fenced\n```\n[a]: /real')).toEqual([{ label: 'A', line: 3 }]);
  });

  it.each([
    ['an empty label', '[]: /x'],
    ['a blank label', '[  ]: /x'],
    ['a label holding a bracket', '[a[b]: /x'],
    ['a label with no colon after it', '[a] /x'],
    ['a label with no closing bracket', '[a: /x'],
    ['text before the bracket', 'x [a]: /x'],
  ])('reads no definition from %s', (_shape, line) => {
    expect(definitionsOf(line)).toEqual([]);
  });

  it('reads a label holding an escaped bracket', () => {
    expect(definitionsOf('[a\\]b]: /x')).toEqual([{ label: 'A\\]B', line: 0 }]);
  });

  it.each<[string, (length: number) => string]>([
    ['[ with no ]', (n) => `[${'a'.repeat(n - 1)}`],
    ['repeated [a]: lines', (n) => '[a]: x\n'.repeat(n / 7)],
    ['nested [[[[…]]]] lines', (n) => '[[[[]]]]:\n'.repeat(n / 10)],
    ['runs of [ interleaved with line breaks', (n) => '[[[[\n'.repeat(n / 5)],
    ['escapes with no ]', (n) => `[${'\\a'.repeat(n / 2)}`],
    [
      'uses followed by definitions',
      (n) => `${'[x][a] '.repeat(n / 14)}\n${'[a]: <u>\n'.repeat(n / 18)}`,
    ],
  ])('reads %s in time linear in its length', (_shape, make) => {
    expectLinearGrowth(make, definitionsOf, { maxMs: 250 });
  });
});

describe('bracketLabels', () => {
  it('names the full, collapsed and shortcut forms of a reference link', () => {
    for (const form of ['[x][INSTALLVB]', '[installVB][]', '[installVB]']) {
      expect(bracketLabels(`see ${form}.`).has('INSTALLVB'), form).toBe(true);
    }
  });

  it('names only the innermost span, normalizes whitespace across lines, and skips escaped brackets', () => {
    expect([...bracketLabels('[[a]] [Get\n  Started] \\[no\\] [x\\]y]')]).toEqual([
      'A',
      'GET STARTED',
      'X\\]Y',
    ]);
  });

  it('names a closed span with its edges trimmed, and nothing in text with no closed span', () => {
    expect([...bracketLabels('a [b c ] d')]).toEqual(['B C']);
    expect([...bracketLabels('a [b c')]).toEqual([]);
    expect([...bracketLabels('a ] b')]).toEqual([]);
  });

  it.each<[string, (length: number) => string]>([
    ['[ with no ]', (n) => '['.repeat(n)],
    ['repeated [a]: lines', (n) => '[a]: x\n'.repeat(n / 7)],
    ['nested [[[[…]]]]', (n) => `${'['.repeat(n / 2)}${']'.repeat(n / 2)}`],
    ['runs of [ interleaved with line breaks', (n) => '[[[[\n'.repeat(n / 5)],
    ['one span of whitespace', (n) => `[${' \n'.repeat(n / 2 - 1)}]`],
    [
      'uses followed by definitions',
      (n) => `${'[x][a] '.repeat(n / 14)}\n${'[a]: <u>\n'.repeat(n / 18)}`,
    ],
  ])('scans %s in time linear in its length', (_shape, make) => {
    expectLinearGrowth(make, bracketLabels, { maxMs: 250 });
  });
});
