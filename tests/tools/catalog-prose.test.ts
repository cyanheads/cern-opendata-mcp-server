/**
 * @fileoverview Catalog prose size and the semantics needed to interpret and continue results.
 * @module tests/tools/catalog-prose.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { RecordSchema } from '@/mcp-server/record-schema.js';
import { recordResource } from '@/mcp-server/resources/definitions/record.resource.js';
import { getRecords } from '@/mcp-server/tools/definitions/get-records.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { searchRecords } from '@/mcp-server/tools/definitions/search-records.tool.js';

/** Decoded description bytes, including repeated nested schemas as emitted. */
function descriptionBytes(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + descriptionBytes(item), 0);
  if (value === null || typeof value !== 'object') return 0;
  return Object.entries(value).reduce(
    (sum, [key, item]) =>
      sum +
      (key === 'description' && typeof item === 'string'
        ? Buffer.byteLength(item)
        : descriptionBytes(item)),
    0,
  );
}

describe('catalog prose', () => {
  it('keeps shared record metadata and continuation shapes', () => {
    expect(recordResource.output).toBe(RecordSchema);
    expect(Object.keys(getRecords.output.shape)).toEqual(['records', 'missing', 'deferred']);
    expect(getRecords.output.shape.deferred.element.type).toBe('string');
    expect(RecordSchema.shape.body_offset.unwrap().type).toBe('number');
    expect(searchRecords.input.parse({})).toEqual({ limit: 10, page: 1 });
    expect(searchRecords.input.safeParse({ limit: 10_001 }).success).toBe(false);
    expect(searchRecords.output.shape.facets.shape.type.shape.buckets.element.shape).toHaveProperty(
      'subtypes_other_count',
    );
    expect(
      searchRecords.output.shape.facets.shape.category.shape.buckets.element.shape,
    ).toHaveProperty('subcategories_other_count');
  });

  it('retains whole-first-record, lookup-cap and ordered continuation guidance', () => {
    const deferred = getRecords.output.shape.deferred.description ?? '';
    expect(deferred).toMatch(/64,000 bytes/);
    expect(deferred).toMatch(/first record.*whole.*(?:larger|exceeds)/);
    expect(deferred).toMatch(/then.*(?:past|after).*20.*not looked up/);
    expect(deferred).toMatch(/input order/);
    expect(deferred).toMatch(/(?:Pass|pass).*ids/);
    expect(deferred).toMatch(/Empty|empty/);
    expect(RecordSchema.shape.body.description).toMatch(/30,000.*UTF-16 code units/);
    expect(RecordSchema.shape.body_length.description).toContain('UTF-16 code units');
    expect(RecordSchema.shape.body_next_offset.description).toMatch(
      /body_offset.*(?:id alone|one id)/,
    );
  });

  it('retains facet self-filter, per-value overflow and vocabulary guidance', () => {
    const facets = searchRecords.output.shape.facets.description ?? '';
    expect(facets).toMatch(/ignores its own filter/);
    expect(facets).toMatch(/10.*alphabetically.*file_type.*100/);
    expect(facets).toMatch(/type and category.*10.*secondary/);
    expect(facets).toMatch(/once per value/);
    expect(facets).toMatch(/other_count.*0.*year.*number_events/);
    for (const pointer of [
      'cern_opendata_list_reference',
      'record_types',
      'categories',
      'Primary::Secondary',
      'totalCount',
    ])
      expect(facets).toContain(pointer);
    const category = searchRecords.input.shape.category.description ?? '';
    for (const spelling of [
      'Exotica::Heavy Fermions, Heavy Righ-Handed Neutrinos',
      'Heavy-Ion Physics',
      'cern_opendata_list_reference',
      'categories',
    ])
      expect(category).toContain(spelling);
    expect(searchRecords.input.shape.query.description).toContain('query_syntax');
    expect(searchRecords.input.shape.stripping_stream.description).toContain('lhcb');
  });

  it('bounds aggregate success/enrichment and search-input description bytes', () => {
    // Production extends output with enrichment before advertising its success properties.
    const outputBytes = allToolDefinitions.reduce((sum, definition) => {
      const success = definition.enrichment
        ? definition.output.extend(definition.enrichment)
        : definition.output;
      return sum + descriptionBytes(z.toJSONSchema(success).properties);
    }, 0);
    const inputBytes = descriptionBytes(
      z.toJSONSchema(searchRecords.input, { io: 'input', unrepresentable: 'any' }),
    );
    // Aggregate headroom allows wording edits without restoring the former catalog bulk.
    expect(outputBytes + inputBytes).toBeLessThanOrEqual(25_000);
  });
});
