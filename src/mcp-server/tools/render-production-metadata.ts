/**
 * @fileoverview Markdown for CERN record production steps and cross sections.
 * @module mcp-server/tools/render-production-metadata
 */

import type { ProductionMetadata } from '@/services/cern-opendata/production-metadata.js';
import { fence, inlineSpelling, NOT_AVAILABLE, printUrl } from '@/services/cern-opendata/text.js';

function stated(value: string | undefined): string {
  if (value === undefined) return NOT_AVAILABLE;
  return value === '' ? '""' : inlineSpelling(value);
}

function efficiency(label: string, value: string | undefined, error: string | undefined) {
  if (value === undefined)
    return error === undefined ? undefined : `${label} error ${stated(error)}`;
  return `${label} ${stated(value)}${error === undefined ? '' : ` (error ${stated(error)})`}`;
}

/** Render every supplied cross-section value beside Distribution. */
export function renderCrossSection(crossSection: NonNullable<ProductionMetadata['cross_section']>) {
  const {
    total_value,
    total_value_uncertainty,
    filter_efficiency,
    filter_efficiency_error,
    matching_efficiency,
    matching_efficiency_error,
    neg_weight_fraction,
  } = crossSection;
  let total: string | undefined;
  if (total_value !== undefined) {
    const uncertainty =
      total_value_uncertainty === undefined ? '' : ` ± ${stated(total_value_uncertainty)}`;
    total = `${stated(total_value)}${uncertainty} pb`;
  } else if (total_value_uncertainty !== undefined) {
    total = `uncertainty ${stated(total_value_uncertainty)} pb`;
  }
  const facts = [
    total,
    efficiency('filter efficiency', filter_efficiency, filter_efficiency_error),
    efficiency('matching efficiency', matching_efficiency, matching_efficiency_error),
    neg_weight_fraction === undefined
      ? undefined
      : `negative weights ${stated(neg_weight_fraction)} %`,
  ];
  return `**Cross section:** ${facts.filter((fact) => fact !== undefined).join(' · ')}`;
}

/** Render ordered steps as a table, followed by their configurations and inline scripts. */
export function renderMethodologySteps(
  steps: NonNullable<ProductionMetadata['methodology_steps']>,
): string[] {
  const lines = [
    '| # | Step | Release | Global tag | Generators | Output dataset |',
    '|---|---|---|---|---|---|',
  ];
  for (const [index, step] of steps.entries()) {
    const generators =
      step.generators === undefined
        ? NOT_AVAILABLE
        : step.generators.map(stated).join(', ') || '[]';
    lines.push(
      `| ${index + 1} | ${stated(step.type)} | ${stated(step.release)} | ${stated(step.global_tag)} | ${generators} | ${stated(step.output_dataset)} |`,
    );
  }
  for (const [index, step] of steps.entries()) {
    if (!step.configuration_files?.length) continue;
    lines.push('', `#### Configuration for step ${index + 1}`, '');
    for (const file of step.configuration_files) {
      const facts = [stated(file.title)];
      if (file.url !== undefined) {
        const url = printUrl(file.url);
        facts.push(/^https?:\/\//i.test(url) ? `<${url}>` : stated(file.url));
      }
      if (file.process !== undefined) facts.push(`process ${stated(file.process)}`);
      if (file.cms_confdb_id !== undefined)
        facts.push(`CMS ConfDB id ${stated(file.cms_confdb_id)}`);
      lines.push(`- ${facts.join(' · ')}`);
      if (file.script !== undefined) lines.push('', fence(file.script), '');
    }
  }
  return lines;
}
