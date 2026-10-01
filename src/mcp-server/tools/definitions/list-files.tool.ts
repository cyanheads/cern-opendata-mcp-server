/**
 * @fileoverview cern_opendata_list_files — page through one record's file
 * manifest: its file indexes with URI-list URLs, and per file the XRootD URI,
 * HTTPS download URL, size, checksum and availability. Reads the record once
 * (cached as a compact manifest) and pages locally with an opaque cursor.
 * @module mcp-server/tools/definitions/list-files.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { AvailabilityCountsSchema } from '@/mcp-server/record-schema.js';
import { getCernOpenDataService } from '@/services/cern-opendata/cern-opendata-service.js';
import { definedOnly, recordUrl } from '@/services/cern-opendata/normalize.js';
import {
  countOf,
  inline,
  inlineOrNA,
  NOT_AVAILABLE,
  oneLine,
  PORTAL_ORIGIN,
  printUrl,
} from '@/services/cern-opendata/text.js';
import type { CompactFile, CompactIndex } from '@/services/cern-opendata/types.js';
import {
  composeNotice,
  finishListEnrichment,
  listEnrichment,
  startListEnrichment,
} from '../enrichment.js';
import { blankAsUnset, recidInput } from '../inputs.js';

/** Child recids named in the umbrella-record notice. */
const CHILDREN_NAMED = 5;

/** The decoded `cursor`: recid, index key (`null` in record scope) and offset. */
const CursorSchema = z.object({
  r: z.string(),
  i: z.string().nullable(),
  o: z.number().int().min(0),
});

type FilesCursor = z.infer<typeof CursorSchema>;

function encodeCursor(cursor: FilesCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** The cursor's fields, or `undefined` when it is not base64url JSON of the expected shape. */
function decodeCursor(raw: string): FilesCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return;
  }
  const parsed = CursorSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** A file key as a URL path: each `/`-separated segment percent-encoded. */
function keyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function fileUrl(recid: string, key: string): string {
  return `${PORTAL_ORIGIN}/record/${encodeURIComponent(recid)}/files/${keyPath(key)}`;
}

function indexUrl(recid: string, key: string, extension: 'txt' | 'json'): string {
  const keyed = key.replace(/\.(?:json|txt)$/i, '');
  return `${PORTAL_ORIGIN}/record/${encodeURIComponent(recid)}/file_index/${keyPath(`${keyed}.${extension}`)}`;
}

function toFileOut(recid: string, file: CompactFile) {
  return definedOnly<FileOut>({
    key: file.key,
    filename: file.filename,
    size_in_bytes: file.size,
    checksum: file.checksum,
    xrootd_uri: file.uri,
    https_url: fileUrl(recid, file.key),
    availability: file.availability,
  });
}

function toIndexOut(recid: string, index: CompactIndex) {
  return definedOnly<IndexOut>({
    key: index.key,
    description: index.description,
    number_files: index.number_files,
    size_in_bytes: index.size,
    availability: index.availability,
    uri_list_url: indexUrl(recid, index.key, 'txt'),
    json_url: indexUrl(recid, index.key, 'json'),
  });
}

const FileSchema = z
  .object({
    key: z.string().describe('File key; index members read <index>.json_<n>.'),
    filename: z.string().optional().describe('Real file name, for index members.'),
    size_in_bytes: z.number().describe('File size in bytes.'),
    checksum: z.string().optional().describe('Checksum, such as adler32:1a2b3c4d.'),
    xrootd_uri: z.string().describe('XRootD URI (root://eospublic.cern.ch//eos/opendata/…).'),
    https_url: z.string().describe('HTTPS download URL on the portal.'),
    availability: z
      .string()
      .optional()
      .describe('online, or on demand (on tape; request it on the record page first).'),
  })
  .describe('One file.');

