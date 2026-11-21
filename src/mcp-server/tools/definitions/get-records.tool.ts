/**
 * @fileoverview cern_opendata_get_records — resolve the first 20 of up to 100
 * identifiers (recid, DOI, CMS dataset path, documentation slug) to full record
 * metadata with license and citation, in one portal search. Ids past the
 * 20th are deferred unread. `body_offset` reads a long doc body slice by slice.
 * File manifests are left to cern_opendata_list_files; ids that do not resolve
 * come back under `missing`.
 * @module mcp-server/tools/definitions/get-records.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { RecordSchema, renderRecordType } from '@/mcp-server/record-schema.js';
import { getCernOpenDataService } from '@/services/cern-opendata/cern-opendata-service.js';
import { type ClassifiedId, classifyIdentifier } from '@/services/cern-opendata/identifiers.js';
import { toRecord } from '@/services/cern-opendata/normalize.js';
import {
  countOf,
  fence,
  fenceHtml,
  htmlToText,
  inline,
  inlineList,
  inlineOrNA,
  inlineSpelling,
  NOT_AVAILABLE,
  noticeValue,
  printUrl,
} from '@/services/cern-opendata/text.js';
import { composeNotice } from '../enrichment.js';
import { blankAsUnset, requiredListInput } from '../inputs.js';
import { renderCrossSection, renderMethodologySteps } from '../render-production-metadata.js';

const INTERPRETED_AS = ['recid', 'doi', 'cms_dataset_path', 'doc_slug', 'unrecognized'] as const;

/** The most ids `ids` accepts, counted after exact duplicates collapse. */
const IDS_CEILING = 100;

/** The ids one call looks up; the rest are deferred unread (Decision 56). */
const LOOKUP_CAP = 20;

type RecordOut = z.infer<typeof RecordSchema>;

interface MissingOut {
  guidance: string;
  input: string;
  interpreted_as: (typeof INTERPRETED_AS)[number];
}

/** The guidance a `missing` entry carries for its identifier form. */
function missingGuidance(id: ClassifiedId): string {
  switch (id.kind) {
    case 'recid':
      return `No record has recid ${id.value}. Call cern_opendata_search_records with a title keyword to find the record's recid.`;
    case 'doi':
      return `No record carries DOI ${id.value} (tried as given and uppercased). Call cern_opendata_search_records with a title keyword to find the record; portal DOIs look like 10.7483/OPENDATA.{EXPERIMENT}.XXXX.XXXX.`;
    case 'cms_dataset_path':
      return `No record title equals ${id.value}. Call cern_opendata_search_records with experiment CMS and query set to the primary-dataset name to find the exact path.`;
    case 'doc_slug':
      return `No documentation or news page has slug ${id.value}. Call cern_opendata_search_records with type Documentation and a keyword to find the slug.`;
    default:
      return 'Not a recid, DOI, CMS dataset path or documentation slug. Call cern_opendata_list_reference with topic identifiers for the accepted forms.';
  }
}

/** Fact lines for the physics category, keywords, and the LHCb magnet polarity and stripping. */
function physicsFacts(record: RecordOut): string[] {
  const lines: string[] = [];
  if (record.category) {
    const { primary, secondary, source } = record.category;
    const sub = secondary.length > 0 ? ` (${secondary.map(inlineSpelling).join(', ')})` : '';
    lines.push(
      `**Category:** ${inlineSpelling(primary)}${sub}${source ? ` · **Category source:** ${inline(source)}` : ''}`,
    );
  }
  if (record.keywords)
    lines.push(`**Keywords:** ${record.keywords.map(inlineSpelling).join(', ')}`);
  const lhcb: string[] = [];
  if (record.magnet_polarity) lhcb.push(`**Magnet polarity:** ${inline(record.magnet_polarity)}`);
  if (record.stripping) {
    lhcb.push(
      `**Stripping:** stream ${inlineOrNA(record.stripping.stream)}, version ${inlineOrNA(record.stripping.version)}`,
    );
  }
  if (lhcb.length > 0) lines.push(lhcb.join(' · '));
  return lines;
}

