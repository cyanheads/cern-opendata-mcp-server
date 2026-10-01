/**
 * @fileoverview The Record output schema shared by `cern_opendata_get_records`
 * (one entry of `records[]`) and the `cern-opendata://record/{recid}`
 * resource. Mirrors `RecordShape` in the service types; strings are relayed as
 * the portal sent them, and absent upstream fields are omitted, never defaulted.
 * @module mcp-server/record-schema
 */

import { z } from '@cyanheads/mcp-ts-core';

/** File counts by availability state, `{ online?, on_demand? }`. */
export const AvailabilityCountsSchema = z
  .object({
    online: z.number().optional().describe('Files on disk, downloadable now.'),
    on_demand: z
      .number()
      .optional()
      .describe("Files on tape, requested on the record's portal page before download."),
  })
  .describe('File counts by availability state, as the portal reports them.');

/** A record's type: `{ primary, secondary[] }`. */
export const RecordTypeSchema = z
  .object({
    primary: z
      .string()
      .describe(
        'Primary type: Dataset, Software, Environment, Documentation, Supplementaries or News. Empty when the record states none.',
      ),
    secondary: z
      .array(z.string().describe('One secondary type.'))
      .describe('Secondary types, such as Collision or Simulated; empty when none.'),
  })
  .describe('Record type as the portal classifies it.');

