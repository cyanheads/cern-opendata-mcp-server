/**
 * @fileoverview cern_opendata_get_records — resolve 1–20 identifiers (recid,
 * DOI, CMS dataset path, documentation slug) to full record metadata with
 * license and citation, in one portal search. Each response holds to a byte
 * budget by deferring whole records, and `body_offset` reads a long doc body
 * slice by slice. File manifests are left to cern_opendata_list_files; ids
 * that do not resolve come back under `missing`.
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

const INTERPRETED_AS = ['recid', 'doi', 'cms_dataset_path', 'doc_slug', 'unrecognized'] as const;

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
    if (html) lines.push('', `### ${heading}`, fenceHtml(html));
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

/** Each response surface, structuredContent JSON and content[] text with the notice, stays within this many UTF-8 bytes (Decision 50). */
const RESPONSE_BUDGET_BYTES = 64_000;

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

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

/** One fragment per returned body with more to read, then the deferral, if any. */
function responseNotice(records: readonly RecordOut[], deferredCount: number): string | undefined {
  const one = deferredCount === 1;
  return composeNotice([
    ...records.flatMap((record) => {
      const next = record.body_next_offset;
      if (next === undefined) return [];
      const slug = noticeValue(record.slug ?? record.id);
      return [
        `The body of ${slug} was cut at character ${next} of ${record.body_length}; call cern_opendata_get_records with ids ["${slug}"] and body_offset ${next} to continue it.`,
      ];
    }),
    deferredCount > 0
      ? `The response reached its 64,000-byte budget, so ${countOf(deferredCount, 'record')} ${one ? 'was' : 'were'} deferred; call cern_opendata_get_records with ids set to the deferred list to fetch ${one ? 'it' : 'them'}.`
      : undefined,
  ]);
}

/**
 * Admit records in response order while both surfaces stay within the budget,
 * stopping at the first record that would cross it; the first record is always
 * admitted whole. A record is charged the larger of its JSON and its rendered
 * text (plus its separator), and the rest of the response, the notice
 * included, is measured exactly for each prefix.
 */
function withinBudget(
  records: readonly RecordOut[],
  ids: readonly string[],
  missing: readonly MissingOut[],
): { deferred: string[]; notice: string | undefined; records: RecordOut[] } {
  const settle = (admitted: number) => {
    const left = new Set(records.slice(admitted).flatMap((record) => record.matched_inputs));
    const deferred = ids.filter((id) => left.has(id));
    const notice = responseNotice(records.slice(0, admitted), records.length - admitted);
    return { records: records.slice(0, admitted), deferred, notice };
  };
  const restBytes = ({ deferred, notice }: ReturnType<typeof settle>) =>
    Math.max(
      byteLength(JSON.stringify({ records: [], missing, deferred, notice })),
      byteLength(closingBlocks(missing, deferred).join('\n\n')) +
        (notice === undefined ? 0 : byteLength(`\n\n> ${notice}`)),
    );
  const cost = (record: RecordOut) =>
    Math.max(byteLength(JSON.stringify(record)) + 1, byteLength(renderRecord(record)) + 2);

  let admitted = Math.min(1, records.length);
  let spent = records[0] ? cost(records[0]) : 0;
  for (const record of records.slice(1)) {
    const total = spent + cost(record);
    if (restBytes(settle(admitted + 1)) + total > RESPONSE_BUDGET_BYTES) break;
    spent = total;
    admitted += 1;
  }
  return settle(admitted);
}

export const getRecords = tool('cern_opendata_get_records', {
  title: 'Get CERN Open Data Records',
  description:
    'Fetch full metadata for 1-20 records in one call, by recid, DOI, CMS dataset path (/Primary/Era/TIER) or documentation slug. Returns the description, run periods, collision and distribution details, related records, a software-environment summary, the license and a ready citation, plus what a record states of its variable dictionary, physics category, pile-up, keywords, and LHCb magnet polarity and stripping. Documentation and news pages include their markdown body in slices of at most 30,000 characters; body_offset with that one id reads on from where a slice stops. Each response holds to 64,000 bytes: records past it are left out whole and listed under deferred, to pass back as ids. File lists are not included; use cern_opendata_list_files. Identifiers that do not resolve come back under missing with guidance; they do not fail the call.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ids: requiredListInput(
      20,
      z
        .string()
        .max(500)
        .describe(
          'One identifier: a recid (6004 or atlas-160006, recid:6004 or a portal record URL), a DOI (10.7483/OPENDATA.CMS.YLIC.86ZZ, doi:… or a doi.org URL), a CMS dataset path (/DoubleMuParked/Run2012B-22Jan2013-v1/AOD) or a documentation slug (cms-guide-docker or its portal URL).',
        ),
      'At least one identifier is required (a recid, DOI, CMS dataset path or documentation slug); cern_opendata_search_records finds them.',
    ).describe(
      'Identifiers to resolve, 1-20: an array, or one comma-separated string. Forms may be mixed; duplicates collapse.',
    ),
    body_offset: blankAsUnset(z.number().int().min(0).default(0)).describe(
      "With exactly one documentation or news id: where its body slice starts, in characters (UTF-16 code units), usually the body_next_offset an earlier call returned. 0 (the default) is the body's start and is accepted with any ids; above 0 needs exactly one id.",
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
        'Inputs whose records were left out to hold the response to 64,000 bytes, in input order; pass them as ids to fetch those records. Empty when every resolved record is returned.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Caveats about the returned records: a documentation body with more to read, or records deferred by the response budget, each with the call that continues it.',
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
    const classified = input.ids.map(classifyIdentifier);
    const service = getCernOpenDataService();
    const { matches, missing } = await service.lookup(classified, service.startBudget(), ctx);
    const resolved = matches.map((match) => toRecord(match.hit, match.matchedInputs, offset));

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
    const { records, deferred, notice } = withinBudget(resolved, input.ids, missingOut);
    if (notice) ctx.enrich.notice(notice);

    ctx.log.info('Records resolved', {
      requested: classified.length,
      resolved: resolved.length,
      returned: records.length,
      deferred: resolved.length - records.length,
      missing: missing.length,
    });
    return { records, missing: missingOut, deferred };
  },

  format: (result) => {
    const blocks = result.records.map(renderRecord);
    if (result.records.length === 0) blocks.push('No identifier resolved to a record.');
    blocks.push(...closingBlocks(result.missing, result.deferred));
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
