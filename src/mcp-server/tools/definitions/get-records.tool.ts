/**
 * @fileoverview cern_opendata_get_records — resolve 1–20 identifiers (recid,
 * DOI, CMS dataset path, documentation slug) to full record metadata with
 * license and citation, in one portal search. File manifests are left to
 * cern_opendata_list_files; ids that do not resolve come back under `missing`.
 * @module mcp-server/tools/definitions/get-records.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { RecordSchema } from '@/mcp-server/record-schema.js';
import { getCernOpenDataService } from '@/services/cern-opendata/cern-opendata-service.js';
import { type ClassifiedId, classifyIdentifier } from '@/services/cern-opendata/identifiers.js';
import { DOC_BODY_MAX_CHARS, toRecord } from '@/services/cern-opendata/normalize.js';
import {
  fence,
  fenceHtml,
  inline,
  inlineOrNA,
  NOT_AVAILABLE,
  printUrl,
} from '@/services/cern-opendata/text.js';
import { composeNotice } from '../enrichment.js';
import { requiredListInput } from '../inputs.js';

const INTERPRETED_AS = ['recid', 'doi', 'cms_dataset_path', 'doc_slug', 'unrecognized'] as const;

type RecordOut = z.infer<typeof RecordSchema>;

/** The guidance a `missing` entry carries for its identifier form. */
function missingGuidance(id: ClassifiedId): string {
  switch (id.kind) {
    case 'recid':
      return `No record has recid ${id.value}. Call cern_opendata_search_records with a title keyword to find the record's recid.`;
    case 'doi':
      return `No record carries DOI ${id.value} (tried as given and uppercased). Call cern_opendata_search_records with a title keyword to find the record; portal DOIs look like 10.7483/OPENDATA.CMS.XXXX.XXXX.`;
    case 'cms_dataset_path':
      return `No record title equals ${id.value}. Call cern_opendata_search_records with experiment CMS and query set to the primary-dataset name to find the exact path.`;
    case 'doc_slug':
      return `No documentation or news page has slug ${id.value}. Call cern_opendata_search_records with type Documentation and a keyword to find the slug.`;
    default:
      return 'Not a recid, DOI, CMS dataset path or documentation slug. Call cern_opendata_list_reference with topic identifiers for the accepted forms.';
  }
}

const list = (values: readonly string[] | undefined) =>
  values?.length ? values.map(inline).join(', ') : NOT_AVAILABLE;