/** The variable dictionary as a table; Type and Unit columns only when some entry carries them. */
function variablesTable(variables: NonNullable<RecordOut['variables']>): string {
  const withType = variables.some((variable) => variable.type !== undefined);
  const withUnit = variables.some((variable) => variable.unit !== undefined);
  const columns = [
    'Variable',
    ...(withType ? ['Type'] : []),
    ...(withUnit ? ['Unit'] : []),
    'Description',
  ];
  const rows = variables.map((variable) => {
    const cells = [
      inline(variable.variable),
      ...(withType ? [inlineOrNA(variable.type)] : []),
      ...(withUnit ? [inlineOrNA(variable.unit)] : []),
      variable.description_html === undefined
        ? NOT_AVAILABLE
        : inline(htmlToText(variable.description_html)),
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return [`| ${columns.join(' | ')} |`, `|${columns.map(() => ':--').join('|')}|`, ...rows].join(
    '\n',
  );
}

/** Markdown for one record: facts, then fenced free text, links and relations. */
function renderRecord(record: RecordOut): string {
  const lines = [`## ${inline(record.title ?? record.id)}`];
  if (record.title_additional) lines.push(`**Also titled:** ${inline(record.title_additional)}`);

  const ids = [`**id:** ${inline(record.id)}`, `**kind:** ${record.kind}`];
  if (record.recid !== undefined) ids.push(`**recid:** ${inline(record.recid)}`);
  if (record.slug !== undefined) ids.push(`**slug:** ${inline(record.slug)}`);
  lines.push(ids.join(' · '));
  lines.push(`**Matched inputs:** ${inlineList(record.matched_inputs)}`);

  lines.push(
    `**Type:** ${renderRecordType(record.type)} · **Experiment:** ${inlineList(record.experiment)}`,
  );

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
    `**Year:** ${inlineList(record.date_created)} · **Run period:** ${inlineList(record.run_period)}${record.run_numbers ? ` · **Run numbers:** ${inlineList(record.run_numbers)}` : ''}`,
  );
  if (record.collision_energy || record.collision_type) {
    lines.push(
      `**Collision energy:** ${inlineOrNA(record.collision_energy)} · **Collision type:** ${inlineOrNA(record.collision_type)}`,
    );
  }
  if (record.distribution) {
    const d = record.distribution;
    lines.push(
      `**Formats:** ${inlineList(d.formats)} · **Events:** ${inlineOrNA(d.number_events)} · **Files:** ${inlineOrNA(d.number_files)} · **Size:** ${d.size_in_bytes === undefined ? NOT_AVAILABLE : countOf(d.size_in_bytes, 'byte')}`,
    );
  }
  if (record.cross_section) lines.push(renderCrossSection(record.cross_section));
  const counts = record.availability_details
    ? ` (online files: ${inlineOrNA(record.availability_details.online)}, on-demand files: ${inlineOrNA(record.availability_details.on_demand)})`
    : '';
  lines.push(`**Availability:** ${inlineOrNA(record.availability)}${counts}`);
  if (record.collections) lines.push(`**Collections:** ${inlineList(record.collections)}`);
  if (record.tags) lines.push(`**Tags:** ${inlineList(record.tags)}`);
  lines.push(...physicsFacts(record));

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
    ['Pile-up', record.pileup_html],
  ];
  for (const [heading, html] of sections) {
    if (heading === 'Methodology' && record.methodology_steps) {
      lines.push('', '### Methodology');
      if (html) lines.push(fenceHtml(html));
      lines.push('', ...renderMethodologySteps(record.methodology_steps));
      if (record.methodology_scripts_notice) lines.push('', record.methodology_scripts_notice);
    } else if (html) {
      lines.push('', `### ${heading}`, fenceHtml(html));
    }
  }
  if (record.variables) lines.push('', '### Variables', variablesTable(record.variables));
  if (record.short_description) {
    lines.push('', '### Short description', fence(record.short_description));
  }
  if (record.body !== undefined) {
    const length =
      record.body_length === undefined
        ? `${NOT_AVAILABLE} characters`
        : countOf(record.body_length, 'character');
    const next = record.body_next_offset;
    const position =
      next === undefined
        ? `from body_offset ${inlineOrNA(record.body_offset)} to the end`
        : `from body_offset ${inlineOrNA(record.body_offset)}, cut at character ${next}; continue with body_offset ${next}`;
    lines.push(
      '',
      `### Body (format ${inlineOrNA(record.body_format)}, ${length}, ${position})`,
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

/** The `## Missing` and `## Deferred` blocks that follow the records in `format()`. */
function closingBlocks(missing: readonly MissingOut[], deferred: readonly string[]): string[] {
  const blocks: string[] = [];
  if (missing.length > 0) {
    blocks.push(
      [
        '## Missing',
        ...missing.map(
          (entry) =>
            `- ${inline(entry.input)} (interpreted as ${entry.interpreted_as}): ${inline(entry.guidance)}`,
        ),
      ].join('\n'),
    );
  }
  if (deferred.length > 0) {
    blocks.push(['## Deferred', ...deferred.map((input) => `- ${inline(input)}`)].join('\n'));
  }
  return blocks;
}

/** One continuation per sliced body, plus instructions for identifiers past the lookup cap. */
function responseNotice(records: readonly RecordOut[], unread: number): string | undefined {
  return composeNotice([
    ...records.flatMap((record) => {
      const next = record.body_next_offset;
      if (next === undefined) return [];
      const slug = noticeValue(record.slug ?? record.id);
      return [
        `The body of ${slug} was cut at character ${next} of ${record.body_length}; call cern_opendata_get_records with ids ["${slug}"] and body_offset ${next} to continue it.`,
      ];
    }),
    unread > 0
      ? `${countOf(unread, 'id')} past the first ${LOOKUP_CAP} ${unread === 1 ? 'was' : 'were'} not looked up; call cern_opendata_get_records with ids set to the deferred list to fetch ${unread === 1 ? 'it' : 'them'}.`
      : undefined,
  ]);
}

export const getRecords = tool('cern_opendata_get_records', {
  title: 'Get CERN Open Data Records',
  description:
    'Fetch full metadata, license and citation for up to 20 records by recid, DOI, CMS dataset path or documentation slug. Includes production steps and cross sections when published. Set include_scripts to true for inline production configurations. Documentation and news bodies come in slices of up to 30,000 characters; continue with body_offset and one id. All resolved records are returned. Pass ids beyond the first 20 back from deferred for the next lookup. Use cern_opendata_list_files for file lists. Unresolved ids return under missing with guidance.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ids: requiredListInput(
      IDS_CEILING,
      z
        .string()
        .max(500)
        .describe(
          'One identifier: a recid (6004 or atlas-160006, recid:6004 or a portal record URL), a DOI (10.7483/OPENDATA.CMS.YLIC.86ZZ, doi:… or a doi.org URL), a CMS dataset path (/DoubleMuParked/Run2012B-22Jan2013-v1/AOD) or a documentation slug (cms-guide-docker or its portal URL).',
        ),
      'At least one identifier is required (a recid, DOI, CMS dataset path or documentation slug, up to 100); cern_opendata_search_records finds them.',
    ).describe(
      'Identifiers to resolve: up to 100, of which the first 20 distinct are looked up and the rest returned under deferred. Forms may be mixed; exact duplicates collapse.',
    ),
    body_offset: blankAsUnset(z.number().int().min(0).default(0)).describe(
      "With exactly one documentation or news id: where its body slice starts, in characters (UTF-16 code units), usually the body_next_offset an earlier call returned. 0 (the default) is the body's start and is accepted with any ids; above 0 needs exactly one id.",
    ),
    include_scripts: blankAsUnset(z.boolean().default(false)).describe(
      'Include verbatim inline production scripts and generator fragments.',
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
    deferred: z
      .array(z.string().describe('One input, as given.'))
      .describe(
        'Ids past the first 20, in input order, not looked up. Pass as ids to fetch them; empty when none.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Continuation calls for cut documentation bodies or ids past the first 20 left unread; absent when none.',
      ),
  },
  errors: [
    {
      reason: 'invalid_body_offset',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'body_offset is above 0 beside two or more ids, or at or past the body_length of the record its one id names, or that record has no body.',
      recovery:
        'Call cern_opendata_get_records with one documentation or news id and a body_offset below the body_length an earlier call returned (its body_next_offset), or omit body_offset to read from the start.',
    },
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
    const offset = input.body_offset;
    if (offset > 0 && input.ids.length > 1) {
      throw ctx.fail(
        'invalid_body_offset',
        `body_offset ${offset} continues one body, so it takes exactly one id; ${input.ids.length} ids were given.`,
        { body_offset: offset, ids: input.ids.length },
      );
    }
    const lookedUp = input.ids.slice(0, LOOKUP_CAP);
    const unread = input.ids.slice(LOOKUP_CAP);
    const classified = lookedUp.map(classifyIdentifier);
    const service = getCernOpenDataService();
    const { matches, missing } = await service.lookup(classified, service.startBudget(), ctx);
    const resolved = matches.map((match) =>
      toRecord(match.hit, match.matchedInputs, offset, input.include_scripts),
    );

    const [only] = resolved;
    if (offset > 0 && only) {
      const name = noticeValue(only.slug ?? only.id);
      if (only.body_length === undefined) {
        throw ctx.fail(
          'invalid_body_offset',
          `body_offset ${offset} needs a documentation or news body, and ${name} has none.`,
          { body_offset: offset },
        );
      }
      if (offset >= only.body_length) {
        throw ctx.fail(
          'invalid_body_offset',
          `body_offset ${offset} is at or past the end of the body of ${name}, which is ${countOf(only.body_length, 'character')} long.`,
          { body_offset: offset, body_length: only.body_length },
        );
      }
    }

    const missingOut = missing.map((id) => ({
      input: id.input,
      interpreted_as: id.kind,
      guidance: missingGuidance(id),
    }));
    const notice = responseNotice(resolved, unread.length);
    if (notice) ctx.enrich.notice(notice);

    ctx.log.info('Records resolved', {
      requested: input.ids.length,
      looked_up: classified.length,
      resolved: resolved.length,
      not_looked_up: unread.length,
      missing: missing.length,
    });
    return { records: resolved, missing: missingOut, deferred: unread };
  },

  format: (result) => {
    const blocks = result.records.map(renderRecord);
    if (result.records.length === 0) blocks.push('No identifier resolved to a record.');
    blocks.push(...closingBlocks(result.missing, result.deferred));
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
