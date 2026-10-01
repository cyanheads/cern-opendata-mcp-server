/**
 * @fileoverview cern_opendata_get_analysis_env — assemble what is needed to
 * analyse one record: its container images, CMSSW release and global tag; the
 * condition, VM and validation records for its run periods and the software
 * that declares it works with the record (one search); and quoted sections of
 * the first two guides the record links (one doc GET each). Legs 2 and 3 run
 * together after the record lookup and degrade with a notice.
 * @module mcp-server/tools/definitions/get-analysis-env.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { RecordTypeSchema } from '@/mcp-server/record-schema.js';
import { getCernOpenDataService } from '@/services/cern-opendata/cern-opendata-service.js';
import {
  definedOnly,
  pathSegment,
  portalUrlOf,
  recordTypeOf,
  str,
  strList,
  systemDetailsOf,
} from '@/services/cern-opendata/normalize.js';
import {
  absoluteUrl,
  capText,
  fence,
  fenceHtml,
  inline,
  inlineList,
  inlineOrNA,
  NOT_AVAILABLE,
  noticeValue,
  printUrl,
} from '@/services/cern-opendata/text.js';
import type { RawHit, RawLink } from '@/services/cern-opendata/types.js';
import { composeNotice } from '../enrichment.js';
import { recidInput } from '../inputs.js';

/** Leg-2 page size: linked environment and software records shown. */
const LINKED_CAP = 50;
/** Guides fetched per call (Decision 18). */
const GUIDES_FETCHED = 2;
/** Quoted guide sections are cut at this many characters (Decision 18). */
const SECTION_MAX_CHARS = 12_000;
/** Only run periods of this shape enter the leg-2 query, so record data cannot break it. */
const QUERYABLE_RUN_PERIOD = /^[A-Za-z0-9_.-]+$/;
/** A portal doc link, relative or absolute: slug and optional fragment. */
const DOC_LINK =
  /^(?:https?:\/\/opendata\.cern\.ch)?\/docs\/([^/?#\s]+)\/?(?:\?[^#]*)?(?:#(.*))?$/i;
/** A fragment that can name a guide section; any other fragment is read as no anchor. */
const GUIDE_ANCHOR = /^[A-Za-z0-9_.:-]{1,100}$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

const LICENSE_NOTE =
  'Container images, software and guide code are licensed separately from the CC0 data; each software record states its own license.';

/** A `Map`, so a secondary type named like an object member (`constructor`) reads as `other`. */
const ENVIRONMENT_KINDS = new Map<string, 'condition' | 'vm' | 'validation'>([
  ['Condition', 'condition'],
  ['VM', 'vm'],
  ['Validation', 'validation'],
]);

/** The heading level of a markdown line, or `undefined` when it is not a heading. */
function headingLevel(line: string): number | undefined {
  return HEADING.exec(line)?.[1]?.length;
}

/** For each line of a markdown body: its heading level, ignoring lines inside fenced code blocks. */
function headingLevels(lines: readonly string[]): (number | undefined)[] {
  const levels: (number | undefined)[] = [];
  let open: string | undefined;
  for (const line of lines) {
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (open) {
      if (marker && marker[0] === open[0] && marker.length >= open.length) open = undefined;
      levels.push(undefined);
    } else if (marker) {
      open = marker;
      levels.push(undefined);
    } else {
      levels.push(headingLevel(line));
    }
  }
  return levels;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `line` holds an `<a>` tag whose `name` or `id` attribute is the
 * anchor `value` matches (a sticky regex: the anchor, then a quote, space, `/`,
 * `>` or the line's end), quoted or not. Tag by tag: an attribute must start
 * before its tag's first `>`, so a tag with no `>` is read to the line's end once.
 */
function hasAnchorTag(line: string, value: RegExp): boolean {
  let resume = 0;
  for (const open of line.matchAll(/<a\s/gi)) {
    if (open.index < resume) continue;
    const start = open.index + open[0].length;
    const tagEnd = line.indexOf('>', start);
    const tag = line.slice(start, tagEnd < 0 ? undefined : tagEnd);
    for (const attr of tag.matchAll(/\b(?:name|id)\s*=\s*(["']?)/gi)) {
      const valueStart = start + attr.index + attr[0].length;
      for (const at of attr[1] ? [valueStart, valueStart - 1] : [valueStart]) {
        value.lastIndex = at;
        if (value.test(line)) return true;
      }
    }
    if (tagEnd < 0) return false;
    resume = tagEnd;
  }
  return false;
}

/**
 * The section a guide link points at. With an anchor: from the heading line
 * holding `<a name="{anchor}">` to the next heading of the same or higher
 * level. Without one (or when the anchor is absent): from the start to the
 * second level-2 heading. `anchored` says whether the anchor was found.
 */
function extractSection(body: string, anchor: string | undefined) {
  const lines = body.split(/\r?\n/);
  const levels = headingLevels(lines);
  if (anchor) {
    const value = new RegExp(`${escapeRegExp(anchor)}(?:["'\\s/>]|$)`, 'iy');
    const start = lines.findIndex(
      (line, i) => levels[i] !== undefined && hasAnchorTag(line, value),
    );
    const level = start >= 0 ? levels[start] : undefined;
    if (level !== undefined) {
      const after = levels.findIndex((l, i) => i > start && l !== undefined && l <= level);
      return {
        text: lines.slice(start, after < 0 ? undefined : after).join('\n'),
        anchored: true,
      };
    }
  }
  let seen = 0;
  const end = levels.findIndex((l) => l === 2 && ++seen === 2);
  return { text: lines.slice(0, end < 0 ? undefined : end).join('\n'), anchored: false };
}

/**
 * A `usage.links` entry pointing at a portal doc page: its slug and anchor. A
 * slug of `.` or `..` is no doc link; a fragment that is not an anchor name
 * is no anchor.
 */
function docLinkOf(url: string): { slug: string; anchor?: string } | undefined {
  const match = DOC_LINK.exec(url.trim());
  const slug = pathSegment(match?.[1]);
  if (!slug) return;
  const anchor = match?.[2]?.trim();
  return anchor && GUIDE_ANCHOR.test(anchor) ? { slug, anchor } : { slug };
}

/** A short label for why a degraded leg failed. */
function failureLabel(error: unknown): string {
  if (error instanceof McpError) {
    const reason = error.data?.reason;
    return typeof reason === 'string' ? reason : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Upstream failures leg 2 degrades on; anything else (a 400 on a built query, a bug) fails the call. */
function isDegradable(error: unknown): boolean {
  return (
    error instanceof McpError &&
    (error.code === JsonRpcErrorCode.RateLimited ||
      error.code === JsonRpcErrorCode.ServiceUnavailable ||
      error.code === JsonRpcErrorCode.Timeout)
  );
}

const EnvironmentRecordSchema = z
  .object({
    recid: z.string().describe('Recid of the environment record.'),
    title: z.string().optional().describe('Record title.'),
    kind: z
      .enum(['condition', 'vm', 'validation', 'other'])
      .describe(
        'From the secondary type: condition data, virtual machine, validated-run list, or other.',
      ),
    run_period: z
      .array(z.string().describe('One run period.'))
      .optional()
      .describe('Run periods the record covers.'),
    portal_url: z.string().describe('The record page on the portal.'),
  })
  .describe('One Environment record for this record (condition data, VM, validation).');

const ExampleSoftwareSchema = z
  .object({
    recid: z.string().describe('Recid of the software record.'),
    title: z.string().optional().describe('Record title.'),
    secondary: z
      .array(z.string().describe('One secondary type.'))
      .describe('Secondary types, such as Analysis or Validation; empty when none.'),
    license_id: z
      .string()
      .optional()
      .describe('License the software record states (such as GPL-3.0-only); absent when none.'),
    source_code_repository_url: z
      .string()
      .optional()
      .describe('Source code repository URL, when stated.'),
    portal_url: z.string().describe('The record page on the portal.'),
  })
  .describe('One Software record that declares it works with this record.');

const GuideSchema = z
  .object({
    slug: z.string().describe('Doc slug; pass it to cern_opendata_get_records for the full page.'),
    url: z.string().describe('The guide link, absolute.'),
    link_description: z.string().optional().describe('The link text the record gives the guide.'),
    anchor: z.string().optional().describe('Section anchor the link points at, when it has one.'),
    title: z.string().optional().describe('Guide title, when fetched.'),
    section: z
      .string()
      .optional()
      .describe(
        'The linked section (or the opening section) as markdown, as the portal sent it; at most 12,000 characters.',
      ),
    section_truncated: z
      .boolean()
      .optional()
      .describe('True when the section was cut at 12,000 characters.'),
    fetched: z
      .boolean()
      .describe(
        'False when the guide was not fetched (only the first two are) or was not found; notice says which.',
      ),
  })
  .describe('One portal guide the record links in its usage section.');

const GetAnalysisEnvOutput = z.object({
  recid: z.string().describe('The record id.'),
  title: z.string().optional().describe('Record title.'),
  type: RecordTypeSchema,
  experiment: z
    .array(z.string().describe('One experiment.'))
    .optional()
    .describe('Experiments the record belongs to.'),
  run_period: z
    .array(z.string().describe('One run period.'))
    .optional()
    .describe('Run periods the record covers, such as Run2012B.'),
  software: z
    .object({
      release: z.string().optional().describe('Software release, such as CMSSW_5_3_32.'),
      global_tag: z.string().optional().describe('Conditions global tag.'),
      container_images: z
        .array(
          z
            .object({
              name: z.string().describe('Image name.'),
              registry: z.string().optional().describe('Image registry, when stated.'),
            })
            .describe('One container image.'),
        )
        .describe('Container images for the environment; empty when the record lists none.'),
      environment_recid: z
        .string()
        .optional()
        .describe('Recid of the environment (VM or container) record, when stated.'),
      description: z
        .string()
        .optional()
        .describe('Environment description as the portal sent it (HTML).'),
    })
    .describe("The record's own software environment (system_details)."),
  environment_records: z
    .array(EnvironmentRecordSchema)
    .describe('Condition, VM and validation records for the run periods, and others linking here.'),
  example_software: z
    .array(ExampleSoftwareSchema)
    .describe('Software records that declare they work with this record.'),
  guides: z.array(GuideSchema).describe('Every portal guide linked in the usage section.'),
  other_links: z
    .array(
      z
        .object({
          url: z.string().describe('Link URL, absolute.'),
          description: z.string().optional().describe('Link text.'),
        })
        .describe('One link.'),
    )
    .describe('The other usage links (getting-started pages and the like).'),
  separately_licensed: z
    .literal(true)
    .describe('Always true: images, software and guide code are licensed apart from the CC0 data.'),
  license_note: z.string().describe('How the environment is licensed.'),
});

type GetAnalysisEnvOut = z.infer<typeof GetAnalysisEnvOutput>;
type EnvironmentRecordOut = z.infer<typeof EnvironmentRecordSchema>;
type ExampleSoftwareOut = z.infer<typeof ExampleSoftwareSchema>;
type GuideOut = z.infer<typeof GuideSchema>;

function toEnvironmentRecord(hit: RawHit): EnvironmentRecordOut {
  const meta = hit.metadata;
  const secondary = recordTypeOf(meta).secondary;
  return definedOnly<EnvironmentRecordOut>({
    recid: str(meta.recid) ?? String(hit.id),
    title: str(meta.title),
    kind: secondary.map((s) => ENVIRONMENT_KINDS.get(s)).find(Boolean) ?? 'other',
    run_period: strList(meta.run_period),
    portal_url: portalUrlOf(hit),
  });
}

function toExampleSoftware(hit: RawHit): ExampleSoftwareOut {
  const meta = hit.metadata;
  return definedOnly<ExampleSoftwareOut>({
    recid: str(meta.recid) ?? String(hit.id),
    title: str(meta.title),
    secondary: recordTypeOf(meta).secondary,
    license_id: str(meta.license?.attribution),
    source_code_repository_url: str(meta.source_code_repository?.url),
    portal_url: portalUrlOf(hit),
  });
}

function renderType(type: GetAnalysisEnvOut['type']): string {
  const primary = type.primary ? inline(type.primary) : NOT_AVAILABLE;
  return type.secondary.length > 0
    ? `${primary} (${type.secondary.map(inline).join(', ')})`
    : primary;
}

function renderGuide(guide: GuideOut): string[] {
  const lines = [
    `#### ${inline(guide.slug)}${guide.anchor ? ` § ${inline(guide.anchor)}` : ''}`,
    `**URL:** ${printUrl(guide.url)} · **Link text:** ${inlineOrNA(guide.link_description)} · **Anchor:** ${inlineOrNA(guide.anchor)}`,
    `**Title:** ${inlineOrNA(guide.title)} · **Fetched:** ${guide.fetched ? 'yes' : 'no'}${guide.section_truncated === undefined ? '' : ` · **Section cut at 12,000 characters:** ${guide.section_truncated ? 'yes' : 'no'}`}`,
  ];
  if (guide.section) lines.push(fence(guide.section));
  return lines;
}

export const getAnalysisEnv = tool('cern_opendata_get_analysis_env', {
  title: 'Get CERN Open Data Analysis Environment',
  description:
    "Assemble what is needed to analyse a record: its container images, CMSSW release and global tag; the condition-data, VM and validated-run records for its run periods; example software that declares it works with the record; and quoted sections of the guides the record links (the first two are fetched). Container images, software and guide code are licensed separately from the CC0 data. Use cern_opendata_list_files for the record's files.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    recid: recidInput().describe(
      'Record id: up to 12 digits (6004), recid:6004, or a portal record URL. cern_opendata_search_records and cern_opendata_get_records return it.',
    ),
  }),
  output: GetAnalysisEnvOutput,
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'What could not be assembled and how to get it: an empty environment, linked records that could not be read, guides not fetched or cut, or more linked records than shown.',
      ),
  },
  errors: [
    {
      reason: 'record_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record has this recid.',
      recovery:
        "Call cern_opendata_search_records to find the record's recid, then call cern_opendata_get_analysis_env with it.",
      severity: 'notice',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The portal's 60-a-minute budget is spent: it answered 429, or the request could not start within the call's deadline. data.retryAfter is set.",
      recovery:
        'Wait the retryAfter seconds given in this error (the portal allows 60 requests a minute per IP), then call cern_opendata_get_analysis_env again with the same arguments.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The portal answered with a body the server could not read: not JSON, missing the expected envelope, or over the byte ceiling (then data.retryable is false). Also raised when a search answers 404.',
      recovery:
        'Call cern_opendata_get_analysis_env again in a minute; if it repeats, the portal is serving an error page or an oversized response, so read the same data on https://opendata.cern.ch instead.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const service = getCernOpenDataService();
    const budget = service.startBudget();
    const { recid } = input;

    const record = await service.findRecord(recid, budget, ctx);
    if (!record) {
      throw ctx.fail('record_not_found', `No record has recid ${recid}.`, { recid });
    }
    const meta = record.metadata;
    const experiment = strList(meta.experiment);
    const runPeriod = strList(meta.run_period);

    const links: RawLink[] = Array.isArray(meta.usage?.links) ? meta.usage.links : [];
    const guides: GuideOut[] = [];
    const otherLinks: GetAnalysisEnvOut['other_links'] = [];
    for (const link of links) {
      const url = str(link?.url);
      if (!url) continue;
      const description = str(link.description);
      const doc = docLinkOf(url);
      if (doc) {
        guides.push(
          definedOnly<GuideOut>({
            slug: doc.slug,
            url: absoluteUrl(url.trim()),
            link_description: description,
            anchor: doc.anchor,
            title: undefined,
            section: undefined,
            section_truncated: undefined,
            fetched: false,
          }),
        );
      } else {
        otherLinks.push(
          definedOnly<GetAnalysisEnvOut['other_links'][number]>({
            url: absoluteUrl(url.trim()),
            description,
          }),
        );
      }
    }
    const fetchSlugs = [...new Set(guides.slice(0, GUIDES_FETCHED).map((guide) => guide.slug))];

    const periods = (runPeriod ?? []).filter((period) => QUERYABLE_RUN_PERIOD.test(period));
    const q =
      periods.length > 0
        ? `use_with.links.recid:${recid} OR (type.primary:Environment AND run_period:(${periods.map((p) => `"${p}"`).join(' OR ')}))`
        : `use_with.links.recid:${recid}`;
    const [linkedOutcome, ...docOutcomes] = await Promise.allSettled([
      service.searchBuilt(
        {
          q,
          ...(experiment?.[0] ? { experiment: [experiment[0]] } : {}),
          size: LINKED_CAP,
          skipFiles: true,
        },
        budget,
        ctx,
      ),
      ...fetchSlugs.map((slug) => service.getDoc(slug, budget, ctx)),
    ]);
    if (ctx.signal.aborted) {
      const rejected = [linkedOutcome, ...docOutcomes].find((o) => o.status === 'rejected');
      throw rejected?.status === 'rejected' ? rejected.reason : ctx.signal.reason;
    }

    const fragments: string[] = [];
    let linkedHits: RawHit[] = [];
    let linkedTotal = 0;
    let degraded = false;
    if (linkedOutcome.status === 'fulfilled') {
      linkedHits = linkedOutcome.value.hits.filter(
        (hit) => (str(hit.metadata.recid) ?? String(hit.id)) !== recid,
      );
      linkedTotal = linkedOutcome.value.total;
    } else if (isDegradable(linkedOutcome.reason)) {
      degraded = true;
      const reason = failureLabel(linkedOutcome.reason);
      ctx.log.warning('Linked environment and software records could not be read', {
        recid,
        reason,
      });
      fragments.push(
        `Linked environment and software records could not be read (${noticeValue(reason)}); call cern_opendata_get_analysis_env again in a minute.`,
      );
    } else {
      throw linkedOutcome.reason;
    }

    /** One notice fragment per guide slug and state, in link order. */
    const guideNotes = new Map<string, string>();
    const noteGuide = (slug: string, what: string) =>
      guideNotes.set(
        `${slug}\n${what}`,
        `Guide ${noticeValue(slug)} ${what}; call cern_opendata_get_records with ids ["${noticeValue(slug)}"] for the page body.`,
      );
    const resolvedGuides = guides.map((guide, i) => {
      const outcome = i < GUIDES_FETCHED ? docOutcomes[fetchSlugs.indexOf(guide.slug)] : undefined;
      if (outcome?.status !== 'fulfilled') {
        noteGuide(guide.slug, 'was not fetched');
        return guide;
      }
      const doc = outcome.value;
      if (!doc) {
        noteGuide(guide.slug, 'was not found');
        return guide;
      }
      const body = str(doc.metadata.body?.content);
      const extracted = body === undefined ? undefined : extractSection(body, guide.anchor);
      const capped =
        extracted === undefined ? undefined : capText(extracted.text, SECTION_MAX_CHARS);
      if (capped?.truncated) noteGuide(guide.slug, 'was cut at 12,000 characters');
      if (guide.anchor && extracted && !extracted.anchored) {
        fragments.push(
          `Guide ${noticeValue(guide.slug)} has no section anchored ${noticeValue(guide.anchor)}; its opening section is quoted instead.`,
        );
      }
      return definedOnly<GuideOut>({
        slug: guide.slug,
        url: guide.url,
        link_description: guide.link_description,
        anchor: guide.anchor,
        title: str(doc.metadata.title),
        section: capped?.text,
        section_truncated: capped?.truncated,
        fetched: true,
      });
    });
    fragments.push(...guideNotes.values());

    const environmentRecords = linkedHits
      .filter((hit) => hit.metadata.type?.primary === 'Environment')
      .map(toEnvironmentRecord);
    const exampleSoftware = linkedHits
      .filter((hit) => hit.metadata.type?.primary === 'Software')
      .map(toExampleSoftware);
    const details = systemDetailsOf(meta);

    if (!details && linkedHits.length === 0 && guides.length === 0 && !degraded) {
      fragments.unshift(
        "This record lists no software environment, and no environment or software record links to it; call cern_opendata_search_records with type Environment and the record's experiment to browse environments.",
      );
    }
    if (linkedTotal > LINKED_CAP) {
      fragments.push(
        `${linkedTotal} records link to this one and only ${LINKED_CAP} are shown; call cern_opendata_search_records with query use_with.links.recid:${recid} for the rest.`,
      );
    }
    const notice = composeNotice(fragments);
    if (notice) ctx.enrich.notice(notice);

    return definedOnly<GetAnalysisEnvOut>({
      recid,
      title: str(meta.title),
      type: recordTypeOf(meta),
      experiment,
      run_period: runPeriod,
      software: definedOnly<GetAnalysisEnvOut['software']>({
        release: details?.release,
        global_tag: details?.global_tag,
        container_images: details?.container_images ?? [],
        environment_recid: details?.environment_recid,
        description: details?.description,
      }),
      environment_records: environmentRecords,
      example_software: exampleSoftware,
      guides: resolvedGuides,
      other_links: otherLinks,
      separately_licensed: true,
      license_note: LICENSE_NOTE,
    });
  },

  format: (result) => {
    const { software } = result;
    const lines = [
      `## Analysis environment for record ${inline(result.recid)}: ${inlineOrNA(result.title)}`,
      `**Type:** ${renderType(result.type)} · **Experiment:** ${inlineList(result.experiment)} · **Run periods:** ${inlineList(result.run_period)}`,
      '',
      '### Software',
      `**Release:** ${inlineOrNA(software.release)} · **Global tag:** ${inlineOrNA(software.global_tag)} · **Environment record:** ${inlineOrNA(software.environment_recid)}`,
    ];
    if (software.container_images.length > 0) {
      lines.push(
        '**Container images:**',
        ...software.container_images.map(
          (image) => `- ${inline(image.name)} (registry: ${inlineOrNA(image.registry)})`,
        ),
      );
    } else {
      lines.push('**Container images:** none listed');
    }
    if (software.description) {
      lines.push('**Environment description:**', fenceHtml(software.description));
    }

    lines.push('', `### Environment records (${result.environment_records.length})`);
    if (result.environment_records.length === 0) lines.push('None found.');
    else {
      lines.push(
        '| Recid | Kind | Title | Run periods | Portal |',
        '|:------|:-----|:------|:------------|:-------|',
        ...result.environment_records.map(
          (env) =>
            `| ${inline(env.recid)} | ${env.kind} | ${inlineOrNA(env.title)} | ${inlineList(env.run_period)} | ${printUrl(env.portal_url)} |`,
        ),
      );
    }

    lines.push('', `### Example software (${result.example_software.length})`);
    if (result.example_software.length === 0) lines.push('None found.');
    else {
      lines.push(
        '| Recid | Title | Secondary | License | Source code | Portal |',
        '|:------|:------|:----------|:--------|:------------|:-------|',
        ...result.example_software.map(
          (sw) =>
            `| ${inline(sw.recid)} | ${inlineOrNA(sw.title)} | ${inlineList(sw.secondary)} | ${inlineOrNA(sw.license_id)} | ${sw.source_code_repository_url ? printUrl(sw.source_code_repository_url) : NOT_AVAILABLE} | ${printUrl(sw.portal_url)} |`,
        ),
      );
    }

    lines.push('', `### Guides (${result.guides.length})`);
    if (result.guides.length === 0) lines.push('None linked.');
    for (const guide of result.guides) lines.push(...renderGuide(guide));

    lines.push('', `### Other links (${result.other_links.length})`);
    if (result.other_links.length === 0) lines.push('None.');
    for (const link of result.other_links) {
      lines.push(`- ${printUrl(link.url)}: ${inlineOrNA(link.description)}`);
    }

    lines.push(
      '',
      `**Separately licensed:** ${result.separately_licensed ? 'yes' : 'no'}. ${result.license_note}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
