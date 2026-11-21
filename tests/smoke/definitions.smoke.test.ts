/**
 * @fileoverview Smoke coverage for every definition the server registers: all
 * seven tools and the record resource are present, carry a description, an
 * output schema and a `format()`, serialize to JSON Schema, advertise the
 * `limit` and `ids` constraints, and declare the shared error contract and list
 * enrichment the design requires. The reference
 * tool runs end to end (it needs no upstream).
 * @module tests/smoke/definitions.smoke.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { recordResource } from '@/mcp-server/resources/definitions/record.resource.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { errorOf } from '../fixtures/cern-opendata-harness.js';

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

const LIMIT_CAPS = {
  cern_opendata_search_records: 1_000,
  cern_opendata_search_trigger_paths: 625,
  cern_opendata_list_files: 2_000,
  cern_opendata_get_validated_runs: 2_000,
};

type AdvertisedInput = {
  properties?: Record<
    string,
    { type?: string; minimum?: number; maximum?: number; maxItems?: number }
  >;
};

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

  it('advertises clamped limits as positive integers without maxima and ids with a 100-item ceiling', () => {
    const limits = allToolDefinitions.flatMap((tool) => {
      const { properties = {} } = z.toJSONSchema(tool.input, {
        io: 'input',
        unrepresentable: 'any',
      }) as AdvertisedInput;
      if (tool.name === 'cern_opendata_get_records') expect(properties.ids?.maxItems).toBe(100);
      if (!properties.limit) return [];
      expect(properties.limit).toMatchObject({ type: 'integer', minimum: 1 });
      expect(JSON.stringify(properties.limit)).not.toContain('maximum');
      return [tool.name];
    });
    expect(limits).toEqual(LIST_TOOLS);
  });

  it('advertises and enforces each cap when the process starts in strict mode', async () => {
    vi.stubEnv('CERN_OPENDATA_CLAMP_LIMITS', 'false');
    vi.resetModules();
    try {
      const { allToolDefinitions: strictDefinitions } = await import(
        '@/mcp-server/tools/definitions/index.js'
      );
      const selectors = {
        cern_opendata_search_records: {},
        cern_opendata_search_trigger_paths: { path: 'HLT_Mu*' },
        cern_opendata_list_files: { recid: '6004' },
        cern_opendata_get_validated_runs: { recid: '1005' },
      };
      const strictCaps = new Map<keyof typeof LIMIT_CAPS, number>();
      for (const tool of strictDefinitions) {
        const { properties = {} } = z.toJSONSchema(tool.input, {
          io: 'input',
          unrepresentable: 'any',
        }) as AdvertisedInput;
        if (!properties.limit) continue;
        const key = tool.name as keyof typeof LIMIT_CAPS;
        const cap = LIMIT_CAPS[key];
        expect(properties.limit).toMatchObject({ minimum: 1, maximum: cap, type: 'integer' });
        strictCaps.set(key, cap);
        expect(tool.input.safeParse({ ...selectors[key], limit: cap }).success).toBe(true);
        for (const limit of [cap + 1, 0, 1.5]) {
          const result = await runToolContract(
            tool as never,
            { ...selectors[key], limit } as never,
          );
          expect(errorOf(result).data).toMatchObject({ reason: 'invalid_arguments' });
        }
      }
      expect(Object.fromEntries(strictCaps)).toEqual(LIMIT_CAPS);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
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