const IndexSchema = z
  .object({
    key: z.string().describe('Index key (…_file_index.json); pass it as index to page its files.'),
    description: z.string().optional().describe('Index description as the portal states it.'),
    number_files: z.number().describe('Files in the index.'),
    size_in_bytes: z.number().describe('Total size of the index files in bytes.'),
    availability: AvailabilityCountsSchema,
    uri_list_url: z
      .string()
      .describe('Plain-text list of every XRootD URI in the index, one per line.'),
    json_url: z.string().describe('The index entry with its files, as JSON.'),
  })
  .describe('One file index (a group of files).');

const ListFilesOutput = z.object({
  recid: z.string().describe('The record id.'),
  title: z.string().optional().describe('Record title.'),
  availability: z
    .string()
    .optional()
    .describe('Record-level availability: online, partial, ondemand or requested.'),
  availability_details: AvailabilityCountsSchema.optional().describe(
    'File counts by availability state for the whole record.',
  ),
  scope: z
    .enum(['record', 'index'])
    .describe("record: the record's indexes and regular files; index: one index's files."),
  indexes: z
    .array(IndexSchema)
    .describe('Every file index in record scope; only the selected one in index scope.'),
  files: z
    .array(FileSchema)
    .describe(
      "This page of files: regular files in record scope, the index's files in index scope.",
    ),
  children: z
    .array(z.string().describe('One child recid.'))
    .describe(
      'Set only for an umbrella record holding no files itself: the child recids whose files make it up. Empty otherwise.',
    ),
  has_more: z.boolean().describe('True when more files remain past this page.'),
  next_cursor: z
    .string()
    .optional()
    .describe('Pass as cursor, with the same recid and index, for the next page.'),
  portal_url: z.string().describe('The record page, where on-demand (tape) files are requested.'),
});

type FileOut = z.infer<typeof FileSchema>;
type IndexOut = z.infer<typeof IndexSchema>;
type ListFilesOut = z.infer<typeof ListFilesOutput>;