/** The Record shape (one `cern_opendata_get_records` entry, or the record resource). */
export const RecordSchema = z
  .object({
    id: z
      .string()
      .describe('Portal id: the recid for records, the slug for documentation and news.'),
    kind: z
      .enum(['record', 'doc'])
      .describe('doc for documentation and news pages (they carry a slug), record otherwise.'),
    recid: z.string().optional().describe('Record id (digits); absent on docs and news.'),
    slug: z.string().optional().describe('Documentation or news slug; absent on records.'),
    matched_inputs: z
      .array(z.string().describe('One input id.'))
      .describe('The requested ids that resolved to this record, as given.'),
    title: z.string().optional().describe('Title as the portal states it.'),
    title_additional: z
      .string()
      .optional()
      .describe('Descriptive secondary title; used in the citation when present.'),
    type: RecordTypeSchema,
    experiment: z
      .array(z.string().describe('One experiment name.'))
      .optional()
      .describe('Experiments, such as CMS or ATLAS.'),
    collections: z
      .array(z.string().describe('One collection name.'))
      .optional()
      .describe('Portal collections, exact and case-sensitive (the search collection filter).'),
    date_created: z
      .array(z.string().describe('One year or date.'))
      .optional()
      .describe('Data-taking or creation years.'),
    run_period: z
      .array(z.string().describe('One run period.'))
      .optional()
      .describe('Run periods, such as Run2012B.'),
    run_numbers: z
      .array(z.string().describe('One run number.'))
      .optional()
      .describe('Run numbers the record covers, as strings.'),
    collaboration: z
      .object({
        name: z.string().describe('Collaboration name.'),
        recid: z.string().optional().describe('Record id of the collaboration page.'),
      })
      .optional()
      .describe('The collaboration that released the record.'),
    authors: z
      .array(
        z
          .object({
            name: z.string().describe('Author name.'),
            orcid: z.string().optional().describe('ORCID iD, when the record states one.'),
          })
          .describe('One author.'),
      )
      .optional()
      .describe('Authors; a news page author string becomes one entry.'),
    doi: z.string().optional().describe('DOI to cite, such as 10.7483/OPENDATA.CMS.YLIC.86ZZ.'),
    date_published: z.string().optional().describe('Publication date on the portal.'),
    date_reprocessed: z.string().optional().describe('Reprocessing date, for reprocessed data.'),
    availability: z
      .string()
      .optional()
      .describe('Record-level availability: online, partial, ondemand or requested.'),
    collision_energy: z.string().optional().describe('Collision energy, such as 8TeV.'),
    collision_type: z.string().optional().describe('Collision type, such as pp or PbPb.'),
    distribution: z
      .object({
        formats: z
          .array(z.string().describe('One file format or data tier.'))
          .describe('File formats and data tiers, such as aod or nanoaod; empty when none.'),
        number_events: z.number().optional().describe('Number of events.'),
        number_files: z.number().optional().describe('Number of files.'),
        size_in_bytes: z.number().optional().describe('Total size in bytes.'),
      })
      .optional()
      .describe('Distribution summary: formats, events, files and size.'),
    availability_details: AvailabilityCountsSchema.optional().describe(
      'File counts by availability state (online, on demand), as the portal reports them.',
    ),
    abstract_html: z.string().optional().describe('Abstract, HTML as the portal sent it.'),
    methodology_html: z.string().optional().describe('Methodology, HTML as the portal sent it.'),
    usage_html: z.string().optional().describe('Usage instructions, HTML as the portal sent it.'),
    validation_html: z
      .string()
      .optional()
      .describe('Validation notes, HTML as the portal sent it.'),
    note_html: z.string().optional().describe('Notes, HTML as the portal sent it.'),
    use_with_html: z
      .string()
      .optional()
      .describe('What the record is used with, HTML as the portal sent it.'),
    links: z
      .array(
        z
          .object({
            source: z
              .enum(['abstract', 'note', 'usage', 'validation', 'use_with', 'software'])
              .describe('The metadata section the link came from.'),
            recid: z.string().optional().describe('Linked record id.'),
            url: z.string().optional().describe('Linked URL; portal-relative paths start with /.'),
            description: z.string().optional().describe('Link text as the portal states it.'),
          })
          .describe('One link.'),
      )
      .describe(
        'Links from the abstract, note, usage, validation and use_with sections and software links; empty when none.',
      ),
    relations: z
      .array(
        z
          .object({
            type: z
              .string()
              .describe(
                'Relation type as the portal states it (isParentOf, isChildOf, isRelatedTo); the portal applies it inconsistently.',
              ),
            recid: z.string().optional().describe('Related record id.'),
            doi: z.string().optional().describe('Related record DOI.'),
            title: z.string().optional().describe('Related record title.'),
            description: z.string().optional().describe('Relation description.'),
          })
          .describe('One related record.'),
      )
      .describe('Related records, relayed verbatim; empty when none.'),
    system_details: z
      .object({
        release: z.string().optional().describe('Software release, such as a CMSSW version.'),
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
          .optional()
          .describe('Container images for the analysis environment (separately licensed).'),
        environment_recid: z
          .string()
          .optional()
          .describe('Record id of the environment record the portal names.'),
        description: z
          .string()
          .optional()
          .describe('Environment description, HTML as the portal sent it.'),
      })
      .optional()
      .describe('Software environment summary; cern_opendata_get_analysis_env expands it.'),
    source_code_repository_url: z.string().optional().describe('Source code repository URL.'),
    dataset_semantics: z
      .object({
        html_url: z.string().optional().describe('Dataset semantics page (HTML).'),
        json_url: z.string().optional().describe('Dataset semantics (JSON).'),
      })
      .optional()
      .describe('Variable descriptions for the dataset, on the portal.'),
    short_description: z
      .string()
      .optional()
      .describe('Docs and news: the short description, as received.'),
    tags: z.array(z.string().describe('One tag.')).optional().describe('Docs and news: tags.'),
    body: z
      .string()
      .optional()
      .describe('Docs and news: the page body (markdown), cut at 30,000 characters.'),
    body_format: z.string().optional().describe('Docs and news: body format, such as md.'),
    body_length: z
      .number()
      .optional()
      .describe('Docs and news: original body length in characters.'),
    body_truncated: z
      .boolean()
      .optional()
      .describe('Docs and news: true when the body was cut at 30,000 characters.'),
    license: z
      .object({
        id: z.string().optional().describe('SPDX-style license id, such as CC0-1.0.'),
        basis: z
          .enum(['record', 'cern_terms_default', 'not_stated'])
          .describe(
            'record: stated on the record; cern_terms_default: a Dataset with no license of its own, CC0 under the CERN Open Data Terms of Use; not_stated: no license stated.',
          ),
        statement: z.string().describe('The license statement to relay.'),
      })
      .describe('License of the record content.'),
    citation: z
      .object({
        text: z.string().describe('Ready citation built from the record fields.'),
        doi: z.string().describe('The DOI to cite.'),
        request: z.string().describe("CERN's citation request."),
      })
      .optional()
      .describe('Citation; present only when the record has a DOI.'),
    portal_url: z.string().describe('The record or documentation page on opendata.cern.ch.'),
  })
  .describe('One record with its metadata, license and citation; file lists are not included.');
