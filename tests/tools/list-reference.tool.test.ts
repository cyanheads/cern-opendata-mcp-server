/**
 * @fileoverview Tests for cern_opendata_list_reference: input handling, output
 * per topic, the text twin of structuredContent, neutralization of inline slots,
 * and the absence of upstream calls.
 * @module tests/tools/list-reference.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { inline } from '@/services/cern-opendata/text.js';
import { REFERENCE_TABLES, REFERENCE_TOPICS } from '@/services/cern-opendata/vocabulary.js';

type Output = ReturnType<typeof listReference.handler> extends infer R ? Awaited<R> : never;

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected a text block.');
  return first.text;
}

function topicsOf(result: Awaited<ReturnType<typeof runToolContract>>): Output['topics'] {
  return (result.structuredContent as Output).topics;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cern_opendata_list_reference registration', () => {
  it('is registered, read-only, closed-world and idempotent', () => {
    expect(allToolDefinitions).toContain(listReference);
    expect(listReference.name).toBe('cern_opendata_list_reference');
    expect(listReference.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('declares no error contract and no enrichment (static, offline)', () => {
    expect(listReference.errors).toBeUndefined();
    expect((listReference as { enrichment?: unknown }).enrichment).toBeUndefined();
  });

  it('describes an entry value as a name, not an accepted spelling, in identifiers and licensing', () => {
    const json = JSON.stringify(z.toJSONSchema(listReference.output, { unrepresentable: 'any' }));
    expect(json).toContain(
      'A value or query form, spelled exactly as the tools accept it; in the identifiers and licensing topics, the name of an identifier form or a licensing rule.',
    );
    const valuesOf = (topic: string) =>
      REFERENCE_TABLES.find((table) => table.topic === topic)?.entries.map((entry) => entry.value);
    expect(valuesOf('identifiers')).toContain('file-index key');
    expect(valuesOf('licensing')).toContain('Per-record license');
  });
});

describe('cern_opendata_list_reference input', () => {
  it.each([[undefined], [''], ['   '], ['\t']])(
    'returns every topic when topic is %j',
    async (topic) => {
      const result = await runToolContract(listReference, topic === undefined ? {} : { topic });
      expect(result.isError).toBeFalsy();
      expect(topicsOf(result).map((table) => table.topic)).toEqual([...REFERENCE_TOPICS]);
    },
  );

  it.each(REFERENCE_TOPICS)('returns only the %s table', async (topic) => {
    const result = await runToolContract(listReference, { topic });
    expect(result.isError).toBeFalsy();
    const topics = topicsOf(result);
    expect(topics).toHaveLength(1);
    expect(topics[0]?.topic).toBe(topic);
    expect(topics[0]?.entries.length).toBeGreaterThan(0);
  });

  it.each([['bogus'], ['Experiments'], ['file types'], ['experiments,licensing']])(
    'rejects the unknown topic %j as invalid arguments',
    async (topic) => {
      const result = await runToolContract(listReference, { topic: topic as never });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    },
  );

  it('parses blank topics to unset at the schema', () => {
    expect(listReference.input.parse({ topic: ' ' })).toEqual({});
    expect(listReference.input.parse({ topic: 'licensing' })).toEqual({ topic: 'licensing' });
  });
});

describe('cern_opendata_list_reference output', () => {
  it('serves the verified table sizes', async () => {
    const result = await runToolContract(listReference, {});
    const counts = Object.fromEntries(
      topicsOf(result).map((table) => [table.topic, table.entries.length]),
    );
    expect(counts).toMatchObject({
      experiments: 9,
      collision_energies: 15,
      collision_types: 5,
      file_types: 65,
      categories: 39,
      lhcb: 25,
    });
  });

  it('serves the category and LHCb snapshots on both surfaces, dated', async () => {
    for (const [topic, sample] of [
      ['categories', '| Higgs Physics::Standard Model | Experiments: CMS, ATLAS. |'],
      ['lhcb', '| MagDown | magnet_polarity: data taken with'],
    ] as const) {
      const result = await runToolContract(listReference, { topic });
      const [table] = topicsOf(result);
      expect(table?.summary, topic).toMatch(/^Static snapshot dated 2026-10-01/);
      expect(textOf(result), topic).toContain(`## ${topic}`);
      expect(textOf(result), topic).toContain(sample);
    }
  });

  it('matches the vocabulary tables value for value', async () => {
    const result = await runToolContract(listReference, {});
    expect(topicsOf(result)).toEqual(
      REFERENCE_TABLES.map((table) => ({
        topic: table.topic,
        summary: table.summary,
        entries: table.entries.map((entry) => ({ value: entry.value, meaning: entry.meaning })),
      })),
    );
  });

  it('keeps 13TeV, 13.6TeV as one entry', async () => {
    const result = await runToolContract(listReference, { topic: 'collision_energies' });
    const values = topicsOf(result)[0]?.entries.map((entry) => entry.value);
    expect(values).toContain('13TeV, 13.6TeV');
  });

  it('says Glossary is not served and states the run-period snapshot', async () => {
    const types = await runToolContract(listReference, { topic: 'record_types' });
    expect(topicsOf(types)[0]?.summary).toMatch(/Glossary entries are not served/);
    const periods = await runToolContract(listReference, { topic: 'run_periods' });
    expect(topicsOf(periods)[0]?.summary).toContain('2026-10-01');
  });

  it('makes no upstream call and needs no initialized service', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ctx = createMockContext();
    const output = await listReference.handler(listReference.input.parse({}), ctx);
    expect(output.topics).toHaveLength(REFERENCE_TOPICS.length);
    await runToolContract(listReference, { topic: 'licensing' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the same data on every call', async () => {
    const first = await runToolContract(listReference, {});
    const second = await runToolContract(listReference, {});
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(textOf(second)).toBe(textOf(first));
  });
});

describe('cern_opendata_list_reference format', () => {
  it('renders every topic, summary, value and meaning that structuredContent carries', async () => {
    const result = await runToolContract(listReference, {});
    const text = textOf(result);
    for (const table of topicsOf(result)) {
      expect(text, table.topic).toContain(`## ${inline(table.topic)}`);
      expect(text, table.topic).toContain(inline(table.summary));
      for (const entry of table.entries) {
        expect(text, `${table.topic}: ${entry.value}`).toContain(
          `| ${inline(entry.value)} | ${inline(entry.meaning)} |`,
        );
      }
    }
  });

  it('renders one table row per entry and one table per topic', async () => {
    const result = await runToolContract(listReference, {});
    const lines = textOf(result).split('\n');
    const rows = lines.filter((line) => line.startsWith('| ') && !line.startsWith('| Value |'));
    const entryCount = topicsOf(result).reduce((total, table) => total + table.entries.length, 0);
    expect(rows).toHaveLength(entryCount);
    expect(lines.filter((line) => line === '| Value | Meaning |')).toHaveLength(
      REFERENCE_TOPICS.length,
    );
  });

  it('renders a single topic by itself', async () => {
    const result = await runToolContract(listReference, { topic: 'availability' });
    const text = textOf(result);
    expect(text.startsWith('## availability')).toBe(true);
    expect(text).not.toContain('## experiments');
    expect(text).toContain('| on demand |');
  });

  it('escapes the characters the tables would misread in real entries', async () => {
    const result = await runToolContract(listReference, { topic: 'query_syntax' });
    const text = textOf(result);
    expect(text).toContain('distribution.number_files:&gt;10000');
    expect(text).toContain('HLT_IsoMu*');
  });

  it('keeps CR/LF, pipes and markup in upstream-shaped text out of the table structure', () => {
    const blocks = listReference.format?.({
      topics: [
        {
          topic: 'experiments',
          summary: 'Summary line one\nline two\r\n# Not a heading',
          entries: [
            { value: 'A | B', meaning: 'first\nsecond | third\r\n[link](https://evil.example)' },
            { value: '<b>x</b>', meaning: 'tab\there ‮bidi\u0000' },
          ],
        },
      ],
    });
    const text = blocks?.[0]?.type === 'text' ? blocks[0].text : '';
    const lines = text.split('\n');
    expect(lines[0]).toBe('## experiments');
    expect(lines).toHaveLength(8);
    expect(lines[2]).toBe('Summary line one line two  # Not a heading');
    for (const row of lines.slice(6)) {
      expect(row.startsWith('| ')).toBe(true);
      expect(row.endsWith(' |')).toBe(true);
      expect(row).not.toMatch(/(?<!\\)\|.*(?<!\\)\|.*(?<!\\)\|.*(?<!\\)\|/);
      expect(row).not.toMatch(/[\r‮\u0000]/);
    }
    expect(lines[6]).toBe('| A \\| B | first second \\| third  \\[link\\](https://evil.example) |');
    expect(lines[7]).toBe('| &lt;b&gt;x&lt;/b&gt; | tab here bidi |');
  });

  it('returns a single text block', async () => {
    const result = await runToolContract(listReference, {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
  });
});
