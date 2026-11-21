/**
 * @fileoverview CERN production-step and cross-section metadata shared by record readers.
 * @module services/cern-opendata/production-metadata
 */

import { z } from '@cyanheads/mcp-ts-core';
import { noticeValue } from './text.js';

const ConfigurationFileSchema = z
  .object({
    title: z.string().optional().describe('Configuration title or file name.'),
    url: z.string().optional().describe('Configuration URL.'),
    process: z.string().optional().describe('CMS process name.'),
    cms_confdb_id: z.string().optional().describe('CMS configuration database id.'),
    script: z.string().optional().describe('Verbatim inline configuration, with include_scripts.'),
  })
  .describe('One upstream configuration entry.');

const MethodologyStepSchema = z
  .object({
    type: z.string().optional().describe('Step label as published.'),
    release: z.string().optional().describe('Software release for the step.'),
    global_tag: z.string().optional().describe('Step conditions tag, including explicit blanks.'),
    generators: z
      .array(z.string().describe('One generator name.'))
      .optional()
      .describe('Generators used by the step.'),
    output_dataset: z.string().optional().describe('Output dataset path.'),
    configuration_files: z
      .array(ConfigurationFileSchema)
      .optional()
      .describe('Configuration entries in portal order.'),
  })
  .describe('One production step.');

/** Shared output contract for the portal's production metadata. */
export const productionMetadataShape = {
  methodology_steps: z
    .array(MethodologyStepSchema)
    .optional()
    .describe('Production steps in portal order, including repeats.'),
  methodology_scripts_notice: z
    .string()
    .optional()
    .describe('Omitted script count and the tool call that retrieves them.'),
  cross_section: z
    .object({
      total_value: z.string().optional().describe('Final cross section in pb.'),
      total_value_uncertainty: z.string().optional().describe('Cross-section uncertainty in pb.'),
      filter_efficiency: z.string().optional().describe('Filter efficiency, as a ratio.'),
      filter_efficiency_error: z.string().optional().describe('Reported filter efficiency error.'),
      matching_efficiency: z.string().optional().describe('Matching efficiency, as a ratio.'),
      matching_efficiency_error: z
        .string()
        .optional()
        .describe('Reported matching efficiency error.'),
      neg_weight_fraction: z
        .string()
        .optional()
        .describe('Percent of events with negative weights.'),
    })
    .optional()
    .describe('CMS cross-section metadata as published; numeric spellings are preserved.'),
};

/** Normalized fields that may be added to a record from the portal. */
export type ProductionMetadata = z.infer<z.ZodObject<typeof productionMetadataShape>>;

/** Admits partial objects and keeps only stated string values, including blanks. */
function copyStrings<const Key extends string>(
  value: object,
  keys: readonly Key[],
): Partial<Record<Key, string>> {
  const fields: Partial<Record<Key, string>> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (typeof field === 'string') fields[key] = field;
  }
  return fields;
}

function objectsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
}

const crossSectionKeys = productionMetadataShape.cross_section.unwrap().keyof().options;
const configurationFileKeys = ConfigurationFileSchema.keyof().options;

/** Project the portal fields without modifying a cached hit or executing its configurations. */
export function productionMetadataOf(
  steps: unknown,
  crossSection: unknown,
  lookupId: string,
  includeScripts: boolean,
): ProductionMetadata {
  let omitted = 0;
  const methodology_steps = objectsOf(steps).flatMap((step) => {
    const fields: z.infer<typeof MethodologyStepSchema> = copyStrings(step, [
      'type',
      'release',
      'global_tag',
      'output_dataset',
    ]);
    if (Array.isArray(step.generators)) {
      fields.generators = step.generators.filter(
        (name): name is string => typeof name === 'string',
      );
    }
    const files = objectsOf(step.configuration_files);
    if (files.length > 0) {
      fields.configuration_files = files.flatMap((file) => {
        const configuration = copyStrings(file, configurationFileKeys);
        if (configuration.script !== undefined && !includeScripts) {
          omitted += 1;
          delete configuration.script;
          return [configuration];
        }
        return Object.keys(configuration).length > 0 ? [configuration] : [];
      });
    }
    return Object.keys(fields).length > 0 ? [fields] : [];
  });
  const cross_section =
    crossSection !== null && typeof crossSection === 'object'
      ? copyStrings(crossSection, crossSectionKeys)
      : {};
  const scriptLabel = omitted === 1 ? 'script' : 'scripts';
  return {
    ...(methodology_steps.length > 0 && { methodology_steps }),
    ...(Object.keys(cross_section).length > 0 && { cross_section }),
    ...(omitted > 0 && {
      methodology_scripts_notice: `${omitted} ${scriptLabel} omitted. Call cern_opendata_get_records with ids ["${noticeValue(lookupId)}"] and include_scripts: true to retrieve them.`,
    }),
  };
}
