/**
 * @fileoverview Smoke coverage for every definition the server registers: all
 * seven tools and the record resource are present, carry a description, an
 * output schema and a `format()`, serialize to JSON Schema, advertise the
 * `limit` and `ids` ceilings, and declare the shared error contract and list
 * enrichment the design requires. The reference
 * tool runs end to end (it needs no upstream).
 * @module tests/smoke/definitions.smoke.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { recordResource } from '@/mcp-server/resources/definitions/record.resource.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';

const TOOL_NAMES = [
  'cern_opendata_search_records',
  'cern_opendata_get_records',
  'cern_opendata_list_files',
  'cern_opendata_get_analysis_env',
  'cern_opendata_get_validated_runs',
  'cern_opendata_search_trigger_paths',
  'cern_opendata_list_reference',
];

const LIST_TOOLS = [
  'cern_opendata_search_records',
  'cern_opendata_list_files',
  'cern_opendata_get_validated_runs',
  'cern_opendata_search_trigger_paths',
];

const UPSTREAM_TOOLS = allToolDefinitions.filter((tool) => tool.name !== listReference.name);

/** Wording that offers a spelling only an input's preprocess accepts, never its advertised schema. */
const PREPROCESS_ONLY_WORDING = /comma-separated|recid:|record URL|Trimmed/;

type AdvertisedProperty = { type?: string; pattern?: string; description?: string };

/** `tool.field` for every input property whose advertised schema is an array or a pattern and whose description offers a form that schema refuses. */
function offeredButRefused(tools: typeof allToolDefinitions): string[] {
  return tools.flatMap((tool) => {
    const { properties = {} } = z.toJSONSchema(tool.input, {
      io: 'input',
      unrepresentable: 'any',
    }) as { properties?: Record<string, AdvertisedProperty> };
    return Object.entries(properties)
      .filter(
        ([, property]) =>
          (property.type === 'array' || property.pattern !== undefined) &&
          PREPROCESS_ONLY_WORDING.test(property.description ?? ''),
      )
      .map(([field]) => `${tool.name}.${field}`);
  });
}

describe('definition smoke test', () => {
  it('registers all seven tools, once each, in the documented order', () => {
    expect(allToolDefinitions.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(new Set(allToolDefinitions.map((tool) => tool.name)).size).toBe(7);
  });

  it('registers the record resource', () => {
    expect(allResourceDefinitions).toEqual([recordResource]);
    expect(recordResource.name).toBe('cern-opendata-record');
    expect(recordResource.mimeType).toBe('application/json');
  });

  it.each(allToolDefinitions.map((tool) => [tool.name, tool] as const))(
    '%s has a description, annotations, an output schema and a format()',
    (_name, tool) => {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
      expect(tool.annotations?.openWorldHint).toBe(tool.name !== listReference.name);
      expect(tool.output).toBeDefined();
      expect(typeof tool.format).toBe('function');
    },
  );

  it.each(allToolDefinitions.map((tool) => [tool.name, tool] as const))(
    '%s serializes its input and output schemas to JSON Schema',
    (_name, tool) => {
      expect(() =>
        z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }),
      ).not.toThrow();
      expect(() => z.toJSONSchema(tool.output, { unrepresentable: 'any' })).not.toThrow();
    },
  );

  it('advertises the 10,000 ceiling on every limit and the 100 ceiling on ids, so a value past a cap reaches the tool', () => {
    const ceilings = allToolDefinitions.flatMap((tool) => {
      const { properties = {} } = z.toJSONSchema(tool.input, {
        io: 'input',
        unrepresentable: 'any',
      }) as { properties?: Record<string, { maximum?: number; maxItems?: number }> };
      return [
        ...(properties.limit ? [[`${tool.name}.limit`, properties.limit.maximum]] : []),
        ...(properties.ids ? [[`${tool.name}.ids`, properties.ids.maxItems]] : []),
      ];
    });
    expect(Object.fromEntries(ceilings)).toEqual({
      'cern_opendata_search_records.limit': 10_000,
      'cern_opendata_get_records.ids': 100,
      'cern_opendata_list_files.limit': 10_000,
      'cern_opendata_get_validated_runs.limit': 10_000,
      'cern_opendata_search_trigger_paths.limit': 10_000,
    });
  });

  it('offers no input form the advertised schema refuses on an array or pattern field', () => {
    expect(offeredButRefused(allToolDefinitions)).toEqual([]);
  });

  it('flags an array or pattern field described with a preprocess-only spelling, and nothing else', () => {
    const probe = tool('probe_tool', {
      description: 'A probe definition for the description guard, never registered.',
      input: z.object({
        list: z.array(z.string()).describe('An array, or one comma-separated string.'),
        id: z
          .string()
          .regex(/^\d+$/)
          .describe('Digits; recid:6004 or a portal record URL also work.'),
        path: z
          .string()
          .regex(/^[A-Z]+$/)
          .describe('Letters. Trimmed.'),
        query: z.string().describe('Full text; recid:(1 OR 2) works.'),
        ids: z.array(z.string()).describe('Up to 20 identifiers.'),
      }),
      output: z.object({}),
      handler: () => ({}),
    });
    expect(offeredButRefused([probe] as never)).toEqual([
      'probe_tool.list',
      'probe_tool.id',
      'probe_tool.path',
    ]);
  });

  it.each(UPSTREAM_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s declares the shared upstream errors, service-thrown, with recoveries naming itself',
    (name, tool) => {
      const byReason = Object.fromEntries(
        (tool.errors ?? []).map((entry) => [entry.reason, entry]),
      );
      expect(byReason.rate_limited).toMatchObject({ thrownBy: 'service', retryable: true });
      expect(byReason.upstream_unreadable).toMatchObject({ thrownBy: 'service' });
      for (const entry of tool.errors ?? []) {
        expect(entry.when.length, `${name} ${entry.reason} when`).toBeGreaterThan(10);
        expect(entry.recovery, `${name} ${entry.reason} recovery`).toContain(name);
      }
    },
  );

  it.each(
    [
      ...UPSTREAM_TOOLS.filter((tool) => tool.name !== 'cern_opendata_list_files'),
      recordResource,
    ].map((definition) => [definition.name, definition] as const),
  )('%s names a search 404 among the upstream_unreadable cases', (_name, definition) => {
    const entry = (definition.errors ?? []).find(
      (candidate) => candidate.reason === 'upstream_unreadable',
    );
    expect(entry?.when).toContain('Also raised when a search answers 404');
  });

  it.each(LIST_TOOLS)('%s declares the required list enrichment fields', (name) => {
    const tool = allToolDefinitions.find((candidate) => candidate.name === name);
    expect(Object.keys(tool?.enrichment ?? {})).toEqual(
      expect.arrayContaining(['truncated', 'shown', 'cap', 'totalCount', 'notice']),
    );
  });

  it('declares no error contract or enrichment on the offline reference tool', () => {
    expect(listReference.errors ?? []).toEqual([]);
    expect(Object.keys(listReference.enrichment ?? {})).toEqual([]);
  });

  it('runs the reference tool end to end and returns every topic', async () => {
    const result = await listReference.handler(listReference.input.parse({}), createMockContext());
    expect(result).toEqual(expect.schemaMatching(listReference.output));
    expect(result.topics).toHaveLength(12);
    expect(listReference.format?.(result)[0]).toMatchObject({ type: 'text' });
  });

  it('reads a blank topic on the reference tool as unset', () => {
    expect(listReference.input.parse({ topic: '' })).toEqual({});
  });
});