export const listFiles = tool('cern_opendata_list_files', {
  title: 'List CERN Open Data Record Files',
  description:
    "List one record's files: its file indexes (groups of up to ~1,300 files) with their XRootD URI-list URLs, and per file the XRootD URI, HTTPS download URL, size, adler32 checksum and availability. Without index, returns the record's indexes and its regular files; with index, pages through that index's files. Files marked on demand sit on tape and must be requested on the record's portal page before download.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    recid: recidInput().describe(
      'Record id: digits (6004), recid:6004, or a portal record URL. cern_opendata_search_records and cern_opendata_get_records return it.',
    ),
    index: blankAsUnset(
      z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().replace(/\.txt$/i, '.json') : value),
        z.string().max(300).optional(),
      ),
    ).describe(
      "A file index key from the indexes list, matched exactly (a .txt ending is read as .json). Omit to list the record's indexes and regular files.",
    ),
    cursor: blankAsUnset(z.string().max(500).optional()).describe(
      'next_cursor from the previous page, unchanged, with the same recid and index. Omit for the first page.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(500).default(50)).describe(
      'Files per page, 1-500.',
    ),
  }),
  output: ListFilesOutput,
  enrichment: listEnrichment(
    'Files in scope: regular files in record scope, index files in index scope.',
  ),
  errors: [
    {
      reason: 'record_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record has this recid (the portal answered 404).',
      recovery:
        'Call cern_opendata_search_records to find the record and its recid, then call cern_opendata_list_files with that recid.',
      severity: 'notice',
    },
    {
      reason: 'index_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'index names no file index of this record.',
      recovery:
        "Call cern_opendata_list_files with this recid and no index to list the record's index keys, then pass one of them exactly.",
      severity: 'notice',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cursor does not decode, was issued for another recid or index, or points past the end.',
      recovery:
        'Call cern_opendata_list_files again without cursor to restart from the first page, or pass next_cursor from the previous page unchanged with the same recid and index.',
      severity: 'notice',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The portal's 60-a-minute budget is spent: it answered 429, or the request could not start within the call's deadline. data.retryAfter is set.",
      recovery:
        'Wait the retryAfter seconds given in this error (the portal allows 60 requests a minute per IP), then call cern_opendata_list_files again with the same arguments.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The portal answered with a body the server could not read: not JSON, missing the expected envelope, or over the byte ceiling (then data.retryable is false).',
      recovery:
        'Call cern_opendata_list_files again in a minute; if it repeats, the portal is serving an error page or an oversized response, so read the same data on https://opendata.cern.ch instead.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    startListEnrichment(ctx, input.limit);
    const indexKey = input.index ?? null;

    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor);
      if (!cursor || cursor.r !== input.recid || cursor.i !== indexKey) {
        throw ctx.fail(
          'invalid_cursor',
          cursor
            ? `This cursor was issued for record ${oneLine(cursor.r)}${cursor.i ? ` index ${oneLine(cursor.i)}` : ''}, not for this recid and index.`
            : 'The cursor does not decode; it is not a next_cursor this tool issued.',
          { recid: input.recid, index: indexKey },
        );
      }
      offset = cursor.o;
    }

    const service = getCernOpenDataService();
    const manifest = await service.getManifest(input.recid, service.startBudget(), ctx);
    if (!manifest) {
      throw ctx.fail('record_not_found', `No record has recid ${input.recid}.`, {
        recid: input.recid,
      });
    }

    let scopeFiles: CompactFile[];
    let indexes: CompactIndex[];
    if (indexKey === null) {
      scopeFiles = manifest.files;
      indexes = manifest.indexes;
    } else {
      const selected = manifest.indexes.find((index) => index.key === indexKey);
      if (!selected) {
        throw ctx.fail(
          'index_not_found',
          `Record ${input.recid} has no file index with key "${oneLine(indexKey)}"; it has ${countOf(manifest.indexes.length, 'file index', 'file indexes')}.`,
          { recid: input.recid, index: indexKey, indexCount: manifest.indexes.length },
        );
      }
      scopeFiles = selected.files;
      indexes = [selected];
    }

    const total = scopeFiles.length;
    if (offset > 0 && offset >= total) {
      throw ctx.fail(
        'invalid_cursor',
        `The cursor points to file ${offset + 1}, past the ${countOf(total, 'file')} in scope.`,
        { recid: input.recid, index: indexKey, offset, total },
      );
    }

    const page = scopeFiles.slice(offset, offset + input.limit);
    const hasMore = offset + page.length < total;
    const portalUrl = recordUrl(manifest.recid);

    const fragments: string[] = [];
    if (indexKey === null && manifest.files.length === 0 && indexes.length > 0) {
      const indexed = indexes.reduce((sum, index) => sum + index.number_files, 0);
      fragments.push(
        `Files are grouped into ${countOf(indexes.length, 'file index', 'file indexes')} (${countOf(indexed, 'file')}); call cern_opendata_list_files with index set to one of the index keys to page its files, or fetch an index's uri_list_url for every XRootD URI at once.`,
      );
    }
    const onTape =
      scopeFiles.filter((file) => file.availability === 'on demand').length +
      (indexKey === null
        ? indexes.reduce((sum, index) => sum + (index.availability.on_demand ?? 0), 0)
        : 0);
    if (onTape > 0) {
      const [are, them] = onTape === 1 ? ['is', 'it'] : ['are', 'them'];
      fragments.push(
        `${countOf(onTape, 'file')} ${are} on tape (availability on demand); request ${them} on the record's portal page (${portalUrl}) before downloading.`,
      );
    }
    if (manifest.files.length === 0 && manifest.indexes.length === 0) {
      if (manifest.children.length > 0) {
        const named = manifest.children.slice(0, CHILDREN_NAMED).join(', ');
        const more = manifest.children.length > CHILDREN_NAMED ? ', …' : '';
        const which = manifest.children.length === 1 ? 'that recid' : 'one of those recids';
        fragments.push(
          `This record holds no files itself; its files sit in ${countOf(manifest.children.length, 'child record')} (${named}${more}). Call cern_opendata_list_files with ${which}.`,
        );
      } else if (manifest.number_files) {
        const stated = `${countOf(manifest.number_files, 'file')}${manifest.size === undefined ? '' : ` (${countOf(manifest.size, 'byte')})`}`;
        const [are, them, listsNone] =
          manifest.number_files === 1
            ? ['is', 'it', 'does not list it']
            : ['are', 'them', 'lists none of them'];
        fragments.push(
          manifest.availability === 'ondemand'
            ? `This record's ${stated} ${are} on tape (availability ondemand), and the portal's API does not list ${them}; request ${them} on the record's portal page (${portalUrl}) before downloading.`
            : `The record states ${stated}, but the portal's API ${listsNone}; check the record's portal page (${portalUrl}).`,
        );
      } else {
        fragments.push('This record has no files.');
      }
    }
    if (hasMore) {
      fragments.push(
        `Showing files ${offset + 1}–${offset + page.length} of ${total}; call cern_opendata_list_files again with cursor set to next_cursor.`,
      );
    }

    finishListEnrichment(ctx, {
      shown: page.length,
      total,
      cap: input.limit,
      truncated: hasMore,
      notice: composeNotice(fragments),
    });

    return definedOnly<ListFilesOut>({
      recid: manifest.recid,
      title: manifest.title,
      availability: manifest.availability,
      availability_details: manifest.availability_details,
      scope: indexKey === null ? 'record' : 'index',
      indexes: indexes.map((index) => toIndexOut(manifest.recid, index)),
      files: page.map((file) => toFileOut(manifest.recid, file)),
      children: manifest.children,
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({ r: input.recid, i: indexKey, o: offset + page.length })
        : undefined,
      portal_url: portalUrl,
    });
  },

  format: (result) => {
    const lines = [`## Files of record ${inline(result.recid)}: ${inlineOrNA(result.title)}`];
    const counts = result.availability_details
      ? ` (online files: ${inlineOrNA(result.availability_details.online)}, on-demand files: ${inlineOrNA(result.availability_details.on_demand)})`
      : '';
    lines.push(
      `**Scope:** ${result.scope} · **Availability:** ${inlineOrNA(result.availability)}${counts}`,
      `**Portal:** ${printUrl(result.portal_url)}`,
    );
    if (result.children.length > 0) {
      lines.push(`**Child records:** ${result.children.map(inline).join(', ')}`);
    }

    if (result.indexes.length > 0) {
      lines.push('', `### File indexes (${result.indexes.length})`);
      for (const index of result.indexes) {
        lines.push(
          `- **${inline(index.key)}**: ${countOf(index.number_files, 'file')}, ${countOf(index.size_in_bytes, 'byte')}, online ${inlineOrNA(index.availability.online)}, on demand ${inlineOrNA(index.availability.on_demand)}`,
          `  - Description: ${index.description ? inline(index.description) : NOT_AVAILABLE}`,
          `  - URI list: ${printUrl(index.uri_list_url)}`,
          `  - JSON: ${printUrl(index.json_url)}`,
        );
      }
    }

    lines.push('', `### Files (${result.files.length} on this page)`);
    if (result.files.length === 0) {
      lines.push('No files on this page.');
    } else {
      lines.push(
        '| Key | Filename | Size (bytes) | Checksum | Availability | XRootD URI | HTTPS URL |',
        '|:----|:---------|-------------:|:---------|:-------------|:-----------|:----------|',
      );
      for (const file of result.files) {
        lines.push(
          `| ${inline(file.key)} | ${inlineOrNA(file.filename)} | ${file.size_in_bytes} | ${inlineOrNA(file.checksum)} | ${inlineOrNA(file.availability)} | ${printUrl(file.xrootd_uri)} | ${printUrl(file.https_url)} |`,
        );
      }
    }
    lines.push(
      '',
      `**More files:** ${result.has_more ? 'yes' : 'no'}${result.next_cursor ? ` · **next_cursor:** \`${result.next_cursor}\`` : ''}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
