/**
 * @fileoverview cern_opendata_list_reference — the static vocabulary the other
 * tools accept: experiments, record types, collision energies and types, file
 * types, availability states, physics categories, LHCb magnet polarities and
 * stripping streams and versions, identifier forms, query syntax, licensing
 * and CMS run periods. Offline; no upstream calls.
 * @module mcp-server/tools/definitions/list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { inline } from '@/services/cern-opendata/text.js';
import { REFERENCE_TABLES, REFERENCE_TOPICS } from '@/services/cern-opendata/vocabulary.js';
import { blankAsUnset } from '../inputs.js';

export const listReference = tool('cern_opendata_list_reference', {
  title: 'List Reference Vocabulary',
  description:
    'Decode the vocabulary the other cern_opendata tools accept: experiments, record types, collision energies and types, file formats and data tiers, availability states, physics categories, LHCb magnet polarities and stripping streams and versions, identifier forms, query syntax, licensing, and the CMS run periods that have validated-run lists. Static and offline; omit topic for every table.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: blankAsUnset(z.enum(REFERENCE_TOPICS).optional()).describe(
      'One table to return: experiments, record_types, collision_energies, collision_types, file_types, availability, categories, lhcb, identifiers, query_syntax, licensing or run_periods. Omit for every table.',
    ),
  }),
  output: z.object({
    topics: z
      .array(
        z
          .object({
            topic: z.enum(REFERENCE_TOPICS).describe('Topic name, as accepted by the topic input.'),
            summary: z
              .string()
              .describe('What the table covers and how its values are matched or normalized.'),
            entries: z
              .array(
                z
                  .object({
                    value: z
                      .string()
                      .describe(
                        'A value or query form, spelled exactly as the tools accept it; in the identifiers and licensing topics, the name of an identifier form or a licensing rule.',
                      ),
                    meaning: z.string().describe('What the value means and where it applies.'),
                  })
                  .describe('One vocabulary value.'),
              )
              .describe('The values of this topic.'),
          })
          .describe('One reference table.'),
      )
      .describe('The requested table, or every table when topic is omitted.'),
  }),

  handler(input) {
    const tables = input.topic
      ? REFERENCE_TABLES.filter((table) => table.topic === input.topic)
      : REFERENCE_TABLES;
    return {
      topics: tables.map((table) => ({
        topic: table.topic,
        summary: table.summary,
        entries: table.entries.map((entry) => ({ value: entry.value, meaning: entry.meaning })),
      })),
    };
  },

  format: (result) => {
    const sections = result.topics.map((table) => {
      const rows = table.entries.map(
        (entry) => `| ${inline(entry.value)} | ${inline(entry.meaning)} |`,
      );
      return [
        `## ${inline(table.topic)}`,
        '',
        inline(table.summary),
        '',
        '| Value | Meaning |',
        '|:------|:--------|',
        ...rows,
      ].join('\n');
    });
    return [{ type: 'text', text: sections.join('\n\n') }];
  },
});