/** Markdown for one record: facts, then fenced free text, links and relations. */
function renderRecord(record: RecordOut): string {
  const lines = [`## ${inline(record.title ?? record.id)}`];
  if (record.title_additional) lines.push(`**Also titled:** ${inline(record.title_additional)}`);

  const ids = [`**id:** ${inline(record.id)}`, `**kind:** ${record.kind}`];
  if (record.recid !== undefined) ids.push(`**recid:** ${inline(record.recid)}`);
  if (record.slug !== undefined) ids.push(`**slug:** ${inline(record.slug)}`);
  lines.push(ids.join(' · '));
  lines.push(`**Matched inputs:** ${list(record.matched_inputs)}`);

  const typeText =
    record.type.primary === ''
      ? NOT_AVAILABLE
      : `${inline(record.type.primary)}${record.type.secondary.length > 0 ? ` (${list(record.type.secondary)})` : ''}`;
  lines.push(`**Type:** ${typeText} · **Experiment:** ${list(record.experiment)}`);

  if (record.collaboration) {
    const recid = record.collaboration.recid
      ? ` (recid ${inline(record.collaboration.recid)})`
      : '';
    lines.push(`**Collaboration:** ${inline(record.collaboration.name)}${recid}`);
  }
  if (record.authors) {
    const authors = record.authors.map(
      (author) => `${inline(author.name)}${author.orcid ? ` (ORCID ${inline(author.orcid)})` : ''}`,
    );
    lines.push(`**Authors:** ${authors.join('; ')}`);
  }

  lines.push(
    `**DOI:** ${inlineOrNA(record.doi)} · **Published:** ${inlineOrNA(record.date_published)}${record.date_reprocessed ? ` · **Reprocessed:** ${inline(record.date_reprocessed)}` : ''}`,
  );
  lines.push(
    `**Year:** ${list(record.date_created)} · **Run period:** ${list(record.run_period)}${record.run_numbers ? ` · **Run numbers:** ${list(record.run_numbers)}` : ''}`,
  );
  if (record.collision_energy || record.collision_type) {
    lines.push(
      `**Collision energy:** ${inlineOrNA(record.collision_energy)} · **Collision type:** ${inlineOrNA(record.collision_type)}`,
    );
  }
  if (record.distribution) {
    const d = record.distribution;
    lines.push(
      `**Formats:** ${list(d.formats)} · **Events:** ${inlineOrNA(d.number_events)} · **Files:** ${inlineOrNA(d.number_files)} · **Size:** ${d.size_in_bytes === undefined ? NOT_AVAILABLE : `${d.size_in_bytes} bytes`}`,
    );
  }
  const counts = record.availability_details
    ? ` (online files: ${inlineOrNA(record.availability_details.online)}, on-demand files: ${inlineOrNA(record.availability_details.on_demand)})`
    : '';
  lines.push(`**Availability:** ${inlineOrNA(record.availability)}${counts}`);
  if (record.collections) lines.push(`**Collections:** ${list(record.collections)}`);
  if (record.tags) lines.push(`**Tags:** ${list(record.tags)}`);

  if (record.system_details) {
    const s = record.system_details;
    const images = s.container_images
      ?.map(
        (image) => `${inline(image.name)}${image.registry ? ` (${inline(image.registry)})` : ''}`,
      )
      .join(', ');
    lines.push(
      `**Software environment:** release ${inlineOrNA(s.release)} · global tag ${inlineOrNA(s.global_tag)} · container images ${images ?? NOT_AVAILABLE} · environment recid ${inlineOrNA(s.environment_recid)}`,
    );
    if (s.description) lines.push('Environment description:', fenceHtml(s.description));
  }
  if (record.source_code_repository_url) {
    lines.push(`**Source code:** ${printUrl(record.source_code_repository_url)}`);
  }
  if (record.dataset_semantics) {
    const ds = record.dataset_semantics;
    lines.push(
      `**Dataset semantics:** ${ds.html_url ? printUrl(ds.html_url) : NOT_AVAILABLE} (HTML) · ${ds.json_url ? printUrl(ds.json_url) : NOT_AVAILABLE} (JSON)`,
    );
  }

  lines.push(
    `**License:** ${record.license.id ? `${inline(record.license.id)} ` : ''}(basis: ${record.license.basis}) ${inline(record.license.statement)}`,
  );
  if (record.citation) {
    lines.push(
      `**Citation** (DOI ${inline(record.citation.doi)}):`,
      fence(record.citation.text),
      inline(record.citation.request),
    );
  }
  lines.push(`**Portal:** ${printUrl(record.portal_url)}`);

  const sections: [string, string | undefined][] = [
    ['Abstract', record.abstract_html],
    ['Methodology', record.methodology_html],
    ['Usage', record.usage_html],
    ['Validation', record.validation_html],
    ['Note', record.note_html],
    ['Use with', record.use_with_html],
  ];
  for (const [heading, html] of sections) {
    if (html) lines.push('', `### ${heading}`, fenceHtml(html));
  }
  if (record.short_description) {
    lines.push('', '### Short description', fence(record.short_description));
  }
  if (record.body !== undefined) {
    const cut = record.body_truncated
      ? `, truncated at ${DOC_BODY_MAX_CHARS} characters`
      : ', not truncated';
    lines.push(
      '',
      `### Body (format ${inlineOrNA(record.body_format)}, ${inlineOrNA(record.body_length)} characters${cut})`,
      fence(record.body),
    );
  }

  if (record.links.length > 0) {
    lines.push('', '### Links');
    for (const link of record.links) {
      const target = [
        link.recid ? `recid ${inline(link.recid)}` : '',
        link.url ? printUrl(link.url) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(
        `- [${link.source}] ${link.description ? inline(link.description) : NOT_AVAILABLE}${target ? ` — ${target}` : ''}`,
      );
    }
  }
  if (record.relations.length > 0) {
    lines.push('', '### Relations');
    for (const relation of record.relations) {
      const ids = [
        relation.recid ? `recid ${inline(relation.recid)}` : '',
        relation.doi ? `DOI ${inline(relation.doi)}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `- ${inline(relation.type)}: ${relation.title ? inline(relation.title) : NOT_AVAILABLE}${ids ? ` (${ids})` : ''}${relation.description ? ` — ${inline(relation.description)}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

export const getRecords = tool('cern_opendata_get_records', {
  title: 'Get CERN Open Data Records',
  description:
    'Fetch full metadata for 1-20 records in one call, by recid, DOI, CMS dataset path (/Primary/Era/TIER) or documentation slug. Returns the description, run periods, collision and distribution details, related records, a software-environment summary, the license and a ready citation. Documentation and news pages include their markdown body, cut at 30,000 characters. File lists are not included; use cern_opendata_list_files. Identifiers that do not resolve come back under missing with guidance; they do not fail the call.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ids: requiredListInput(
      20,
      z
        .string()
        .max(500)
        .describe(
          'One identifier: a recid (6004, recid:6004 or a portal record URL), a DOI (10.7483/OPENDATA.CMS.YLIC.86ZZ, doi:… or a doi.org URL), a CMS dataset path (/DoubleMuParked/Run2012B-22Jan2013-v1/AOD) or a documentation slug (cms-guide-docker or its portal URL).',
        ),
      'At least one identifier is required (a recid, DOI, CMS dataset path or documentation slug); cern_opendata_search_records finds them.',
    ).describe(
      'Identifiers to resolve, 1-20: an array, or one comma-separated string. Forms may be mixed; duplicates collapse.',
    ),
  }),
  output: z.object({
    records: z
      .array(RecordSchema)
      .describe('Resolved records, in the order of their first matching input.'),
    missing: z
      .array(
        z
          .object({
            input: z.string().describe('The identifier as given.'),
            interpreted_as: z
              .enum(INTERPRETED_AS)
              .describe('The identifier form it was read as; unrecognized when no form fits.'),
            guidance: z.string().describe('Why it did not resolve and how to find the record.'),
          })
          .describe('One identifier that did not resolve.'),
      )
      .describe('Identifiers that resolved to no record; empty when every id resolved.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Caveats about the returned records, such as a documentation body that was cut.'),
  },
  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The portal's 60-a-minute budget is spent: it answered 429, or the request could not start within the call's deadline. data.retryAfter is set.",
      recovery:
        'Wait the retryAfter seconds given in this error (the portal allows 60 requests a minute per IP), then call cern_opendata_get_records again with the same arguments.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The portal answered with a body the server could not read: not JSON, missing the expected envelope, or over the byte ceiling (then data.retryable is false). Also raised when a search answers 404.',
      recovery:
        'Call cern_opendata_get_records again in a minute; if it repeats, the portal is serving an error page or an oversized response, so read the same data on https://opendata.cern.ch instead.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const classified = input.ids.map(classifyIdentifier);
    const service = getCernOpenDataService();
    const { matches, missing } = await service.lookup(classified, service.startBudget(), ctx);
    const records = matches.map((match) => toRecord(match.hit, match.matchedInputs));

    const notice = composeNotice(
      records.map((record) =>
        record.body_truncated
          ? `The body of ${record.slug ?? record.id} was cut at 30,000 of ${record.body_length} characters; read the full page at ${record.portal_url}.`
          : undefined,
      ),
    );
    if (notice) ctx.enrich.notice(notice);

    ctx.log.info('Records resolved', {
      requested: classified.length,
      resolved: records.length,
      missing: missing.length,
    });
    return {
      records,
      missing: missing.map((id) => ({
        input: id.input,
        interpreted_as: id.kind,
        guidance: missingGuidance(id),
      })),
    };
  },

  format: (result) => {
    const blocks = result.records.map(renderRecord);
    if (result.records.length === 0) blocks.push('No identifier resolved to a record.');
    if (result.missing.length > 0) {
      blocks.push(
        [
          '## Missing',
          ...result.missing.map(
            (entry) =>
              `- ${inline(entry.input)} (interpreted as ${entry.interpreted_as}): ${inline(entry.guidance)}`,
          ),
        ].join('\n'),
      );
    }
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
