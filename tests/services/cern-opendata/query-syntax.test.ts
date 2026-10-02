/**
 * @fileoverview Tests for the search query delimiter scan: what it reports for
 * unbalanced parentheses, range brackets, double quotes and a trailing
 * backslash, what it lets through, and that it reads the query in one pass.
 * @module tests/services/cern-opendata/query-syntax.test
 */

import { describe, expect, it } from 'vitest';
import { findUnbalancedDelimiter } from '@/services/cern-opendata/query-syntax.js';
import { expectLinearTime } from '../../fixtures/cpu-time.js';

describe('findUnbalancedDelimiter', () => {
  it.each([
    ['(foo', { character: '(', position: 1, problem: 'unclosed' }],
    ['a (b (c) d', { character: '(', position: 3, problem: 'unclosed' }],
    ['(a (b) c', { character: '(', position: 1, problem: 'unclosed' }],
    ['foo)', { character: ')', position: 4, problem: 'unopened' }],
    ['(foo]', { character: ']', position: 5, problem: 'unopened' }],
    ['[2010 TO 2012)', { character: '[', position: 1, problem: 'unclosed' }],
    ['(a [b TO c)]', { character: '(', position: 1, problem: 'unclosed' }],
    ['[a TO b] )', { character: ')', position: 10, problem: 'unopened' }],
    ['title:["a TO b] x"', { character: '[', position: 7, problem: 'unclosed' }],
    ['[a TO "b] c"', { character: '[', position: 1, problem: 'unclosed' }],
    ['{a TO b', { character: '{', position: 1, problem: 'unclosed' }],
    ['"foo', { character: '"', position: 1, problem: 'unclosed' }],
    ['a "b" "c', { character: '"', position: 7, problem: 'unclosed' }],
    ['"foo\\"', { character: '"', position: 1, problem: 'unclosed' }],
    ['foo\\', { character: '\\', position: 4, problem: 'dangling_escape' }],
    ['"foo\\', { character: '\\', position: 5, problem: 'dangling_escape' }],
    ['\\\\\\', { character: '\\', position: 3, problem: 'dangling_escape' }],
  ])('reports %s', (query, expected) => {
    expect(findUnbalancedDelimiter(query)).toEqual(expected);
  });

  it.each([
    '',
    'muon',
    '((a) (b (c)))',
    '[a TO b} {c TO d]',
    '(date_created:[2010 TO 2012] OR title:"x (y")',
    '"a ) ] }"',
    '\\(\\)\\[\\]\\{\\}\\"',
    '"\\\\"',
    "it's",
    'title:[A( TO B]',
    'title:[a TO b)]',
    'title:["a TO b]',
    'title:[a{ TO b]',
    'title:[a[ TO b]',
    'title:["a]" TO "z"]',
    'title:[A" TO B] "muon"',
    'title:[a"b TO c"d] "e"',
  ])('lets %s through', (query) => {
    expect(findUnbalancedDelimiter(query)).toBeUndefined();
  });

  it.each<[string, (length: number) => string]>([
    ['a run of (', (n) => '('.repeat(n)],
    ['a run of " with an odd count', (n) => '"'.repeat(n - 1)],
    ['a run of \\ with an odd count', (n) => '\\'.repeat(n - 1)],
    ['a run of [', (n) => '['.repeat(n)],
    ['quoted bounds inside a range with no closer', (n) => `[${' "x'.repeat(n / 3)}`],
    ['nested openers closed in order', (n) => `${'(['.repeat(n / 4)}${'])'.repeat(n / 4)}`],
  ])('scans %s in time linear in its length', (_shape, make) => {
    expectLinearTime(make, findUnbalancedDelimiter, { maxMs: 50 });
  });
});
