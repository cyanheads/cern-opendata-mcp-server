/**
 * @fileoverview Smoke coverage for every definition the server registers: all
 * seven tools and the record resource are present, carry a description, an
 * output schema and a `format()`, serialize to JSON Schema, and declare the
 * shared error contract and list enrichment the design requires. The reference
 * tool runs end to end (it needs no upstream).
 * @module tests/smoke/definitions.smoke.test
 */

import { z } from '@cyanheads/mcp-ts-core';
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
    expect(result.topics).toHaveLength(10);
    expect(listReference.format?.(result)[0]).toMatchObject({ type: 'text' });
  });

  it('reads a blank topic on the reference tool as unset', () => {
    expect(listReference.input.parse({ topic: '' })).toEqual({});
  });
});
